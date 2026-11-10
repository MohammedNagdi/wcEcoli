"""Bound a pilot subprocess independently of the host controller (Python 3.10)."""

import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--seconds", type=int, required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if args.seconds <= 0 or not command:
        parser.error("a positive deadline and command are required")
    started = time.time()
    peak_rss = 0
    error = ""
    child = subprocess.Popen(command, start_new_session=True)
    stopped = False

    def stop(_signum=None, _frame=None):
        nonlocal stopped, error
        stopped = True
        error = error or "cancelled by operator/runner shutdown"
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    while child.poll() is None:
        # Include descendant RSS, not just the launcher process. This is an
        # observed maximum; the cgroup enforces the separate 4 GiB ceiling.
        rss = 0
        for path in Path("/proc").glob("[0-9]*/stat"):
            try:
                fields = path.read_text().rsplit(")", 1)[1].split()
                if int(fields[2]) == child.pid:  # process group
                    rss += int(fields[21]) * os.sysconf("SC_PAGE_SIZE")
            except (OSError, ValueError, IndexError):
                continue
        peak_rss = max(peak_rss, rss)
        if time.time() - started > args.seconds:
            error = "wall-time limit exceeded"
            stop()
        if shutil.disk_usage(args.receipt.parent).free < 15 * 1024**3:
            error = "Docker storage below 15 GiB stop threshold"
            stop()
        if stopped:
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
            break
        time.sleep(1)
    code = child.wait()
    record = dict(
        command=command,
        started_at=started,
        finished_at=time.time(),
        duration_sec=time.time() - started,
        peak_process_group_rss_bytes=peak_rss,
        returncode=code,
        infrastructure_error=error,
        classification="execution_error" if error or code else "completed",
    )
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    tmp = args.receipt.with_suffix(".tmp")
    tmp.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")
    tmp.replace(args.receipt)
    raise SystemExit(code if code > 0 else 1 if error or code else 0)


if __name__ == "__main__":
    main()
