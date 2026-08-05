"""Run multiple isolated wcEcoli commands inside one persistent container.

The runner exposes a small JSON-lines protocol over a Unix domain socket.  It
does not know about the platform database; the interface worker remains the
source of truth for job ownership and lifecycle state.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import socketserver
import subprocess
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


TASK_ID_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+$")
ENV_KEY_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
TERMINAL_STATES = {"done", "failed", "cancelled"}
ACTIVE_STATES = {"running", "cancelling"}


def _now() -> float:
	return time.time()


@dataclass
class RunnerTask:
	task_id: str
	kind: str
	args: list[str]
	env: dict[str, str]
	cpu_slots: int
	status: str = "queued"
	pid: int = 0
	returncode: int | None = None
	created_at: float = field(default_factory=_now)
	started_at: float = 0.0
	finished_at: float = 0.0
	cancel_requested_at: float = 0.0
	log_path: str = ""
	process: subprocess.Popen | None = field(default=None, repr=False)
	log_handle: Any = field(default=None, repr=False)

	def public(self) -> dict[str, Any]:
		return {
			"task_id": self.task_id,
			"kind": self.kind,
			"status": self.status,
			"pid": self.pid,
			"returncode": self.returncode,
			"created_at": self.created_at,
			"started_at": self.started_at,
			"finished_at": self.finished_at,
			"log_path": self.log_path,
			"cpu_slots": self.cpu_slots,
		}


class RunnerState:
	"""Thread-safe task registry and subprocess scheduler."""

	def __init__(
			self,
			root: Path,
			output_root: Path,
		concurrency: int,
		cpu_budget: int,
		simulation_cpu_slots: int = 1,
		parca_max_concurrency: int = 1,
			shutdown_grace_sec: int = 1800,
	):
		if concurrency < 1:
			raise ValueError("concurrency must be at least 1")
		if cpu_budget < 1:
			raise ValueError("cpu_budget must be at least 1")
		if parca_max_concurrency < 1:
			raise ValueError("parca_max_concurrency must be at least 1")
		if simulation_cpu_slots < 1:
			raise ValueError("simulation_cpu_slots must be at least 1")

		self.root = root
		self.output_root = output_root
		self.concurrency = concurrency
		self.cpu_budget = cpu_budget
		self.simulation_cpu_slots = simulation_cpu_slots
		self.parca_max_concurrency = parca_max_concurrency
		self.shutdown_grace_sec = shutdown_grace_sec
		self.tasks: dict[str, RunnerTask] = {}
		self.queue: deque[str] = deque()
		self.lock = threading.RLock()
		self.stopping = False
		self._thread: threading.Thread | None = None

		(self.output_root / ".runner" / "logs").mkdir(parents=True, exist_ok=True)

	def start(self):
		if self._thread and self._thread.is_alive():
			return
		self._thread = threading.Thread(target=self._supervise, name="sim-runner", daemon=True)
		self._thread.start()

	def submit(self, payload: dict[str, Any]) -> dict[str, Any]:
		task_id = str(payload.get("task_id", ""))
		if not TASK_ID_PATTERN.fullmatch(task_id):
			raise ValueError("task_id must contain only letters, numbers, '.', '_' or '-'")
		kind = str(payload.get("kind", "sim"))
		if kind not in {"sim", "parca", "smoke"}:
			raise ValueError("kind must be sim, parca, or smoke")
		args = payload.get("args")
		if not isinstance(args, list) or not args or not all(isinstance(arg, str) for arg in args):
			raise ValueError("args must be a non-empty list of strings")
		env = payload.get("env", {})
		if not isinstance(env, dict):
			raise ValueError("env must be an object")
		clean_env = {}
		for key, value in env.items():
			if not isinstance(key, str) or not ENV_KEY_PATTERN.fullmatch(key):
				raise ValueError("invalid environment variable name")
			clean_env[key] = str(value)
		cpu_slots = int(payload.get("cpu_slots", 1))
		if cpu_slots < 1 or cpu_slots > self.cpu_budget:
			raise ValueError("cpu_slots must be between 1 and the runner CPU budget")
		replace_terminal = bool(payload.get("replace_terminal", False))
		if replace_terminal and kind != "parca":
			raise ValueError("replace_terminal is only supported for Parca tasks")

		with self.lock:
			if self.stopping:
				raise RuntimeError("runner is shutting down")
			existing = self.tasks.get(task_id)
			if existing:
				if (
					existing.args != args
					or existing.kind != kind
					or existing.env != clean_env
					or existing.cpu_slots != cpu_slots
				):
					raise ValueError("task_id already exists with a different payload")
				if not (replace_terminal and existing.status in {"failed", "cancelled"}):
					return existing.public()
				self._remove_from_queue(task_id)
				if existing.log_handle:
					existing.log_handle.close()
					existing.log_handle = None
				del self.tasks[task_id]

			log_path = Path(".runner") / "logs" / (task_id + ".log")
			task = RunnerTask(
				task_id=task_id,
				kind=kind,
				args=args,
				env=clean_env,
				cpu_slots=cpu_slots,
				log_path=str(log_path),
			)
			self.tasks[task_id] = task
			self.queue.append(task_id)
			return task.public()

	def status(self, task_id: str) -> dict[str, Any]:
		with self.lock:
			task = self.tasks.get(task_id)
			if not task:
				raise KeyError("unknown task_id")
			return task.public()

	def health(self) -> dict[str, Any]:
		with self.lock:
			running = [task for task in self.tasks.values() if task.status in ACTIVE_STATES]
			scheduler_alive = bool(self._thread and self._thread.is_alive())
			return {
				"status": (
					"stopping" if self.stopping
					else "ok" if scheduler_alive
					else "unhealthy"
				),
				"scheduler_alive": scheduler_alive,
				"concurrency": self.concurrency,
				"cpu_budget": self.cpu_budget,
				"effective_simulation_capacity": min(
					self.concurrency,
					self.cpu_budget // self.simulation_cpu_slots,
				),
				"cpu_allocated": sum(task.cpu_slots for task in running),
				"running": len(running),
				"running_simulations": sum(task.kind != "parca" for task in running),
				"running_parca": sum(task.kind == "parca" for task in running),
				"queued": sum(task.status == "queued" for task in self.tasks.values()),
				"terminal_tasks": sum(
					task.status in TERMINAL_STATES for task in self.tasks.values()
				),
			}

	def _remove_from_queue(self, task_id: str):
		"""Remove every queued reference to a task ID while holding the lock."""
		self.queue = deque(item for item in self.queue if item != task_id)

	def cancel(self, task_id: str) -> dict[str, Any]:
		with self.lock:
			task = self.tasks.get(task_id)
			if not task:
				raise KeyError("unknown task_id")
			if task.status in TERMINAL_STATES:
				return task.public()
			if task.status == "queued":
				self._remove_from_queue(task_id)
				task.status = "cancelled"
				task.returncode = -signal.SIGTERM
				task.finished_at = _now()
				return task.public()
			process = task.process

		if process and process.poll() is None:
			try:
				os.killpg(process.pid, signal.SIGTERM)
			except ProcessLookupError:
				pass
		with self.lock:
			task.status = "cancelling"
			task.cancel_requested_at = _now()
		return task.public()

	def forget(self, task_id: str) -> dict[str, Any]:
		"""Release completed task metadata while retaining its log file."""
		with self.lock:
			task = self.tasks.get(task_id)
			if not task:
				return {"task_id": task_id, "forgotten": False}
			if task.status not in TERMINAL_STATES:
				raise RuntimeError("cannot forget an active task")
			self._remove_from_queue(task_id)
			del self.tasks[task_id]
			return {"task_id": task_id, "forgotten": True}

	def initiate_shutdown(self):
		with self.lock:
			self.stopping = True

	def stop(self):
		self.initiate_shutdown()
		deadline = time.monotonic() + self.shutdown_grace_sec
		while time.monotonic() < deadline:
			with self.lock:
				active = [task for task in self.tasks.values() if task.status in ACTIVE_STATES]
			if not active:
				break
			time.sleep(0.1)

		with self.lock:
			active = [task for task in self.tasks.values() if task.status in ACTIVE_STATES]
		for task in active:
			process = task.process
			if process and process.poll() is None:
				try:
					os.killpg(process.pid, signal.SIGKILL)
				except ProcessLookupError:
					pass
		if self._thread:
			self._thread.join(timeout=5)

	def _can_start(self, task: RunnerTask) -> bool:
		running = [item for item in self.tasks.values() if item.status in ACTIVE_STATES]
		allocated = sum(item.cpu_slots for item in running)
		if allocated + task.cpu_slots > self.cpu_budget:
			return False
		if task.kind == "parca":
			return sum(item.kind == "parca" for item in running) < self.parca_max_concurrency
		if not any(item.kind == "parca" for item in running):
			queued_parca_slots = [
				item.cpu_slots for item in self.tasks.values()
				if item.kind == "parca" and item.status == "queued"
			]
			if queued_parca_slots and allocated + task.cpu_slots + max(queued_parca_slots) > self.cpu_budget:
				return False
		return sum(item.kind != "parca" for item in running) < self.concurrency

	def _start_task(self, task: RunnerTask):
		log_path = self.output_root / task.log_path
		log_path.parent.mkdir(parents=True, exist_ok=True)
		log_handle = log_path.open("a", encoding="utf-8", buffering=1)
		env = os.environ.copy()
		env.update({
			"PYTHONPATH": str(self.root),
			"OPENBLAS_NUM_THREADS": "1",
			"OMP_NUM_THREADS": "1",
			"MKL_NUM_THREADS": "1",
		})
		env.update(task.env)
		try:
			process = subprocess.Popen(
				task.args,
				cwd=self.root,
				env=env,
				stdout=log_handle,
				stderr=subprocess.STDOUT,
				text=True,
				start_new_session=True,
			)
		except Exception:
			log_handle.close()
			raise
		task.process = process
		task.log_handle = log_handle
		task.pid = process.pid
		task.status = "running"
		task.started_at = _now()

	def _finish_task(self, task: RunnerTask, returncode: int):
		task.returncode = returncode
		task.finished_at = _now()
		if task.status == "cancelling":
			task.status = "cancelled"
		else:
			task.status = "done" if returncode == 0 else "failed"
		if task.log_handle:
			task.log_handle.close()
			task.log_handle = None

	def _supervise(self):
		while True:
			with self.lock:
				for task in self.tasks.values():
					if task.status not in ACTIVE_STATES or not task.process:
						continue
					returncode = task.process.poll()
					if returncode is not None:
						self._finish_task(task, returncode)
					elif task.status == "cancelling" and _now() - task.cancel_requested_at >= 10:
						try:
							os.killpg(task.process.pid, signal.SIGKILL)
						except ProcessLookupError:
							pass

				if not self.stopping:
					for _ in range(len(self.queue)):
						task_id = self.queue.popleft()
						task = self.tasks.get(task_id)
						if task is None:
							continue
						if task.status != "queued":
							continue
						if not self._can_start(task):
							self.queue.append(task_id)
							continue
						try:
							self._start_task(task)
						except Exception as exc:
							task.status = "failed"
							task.returncode = 1
							task.finished_at = _now()
							log_path = self.output_root / task.log_path
							with log_path.open("a", encoding="utf-8") as log:
								log.write("Runner failed to start task: {}\n".format(exc))

				active = any(task.status in ACTIVE_STATES for task in self.tasks.values())
				if self.stopping and not active:
					return
			time.sleep(0.1)


class RunnerRequestHandler(socketserver.StreamRequestHandler):
	def handle(self):
		line = self.rfile.readline()
		try:
			request = json.loads(line.decode("utf-8"))
			response = self.server.dispatch(request)
		except Exception as exc:
			response = {
				"ok": False,
				"error": str(exc),
				"error_type": type(exc).__name__,
			}
		self.wfile.write((json.dumps(response, sort_keys=True) + "\n").encode("utf-8"))


class RunnerServer(socketserver.ThreadingUnixStreamServer):
	daemon_threads = True

	def __init__(self, socket_path: Path, state: RunnerState):
		self.socket_path = socket_path
		self.state = state
		socket_path.parent.mkdir(parents=True, exist_ok=True)
		if socket_path.exists() or socket_path.is_socket():
			socket_path.unlink()
		super().__init__(str(socket_path), RunnerRequestHandler)

	def dispatch(self, request: dict[str, Any]) -> dict[str, Any]:
		command = request.get("command")
		if command == "health":
			result = self.state.health()
		elif command == "submit":
			result = self.state.submit(request)
		elif command == "status":
			result = self.state.status(str(request.get("task_id", "")))
		elif command == "cancel":
			result = self.state.cancel(str(request.get("task_id", "")))
		elif command == "forget":
			result = self.state.forget(str(request.get("task_id", "")))
		elif command == "shutdown":
			self.state.initiate_shutdown()
			result = {"status": "stopping"}
		else:
			raise ValueError("unknown runner command")
		return {"ok": True, "result": result}

	def server_close(self):
		super().server_close()
		try:
			self.socket_path.unlink()
		except FileNotFoundError:
			pass


def _positive_int(value: str) -> int:
	parsed = int(value)
	if parsed < 1:
		raise argparse.ArgumentTypeError("must be at least 1")
	return parsed


def parse_args():
	root = Path(__file__).resolve().parents[2]
	parser = argparse.ArgumentParser(description="Persistent wcEcoli simulation process runner")
	parser.add_argument("--root", type=Path, default=root)
	parser.add_argument("--output-root", type=Path, default=root / "out")
	parser.add_argument(
		"--socket",
		type=Path,
		default=Path(os.environ.get("SIM_RUNNER_SOCKET", root / "out" / ".runner" / "control.sock")),
	)
	parser.add_argument(
		"--concurrency",
		type=_positive_int,
		default=int(os.environ.get("SIM_RUNNER_CONCURRENCY", "1")),
	)
	parser.add_argument(
		"--cpu-budget",
		type=_positive_int,
		default=int(os.environ.get("SIM_RUNNER_CPU_BUDGET", "8")),
	)
	parser.add_argument(
		"--parca-max-concurrency",
		type=_positive_int,
		default=int(os.environ.get("PARCA_MAX_CONCURRENCY", "1")),
	)
	parser.add_argument(
		"--simulation-cpu-slots",
		type=_positive_int,
		default=int(os.environ.get("SIM_CPUS_PER_JOB", "1")),
	)
	parser.add_argument(
		"--shutdown-grace-sec",
		type=_positive_int,
		default=int(os.environ.get("WORKER_SHUTDOWN_GRACE_SEC", "1800")),
	)
	return parser.parse_args()


def main():
	args = parse_args()
	state = RunnerState(
		root=args.root,
		output_root=args.output_root,
		concurrency=args.concurrency,
		cpu_budget=args.cpu_budget,
		simulation_cpu_slots=args.simulation_cpu_slots,
		parca_max_concurrency=args.parca_max_concurrency,
		shutdown_grace_sec=args.shutdown_grace_sec,
	)
	state.start()
	server = RunnerServer(args.socket, state)
	stop_event = threading.Event()

	def stop_handler(_signum, _frame):
		state.initiate_shutdown()
		stop_event.set()

	signal.signal(signal.SIGTERM, stop_handler)
	signal.signal(signal.SIGINT, stop_handler)
	server.timeout = 0.5
	print(
		"Simulation runner listening on {} (concurrency={}, cpu_budget={})".format(
			args.socket, args.concurrency, args.cpu_budget),
		flush=True,
	)
	try:
		while not stop_event.is_set() and not state.stopping:
			server.handle_request()
	finally:
		server.server_close()
		state.stop()


if __name__ == "__main__":
	main()
