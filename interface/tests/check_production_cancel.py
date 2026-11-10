"""Ensure SIGTERM interrupts production validation without Docker's forced kill."""

import json
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]
STATE = ROOT / "interface/.explorer"
NAME = "wcecoli-explorer-cancel-smoke"


def docker(*args, check=True):
    return subprocess.run(["docker", *args], text=True, capture_output=True, check=check)


def main():
    receipt = json.loads((STATE / "current.json").read_text())
    release = ROOT / receipt["bundle"] / "dataset/release"
    docker("run", "-d", "--name", NAME, "--memory", "512m", "--cpus", "2", "--read-only",
           "--tmpfs", "/tmp:rw,size=64m", "--mount", "type=bind,source=" + str(release) + ",target=/published,readonly",
           "-e", "EXPLORER_DATA_MODE=local", "-e", "EXPLORER_RELEASE=/published", receipt["image"])
    try:
        began = time.monotonic()
        while True:
            log = docker("logs", NAME)
            if "Waiting for application startup" in log.stdout + log.stderr:
                break
            assert time.monotonic() - began < 60
            time.sleep(0.2)
        began = time.monotonic()
        docker("stop", "--time", "25", NAME)
        elapsed = time.monotonic() - began
        state = json.loads(docker("inspect", NAME).stdout)[0]["State"]
        assert state["ExitCode"] != 137 and not state["OOMKilled"] and elapsed < 25
        report = dict(passed=True, image=receipt["image"], startup_cancel_seconds=elapsed,
                      exit_code=state["ExitCode"], forced_kill=False, oom=False,
                      interpretation="intentional cancellation before readiness, not an execution/data failure")
        (STATE / "proofs/startup-cancel.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report))
    finally:
        docker("stop", "--time", "25", NAME, check=False)
        docker("rm", NAME, check=False)


if __name__ == "__main__":
    main()
