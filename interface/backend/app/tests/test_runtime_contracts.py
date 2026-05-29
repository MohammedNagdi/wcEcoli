import unittest
from collections import deque
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace

from app.services import sim_worker


def _load_tf_activity_function():
	module_path = Path(sim_worker.settings.models_path) / 'ecoli' / 'sim' / 'variants' / 'tf_activity.py'
	spec = spec_from_file_location('copilot_tf_activity_test', module_path)
	module = module_from_spec(spec)
	assert spec.loader is not None
	spec.loader.exec_module(module)
	return module.tf_activity


tf_activity = _load_tf_activity_function()


class ExternalState:
	def __init__(self):
		self.current_timeline_id = None
		self.saved_timelines = {}


class RuntimeContractsTest(unittest.TestCase):
	def test_tf_activity_uses_current_timeline_id(self):
		sim_data = SimpleNamespace(
			tf_to_active_inactive_conditions={
				'araC': {
					'active nutrients': 'minimal_plus_arabinose',
					'inactive nutrients': 'minimal',
				},
			},
			condition='basal',
			external_state=ExternalState(),
			conditions={
				'araC__active': {'perturbations': []},
				'araC__inactive': {'perturbations': []},
			},
			process=SimpleNamespace(transcription=SimpleNamespace()),
		)

		info, updated = tf_activity(sim_data, 1)

		self.assertEqual('araC__active_phenotype', info['shortName'])
		self.assertEqual('araC__active', updated.condition)
		self.assertEqual('araC__active', updated.external_state.current_timeline_id)
		self.assertEqual(
			[(0.0, 'minimal_plus_arabinose')],
			updated.external_state.saved_timelines['araC__active'],
		)

	def test_ingest_results_fails_when_sim_outputs_are_missing(self):
		job = SimpleNamespace(sim_dir='missing-output', id=1, experiment_id=1, seed=0)
		experiment = SimpleNamespace()
		log_buffer = deque(maxlen=20)

		with TemporaryDirectory() as tmpdir:
			original_sim_output_dir = sim_worker.settings.sim_output_dir
			sim_worker.settings.sim_output_dir = Path(tmpdir)
			try:
				with self.assertRaisesRegex(RuntimeError, 'without producing any simOut directories'):
					sim_worker._ingest_results(object(), job, experiment, log_buffer)
			finally:
				sim_worker.settings.sim_output_dir = original_sim_output_dir


if __name__ == '__main__':
	unittest.main()