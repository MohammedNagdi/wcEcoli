"""Client for the persistent wcEcoli simulation runner."""

from __future__ import annotations

import json
import socket
from pathlib import Path
from typing import Any


class RunnerError(RuntimeError):
	pass


class RunnerTaskNotFound(RunnerError):
	"""The runner is reachable, but no longer knows the requested task."""


class RunnerClient:
	def __init__(self, socket_path: Path, timeout: float = 10.0):
		self.socket_path = Path(socket_path)
		self.timeout = timeout

	def request(self, command: str, **payload: Any) -> dict[str, Any]:
		request = {"command": command, **payload}
		try:
			with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
				client.settimeout(self.timeout)
				client.connect(str(self.socket_path))
				client.sendall((json.dumps(request, sort_keys=True) + "\n").encode("utf-8"))
				response = b""
				while not response.endswith(b"\n"):
					chunk = client.recv(65536)
					if not chunk:
						break
					response += chunk
		except OSError as exc:
			raise RunnerError("simulation runner unavailable: {}".format(exc)) from exc

		if not response:
			raise RunnerError("simulation runner returned an empty response")
		try:
			decoded = json.loads(response.decode("utf-8"))
		except (UnicodeDecodeError, json.JSONDecodeError) as exc:
			raise RunnerError("simulation runner returned invalid JSON") from exc
		if not decoded.get("ok"):
			error = str(decoded.get("error", "runner request failed"))
			if decoded.get("error_type") == "KeyError" and "unknown task_id" in error:
				raise RunnerTaskNotFound(error)
			raise RunnerError(error)
		return decoded["result"]

	def health(self) -> dict[str, Any]:
		return self.request("health")

	def submit(
			self,
			task_id: str,
			kind: str,
			args: list[str],
		env: dict[str, str] | None = None,
		cpu_slots: int = 1,
		replace_terminal: bool = False,
	) -> dict[str, Any]:
		return self.request(
			"submit",
			task_id=task_id,
			kind=kind,
			args=args,
			env=env or {},
			cpu_slots=cpu_slots,
			replace_terminal=replace_terminal,
		)

	def status(self, task_id: str) -> dict[str, Any]:
		return self.request("status", task_id=task_id)

	def cancel(self, task_id: str) -> dict[str, Any]:
		return self.request("cancel", task_id=task_id)

	def forget(self, task_id: str) -> dict[str, Any]:
		return self.request("forget", task_id=task_id)
