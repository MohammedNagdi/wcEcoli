"""Compose parity and launcher contracts; never starts real containers.

Run from the repository root:
    python3 -m unittest discover -s interface/tests -p test_compose_launchers.py -v

Command routing uses a fake Docker executable. Real Compose, when installed,
is used only for `config`, which does not need a running Docker daemon.
"""

import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[2]
INTERPOLATED = set(re.findall(
    r"\$\{([A-Z_]+)", (ROOT / "interface/docker-compose.yml").read_text()
))
SCRIPTS = ("platform.sh", "interface/platform.sh", "interface/start-worker.sh")
FILES = (*SCRIPTS, "compose.yaml", "interface/docker-compose.yml",
         "interface/docker-compose.sim.yml", "interface/.env.example")
FAKE_DOCKER = '''#!/usr/bin/env python3
import json, os, pathlib, time
pathlib.Path(os.environ["FAKE_DOCKER_CAPTURE"]).write_text(json.dumps({
    "argv": __import__("sys").argv[1:], "pid": os.getpid(),
    "env": {key: os.environ.get(key) for key in (
        "SIM_RUNNER_CONCURRENCY", "SIM_RUNNER_CPU_BUDGET",
        "SIM_CPUS_PER_JOB", "PARCA_CPUS", "COMPOSE_PROJECT_NAME")},
}))
if os.environ.get("FAKE_DOCKER_WAIT"):
    while True: time.sleep(1)
raise SystemExit(int(os.environ.get("FAKE_DOCKER_EXIT", "0")))
'''


def clean_environment():
    env = os.environ.copy()
    for key in INTERPOLATED | {key for key in env if key.startswith("COMPOSE_")}:
        env.pop(key, None)
    env.pop("START_WORKER_DRY_RUN", None)
    return env


class CheckoutFixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="wcEcoli launcher with spaces ")
        self.addCleanup(self.tmp.cleanup)
        # macOS aliases /tmp to /private/tmp; compare canonical paths like Compose does.
        self.root = (Path(self.tmp.name) / "checkout with spaces").resolve()
        for name in FILES:
            dest = self.root / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / name, dest)
        self.capture = Path(self.tmp.name) / "docker.json"
        bin_dir = Path(self.tmp.name) / "bin"
        bin_dir.mkdir()
        docker = bin_dir / "docker"
        docker.write_text(FAKE_DOCKER)
        docker.chmod(0o755)
        self.env = clean_environment()
        self.env.update(PATH=str(bin_dir) + os.pathsep + self.env["PATH"],
                        FAKE_DOCKER_CAPTURE=str(self.capture))

    def run_script(self, script="platform.sh", args=("local", "ps"), cwd=None, **env):
        return subprocess.run(
            [str(self.root / script), *args], cwd=cwd or self.root,
            env={**self.env, **env}, capture_output=True, text=True, timeout=15,
        )

    def invocation(self):
        return json.loads(self.capture.read_text())

    def prefix(self, env_file=".env.example"):
        interface = self.root / "interface"
        return ["compose", "--project-directory", str(interface), "--file",
                str(interface / "docker-compose.yml"), "--env-file", str(interface / env_file)]

class LauncherContracts(CheckoutFixture):
    def test_both_launchers_from_root_interface_and_unrelated_cwd(self):
        for script in ("platform.sh", "interface/platform.sh"):
            for cwd in (self.root, self.root / "interface", Path(self.tmp.name)):
                with self.subTest(script=script, cwd=cwd):
                    result = self.run_script(script=script, cwd=cwd)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(self.invocation()["argv"], self.prefix() + ["ps"])

    def test_selects_env_without_sourcing_it_or_using_root_env(self):
        marker = self.root / "must-not-exist"
        (self.root / ".env").write_text("COMPOSE_FILE=wrong.yml\n")
        (self.root / "interface/.env").write_text(f"OPENAI_API_KEY=$(touch '{marker}')\n")
        result = self.run_script(COMPOSE_FILE="also-wrong.yml")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.invocation()["argv"], self.prefix(".env") + ["ps"])
        self.assertFalse(marker.exists())
        self.assertNotIn("OPENAI_API_KEY", result.stdout + result.stderr)

    def test_argument_boundaries_and_project_override(self):
        args = ("local", "-p", "custom-stack", "exec", "api", "printf", "%s", "a b;$literal")
        result = self.run_script(args=args, COMPOSE_PROJECT_NAME="shell-stack")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.invocation()["argv"], self.prefix() + list(args[1:]))
        self.assertEqual(self.invocation()["env"]["COMPOSE_PROJECT_NAME"], "shell-stack")

    def test_docker_exit_code_is_preserved(self):
        result = self.run_script(FAKE_DOCKER_EXIT="37")
        self.assertEqual(result.returncode, 37)

    def test_help_and_invalid_modes_never_call_docker(self):
        for args, code in [((), 2), (("local",), 2), (("unknown",), 2),
                           (("--help",), 0)]:
            with self.subTest(args=args):
                result = self.run_script(args=args)
                self.assertEqual(result.returncode, code)
                self.assertFalse(self.capture.exists())

    def test_exec_chain_preserves_pid_and_termination(self):
        proc = subprocess.Popen([str(self.root / "platform.sh"), "local", "ps"],
                                env={**self.env, "FAKE_DOCKER_WAIT": "1"},
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            deadline = time.monotonic() + 10
            while not self.capture.exists() and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue(self.capture.exists())
            self.assertEqual(self.invocation()["pid"], proc.pid)
            proc.terminate()
            self.assertEqual(proc.wait(timeout=5), -signal.SIGTERM)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()

    def test_worker_defaults_explicit_budget_and_capacity(self):
        cases = [([], {}, "1", "8", "1"),
                 (["4", "8"], {}, "4", "8", "4"),
                 (["6", "8"], {"SIM_CPUS_PER_JOB": "2"}, "6", "8", "4"),
                 (["4"], {"SIM_CPUS_PER_JOB": "3"}, "4", "12", "4"),
                 ([], {"SIM_RUNNER_CONCURRENCY": "2", "SIM_RUNNER_CPU_BUDGET": "10"},
                  "2", "10", "2")]
        for args, overrides, concurrency, budget, capacity in cases:
            with self.subTest(args=args, overrides=overrides):
                result = self.run_script("interface/start-worker.sh", args, **overrides)
                self.assertEqual(result.returncode, 0, result.stderr)
                call = self.invocation()
                self.assertEqual(call["argv"], self.prefix() +
                                 ["up", "-d", "--build", "sim-runner", "worker"])
                self.assertEqual(call["env"]["SIM_RUNNER_CONCURRENCY"], concurrency)
                self.assertEqual(call["env"]["SIM_RUNNER_CPU_BUDGET"], budget)
                self.assertIn("Effective simultaneous simulations: " + capacity, result.stdout)

    def test_worker_invalid_requests_and_dry_run_do_not_launch(self):
        for args, overrides, code in [(["0"], {}, 2), (["-1"], {}, 2),
                                      (["abc"], {}, 2), (["4", "0"], {}, 2),
                                      (["4", "4"], {}, 2),
                                      ([], {"SIM_CPUS_PER_JOB": "0"}, 2),
                                      ([], {"PARCA_CPUS": "bad"}, 2),
                                      (["4", "8"], {"START_WORKER_DRY_RUN": "1"}, 0)]:
            with self.subTest(args=args, overrides=overrides):
                result = self.run_script("interface/start-worker.sh", args, **overrides)
                self.assertEqual(result.returncode, code)
                self.assertFalse(self.capture.exists())


@unittest.skipUnless(shutil.which("docker"), "Docker CLI required for config-only checks")
class ComposeConfiguration(CheckoutFixture):
    """Real Compose parses a disposable checkout; no environment files are edited in-place."""

    def setUp(self):
        super().setUp()
        self.env = clean_environment()  # Real Docker, not the routing fake.
        self.expected = json.loads((ROOT / "interface/tests/fixtures/compose-local-baseline.json").read_text())

    def config(self, entry="root", options=(), **overrides):
        cwd = self.root / "interface" if entry == "interface" else self.root
        command = ["docker", "compose"]
        if entry == "launcher":
            command = [str(self.root / "platform.sh"), "local"]
        result = subprocess.run(command + list(options) + ["config", "--format", "json"], cwd=cwd,
                                env={**self.env, **overrides}, text=True,
                                capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout.replace(str(self.root), "${REPO_ROOT}"))

    # Only config tests belong here; don't inherit tests that require the fake CLI.
    def test_baseline_parity_from_both_directories_and_launcher(self):
        for entry in ("root", "interface", "launcher"):
            with self.subTest(entry=entry):
                self.assertEqual(self.config(entry), self.expected)

    def test_environment_loading_and_shell_precedence(self):
        (self.root / "interface/.env").write_text(
            "SIM_RUNNER_CONCURRENCY=3\nSIM_RUNNER_CPU_BUDGET=12\n"
            "OPENAI_API_KEY=dummy-test-only\n")
        for entry in ("root", "interface", "launcher"):
            with self.subTest(entry=entry):
                data = self.config(entry)
                self.assertEqual(data["services"]["worker"]["environment"]["SIM_RUNNER_CONCURRENCY"], "3")
                self.assertEqual(data["services"]["sim-runner"]["cpus"], 12)
                self.assertEqual(data["services"]["api"]["environment"]["OPENAI_API_KEY"], "dummy-test-only")
                data = self.config(entry, SIM_RUNNER_CONCURRENCY="5")
                self.assertEqual(data["services"]["worker"]["environment"]["SIM_RUNNER_CONCURRENCY"], "5")

    def test_launcher_ignores_conflicting_root_env_and_compose_file(self):
        (self.root / ".env").write_text("SIM_RUNNER_CONCURRENCY=99\nCOMPOSE_FILE=missing.yml\n")
        (self.root / "interface/.env").write_text("SIM_RUNNER_CONCURRENCY=3\n")
        data = self.config("launcher", COMPOSE_FILE="also-missing.yml")
        self.assertEqual(data["services"]["worker"]["environment"]["SIM_RUNNER_CONCURRENCY"], "3")

    def test_custom_project_names_and_legacy_image_helper(self):
        for entry in ("root", "interface", "launcher"):
            data = self.config(entry, COMPOSE_PROJECT_NAME="custom-stack")
            self.assertEqual(data["name"], "custom-stack")
            self.assertEqual(data["volumes"]["api-db"]["name"], "custom-stack_api-db")
            data = self.config(entry, options=("-p", "cli-stack"), COMPOSE_PROJECT_NAME="custom-stack")
            self.assertEqual(data["name"], "cli-stack")
        result = subprocess.run(
            ["docker", "compose", "-f", str(self.root / "interface/docker-compose.sim.yml"),
             "config", "--format", "json"], env=self.env, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        build = json.loads(result.stdout)["services"]["wcecoli-sim"]
        self.assertEqual(build["image"], "wcecoli-sim:latest")
        self.assertEqual(build["build"]["context"], str(self.root))


if __name__ == "__main__":
    unittest.main()
