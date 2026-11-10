"""Compare live full-release HTTP responses with the independent local HDF5 copy."""

import argparse
import json
from pathlib import Path
import subprocess
import sys

import h5py


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api", default="http://127.0.0.1:8001")
    parser.add_argument("--release", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    manifest = json.loads((args.release / "manifest.json").read_text())
    assert manifest["scope"] == "full" and not manifest["synthetic_fixture"]
    assert len(manifest["experiments"]) == 12
    args.out.mkdir(parents=True, exist_ok=True)
    helper = Path(__file__).with_name("check_pilot_artifact_api.py")
    families = {"mrna_counts_matrix": "mRNA", "protein_counts_matrix": "protein",
                "reaction_flux_matrix": "reaction_flux", "exchange_flux_matrix": "exchange_flux"}
    reports = []
    for experiment in manifest["experiments"]:
        with h5py.File(args.release / experiment["shard"], "r") as h5:
            selected = {kind: next(value for value in h5[f"reference/{name}_ids"].asstr()[:] if "," not in value)
                        for name, kind in families.items() if f"reference/{name}_ids" in h5}
        for kind, identifier in selected.items():
            target = args.out / f"{experiment['key']}-{kind}.json"
            result = subprocess.run([sys.executable, str(helper), "--api", args.api, "--release", str(args.release),
                                     "--experiment-key", experiment["key"], "--molecule-type", kind,
                                     "--molecule-id", identifier, "--out", str(target)],
                                    check=True, text=True, stdout=subprocess.PIPE)
            report = json.loads(result.stdout)
            artifact = next(f for f in manifest["files"] if f["path"] == experiment["shard"])
            assert report["passed"] and report["wt_shard_sha256"] == artifact["sha256"]
            reports.append(dict(key=experiment["key"], family=kind, comparisons=report["comparison_count"]))
    summary = dict(passed=True, checks=len(reports), comparisons=sum(r["comparisons"] for r in reports),
                   reports=reports, source="independent local full-release HDF5 copy versus actual HTTP; no route mocks")
    (args.out / "summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
    print(json.dumps(summary, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
