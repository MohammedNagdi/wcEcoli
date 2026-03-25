"""
runExperiment.py — YAML-driven runner for sinusoidal media mixing experiments.

Reads a YAML config file, runs the sinusoidal_media variant simulation, and
verifies that all generations completed successfully.

Usage (inside Docker with live source):
    WCECOLI_BIND_SOURCE=1 docker/local/run.sh py \\
        runscripts/manual/runExperiment.py experiment.yaml

Usage (outside Docker, after make compile):
    PYTHONPATH=$PWD python runscripts/manual/runExperiment.py experiment.yaml

YAML schema
-----------
Required fields:
    sim_dir     : str   — directory name under out/ containing kb/simData.cPickle
    media_a     : str   — recipe name of the first media  (r(t) = 1 - p(t) fraction)
    media_b     : str   — recipe name of the second media (p(t) fraction)
    period_min  : float — sine period T in minutes
    generations : int   — number of generations to simulate

Optional fields:
    seed        : int   — random seed (default: 0)

Example
-------
    sim_dir: sim_glc_exp
    media_a: minimal
    media_b: minimal_GLC_2mM
    period_min: 2
    generations: 4
    seed: 0

Media recipe names must match entries in:
    reconstruction/ecoli/flat/condition/media_recipes.tsv
"""

import argparse
import os
import subprocess
import sys

import yaml

from wholecell.utils.filepath import ROOT_PATH

# ── constants ─────────────────────────────────────────────────────────────────

REQUIRED_FIELDS = ('sim_dir', 'media_a', 'media_b', 'period_min', 'generations')
RUNSIM_PATH = os.path.join(ROOT_PATH, 'runscripts', 'manual', 'runSim.py')
MEDIA_RECIPES_PATH = os.path.join(
	ROOT_PATH, 'reconstruction', 'ecoli', 'flat', 'condition', 'media_recipes.tsv')


# ── helpers ───────────────────────────────────────────────────────────────────

def _load_valid_media_names():
	"""Return the set of recipe names from media_recipes.tsv."""
	names = set()
	with open(MEDIA_RECIPES_PATH) as f:
		for line in f:
			line = line.strip()
			if not line or line.startswith('#') or line.startswith('"media id"'):
				continue
			names.add(line.split('\t')[0].strip('"'))
	return names


def _resolve_sim_path(sim_dir):
	"""Return absolute path for sim_dir (same logic as scriptBase.find_sim_path)."""
	if os.path.isabs(sim_dir):
		return sim_dir
	if sim_dir.startswith('out/'):
		return os.path.join(ROOT_PATH, sim_dir)
	return os.path.join(ROOT_PATH, 'out', sim_dir)


# ── phases ────────────────────────────────────────────────────────────────────

def parse_yaml(path):
	"""Load and return the raw config dict from *path*."""
	with open(path) as f:
		cfg = yaml.safe_load(f)
	if not isinstance(cfg, dict):
		raise ValueError(f'{path}: expected a YAML mapping, got {type(cfg).__name__}')
	return cfg


def validate_config(cfg):
	"""Raise ValueError with a descriptive message if *cfg* is invalid."""
	# Required fields
	missing = [k for k in REQUIRED_FIELDS if k not in cfg]
	if missing:
		raise ValueError(f'Missing required field(s): {", ".join(missing)}')

	# Type checks
	if not isinstance(cfg['generations'], int) or cfg['generations'] < 1:
		raise ValueError(f'"generations" must be a positive integer, got: {cfg["generations"]!r}')
	if not isinstance(cfg['period_min'], (int, float)) or cfg['period_min'] <= 0:
		raise ValueError(f'"period_min" must be a positive number, got: {cfg["period_min"]!r}')

	# Media names
	valid = _load_valid_media_names()
	for key in ('media_a', 'media_b'):
		name = cfg[key]
		if name not in valid:
			raise ValueError(
				f'"{key}: {name}" is not a known media recipe.\n'
				f'Valid names: {sorted(valid)}'
			)

	# sim_dir must contain simData.cPickle
	sim_path = _resolve_sim_path(cfg['sim_dir'])
	sim_data_file = os.path.join(sim_path, 'kb', 'simData.cPickle')
	if not os.path.exists(sim_data_file):
		raise ValueError(
			f'simData.cPickle not found at {sim_data_file}\n'
			f'Run ParCa first: docker/local/run.sh parca {cfg["sim_dir"]}'
		)


def run_simulation(cfg):
	"""Invoke runSim.py as a subprocess.  Returns the exit code."""
	period_index = str(int(cfg['period_min']))
	seed = str(cfg.get('seed', 0))

	cmd = [
		sys.executable, RUNSIM_PATH,
		'--generations', str(cfg['generations']),
		'--seed', seed,
		'--variant', 'sinusoidal_media', period_index, period_index,
		cfg['sim_dir'],
	]

	env = {
		**os.environ,
		'SINE_MEDIA_A': cfg['media_a'],
		'SINE_MEDIA_B': cfg['media_b'],
	}

	print('Running: ' + ' '.join(cmd))
	print(f'  SINE_MEDIA_A={cfg["media_a"]}  SINE_MEDIA_B={cfg["media_b"]}')
	print()

	result = subprocess.run(cmd, env=env)
	return result.returncode


def check_outputs(cfg):
	"""Return a list of per-generation result dicts."""
	sim_path = _resolve_sim_path(cfg['sim_dir'])
	period_index = int(cfg['period_min'])
	seed = cfg.get('seed', 0)

	variant_subdir = f'sinusoidal_media_{period_index:06d}'
	seed_subdir = f'{seed:06d}'

	results = []
	for gen in range(cfg['generations']):
		sim_out = os.path.join(
			sim_path, variant_subdir, seed_subdir,
			f'generation_{gen:06d}', '000000', 'simOut',
		)
		has_data = os.path.isdir(os.path.join(sim_out, 'Main'))
		has_daughters = os.path.exists(
			os.path.join(sim_out, 'Daughter1_inherited_state.cPickle'))
		results.append(dict(
			gen=gen,
			sim_out=sim_out,
			has_data=has_data,
			has_daughters=has_daughters,
			ok=has_data and has_daughters,
		))
	return results


def report(results):
	"""Print a pass/fail table.  Returns True iff all generations passed."""
	width = max(len(r['sim_out']) for r in results) + 2
	header = f'{"Gen":>4}  {"Status":8}  {"Listener data":14}  {"Daughter files":14}  Path'
	print(header)
	print('-' * len(header))
	all_ok = True
	for r in results:
		status = 'PASS' if r['ok'] else 'FAIL'
		data   = 'yes' if r['has_data']      else 'MISSING'
		dau    = 'yes' if r['has_daughters']  else 'MISSING'
		print(f'{r["gen"]:>4}  {status:8}  {data:14}  {dau:14}  {r["sim_out"]}')
		if not r['ok']:
			all_ok = False
	print()
	if all_ok:
		print(f'All {len(results)} generation(s) completed successfully.')
	else:
		failed = sum(1 for r in results if not r['ok'])
		print(f'{failed}/{len(results)} generation(s) FAILED — check paths above.')
	return all_ok


# ── entry point ───────────────────────────────────────────────────────────────

def main():
	parser = argparse.ArgumentParser(
		description=__doc__,
		formatter_class=argparse.RawDescriptionHelpFormatter,
	)
	parser.add_argument('yaml_file', help='Path to the experiment YAML config file')
	args = parser.parse_args()

	# 1. Parse
	try:
		cfg = parse_yaml(args.yaml_file)
	except (OSError, yaml.YAMLError) as exc:
		print(f'Error reading {args.yaml_file}: {exc}', file=sys.stderr)
		sys.exit(1)

	# 2. Validate
	try:
		validate_config(cfg)
	except ValueError as exc:
		print(f'Config error: {exc}', file=sys.stderr)
		sys.exit(1)

	print(f'Experiment config:')
	for k in REQUIRED_FIELDS:
		print(f'  {k}: {cfg[k]}')
	print()

	# 3. Run
	exit_code = run_simulation(cfg)
	if exit_code != 0:
		print(f'\nSimulation process exited with code {exit_code}.', file=sys.stderr)

	# 4. Check outputs (even on non-zero exit — partial output may exist)
	print('\nChecking outputs...\n')
	results = check_outputs(cfg)
	all_ok = report(results)

	sys.exit(0 if (exit_code == 0 and all_ok) else 1)


if __name__ == '__main__':
	main()
