import unittest
import json
import threading
import time
from collections import deque
from datetime import datetime, timedelta, timezone
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

import app.main  # noqa: F401 - load routers through the normal app entrypoint
from sqlmodel import SQLModel, Session, create_engine, select

from app.db.models import Condition, Experiment, SimulationJob, SimulationResult
from app.routers import experiments, jobs as jobs_router
from app.services.job_queue import RunJobRequest, create_simulation_jobs_for_experiment
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


class ExecResult:
	def __init__(self, items):
		self.items = items

	def all(self):
		return self.items

	def first(self):
		return self.items[0] if self.items else None


class FakeSession:
	def __init__(self):
		self.conditions = [
			Condition(id=1, name='basal', nutrients='minimal'),
			Condition(id=2, name='acetate', nutrients='minimal_acetate'),
			Condition(id=3, name='with_aa', nutrients='minimal_plus_amino_acids'),
		]

	def exec(self, _statement):
		return ExecResult(self.conditions)


class RuntimeContractsTest(unittest.TestCase):
	def _runtime_test_engine(self, tmpdir):
		engine = create_engine(
			"sqlite:///" + str(Path(tmpdir) / "runtime-test.db"),
			connect_args={"check_same_thread": False},
		)
		SQLModel.metadata.create_all(engine)
		return engine

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

	def _sim_out(self, root: Path, generation: int, seed: int = 0) -> Path:
		path = root / 'run' / 'wildtype_000000' / f'{seed:06d}' / f'generation_{generation:06d}' / '000000' / 'simOut'
		path.mkdir(parents=True)
		return path

	def test_missing_generation_fails_output_validation(self):
		with TemporaryDirectory() as tmpdir:
			root = Path(tmpdir)
			self._sim_out(root, 0)
			job = SimpleNamespace(sim_dir='run', id=1, experiment_id=1, seed=0, generations=2)
			with patch.object(sim_worker.settings, 'sim_output_dir', root):
				with self.assertRaisesRegex(RuntimeError, 'Generation output mismatch'):
					sim_worker._collect_results(job, SimpleNamespace(), deque())

	def test_duplicate_and_unexpected_generations_fail_validation(self):
		with TemporaryDirectory() as tmpdir:
			root = Path(tmpdir)
			first = self._sim_out(root, 0)
			unexpected = self._sim_out(root, 2)
			job = SimpleNamespace(sim_dir='run', id=1, experiment_id=1, seed=0, generations=1)
			with patch.object(sim_worker.settings, 'sim_output_dir', root):
				with self.assertRaisesRegex(RuntimeError, 'Generation output mismatch'):
					sim_worker._collect_results(job, SimpleNamespace(), deque())
			with patch('app.services.table_reader_bridge.find_sim_outs', return_value=[first, first]):
				with patch.object(sim_worker.settings, 'sim_output_dir', root):
					with self.assertRaisesRegex(RuntimeError, 'Duplicate simOut'):
						sim_worker._collect_results(job, SimpleNamespace(), deque())
			self.assertTrue(unexpected.exists())

	def test_table_reader_failure_prevents_result_creation(self):
		with TemporaryDirectory() as tmpdir:
			root = Path(tmpdir)
			self._sim_out(root, 0)
			job = SimpleNamespace(sim_dir='run', id=1, experiment_id=1, seed=0, generations=1)
			with patch.object(sim_worker.settings, 'sim_output_dir', root), patch(
				'app.services.table_reader_bridge.SimOutReader.extract_summary',
				side_effect=ValueError('corrupt table'),
			):
				with self.assertRaisesRegex(RuntimeError, 'TableReader failed'):
					sim_worker._collect_results(job, SimpleNamespace(), deque())

	def test_fenced_completion_replaces_results_exactly_once(self):
		with TemporaryDirectory() as tmpdir:
			engine = self._runtime_test_engine(tmpdir)
			with Session(engine) as session:
				experiment = Experiment(name='complete', variant_type='wildtype', status='running')
				session.add(experiment)
				session.flush()
				job = SimulationJob(
					experiment_id=experiment.id, status='ingesting', worker_id='worker-a',
					attempt=2, seed=0, generations=1,
				)
				session.add(job)
				session.flush()
				session.add(SimulationResult(job_id=job.id, experiment_id=experiment.id, seed=0, generation=0))
				session.commit()
				job_id = job.id
				experiment_id = experiment.id

			new_result = SimulationResult(
				job_id=job_id, experiment_id=experiment_id, seed=0, generation=0,
				final_mass_fg=700.0,
			)
			sim_worker._commit_results_and_complete(
				engine, job_id, 'worker-a', 2, [new_result], deque(['validated'])
			)
			with self.assertRaises(sim_worker.JobOwnershipLost):
				sim_worker._commit_results_and_complete(
					engine, job_id, 'worker-a', 2, [new_result], deque()
				)
			with Session(engine) as session:
				rows = session.exec(select(SimulationResult).where(SimulationResult.job_id == job_id)).all()
				self.assertEqual(1, len(rows))
				self.assertEqual(700.0, rows[0].final_mass_fg)
				self.assertEqual('done', session.get(SimulationJob, job_id).status)

	def test_cancellation_or_old_attempt_cannot_finalize(self):
		with TemporaryDirectory() as tmpdir:
			engine = self._runtime_test_engine(tmpdir)
			with Session(engine) as session:
				experiment = Experiment(name='cancel', variant_type='wildtype', status='running')
				session.add(experiment)
				session.flush()
				job = SimulationJob(
					experiment_id=experiment.id, status='cancelling', worker_id='worker-new', attempt=3,
				)
				session.add(job)
				session.commit()
				job_id = job.id
			with self.assertRaises(sim_worker.JobOwnershipLost):
				sim_worker._commit_results_and_complete(engine, job_id, 'worker-new', 3, [], deque())
			with self.assertRaises(sim_worker.JobOwnershipLost):
				sim_worker._commit_results_and_complete(engine, job_id, 'worker-old', 2, [], deque())
			with Session(engine) as session:
				self.assertEqual('cancelling', session.get(SimulationJob, job_id).status)

	def test_heartbeat_renews_lease_during_slow_work(self):
		with TemporaryDirectory() as tmpdir:
			engine = self._runtime_test_engine(tmpdir)
			with Session(engine) as session:
				experiment = Experiment(name='heartbeat', variant_type='wildtype', status='running')
				session.add(experiment)
				session.flush()
				job = SimulationJob(
					experiment_id=experiment.id, status='ingesting', worker_id='worker-a', attempt=1,
				)
				session.add(job)
				session.commit()
				job_id = job.id
			original_timeout = sim_worker.settings.worker_lease_timeout
			sim_worker.settings.worker_lease_timeout = 0.3
			heartbeat = sim_worker.LeaseHeartbeat(engine, job_id, 'worker-a', 1, deque(['working']))
			try:
				heartbeat.start()
				with Session(engine) as session:
					first = session.get(SimulationJob, job_id).heartbeat_at
				time.sleep(0.35)
				with Session(engine) as session:
					second = session.get(SimulationJob, job_id).heartbeat_at
				self.assertNotEqual(first, second)
			finally:
				heartbeat.stop()
				sim_worker.settings.worker_lease_timeout = original_timeout

	def test_cancellation_rpc_failure_remains_durable(self):
		with TemporaryDirectory() as tmpdir:
			engine = self._runtime_test_engine(tmpdir)
			with Session(engine) as session:
				experiment = Experiment(name='cancel-rpc', variant_type='wildtype', status='running')
				session.add(experiment)
				session.flush()
				job = SimulationJob(
					experiment_id=experiment.id, status='running_sim', worker_id='worker-a',
					attempt=1, runner_task_id='sim-live',
				)
				session.add(job)
				session.commit()
				job_id = job.id
				with patch.object(
					jobs_router.RunnerClient, 'cancel',
					side_effect=sim_worker.RunnerError('socket unavailable'),
				):
					jobs_router.cancel_job(job_id, session)
				session.expire_all()
				cancelled = session.get(SimulationJob, job_id)
				self.assertEqual('cancelling', cancelled.status)
				self.assertEqual('sim-live', cancelled.runner_task_id)
				self.assertIn('pending runner reconnection', cancelled.phase)

	def test_runner_restart_requeues_under_a_new_attempt(self):
		with TemporaryDirectory() as tmpdir:
			engine = self._runtime_test_engine(tmpdir)
			with Session(engine) as session:
				experiment = Experiment(name='runner-restart', variant_type='wildtype', status='running')
				session.add(experiment)
				session.flush()
				job = SimulationJob(
					experiment_id=experiment.id, status='running_sim', worker_id='worker-a',
					attempt=1, runner_task_id='lost-task',
				)
				session.add(job)
				session.commit()
				job_id = job.id
			sim_worker._requeue_lost_runner_task(
				engine, job_id, 'worker-a', 1, 'unknown task_id'
			)
			self.assertEqual(job_id, sim_worker.claim_next_pending_job(engine, 'worker-b'))
			with Session(engine) as session:
				requeued = session.get(SimulationJob, job_id)
				self.assertEqual('claimed', requeued.status)
				self.assertEqual('worker-b', requeued.worker_id)
				self.assertEqual(2, requeued.attempt)

	def test_concurrent_parca_manifest_publication_is_atomic(self):
		with TemporaryDirectory() as tmpdir:
			root = Path(tmpdir)
			run_id = 'parca-cache-test'
			kb = root / run_id / 'kb'
			kb.mkdir(parents=True)
			for filename in sim_worker.PARCA_EXPECTED_FILES:
				(kb / filename).write_bytes(b'complete')
			with patch.object(sim_worker.settings, 'sim_output_dir', root), patch.object(
				sim_worker, '_parca_cache_key', return_value='cache-key'
			):
				threads = [
					threading.Thread(target=sim_worker._write_parca_manifest, args=(run_id, index + 0.1))
					for index in range(8)
				]
				for thread in threads:
					thread.start()
				for thread in threads:
					thread.join()
				manifest = json.loads((root / run_id / sim_worker.PARCA_MANIFEST).read_text())
				self.assertTrue(manifest['complete'])
				self.assertEqual('cache-key', manifest['cache_key'])
				self.assertEqual([], list((root / run_id).glob('*.tmp')))

	def test_environment_managed_variants_discard_composed_timelines(self):
		session = FakeSession()
		cases = [
			('condition', 2, 'basal', '0 minimal_acetate', ('with_aa', '')),
			('add_one_aa', 5, 'acetate', '0 minimal_acetate', ('basal', '')),
			('add_one_aa_shift', 5, 'acetate', '0 minimal_acetate', ('basal', '')),
			('remove_one_aa', 5, 'basal', '0 minimal', ('with_aa', '')),
			('remove_one_aa_shift', 5, 'basal', '0 minimal', ('with_aa', '')),
			('remove_aas_shift', 1, 'basal', '0 minimal', ('with_aa', '')),
			('remove_aas_shift', 3, 'with_aa', '0 minimal_plus_amino_acids', ('basal', '')),
			('ppgpp_conc', 0, 'acetate', '0 minimal_acetate', ('basal', '')),
			('ppgpp_conc', 10, 'basal', '0 minimal', ('with_aa', '')),
			('sinusoidal_media', 2, 'basal', '0 minimal', ('glc_2mM', '')),
			('rrna_location', 1, 'acetate', '0 minimal_acetate', ('basal', '')),
			('rrna_location', 2, 'basal', '0 minimal', ('with_aa', '')),
			('rrna_location', 3, 'with_aa', '0 minimal_plus_amino_acids', ('basal', '')),
			('rrna_orientation', 2, 'basal', '0 minimal', ('with_aa', '')),
			('rrna_operon_knockout', 1, 'acetate', '0 minimal_acetate', ('basal', '')),
			('rrna_operon_knockout', 7, 'basal', '0 minimal', ('with_aa', '')),
			('rrna_operon_knockout', 13, 'with_aa', '0 minimal_plus_amino_acids', ('basal', '')),
		]

		for variant_type, variant_index, condition, timeline, expected in cases:
			with self.subTest(variant_type=variant_type, variant_index=variant_index):
				actual = experiments._normalized_experiment_environment(
					session,
					variant_type,
					variant_index,
					condition,
					timeline,
				)
				self.assertEqual(expected, actual)

	def test_tf_activity_environment_uses_reconstruction_state_metadata(self):
		session = FakeSession()

		def condition_for_nutrients(_session, nutrients, default='basal'):
			return {
				'minimal': 'basal',
				'minimal_acetate': 'acetate',
			}.get(nutrients, default)

		with patch.object(experiments, '_load_tf_activity_names', return_value=['crp']), \
			patch.object(experiments, '_load_tf_activity_specs', return_value={
				'crp': {
					'active_nutrients': 'minimal_acetate',
					'inactive_nutrients': 'minimal',
				},
			}), \
			patch.object(experiments, '_condition_for_nutrients', condition_for_nutrients), \
			patch.object(experiments, 'resolve_timeline_definition', lambda _session, timeline: timeline), \
			patch.object(experiments, 'infer_condition_from_timeline', lambda _session, _timeline, default: default):
			self.assertEqual(
				('acetate', ''),
				experiments._normalized_experiment_environment(
					session,
					'tf_activity',
					1,
					'basal',
					'0 minimal_plus_amino_acids',
				),
			)
			self.assertEqual(
				('basal', ''),
				experiments._normalized_experiment_environment(
					session,
					'tf_activity',
					2,
					'acetate',
					'0 minimal_acetate',
				),
			)
			self.assertEqual(
				('acetate', '0 minimal_acetate'),
				experiments._normalized_experiment_environment(
					session,
					'tf_activity',
					0,
					'acetate',
					'0 minimal_acetate',
				),
			)

	def test_worker_skips_external_timeline_only_for_environment_managed_variants(self):
		self.assertTrue(sim_worker._variant_manages_environment(
			SimulationJob(variant_type='remove_one_aa', variant_index=5)
		))
		self.assertTrue(sim_worker._variant_manages_environment(
			SimulationJob(variant_type='tf_activity', variant_index=1)
		))
		self.assertTrue(sim_worker._variant_manages_environment(
			SimulationJob(variant_type='rrna_location', variant_index=1)
		))
		self.assertFalse(sim_worker._variant_manages_environment(
			SimulationJob(variant_type='tf_activity', variant_index=0)
		))
		self.assertFalse(sim_worker._variant_manages_environment(
			SimulationJob(variant_type='rrna_location', variant_index=0)
		))
		self.assertFalse(sim_worker._variant_manages_environment(
			SimulationJob(variant_type='gene_knockout', variant_index=884)
		))
		self.assertFalse(sim_worker._variant_manages_environment(
			SimulationJob(variant_type='multi_gene_knockout', variant_index=0)
		))

	def test_sinusoidal_env_from_sim_params_is_whitelisted(self):
		env = sim_worker._sinusoidal_env_from_sim_params(
			'{"sinusoidal_media":{"SINE_MEDIA_A":"minimal","SINE_MEDIA_B":"minimal_acetate","BAD":"x"}}'
		)

		self.assertEqual({
			'SINE_MEDIA_A': 'minimal',
			'SINE_MEDIA_B': 'minimal_acetate',
		}, env)
		self.assertEqual({}, sim_worker._sinusoidal_env_from_sim_params('not json'))

	def test_all_jobs_share_content_addressed_parca_directory(self):
		with patch.object(sim_worker, '_parca_cache_key', return_value='a' * 64):
			self.assertEqual(
				'parca_cache_' + 'a' * 24,
				sim_worker._parca_run_id_for_experiment(
					'job-specific-dir',
					SimpleNamespace(batch_id='batch-123'),
				),
			)
			self.assertEqual(
				'parca_cache_' + 'a' * 24,
				sim_worker._parca_run_id_for_experiment(
					'another-job-dir',
					SimpleNamespace(batch_id=''),
				),
			)

	def test_shared_batch_parca_kb_is_linked_into_job_directory(self):
		log_buffer = deque(maxlen=20)

		with TemporaryDirectory() as tmpdir:
			original_sim_output_dir = sim_worker.settings.sim_output_dir
			sim_worker.settings.sim_output_dir = Path(tmpdir)
			try:
				parca_kb = Path(tmpdir) / 'parca_cache_shared' / 'kb'
				parca_kb.mkdir(parents=True)
				(parca_kb / 'simData.cPickle').write_text('shared')

				sim_worker._prepare_shared_parca_kb(
					'20260603_gene_job1',
					'parca_cache_shared',
					log_buffer,
				)

				job_kb = Path(tmpdir) / '20260603_gene_job1' / 'kb'
				self.assertTrue(job_kb.exists())
				self.assertTrue((job_kb / 'simData.cPickle').exists())
				self.assertIn(
					'Linked job kb to shared Parca cache: ../parca_cache_shared/kb',
					list(log_buffer),
				)
			finally:
				sim_worker.settings.sim_output_dir = original_sim_output_dir

	def test_existing_private_batch_job_kb_is_rejected(self):
		log_buffer = deque(maxlen=20)

		with TemporaryDirectory() as tmpdir:
			original_sim_output_dir = sim_worker.settings.sim_output_dir
			sim_worker.settings.sim_output_dir = Path(tmpdir)
			try:
				job_kb = Path(tmpdir) / '20260603_gene_job1' / 'kb'
				job_kb.mkdir(parents=True)
				(job_kb / 'simData.cPickle').write_text('private')

				with self.assertRaisesRegex(RuntimeError, 'private Parca kb'):
					sim_worker._prepare_shared_parca_kb(
						'20260603_gene_job1',
						'parca_cache_shared',
						log_buffer,
					)
			finally:
				sim_worker.settings.sim_output_dir = original_sim_output_dir

	def test_parca_cache_requires_manifest_and_all_outputs(self):
		with TemporaryDirectory() as tmpdir, patch.object(
			sim_worker, '_parca_cache_key', return_value='cache-key'
		):
			original_sim_output_dir = sim_worker.settings.sim_output_dir
			sim_worker.settings.sim_output_dir = Path(tmpdir)
			try:
				run_path = Path(tmpdir) / 'parca_cache_test'
				kb_path = run_path / 'kb'
				kb_path.mkdir(parents=True)
				for filename in sim_worker.PARCA_EXPECTED_FILES:
					(kb_path / filename).write_text(filename)

				self.assertFalse(sim_worker._parca_cached('parca_cache_test'))
				(run_path / sim_worker.PARCA_MANIFEST).write_text(
					'{"complete": true, "cache_key": "cache-key"}'
				)
				self.assertTrue(sim_worker._parca_cached('parca_cache_test'))
				(kb_path / sim_worker.PARCA_EXPECTED_FILES[-1]).unlink()
				self.assertFalse(sim_worker._parca_cached('parca_cache_test'))
			finally:
				sim_worker.settings.sim_output_dir = original_sim_output_dir

	def test_job_queue_accepts_explicit_seed_values(self):
		with TemporaryDirectory() as tmpdir:
			engine = self._runtime_test_engine(tmpdir)
			with Session(engine) as session:
				experiment = Experiment(
					name='seed-values',
					variant_type='wildtype',
					variant_index=0,
					condition='basal',
					sim_params='{}',
					status='draft',
				)
				session.add(experiment)
				session.flush()

				response = create_simulation_jobs_for_experiment(
					experiment,
					RunJobRequest(seed_values=[3, 5], generations=2),
					session,
				)
				jobs = session.exec(
					select(SimulationJob).where(SimulationJob.experiment_id == experiment.id)
				).all()

			self.assertEqual(2, len(response.job_ids))
			self.assertEqual([3, 5], [job.seed for job in jobs])
			self.assertEqual([2, 2], [job.generations for job in jobs])

	def test_job_queue_seed_count_is_count_not_literal_seed(self):
		with TemporaryDirectory() as tmpdir:
			engine = self._runtime_test_engine(tmpdir)
			with Session(engine) as session:
				experiment = Experiment(
					name='seed-count',
					variant_type='wildtype',
					variant_index=0,
					condition='basal',
					sim_params='{}',
					status='draft',
				)
				session.add(experiment)
				session.flush()

				create_simulation_jobs_for_experiment(
					experiment,
					RunJobRequest(seed_count=3, generations=1),
					session,
				)
				jobs = session.exec(
					select(SimulationJob).where(SimulationJob.experiment_id == experiment.id)
				).all()

			self.assertEqual([0, 1, 2], [job.seed for job in jobs])

	def test_job_queue_keeps_legacy_seeds_list_behavior(self):
		with TemporaryDirectory() as tmpdir:
			engine = self._runtime_test_engine(tmpdir)
			with Session(engine) as session:
				experiment = Experiment(
					name='legacy-seeds',
					variant_type='wildtype',
					variant_index=0,
					condition='basal',
					sim_params='{}',
					status='draft',
				)
				session.add(experiment)
				session.flush()

				create_simulation_jobs_for_experiment(
					experiment,
					RunJobRequest(seeds=[7, 11], generations=1),
					session,
				)
				jobs = session.exec(
					select(SimulationJob).where(SimulationJob.experiment_id == experiment.id)
				).all()

			self.assertEqual([7, 11], [job.seed for job in jobs])

	def test_worker_atomically_claims_one_pending_job(self):
		with TemporaryDirectory() as tmpdir:
			engine = self._runtime_test_engine(tmpdir)
			with Session(engine) as session:
				experiment = Experiment(
					name='claim-test',
					variant_type='wildtype',
					variant_index=0,
					condition='basal',
					status='queued',
				)
				session.add(experiment)
				session.flush()
				job = SimulationJob(
					experiment_id=experiment.id,
					status='pending',
					phase='Queued',
					variant_type='wildtype',
					variant_index=0,
					condition='basal',
				)
				session.add(job)
				session.commit()
				job_id = job.id

			self.assertEqual(job_id, sim_worker.claim_next_pending_job(engine))
			self.assertIsNone(sim_worker.claim_next_pending_job(engine))

			with Session(engine) as session:
				claimed_job = session.get(SimulationJob, job_id)
				self.assertEqual('claimed', claimed_job.status)
				self.assertEqual('Claimed by worker', claimed_job.phase)
				self.assertTrue(claimed_job.worker_id)
				self.assertTrue(claimed_job.lease_expires_at)
				self.assertEqual(1, claimed_job.attempt)

	def test_stale_repair_preserves_job_with_live_lease(self):
		with TemporaryDirectory() as tmpdir:
			engine = self._runtime_test_engine(tmpdir)
			with Session(engine) as session:
				experiment = Experiment(name='live', variant_type='wildtype', status='running')
				session.add(experiment)
				session.flush()
				job = SimulationJob(
					experiment_id=experiment.id,
					status='running_sim',
					worker_id='worker-a',
					lease_expires_at=(datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat(),
				)
				session.add(job)
				session.commit()
				job_id = job.id

			sim_worker._repair_stale_statuses(engine)

			with Session(engine) as session:
				self.assertEqual('running_sim', session.get(SimulationJob, job_id).status)

	def test_stale_repair_requeues_only_expired_job(self):
		with TemporaryDirectory() as tmpdir:
			engine = self._runtime_test_engine(tmpdir)
			with Session(engine) as session:
				experiment = Experiment(name='expired', variant_type='wildtype', status='running')
				session.add(experiment)
				session.flush()
				job = SimulationJob(
					experiment_id=experiment.id,
					status='running_sim',
					worker_id='dead-worker',
					lease_expires_at=(datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat(),
				)
				session.add(job)
				session.commit()
				job_id = job.id

			sim_worker._repair_stale_statuses(engine)

			with Session(engine) as session:
				repaired = session.get(SimulationJob, job_id)
				self.assertEqual('pending', repaired.status)
				self.assertEqual('', repaired.worker_id)
				self.assertEqual('', repaired.lease_expires_at)

	def test_stale_recovery_retains_task_id_until_runner_confirms_stop(self):
		with TemporaryDirectory() as tmpdir:
			engine = self._runtime_test_engine(tmpdir)
			with Session(engine) as session:
				experiment = Experiment(name='stale-task', variant_type='wildtype', status='running')
				session.add(experiment)
				session.flush()
				job = SimulationJob(
					experiment_id=experiment.id, status='running_sim', worker_id='dead-worker',
					attempt=4, runner_task_id='still-running',
					lease_expires_at=(datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat(),
				)
				session.add(job)
				session.commit()
				job_id = job.id

			with patch.object(sim_worker, '_confirm_runner_task_stopped', return_value=False):
				sim_worker._repair_stale_statuses(engine)
			with Session(engine) as session:
				recovering = session.get(SimulationJob, job_id)
				self.assertEqual('recovering', recovering.status)
				self.assertEqual('still-running', recovering.runner_task_id)
				self.assertEqual('dead-worker', recovering.worker_id)

			with patch.object(sim_worker, '_confirm_runner_task_stopped', return_value=True):
				sim_worker._repair_stale_statuses(engine)
			with Session(engine) as session:
				requeued = session.get(SimulationJob, job_id)
				self.assertEqual('pending', requeued.status)
				self.assertEqual('', requeued.runner_task_id)
				self.assertEqual('', requeued.worker_id)


if __name__ == '__main__':
	unittest.main()
