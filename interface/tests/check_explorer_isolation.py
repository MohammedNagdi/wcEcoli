"""Read-only Docker/platform/preparation acceptance for the public explorer."""

import hashlib
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[2]
STATE = ROOT / "interface/.pilot"
PROOF = STATE / "proofs/hf06"


def docker(*args, stdin=None):
    return subprocess.run(
        ["docker", *args], input=stdin, check=True, text=True, stdout=subprocess.PIPE
    ).stdout


def main():
    baseline = json.loads((STATE / "proofs/hf05/main-baseline.json").read_text())
    actual = []
    for container in baseline["containers"]:
        raw = json.loads(docker("inspect", container["name"]))[0]
        current = dict(
            name=raw["Name"],
            id=raw["Id"],
            image=raw["Image"],
            mounts=sorted(
                [
                    dict(name=m.get("Name"), destination=m["Destination"])
                    for m in raw["Mounts"]
                ],
                key=lambda x: x["destination"],
            ),
        )
        expected = dict(
            container,
            mounts=sorted(container["mounts"], key=lambda x: x["destination"]),
        )
        assert current == expected, container["name"]
        actual.append(current)
    program = """import sqlite3,json,hashlib
with sqlite3.connect("file:/app/data/wcecoli.db?mode=ro",uri=True) as db:
 rows={t:db.execute("SELECT * FROM "+t+" ORDER BY id").fetchall() for t in ['experiments','simulation_jobs','simulation_results']}
 print(json.dumps(dict(counts={t:len(v) for t,v in rows.items()},data_sha256=hashlib.sha256(json.dumps(rows,sort_keys=True).encode()).hexdigest())))
"""
    database = json.loads(
        docker("exec", "-i", "interface-api-1", "python", "-", stdin=program)
    )
    assert database == baseline["database"]
    image = docker(
        "image", "inspect", "wcecoli-sim:latest", "--format", "{{.Id}}"
    ).strip()
    assert image == baseline["simulation_image"]
    readiness = json.loads(
        docker(
            "exec",
            "wcecoli-hf-demo-v1-tools-1",
            "python",
            "-m",
            "hf_export.pilot_inside",
            "verify",
        )
    )
    assert (
        readiness["ready"]
        and readiness["receipt_sha256"]
        == json.loads((STATE / "readiness.json").read_text())["receipt_sha256"]
    )
    storage = json.loads(
        docker(
            "exec",
            "wcecoli-hf-demo-v1-tools-1",
            "python",
            "-c",
            "import json,shutil;from pathlib import Path;from hf_export.demo_inside import status;"
            'print(json.dumps(dict(status=status(),free_bytes=shutil.disk_usage("/wcEcoli/out").free,output_children=sorted(p.name for p in Path("/wcEcoli/out").iterdir()))))',
        )
    )
    jobs = storage["status"]["jobs"]
    assert len(jobs) == 12
    assert all(
        j["execution"] == "complete" and j["cleanup"]["state"] == "raw_removed"
        for j in jobs
    )
    raw = json.loads(docker("inspect", "wcecoli-hf-demo-v1-preview-api-1"))[0]
    assert (
        raw["HostConfig"]["ReadonlyRootfs"]
        and raw["HostConfig"]["Memory"] == 512 * 1024**2
    )
    assert all(not m["RW"] for m in raw["Mounts"] if m["Destination"] == "/release")
    memory = json.loads(
        docker(
            "exec",
            "wcecoli-hf-demo-v1-preview-api-1",
            "python",
            "-c",
            'import json;from pathlib import Path; print(json.dumps({k:Path("/sys/fs/cgroup/"+k).read_text().strip() for k in ["memory.current","memory.peak","memory.max","memory.events"]}))',
        )
    )
    assert int(memory["memory.peak"]) <= int(memory["memory.max"])
    events = dict(line.split() for line in memory["memory.events"].splitlines())
    assert events["oom"] == "0" and events["oom_kill"] == "0"
    report = dict(
        passed=True,
        containers=actual,
        database=database,
        simulation_image=image,
        readiness=readiness,
        memory=memory,
        host_free_bytes=shutil.disk_usage(ROOT).free,
        docker_storage=storage,
        original_manifest_sha256=hashlib.sha256(
            (STATE / "demo-release/manifest.json").read_bytes()
        ).hexdigest(),
    )
    assert (
        report["original_manifest_sha256"]
        == json.loads((PROOF / "rollback.json").read_text())["manifest_sha256"]
    )
    (PROOF / "isolation-resources.json").write_text(json.dumps(report, indent=2) + "\n")
    print(
        json.dumps(
            dict(
                passed=True,
                database=database,
                memory=memory,
                host_free_bytes=report["host_free_bytes"],
                raw_removed=len(jobs),
            )
        )
    )


if __name__ == "__main__":
    main()
