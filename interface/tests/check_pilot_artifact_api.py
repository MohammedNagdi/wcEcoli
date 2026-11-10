"""Independent real artifact -> API comparison, run in the pilot tools environment.

No fixtures, database initialization, mutations, row sampling or scientific fallbacks.
The browser test separately proves that these responses reach the existing charts.
"""

from __future__ import annotations
import argparse
import json
from pathlib import Path
import urllib.parse

from artifact_http import get_json

import h5py
import numpy as np


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api", default="http://preview-api:8000")
    parser.add_argument("--release", type=Path, default=Path("/release/current"))
    parser.add_argument("--molecule-id", required=True)
    parser.add_argument("--molecule-type", choices=["protein", "mRNA", "reaction_flux", "exchange_flux"], default="protein")
    parser.add_argument("--experiment-key", default="wt-basal")
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()

    def get(path):
        return get_json(args.api + path)

    manifest = json.loads((args.release / "manifest.json").read_text())
    assert not manifest.get("synthetic_fixture"), "Real scientific artifact required"
    health = get("/api/health")
    assert health["read_only"] and not health["synthetic"]
    wt = next(e for e in manifest["experiments"] if e["key"] == args.experiment_key)
    payload = get(f"/api/jobs/{wt['job_id']}/timeseries")
    molecular = get(
        f"/api/jobs/{wt['job_id']}/molecules/{args.molecule_type}/timeseries?ids="
        + urllib.parse.quote(args.molecule_id, safe="")
    )
    comparisons = []
    matrix_name = {"protein": "protein_counts_matrix", "mRNA": "mrna_counts_matrix",
                   "reaction_flux": "reaction_flux_matrix", "exchange_flux": "exchange_flux_matrix"}[args.molecule_type]

    def compare(group, series):
        assert series["seed"] == 0
        expected_time = group["time"][:]
        expected_value = group["value"][:]
        if expected_value.ndim == 2:
            identifiers = h5[f"reference/{matrix_name}_ids"].asstr()[:].tolist()
            expected_value = expected_value[:, identifiers.index(args.molecule_id)]
        actual_time = np.array([p["time"] for p in series["points"]])
        actual_value = np.array(
            [np.nan if p["value"] is None else p["value"] for p in series["points"]]
        )
        np.testing.assert_array_equal(actual_time, expected_time)
        np.testing.assert_array_equal(actual_value, expected_value)
        assert series["unit"] == group["value"].attrs["unit"]
        assert series["time_basis"] == "elapsed_lineage_seconds"
        return len(expected_time)

    with h5py.File(args.release / wt["shard"], "r") as h5:
        for name, series_list in payload["timeseries"].items():
            for series in series_list:
                generation = series["generation"]
                group = h5[f"seed=0/gen={generation}/{name}"]
                comparisons.append(
                    dict(
                        channel=name,
                        generation=generation,
                        samples=compare(group, series),
                    )
                )
        for series in molecular["molecules"]:
            assert series["molecule_id"] == args.molecule_id
            assert series["molecule_type"] == args.molecule_type
            group = h5[f"seed=0/gen={series['generation']}/{matrix_name}"]
            comparisons.append(
                dict(
                    channel=matrix_name,
                    molecule=args.molecule_id,
                    generation=series["generation"],
                    samples=compare(group, series),
                )
            )
    matrices = {"mrna_counts_matrix", "protein_counts_matrix", "reaction_flux_matrix", "exchange_flux_matrix"}
    expected = {(name, t["generation"]) for t in wt["trajectories"] for name, availability in t["channels"].items()
                if availability["available"] and (name not in matrices or name == matrix_name)}
    actual = {(row["channel"], row["generation"]) for row in comparisons}
    assert actual == expected and len(comparisons) == len(expected), "API omitted or duplicated published series"
    wt_file = next(item for item in manifest["files"] if item["path"] == wt["shard"])
    report = dict(
        passed=True,
        key=args.experiment_key,
        wt_shard_sha256=wt_file["sha256"],
        comparisons=comparisons,
        comparison_count=len(comparisons),
        scientific_data="real HDF5 payload, compared without sampling",
    )
    if args.out:
        args.out.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(json.dumps(report, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
