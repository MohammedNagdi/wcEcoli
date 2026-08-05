"""Smoke and scheduling tests for the persistent simulation runner."""

from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from interface.backend.app.services.sim_runner_client import RunnerClient, RunnerTaskNotFound
from runscripts.manual.simRunner import RunnerServer, RunnerState


TERMINAL = {"done", "failed", "cancelled"}


def wait_for(state: RunnerState, task_ids: list[str], timeout: float = 5.0):
	deadline = time.monotonic() + timeout
	while time.monotonic() < deadline:
		statuses = [state.status(task_id)["status"] for task_id in task_ids]
		if all(status in TERMINAL for status in statuses):
			return statuses
		time.sleep(0.02)
	raise AssertionError("runner tasks did not finish before timeout")


class SimulationRunnerTest(unittest.TestCase):
	def make_state(self, root: Path, concurrency: int, cpu_budget: int) -> RunnerState:
		state = RunnerState(
			root=root,
			output_root=root,
			concurrency=concurrency,
			cpu_budget=cpu_budget,
			shutdown_grace_sec=1,
		)
		state.start()
		self.addCleanup(state.stop)
		return state

	def test_duplicate_task_id_is_idempotent(self):
		with TemporaryDirectory() as tmpdir:
			state = self.make_state(Path(tmpdir), 1, 1)
			payload = {
				"task_id": "same-task",
				"kind": "smoke",
				"args": [sys.executable, "-c", "pass"],
				"cpu_slots": 1,
			}
			first = state.submit(payload)
			second = state.submit(payload)
			self.assertEqual(first["task_id"], second["task_id"])
			self.assertEqual(["done"], wait_for(state, ["same-task"]))
			self.assertTrue(state.forget("same-task")["forgotten"])
			self.assertNotIn("same-task", state.tasks)

	def test_launcher_reports_capacity_for_one_four_and_eight(self):
		repo_root = Path(__file__).resolve().parents[2]
		env = os.environ.copy()
		env.update({
			"START_WORKER_DRY_RUN": "1",
			"SIM_CPUS_PER_JOB": "1",
			"PARCA_CPUS": "8",
		})
		env.pop("SIM_RUNNER_CPU_BUDGET", None)
		for concurrency in (1, 4, 8):
			completed = subprocess.run(
				[repo_root / "interface" / "start-worker.sh", str(concurrency)],
				cwd=repo_root,
				env=env,
				text=True,
				capture_output=True,
				check=True,
			)
			self.assertIn(
				"Effective simultaneous simulations: {}".format(concurrency),
				completed.stdout,
			)

	def test_duplicate_task_id_rejects_different_cpu_slots(self):
		with TemporaryDirectory() as tmpdir:
			state = self.make_state(Path(tmpdir), 2, 2)
			payload = {
				"task_id": "cpu-mismatch",
				"kind": "smoke",
				"args": [sys.executable, "-c", "pass"],
				"cpu_slots": 1,
			}
			state.submit(payload)
			with self.assertRaisesRegex(ValueError, "different payload"):
				state.submit({**payload, "cpu_slots": 2})

	def test_cancel_and_forget_queued_task_removes_queue_reference(self):
		with TemporaryDirectory() as tmpdir:
			state = self.make_state(Path(tmpdir), 1, 1)
			state.submit({
				"task_id": "blocker",
				"kind": "smoke",
				"args": [sys.executable, "-c", "import time; time.sleep(0.2)"],
			})
			state.submit({
				"task_id": "queued-cancel",
				"kind": "smoke",
				"args": [sys.executable, "-c", "pass"],
			})
			state.cancel("queued-cancel")
			state.forget("queued-cancel")
			self.assertNotIn("queued-cancel", state.queue)
			self.assertEqual(["done"], wait_for(state, ["blocker"]))
			self.assertTrue(state.health()["scheduler_alive"])

	def test_health_reports_scheduler_thread_failure(self):
		with TemporaryDirectory() as tmpdir:
			state = RunnerState(Path(tmpdir), Path(tmpdir), 1, 1)
			self.assertEqual("unhealthy", state.health()["status"])
			self.assertFalse(state.health()["scheduler_alive"])

	def test_health_reports_effective_cpu_limited_capacity(self):
		with TemporaryDirectory() as tmpdir:
			state = RunnerState(
				Path(tmpdir), Path(tmpdir), concurrency=8, cpu_budget=8,
				simulation_cpu_slots=2,
			)
			self.assertEqual(4, state.health()["effective_simulation_capacity"])

	def test_failed_parca_can_be_atomically_replaced(self):
		with TemporaryDirectory() as tmpdir:
			state = self.make_state(Path(tmpdir), 1, 1)
			transient_command = (
				"from pathlib import Path; p=Path('parca-ready'); "
				"existed=p.exists(); p.touch(); raise SystemExit(0 if existed else 1)"
			)
			payload = {
				"task_id": "parca-retry",
				"kind": "parca",
				"args": [sys.executable, "-c", transient_command],
				"cpu_slots": 1,
			}
			state.submit(payload)
			self.assertEqual(["failed"], wait_for(state, ["parca-retry"]))
			different_payload = {**payload, "args": [sys.executable, "-c", "pass"]}
			with self.assertRaisesRegex(ValueError, "different payload"):
				state.submit({**different_payload, "replace_terminal": True})

			replacement = state.submit({**payload, "replace_terminal": True})
			self.assertEqual("queued", replacement["status"])
			attached = state.submit({**payload, "replace_terminal": True})
			self.assertEqual(replacement["created_at"], attached["created_at"])
			self.assertEqual(["done"], wait_for(state, ["parca-retry"]))

	def test_concurrent_parca_retry_requests_create_one_replacement(self):
		with TemporaryDirectory() as tmpdir:
			state = self.make_state(Path(tmpdir), 1, 1)
			payload = {
				"task_id": "shared-parca-retry",
				"kind": "parca",
				"args": [sys.executable, "-c", "raise SystemExit(1)"],
				"cpu_slots": 1,
			}
			state.submit(payload)
			self.assertEqual(["failed"], wait_for(state, [payload["task_id"]]))
			barrier = threading.Barrier(5)
			created_at = []

			def replace():
				barrier.wait()
				created_at.append(state.submit({**payload, "replace_terminal": True})["created_at"])

			threads = [threading.Thread(target=replace) for _ in range(5)]
			for thread in threads:
				thread.start()
			for thread in threads:
				thread.join()
			self.assertEqual(1, len(set(created_at)))

	def test_unix_socket_protocol_runs_smoke_task(self):
		with TemporaryDirectory() as tmpdir:
			root = Path(tmpdir)
			state = self.make_state(root, 1, 1)
			server = RunnerServer(root / "control.sock", state)
			thread = threading.Thread(target=server.serve_forever, daemon=True)
			thread.start()
			try:
				client = RunnerClient(root / "control.sock")
				self.assertEqual("ok", client.health()["status"])
				with self.assertRaises(RunnerTaskNotFound):
					client.status("missing-task")
				client.submit(
					"socket-smoke",
					"smoke",
					[sys.executable, "-c", "pass"],
				)
				deadline = time.monotonic() + 5
				status = client.status("socket-smoke")
				while status["status"] not in TERMINAL and time.monotonic() < deadline:
					time.sleep(0.02)
					status = client.status("socket-smoke")
				self.assertEqual("done", status["status"])
			finally:
				server.shutdown()
				server.server_close()
				thread.join(timeout=2)

	def test_parca_reserves_cpu_budget(self):
		with TemporaryDirectory() as tmpdir:
			state = self.make_state(Path(tmpdir), 8, 8)
			state.submit({
				"task_id": "parca",
				"kind": "parca",
				"args": [sys.executable, "-c", "import time; time.sleep(0.2)"],
				"cpu_slots": 8,
			})
			state.submit({
				"task_id": "sim",
				"kind": "smoke",
				"args": [sys.executable, "-c", "pass"],
				"cpu_slots": 1,
			})
			deadline = time.monotonic() + 1
			health = state.health()
			while health["running_parca"] != 1 and time.monotonic() < deadline:
				time.sleep(0.01)
				health = state.health()
			self.assertEqual(1, health["running_parca"])
			self.assertEqual(0, health["running_simulations"])
			self.assertEqual(8, health["cpu_allocated"])
			self.assertEqual(["done", "done"], wait_for(state, ["parca", "sim"]))

	def test_one_failure_does_not_stop_sibling(self):
		with TemporaryDirectory() as tmpdir:
			state = self.make_state(Path(tmpdir), 2, 2)
			state.submit({
				"task_id": "failure",
				"kind": "smoke",
				"args": [sys.executable, "-c", "raise SystemExit(3)"],
			})
			state.submit({
				"task_id": "success",
				"kind": "smoke",
				"args": [sys.executable, "-c", "pass"],
			})
			self.assertEqual(["failed", "done"], wait_for(state, ["failure", "success"]))

	def test_cancel_only_stops_selected_task(self):
		with TemporaryDirectory() as tmpdir:
			state = self.make_state(Path(tmpdir), 2, 2)
			for task_id in ("cancel-me", "keep-me"):
				state.submit({
					"task_id": task_id,
					"kind": "smoke",
					"args": [sys.executable, "-c", "import time; time.sleep(0.3)"],
				})
			time.sleep(0.08)
			state.cancel("cancel-me")
			self.assertEqual(["cancelled", "done"], wait_for(state, ["cancel-me", "keep-me"]))

	def test_eight_process_smoke_benchmark(self):
		with TemporaryDirectory() as tmpdir:
			state = self.make_state(Path(tmpdir), 8, 8)
			started = time.monotonic()
			task_ids = []
			for index in range(8):
				task_id = "bench-{}".format(index)
				task_ids.append(task_id)
				state.submit({
					"task_id": task_id,
					"kind": "smoke",
					"args": [sys.executable, "-c", "import time; time.sleep(0.15)"],
				})
			self.assertEqual(["done"] * 8, wait_for(state, task_ids))
			elapsed = time.monotonic() - started
			self.assertLess(elapsed, 0.8)


if __name__ == "__main__":
	unittest.main()
