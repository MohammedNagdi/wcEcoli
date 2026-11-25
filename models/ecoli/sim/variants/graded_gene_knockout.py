"""
Suppress a gene across ALL of its transcription units, at a chosen strength.

Two capabilities the existing `gene_knockout` variant leaves on the table, both already supported by
`sim_data.adjust_final_expression(gene_indices, factors)`:

  1. MULTI-TU. `gene_knockout` calls `adjust_final_expression([geneIndex], [0])` — ONE index. A gene transcribed
     from several transcription units keeps being expressed from the ones that were not zeroed, so the variant
     cannot knock it out at all. Measured in the Cellarium corpus (data/cache/ko_footprint.json, all four
     `evidence: measured`):

         murA  n_tu=2  ko_mean 1.6  vs wt 1.5   (unchanged — a wild type wearing a knockout's label)
         rpoB  n_tu=3  ko_mean 10.4 vs wt 8.4
         rpmJ  n_tu=2  ko_mean 50.1 vs wt 69.5  (72% of WT)
         valS  n_tu=2  ko_mean 0.7  vs wt 1.9   (37% of WT)

     versus every single-TU gene checked, which silences cleanly (thrC, leuB, dapA, pgi, fabI, lpxC, gltA,
     argG, rpmE, glmS, selA, flgB, ymgD). The asymmetry is NOT a clean rule in the other direction — of 55
     measured gene-observations, `n_tu == 1 -> silenced` holds 27/27 while `n_tu > 1 -> survives` is 23 fit and
     5 refuted (pheS was predicted to survive and measured silenced). So multi-TU means AT RISK, and this
     variant removes the risk by zeroing every TU the gene is on.

  2. GRADED. `factor` in `adjust_final_expression` is a MULTIPLIER (`synth_prob[i] *= factor`), and
     `gene_knockout` hard-codes `factor = 0`. Any value in (0, 1) gives partial suppression, which turns a
     binary perturbation into a dose-response. That matters here because single metabolic knockouts in this
     model mostly REROUTE and show no phenotype — pfkA, tpiA, fabI, glmS and gltA are all viable at division
     rate 1.00 — so "does it reroute" is far less informative than "up to what dose does it reroute".
     `rrna_operon_knockout` is the working precedent for a graded variant in this codebase (measured total
     rRNA probability 100 / 73.8 / 45.9 / 15.8% for control/2op/4op/6op).

VERIFIED BEFORE WRITING THIS, because both would have silently defeated it:

  * The suppression SURVIVES ppGpp re-derivation. `synth_prob_from_ppgpp` rebuilds probabilities as
    `normalize((exp_free * (1 - f_ppgpp) + exp_ppgpp * f_ppgpp) * factor)`, and `adjust_final_expression`
    multiplies BOTH `exp_free` and `exp_ppgpp`. So a runtime recompute starts from the suppressed bases rather
    than overwriting them.
  * There is NO cross-TU re-normalisation for protein-coding genes. The identity-destroying re-average that
    makes `rrna_operon_knockout` a dose-only perturbation is masked to rRNA:
    `prob[rna_data['is_rRNA']] = prob[rna_data['is_rRNA']].mean()`.

KNOWN AND UNAVOIDABLE: `normalize()` makes probabilities sum to 1, so suppressing one gene redistributes a
little probability across all others. That is inherent to the existing `gene_knockout` too, not introduced
here — but at graded factors it should be reported rather than ignored.

Modifies (identical surface to gene_knockout, applied once per TU):
	sim_data.process.transcription.rna_synth_prob
	sim_data.process.transcription.rna_expression
	sim_data.process.transcription.exp_free
	sim_data.process.transcription.exp_ppgpp
	sim_data.process.transcription.attenuation_basal_prob_adjustments
	sim_data.process.transcription_regulation.basal_prob
	sim_data.process.transcription_regulation.delta_prob

Expected variant indices (dense, so a sweep is contiguous):
	0: control (no suppression)
	otherwise: index = gene_ko_index * 10 + level, where `level` selects the factor:

	    level  1     2     3     4     5     6     7     8     9
	    factor 0.0   0.05  0.10  0.25  0.50  0.75  0.90  0.95  0.99

	level 1 (factor 0.0) is a TRUE knockout of a multi-TU gene — what `gene_knockout` cannot do.
	Levels 2-9 are the graded series. Level 0 is reserved so `index % 10 == 0` is never a silent no-op.

RESOLVING THE GENE'S TRANSCRIPTION UNITS needs the gene's OWN CISTRON, and that cannot be derived from the
variant index alone. `ko_index` maps to an `rna_data` row, i.e. a TRANSCRIPTION UNIT (`TU0-42478[c]` for leuB) —
so for a multi-gene operon the index does not say which of its genes is the target. `gene_knockout`'s real
semantics are "zero this TU"; the gene labelling is an interpretation layer above it.

So the target cistron is passed IN (`sim_data._graded_ko_cistron`, set by the caller from Cellarium's
`gene_scope.json`). Given it, the TUs are every row the mapping matrix links that ONE cistron to — which is the
relation `n_tu` is built from, and it now agrees: leuB -> 1, dapA -> 1, murA -> 2. Without it the variant falls
back to the single row `gene_knockout` would have zeroed, so it is never BROADER than the existing variant by
accident.
"""

import os

import numpy as np

CONTROL_OUTPUT = dict(
	shortName="control",
	desc="Control simulation (no graded suppression)"
	)

# level -> multiplier. 1 is a complete knockout; higher levels retain progressively more expression.
FACTORS = {1: 0.0, 2: 0.05, 3: 0.10, 4: 0.25, 5: 0.50, 6: 0.75, 7: 0.90, 8: 0.95, 9: 0.99}


def _tu_indices_for(sim_data, gene_index, cistron_id=None, expected_n_tu=None):
	"""The `rna_data` rows that transcribe the TARGET GENE, resolved from the gene's own cistron.

	A first version walked TU -> all its cistrons -> all TUs containing ANY of them. That over-resolves, because
	a gene riding on a multi-gene operon drags in every TU carrying any co-member. Measured against the corpus
	authority for `n_tu` (`gene_scope.json`): leuB 1 vs 2 found, dapA 1 vs 2, rpoB 3 vs 6, rpmJ 2 vs 3,
	valS 2 vs 3 — only murA agreed. `leuB` and `dapA` are the rows that made it unshippable: both silence
	correctly under the existing variant today, and `leuB` is the genotype behind the SCI-TRNA-4 leu arm that has
	a matched control and is published to HF, so widening it would break a standing result.

	The fix is to follow ONE cistron — the target gene's — rather than all cistrons on its TU. `cistron_id` must
	therefore be supplied by the caller, since the variant index identifies a TU and not a gene. With no
	`cistron_id` this returns the single row `gene_knockout` would have zeroed, so it can never be accidentally
	broader than the variant it extends.
	"""
	transcription = sim_data.process.transcription
	rna_data = transcription.rna_data
	matrix = getattr(transcription, 'cistron_tu_mapping_matrix', None)

	if cistron_id is None or matrix is None:
		if expected_n_tu not in (None, 1):
			raise ValueError(
				"graded_gene_knockout: n_tu={} says this gene has other transcription units, but no "
				"cistron_id was supplied (or no mapping matrix is available), so they cannot be located. "
				"Refusing — a partial suppression reported as a knockout is the exact defect this variant "
				"exists to fix.".format(expected_n_tu))
		return [int(gene_index)]

	cistron_ids = [str(x) for x in transcription.cistron_data['id']]
	try:
		ci = cistron_ids.index(str(cistron_id))
	except ValueError:
		raise ValueError(
			"graded_gene_knockout: cistron {!r} is not in cistron_data. Pass the id exactly as it appears "
			"there.".format(cistron_id))

	csr = matrix.tocsr()
	rows = sorted({int(t) for t in csr[ci, :].nonzero()[1] if 0 <= int(t) < len(rna_data)})
	if int(gene_index) not in rows:
		rows = sorted(set(rows) | {int(gene_index)})

	if expected_n_tu is not None and len(rows) != int(expected_n_tu):
		raise ValueError(
			"graded_gene_knockout: cistron {!r} resolves to {} transcription unit(s) {} but n_tu={}. The "
			"suppression set is unverified; refusing rather than guessing.".format(
				cistron_id, len(rows), rows, expected_n_tu))
	return rows


def graded_gene_knockout(sim_data, index):
	rna_data = sim_data.process.transcription.rna_data
	n_genes = len(rna_data)

	if index == 0:
		return CONTROL_OUTPUT, sim_data

	level = index % 10
	if level not in FACTORS:
		raise ValueError(
			"graded_gene_knockout index {} has level {}, which is not one of {}. Index is "
			"gene_ko_index * 10 + level.".format(index, level, sorted(FACTORS)))

	ko_index = index // 10
	if ko_index < 1 or ko_index > n_genes:
		raise ValueError(
			"graded_gene_knockout gene index {} out of range 1..{}".format(ko_index, n_genes))

	gene_index = ko_index - 1                                   # gene_knockout uses a 1-based ko_index
	factor = FACTORS[level]
	# `expected_n_tu` comes from the caller (Cellarium passes it from scope.ko_will_silence). Absent it, the
	# variant still runs but only over the rows it resolved — never over an unverified wider set.
	# Both supplied by the caller (Cellarium reads them from gene_scope.json / scope.ko_will_silence). Absent
	# them the variant degrades to exactly gene_knockout's behaviour rather than to a guess.
	# The target cistron cannot be derived from the variant index (the index names a TRANSCRIPTION UNIT, and a
	# multi-gene operon has no single implied gene), so the caller supplies it. Two channels, checked in order:
	# an attribute set on sim_data by an in-process caller, or GRADED_KO_CISTRON / GRADED_KO_N_TU in the
	# environment for a plain `runSim.py` invocation. Absent both, `_tu_indices_for` degrades to the single row
	# `gene_knockout` would have zeroed — never to a guess.
	expected = getattr(sim_data, '_graded_ko_expected_n_tu', None)
	cistron = getattr(sim_data, '_graded_ko_cistron', None)
	if cistron is None:
		cistron = os.environ.get('GRADED_KO_CISTRON') or None
	if expected is None and os.environ.get('GRADED_KO_N_TU'):
		expected = int(os.environ['GRADED_KO_N_TU'])
	tu_indices = _tu_indices_for(sim_data, gene_index, cistron_id=cistron, expected_n_tu=expected)

	sim_data.adjust_final_expression(tu_indices, [factor] * len(tu_indices))

	gene_id = rna_data["id"][gene_index]
	kind = "knockout" if factor == 0.0 else "{:.0%} expression".format(factor)
	return dict(
		shortName="{}_{}".format(gene_id, "KO" if factor == 0.0 else "x{:g}".format(factor)),
		desc=("Graded suppression of {} to {} across {} transcription unit(s) {}. "
		      "factor={:g}".format(gene_id, kind, len(tu_indices), tu_indices, factor)),
		), sim_data
