"""
Knockout expression of multiple genes.

Targets are supplied through the runSim.py --multi-ko-indices option as existing
gene_knockout variant indexes.

Modifies:
	sim_data.process.transcription.rna_synth_prob
	sim_data.process.transcription.rna_expression
	sim_data.process.transcription.exp_free
	sim_data.process.transcription.exp_ppgpp
	sim_data.process.transcription.attenuation_basal_prob_adjustments
	sim_data.process.transcription_regulation.basal_prob
	sim_data.process.transcription_regulation.delta_prob

Expected variant indices:
	0: multi-gene knockout defined by the supplied ko_indices
"""

import numpy as np


def _validate_ko_indices(ko_indices):
	if not isinstance(ko_indices, list):
		raise ValueError("multi_gene_knockout ko_indices must be a list.")
	if len(ko_indices) < 2:
		raise ValueError("multi_gene_knockout requires at least two unique KO indexes.")
	if any(isinstance(index, bool) or not isinstance(index, int) for index in ko_indices):
		raise ValueError("All multi_gene_knockout KO indexes must be integers.")
	if any(index < 1 for index in ko_indices):
		raise ValueError("All multi_gene_knockout KO indexes must be positive.")
	if len(set(ko_indices)) != len(ko_indices):
		raise ValueError("Duplicate KO indexes are not allowed in multi_gene_knockout.")


def multi_gene_knockout(sim_data, index, ko_indices=None):
	if index != 0:
		raise ValueError("multi_gene_knockout only supports variant index 0.")

	rna_data = sim_data.process.transcription.rna_data
	_validate_ko_indices(ko_indices)

	out_of_range = [ko_index for ko_index in ko_indices if ko_index > len(rna_data)]
	if out_of_range:
		raise ValueError(
			"multi_gene_knockout KO indexes out of range "
			f"1-{len(rna_data)}: {out_of_range}")

	rna_indices = np.array([ko_index - 1 for ko_index in ko_indices], dtype=int)
	sim_data.adjust_final_expression(rna_indices, np.zeros(len(rna_indices)))

	preview = ", ".join(str(ko_index) for ko_index in ko_indices[:20])
	if len(ko_indices) > 20:
		preview += ", ..."

	return dict(
		shortName=f"{len(ko_indices)}target_KO",
		desc=f"Complete knockout of {len(ko_indices)} KO targets by KO index: {preview}."
		), sim_data
