"""Real reference, metrics, isolation and concurrent-read acceptance."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from functools import partial
import hashlib
import json
from pathlib import Path
import sqlite3
import urllib.request

import h5py
import numpy as np

ROOT = Path(__file__).resolve().parents[1] / ".pilot"
RELEASE = ROOT / "explorer-release"
PROOF = ROOT / "proofs/hf06"
API = "http://127.0.0.1:8001"


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def inventory(release):
    return {
        str(p.relative_to(release)): digest(p)
        for p in release.rglob("*")
        if p.is_file()
    }


def get_json(api, path):
    with urllib.request.urlopen(api + "/api" + path, timeout=60) as response:
        return json.load(response)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api", default=API)
    parser.add_argument("--release", type=Path, default=RELEASE)
    parser.add_argument("--out", type=Path, default=PROOF / "api-acceptance.json")
    args = parser.parse_args()
    release = args.release.resolve()
    get = partial(get_json, args.api.rstrip("/"))
    before = inventory(release)
    manifest = json.loads((release / "manifest.json").read_text())
    cap = get("/capabilities")
    assert (
        cap["mode"] == "explorer"
        and cap["references_available"]
        and not any(
            cap[k] for k in ("execution", "shared_persistence", "assistant", "training")
        )
    )
    for path in [
        "/genes?page_size=5000",
        "/genes/categories",
        "/genes/hisG",
        "/tf-network",
        "/tf-network/crp",
        "/pathways/amino-acids",
        "/conditions",
        "/condition-catalog",
        "/variants",
        "/timelines",
        "/media-recipes",
        "/experiments",
        "/jobs",
    ]:
        assert get(path)
    comparisons = 0
    for exp in manifest["experiments"]:
        with h5py.File(release / exp["shard"], "r") as h5:
            for t in exp["trajectories"]:
                actual = get(
                    f"/explorer/comparison?ids={exp['experiment_id']}&generation={t['generation']}"
                )["experiments"][0]["metrics"]
                assert (
                    actual["available"]
                    and actual["independent_seeds"] == 1
                    and actual["uncertainty"] is None
                )
                for channel, key in [
                    ("cell_mass", "final_saved_mass_fg"),
                    ("growth_rate", "final_saved_growth_rate_per_sec"),
                ]:
                    expected = float(h5[t["h5_group"] + "/" + channel + "/value"][-1])
                    assert actual[key] == (expected if np.isfinite(expected) else None)
                    comparisons += 1
                if t["outcome"] != "completed":
                    assert actual["division_duration_sec"] is None
        if exp["key"] == "hisG-basal":
            absent = get(
                f"/explorer/comparison?ids={exp['experiment_id']}&generation=3"
            )["experiments"][0]["metrics"]
            assert not absent["available"]
        symbol = next(
            s["gene"]
            for s in manifest["campaign"]["experiments"]
            if s["key"] == exp["key"]
        )
        if symbol:
            state = get(f"/jobs/{exp['job_id']}/state-explorer?gene={symbol}")
            stoich = get(
                f"/jobs/{exp['job_id']}/stoichiometry-neighborhood?gene={symbol}"
            )
            assert (
                state["generation"] == 0
                and state["focus_gene"] == symbol
                and stoich["focus_gene"] == symbol
            )
    routes = [
        "/capabilities",
        "/genes?page_size=5000",
        "/condition-catalog",
        "/jobs/1/timeseries",
        "/explorer/comparison?ids=1,2,3&generation=0",
        "/jobs/2/state-explorer?gene=hisG",
    ] * 3
    with ThreadPoolExecutor(max_workers=8) as pool:
        assert all(pool.map(get, routes))
    for path in [
        "/assistant/status",
        "/providers",
        "/train",
        "/debug",
        "/admin",
        "/openapi.json",
    ]:
        try:
            get(path)
        except urllib.error.HTTPError as error:
            assert error.code == 404
        else:
            raise AssertionError(path)
    for method, path in [
        ("POST", "/experiments"),
        ("POST", "/jobs/1/launch"),
        ("PUT", "/conditions/1"),
        ("PATCH", "/timelines/1"),
        ("DELETE", "/builder-drafts/1"),
    ]:
        request = urllib.request.Request(
            args.api.rstrip("/") + "/api" + path, method=method
        )
        try:
            urllib.request.urlopen(request, timeout=60).close()
        except urllib.error.HTTPError as error:
            assert error.code == 405
        else:
            raise AssertionError("Explorer accepted a mutation")
    assert before == inventory(release)
    assert (
        not list(release.rglob("*-wal"))
        + list(release.rglob("*-journal"))
        + list(release.rglob("*-shm"))
    )
    with closing(
        sqlite3.connect(
            (release / "catalog.sqlite").as_uri() + "?mode=ro&immutable=1", uri=True
        )
    ) as db:
        counts = {
            t: db.execute("SELECT count(*) FROM " + t).fetchone()[0]
            for t in ("experiments", "simulation_jobs", "simulation_results")
        }
    report = dict(
        passed=True,
        metric_comparisons=comparisons,
        concurrent_requests=len(routes),
        concurrency=8,
        unchanged_files=len(before),
        counts=counts,
        capabilities=cap,
    )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))


if __name__ == "__main__":
    main()
