"""
Variant to compare the impacts of knocking out a subset of the rRNA operons.

Modifies:
	sim_data.process.transcription.rna_synth_prob
	sim_data.process.transcription.rna_expression
	sim_data.process.transcription.exp_free
	sim_data.process.transcription.exp_ppgpp
	sim_data.process.transcription.attenuation_basal_prob_adjustments
	sim_data.process.transcription_regulation.basal_prob
	sim_data.process.transcription_regulation.delta_prob

Expected variant indices:
	0: control
	1-6: knockout of one to six rRNA operons in minimal media conditions
	7-12: knockout of one to six rRNA operons in rich media conditions
	13-18: knockout of one to six rRNA operons in minimal-to-rich shift conditions
"""

import numpy as np

CONTROL_OUTPUT = dict(
	shortName = "control",
	desc = "Control simulation"
	)

RICH_CONDITION_ID = 'with_aa'
MINIMAL_TO_RICH_TIMELINE_ID = '000028_add_aa_long'


def set_condition_by_name(sim_data, condition_id):
	sim_data.condition = condition_id
	sim_data.external_state.current_timeline_id = condition_id
	sim_data.external_state.saved_timelines[condition_id] = [
		(0, sim_data.conditions[condition_id]["nutrients"])
		]


def set_timeline_by_name(sim_data, timeline_id):
	saved_timelines = sim_data.external_state.saved_timelines
	if timeline_id not in saved_timelines:
		raise ValueError(f'Timeline {timeline_id} is not available in sim_data.')

	sim_data.external_state.current_timeline_id = timeline_id

	# Get possible condition from starting nutrients for proper initialization.
	nutrients = saved_timelines[timeline_id][0][1]
	conditions = [cond for cond in sim_data.condition_active_tfs
		if sim_data.conditions[cond]['nutrients'] == nutrients]
	if len(conditions) == 1:
		sim_data.condition = conditions[0]
	else:
		print('Warning: could not find mapping from nutrients ({}) to condition.'
			' Using default condition ({}).'.format(nutrients, sim_data.condition))


def rrna_operon_knockout(sim_data, index):
	if index > 0:
		n_rrna_to_ko = index % 6
		if n_rrna_to_ko == 0:
			n_rrna_to_ko = 6

		# Build boolean array for rRNAs to knock out
		rrna_ko_array = np.zeros(7, dtype=bool)
		rrna_ko_array[:n_rrna_to_ko] = True

		# Get genes to knock out for this variant
		rRNA_operons_to_ko = [
			sim_data.molecule_groups.rRNA_operons[i] for i in
			np.where(rrna_ko_array)[0]]
		genes_to_ko = []
		for rRNA_operon in rRNA_operons_to_ko:
			genes_to_ko.extend(sim_data.molecule_groups.__dict__[rRNA_operon])

		# Set expression levels of all RNAs encoding for the genes to zero
		rna_indexes_to_ko = np.where(
			sim_data.process.transcription.cistron_tu_mapping_matrix.T.dot(
				np.isin(
					sim_data.process.transcription.cistron_data['gene_id'],
					genes_to_ko)
				))[0]
		sim_data.adjust_final_expression(
			rna_indexes_to_ko, np.zeros_like(rna_indexes_to_ko))

		condition_index = (index - 1)//6

		# Change media conditions for condition indexes 1 and 2
		condition_id = sim_data.condition
		if condition_index == 1:
			condition_id = RICH_CONDITION_ID
			set_condition_by_name(sim_data, condition_id)
		elif condition_index == 2:
			condition_id = MINIMAL_TO_RICH_TIMELINE_ID
			set_timeline_by_name(sim_data, condition_id)

		return dict(
			shortName = f"{'_'.join(rRNA_operons_to_ko)}_rrna_knockout_{condition_id}",
			desc = f"Simulation with the {', '.join(rRNA_operons_to_ko)} rRNA operons knocked out in {condition_id}"
			), sim_data

	else:
		return CONTROL_OUTPUT, sim_data
