"""Build-independent AMD64 smoke on a temporary isolated port; no scientific work."""

import hashlib
import json
from pathlib import Path
import subprocess
import time
import urllib.request

import h5py
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
STATE = ROOT / "interface/.explorer"
NAME = "wcecoli-explorer-amd64-smoke"


def docker(*args, check=True):
    return subprocess.run(["docker", *args], check=check, capture_output=True, text=True)


def main():
    receipt = json.loads((STATE / "current.json").read_text())
    release = ROOT / receipt["bundle"] / "dataset/release"
    image = receipt["image"] + "-amd64"
    metadata = json.loads(docker("image", "inspect", image).stdout)[0]
    assert metadata["Architecture"] == "amd64"
    assert not json.loads(docker("ps", "-a", "--filter", "name=^/" + NAME + "$", "--format", "json").stdout or "null")
    began = time.monotonic()
    docker("run", "-d", "--name", NAME, "--platform", "linux/amd64", "--memory", "512m", "--cpus", "2",
           "--read-only", "--tmpfs", "/tmp:rw,nosuid,size=64m,mode=1777", "--cap-drop", "ALL",
           "--security-opt", "no-new-privileges:true", "-p", "127.0.0.1:17860:7860",
           "--mount", "type=bind,source=" + str(release) + ",target=/published,readonly",
           "-e", "EXPLORER_DATA_MODE=local", "-e", "EXPLORER_RELEASE=/published", image)
    try:
        def get(path):
            with urllib.request.urlopen("http://127.0.0.1:17860" + path, timeout=15) as response:
                return response.read()

        while True:
            try:
                assert json.loads(get("/api/health"))["scope"] == "full"
                break
            except OSError:
                if time.monotonic() - began > 1800:
                    raise AssertionError("AMD64 startup exceeded 30 minutes")
                state = json.loads(docker("inspect", NAME).stdout)[0]["State"]
                assert state["Running"], docker("logs", "--tail", "30", NAME).stdout
                time.sleep(2)
        cold = time.monotonic() - began
        assert b"<html" in get("/results/1")
        capabilities = json.loads(get("/api/capabilities"))
        assert capabilities["mode"] == "explorer" and not capabilities["execution"]
        manifest = json.loads((release / "manifest.json").read_text())
        wt = next(e for e in manifest["experiments"] if e["key"] == "wt-basal")
        series = json.loads(get(f"/api/jobs/{wt['job_id']}/timeseries"))["timeseries"]["cell_mass"]
        with h5py.File(release / wt["shard"], "r") as h5:
            for row in series:
                group = h5[f"seed=0/gen={row['generation']}/cell_mass"]
                np.testing.assert_array_equal([p["time"] for p in row["points"]], group["time"][:])
                np.testing.assert_array_equal([p["value"] for p in row["points"]], group["value"][:])
        metrics = json.loads(docker("exec", NAME, "python", "-c",
            "import json;from pathlib import Path;print(json.dumps({k:Path('/sys/fs/cgroup/'+k).read_text().strip() for k in ['memory.current','memory.peak','memory.max','memory.events']}))").stdout)
        events = dict(line.split() for line in metrics["memory.events"].splitlines())
        assert events["oom"] == "0" and events["oom_kill"] == "0"
        docker("stop", "--time", "25", NAME)
        stopped = json.loads(docker("inspect", NAME).stdout)[0]["State"]
        assert stopped["ExitCode"] == 0 and not stopped["OOMKilled"]
        report = dict(passed=True, image=image, image_id=metadata["Id"], image_bytes=metadata["Size"],
                      architecture="amd64", execution="emulated on ARM64 Docker Desktop; not hosted performance",
                      cold_start_seconds=cold, real_mass_generations=len(series), memory=metrics,
                      manifest_sha256=hashlib.sha256((release / "manifest.json").read_bytes()).hexdigest(),
                      graceful_exit=stopped["ExitCode"])
        (STATE / "proofs/amd64-runtime.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report))
    finally:
        docker("stop", "--time", "25", NAME, check=False)
        docker("rm", NAME, check=False)


if __name__ == "__main__":
    main()
