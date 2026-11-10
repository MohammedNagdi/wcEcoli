"""Immutable explorer checkpoints and lossless API checks, independent of raw output."""

from __future__ import annotations

from contextlib import contextmanager
import json
from pathlib import Path
from types import SimpleNamespace

import h5py
import numpy as np

from .demo_campaign import file_sha256, fingerprint
from .explorer_contract import PublishedExperiment, _check_shard


def inventory(root):
    return [
        dict(path=p.relative_to(root).as_posix(), bytes=p.stat().st_size, sha256=file_sha256(p))
        for p in sorted(root.rglob("*"))
        if p.is_file() and p.name != "receipt.json"
    ]


def seal(value):
    value = {k: v for k, v in value.items() if k != "receipt_sha256"}
    return dict(value, receipt_sha256=fingerprint(value))


def verify_checkpoint(root, *, campaign_sha256=None, readiness_sha256=None):
    root = Path(root)
    if root.is_symlink() or any(p.is_symlink() for p in root.rglob("*")):
        raise ValueError("checkpoint must not contain symbolic links")
    receipt = json.loads((root / "receipt.json").read_text())
    if receipt != seal(receipt) or receipt.get("version") != "demo-checkpoint-v1":
        raise ValueError("checkpoint receipt fingerprint/version mismatch")
    if campaign_sha256 is not None and receipt["campaign_sha256"] != campaign_sha256:
        raise ValueError("checkpoint campaign mismatch")
    if readiness_sha256 is not None and receipt["readiness_sha256"] != readiness_sha256:
        raise ValueError("checkpoint readiness mismatch")
    exp = PublishedExperiment.model_validate(receipt["experiment"])
    if exp.outcome not in {"completed", "no_division", "terminated"}:
        raise ValueError("failed experiment cannot authorize raw cleanup")
    if receipt["key"] != exp.key or exp.shard != f"trajectories/{exp.key}.h5":
        raise ValueError("checkpoint experiment identity mismatch")
    if not receipt["source_comparison"] or not receipt["api_comparison"].get("passed"):
        raise ValueError("checkpoint lacks source/API comparison evidence")
    paths = {f["path"] for f in receipt["files"]}
    if paths != {exp.shard, "execution.json", "source-comparison.json", "api-comparison.json"}:
        raise ValueError("checkpoint inventory differs from required files")
    if inventory(root) != receipt["files"]:
        raise ValueError("checkpoint file checksum/size/inventory mismatch")
    _check_shard(root / exp.shard, exp)
    return receipt


@contextmanager
def adapter(root, experiment):
    # Use the production response adapter without publishing an incomplete release,
    # starting an application lifecycle or touching a database.
    from . import preview

    original = preview.bundle
    preview.bundle = lambda: (Path(root), SimpleNamespace(experiments=[experiment]))
    try:
        yield preview
    finally:
        preview.bundle = original


def compare_api(root, exp):
    from .converter import MATRIX_CHANNELS

    comparisons = []

    def compare(group, series, column=None):
        expected = group["value"][:] if column is None else group["value"][:, column]
        actual = np.asarray([np.nan if p["value"] is None else p["value"] for p in series["points"]])
        np.testing.assert_array_equal(actual, expected)
        np.testing.assert_array_equal([p["time"] for p in series["points"]], group["time"][:])
        if series["unit"] != group["value"].attrs["unit"]:
            raise ValueError("API units differ from artifact")
        if series["time_basis"] != "elapsed_lineage_seconds":
            raise ValueError("API time basis differs from artifact")
        return len(expected)

    with adapter(root, exp) as api, h5py.File(Path(root) / exp.shard, "r") as h5:
        scalar = api.timeseries(exp.job_id)["timeseries"]
        for trajectory in exp.trajectories:
            for name, availability in trajectory.channels.items():
                if name in MATRIX_CHANNELS or not availability.available:
                    continue
                series = next(s for s in scalar[name] if s["generation"] == trajectory.generation)
                comparisons.append(dict(channel=name, generation=trajectory.generation,
                                         samples=compare(h5[trajectory.h5_group + "/" + name], series)))
        for name, kind in MATRIX_CHANNELS.items():
            path = f"reference/{name}_ids"
            if path not in h5:
                continue
            ids = h5[path].asstr()[:].tolist()
            columns = sorted({0, len(ids) // 2, len(ids) - 1})
            # Reaction identifiers can contain commas; the existing API uses commas
            # as its multi-select separator. Choose actual addressable identifiers.
            columns = [i for i in columns if "," not in ids[i]]
            if not columns:
                columns = [next(i for i, value in enumerate(ids) if "," not in value)]
            for column in columns:
                payload = api.molecule_series(exp.job_id, kind, ids[column])["molecules"]
                for series in payload:
                    group = h5[f"seed=0/gen={series['generation']}/{name}"]
                    comparisons.append(dict(channel=name, molecule=ids[column], generation=series["generation"],
                                             samples=compare(group, series, column)))
    return dict(passed=True, comparisons=comparisons, comparison_count=len(comparisons),
                method="production artifact adapter; all scalar rows and up to three actual IDs per matrix; no mock data")
