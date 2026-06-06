"""
Run wcEcoli cell simulations, supporting multiple variants, multiple initial
seeds, and multiple generations, but only single daughters per generation.

Prerequisite: Run the parameter calculator (runParca.py).

Prerequisite: Generate the sim_data variant (makeVariants.py) before running
`runSim.py --require_variants`.

* Easy usage: runParca.py, then runSim.py, then analysis*.py.
* Fancy usage: runParca.py, makeVariants.py, lots of runSim.py and
  runDaughter.py runs, and analysis*.py, in a parallel workflow.

TODO: Share more code with fw_queue.py.

Run with '-h' for command line help.
Set PYTHONPATH when running this.
"""

import re
import os
import sys
import traceback

from models.ecoli.sim.variants.new_gene_internal_shift import (NEW_GENE_EXPRESSION_FACTORS,
	NEW_GENE_TRANSLATION_EFFICIENCY_VALUES, NEW_GENE_INDUCTION_GEN,
	NEW_GENE_KNOCKOUT_GEN)
from wholecell.fireworks.firetasks import SimulationDaughterTask, SimulationTask, VariantSimDataTask
from wholecell.utils import constants, data, scriptBase
import wholecell.utils.filepath as fp

SIM_DIR_PATTERN = r'({})__(.+)'.format(fp.TIMESTAMP_PATTERN)


def multi_ko_variant_kwargs(variant_spec, multi_ko_indices, require_variants):
	"""Validate and build multi-gene knockout variant parameters."""
	variant_type, first_index, last_index = variant_spec

	if variant_type != 'multi_gene_knockout':
		if multi_ko_indices is not None:
			raise ValueError(
				'--multi-ko-indices is only supported with '
				'--variant multi_gene_knockout 0 0.')
		return None

	if (first_index, last_index) != (0, 0):
		raise ValueError('multi_gene_knockout requires --variant multi_gene_knockout 0 0.')
	if require_variants:
		raise ValueError(
			'multi_gene_knockout does not support --require-variants because '
			'the requested KO indexes define the modified sim data.')
	if multi_ko_indices is None:
		raise ValueError('multi_gene_knockout requires --multi-ko-indices.')
	if len(multi_ko_indices) < 2:
		raise ValueError('multi_gene_knockout requires at least two unique KO indexes.')
	if any(index < 1 for index in multi_ko_indices):
		raise ValueError('All multi_gene_knockout KO indexes must be positive.')
	if len(set(multi_ko_indices)) != len(multi_ko_indices):
		raise ValueError('Duplicate KO indexes are not allowed in multi_gene_knockout.')

	return {'ko_indices': multi_ko_indices}


def parse_timestamp_description(sim_path):
	"""Parse `timestamp, description` from a sim_path that ends with a dir like
	'20190704.101500__Latest_sim_run' or failing that, return defaults.
	"""
	sim_dir = os.path.basename(sim_path)
	if not sim_dir:  # sim_path is empty or ends with '/'
		sim_dir = os.path.basename(os.path.dirname(sim_path))

	match = re.match(SIM_DIR_PATTERN, sim_dir)
	if match:
		timestamp = match.group(1)
		description = match.group(2).replace('_', ' ')
	else:
		timestamp = fp.timestamp()
		description = sim_dir

	return timestamp, description


class RunSimulation(scriptBase.ScriptBase):
	"""Drives a simple simulation run."""

	def description(self):
		"""Describe the command line program."""
		return 'Whole Cell E. coli simulation'

	def help(self):
		"""Return help text for the Command Line Interface."""
		return '''Run a {}.
				If the sim_path ends with a dir like
				"20190704.101500__Latest_sim_run", this will get the
				timestamp and description from the path to write into
				metadata.json.
				The command line option names are long but you can use any
				unambiguous prefix.'''.format(self.description())

	def define_parameters(self, parser):
		super(RunSimulation, self).define_parameters(parser)
		self.define_parameter_sim_dir(parser)
		self.define_sim_loop_options(parser, manual_script=True)
		parser.add_argument('--multi-ko-indices', nargs='+', type=int,
			metavar='KO_INDEX',
			help='One-based gene_knockout indexes to combine in a single '
				'multi_gene_knockout run. Requires '
				'--variant multi_gene_knockout 0 0.')
		self.define_sim_options(parser)
		self.define_elongation_options(parser)

	def run(self, args):
		kb_directory = os.path.join(args.sim_path, constants.KB_DIR)
		sim_data_file = os.path.join(kb_directory, constants.SERIALIZED_SIM_DATA_FILENAME)
		fp.verify_file_exists(sim_data_file, 'Run runParca?')

		timestamp, description = parse_timestamp_description(args.sim_path)

		variant_type = args.variant[0]
		variant_spec = (variant_type, int(args.variant[1]), int(args.variant[2]))
		variant_kwargs = multi_ko_variant_kwargs(
			variant_spec, args.multi_ko_indices, args.require_variants)

		cli_sim_args = data.select_keys(vars(args), scriptBase.SIM_KEYS)

		# Write the metadata file.
		metadata = data.select_keys(
			vars(args),
			scriptBase.METADATA_KEYS,
			git_hash=fp.git_hash(),
			git_branch=fp.git_branch(),
			description=description,
			time=timestamp,
			python=sys.version.splitlines()[0],
			analysis_type=None,
			variant=variant_type,
			total_variants=str(variant_spec[2] + 1 - variant_spec[1]),
			total_gens=args.total_gens or args.generations,
			total_init_sims=args.total_init_sims or args.init_sims,
			)

		if variant_type == 'new_gene_internal_shift':
			# Record the values used in this variant for analysis scripts
			metadata.update(
				new_gene_expression_factors=NEW_GENE_EXPRESSION_FACTORS,
				new_gene_translation_efficiency_values=
				NEW_GENE_TRANSLATION_EFFICIENCY_VALUES,
				new_gene_induction_gen=NEW_GENE_INDUCTION_GEN,
				new_gene_knockout_gen=NEW_GENE_KNOCKOUT_GEN,)
		elif variant_type == 'multi_gene_knockout':
			metadata.update(multi_ko_indices=args.multi_ko_indices)

		metadata_dir = fp.makedirs(args.sim_path, constants.METADATA_DIR)
		metadata_path = os.path.join(metadata_dir, constants.JSON_METADATA_FILE)
		fp.write_json_file(metadata_path, metadata)


		# args.sim_path is called INDIV_OUT_DIRECTORY in fw_queue.
		failed_variants = []
		for i, subdir in fp.iter_variants(*variant_spec):
			try:
				variant_directory = os.path.join(args.sim_path, subdir)
				variant_sim_data_directory = os.path.join(variant_directory,
					constants.VKB_DIR)

				variant_sim_data_modified_file = os.path.join(
					variant_sim_data_directory, constants.SERIALIZED_SIM_DATA_MODIFIED)

				if args.require_variants:
					fp.verify_file_exists(
						variant_sim_data_modified_file, 'Run makeVariants?')
				else:
					variant_metadata_directory = os.path.join(variant_directory,
						constants.METADATA_DIR)
					task = VariantSimDataTask(
						variant_function=variant_type,
						variant_index=i,
						input_sim_data=sim_data_file,
						output_sim_data=variant_sim_data_modified_file,
						variant_metadata_directory=variant_metadata_directory,
						variant_kwargs=variant_kwargs,
						)
					task.run_task({})

				for j in range(args.seed, args.seed + args.init_sims):  # init sim seeds
					seed_directory = fp.makedirs(variant_directory, "%06d" % j)

					for k in range(args.generations):  # generation number k
						gen_directory = fp.makedirs(seed_directory, "generation_%06d" % k)

						# l is the daughter number among all of this generation's cells,
						# which is 0 for single-daughters but would span range(2**k) if
						# each parent had 2 daughters.
						l = 0
						cell_directory = fp.makedirs(gen_directory, "%06d" % l)
						cell_sim_out_directory = fp.makedirs(cell_directory, "simOut")

						options = dict(cli_sim_args,
							input_sim_data=variant_sim_data_modified_file,
							output_directory=cell_sim_out_directory,
							)

						if k == 0:
							task = SimulationTask(seed=j, **options)
						else:
							parent_gen_directory = os.path.join(seed_directory, "generation_%06d" % (k - 1))
							parent_cell_directory = os.path.join(parent_gen_directory, "%06d" % (l // 2))
							parent_cell_sim_out_directory = os.path.join(parent_cell_directory, "simOut")
							daughter_state_path = os.path.join(
								parent_cell_sim_out_directory,
								constants.SERIALIZED_INHERITED_STATE % (l % 2 + 1))
							task = SimulationDaughterTask(
								seed=(j + 1) * ((2 ** k - 1) + l),
								inherited_state_path=daughter_state_path,
								**options
								)
						task.run_task({})

			except Exception:
				print("\n" + "=" * 60, file=sys.stderr)
				print("VARIANT {} ({}) FAILED — skipping to next variant".format(i, subdir), file=sys.stderr)
				traceback.print_exc(file=sys.stderr)
				print("=" * 60 + "\n", file=sys.stderr)
				failed_variants.append((i, subdir))

		if failed_variants:
			print("\n" + "=" * 60, file=sys.stderr)
			print("SUMMARY: {} variant(s) failed:".format(len(failed_variants)), file=sys.stderr)
			for idx, name in failed_variants:
				print("  Variant {}: {}".format(idx, name), file=sys.stderr)
			print("=" * 60, file=sys.stderr)


if __name__ == '__main__':
	script = RunSimulation()
	script.cli()
