"""Benchmark runner scheduling with short no-model smoke subprocesses."""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from tempfile import TemporaryDirectory

from runscripts.manual.simRunner import RunnerState


def run_benchmark(concurrency: int, tasks: int, duration: float) -> dict[str, float | int]:
	with TemporaryDirectory() as tmpdir:
		root = Path(tmpdir)
		state = RunnerState(
			root=root,
			output_root=root,
			concurrency=concurrency,
			cpu_budget=concurrency,
			shutdown_grace_sec=5,
		)
		state.start()
		started = time.monotonic()
		try:
			for index in range(tasks):
				state.submit({
					"task_id": "bench-{}-{}".format(concurrency, index),
					"kind": "smoke",
					"args": [
						sys.executable,
						"-c",
						"import time; time.sleep({})".format(duration),
					],
				})
			deadline = time.monotonic() + max(10, tasks * duration * 3)
			while time.monotonic() < deadline:
				statuses = [task.status for task in state.tasks.values()]
				if len(statuses) == tasks and all(status == "done" for status in statuses):
					break
				time.sleep(0.02)
			else:
				raise RuntimeError("runner smoke benchmark timed out")
			elapsed = time.monotonic() - started
		finally:
			state.stop()
	return {
		"concurrency": concurrency,
		"tasks": tasks,
		"task_seconds": duration,
		"elapsed_seconds": round(elapsed, 3),
		"tasks_per_second": round(tasks / elapsed, 3),
	}


def main():
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument("--max-concurrency", type=int, default=8)
	parser.add_argument("--tasks", type=int, default=8)
	parser.add_argument("--task-seconds", type=float, default=0.2)
	args = parser.parse_args()
	if args.max_concurrency < 1 or args.max_concurrency > 8:
		parser.error("--max-concurrency must be between 1 and 8 for development smoke tests")
	levels = [level for level in (1, 4, 8) if level <= args.max_concurrency]
	for level in levels:
		print(json.dumps(run_benchmark(level, args.tasks, args.task_seconds), sort_keys=True))


if __name__ == "__main__":
	main()
