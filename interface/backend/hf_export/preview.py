"""Read-only artifact API; no normal application initialization or database engine."""

from __future__ import annotations
from contextlib import asynccontextmanager, contextmanager
import asyncio
import os
import math
from pathlib import Path
from threading import RLock, current_thread, main_thread
import hashlib
import signal

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse
import h5py

from .converter import MATRIX_CHANNELS
from .explorer_contract import ReleaseManifest, validate_release
from .explorer_routes import install

ROOT = Path(os.environ.get("PILOT_RELEASE", "/release/current"))
_cached = None
_bundle_lock = RLock()
# The pilot preview stays backward compatible. The production entry point sets
# both before lifespan startup and never permits pilot/synthetic publications.
REQUIRE_FULL_RELEASE = False
EXPECTED_MANIFEST_SHA256 = None


@contextmanager
def startup_signals():
    """Cancel a synchronous production scan promptly, before any requests exist.

    Uvicorn's normal handler sets an event-loop flag; a CPU-bound startup scan
    cannot observe it until completion. Restore that handler for normal serving.
    """
    if not REQUIRE_FULL_RELEASE or current_thread() is not main_thread():
        yield
        return

    def cancel(*_):
        raise asyncio.CancelledError("Production validation cancelled before readiness")

    previous = {sig: signal.signal(sig, cancel) for sig in (signal.SIGTERM, signal.SIGINT)}
    try:
        yield
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


def bundle():
    global _cached
    try:
        # A publication switch can make several concurrent requests discover an
        # uncached bundle. Validate it once: cancelled HTTP probes do not cancel
        # synchronous workers, and parallel full-matrix scans can exhaust RAM.
        with _bundle_lock:
            directory = ROOT.resolve(strict=True)
            text = (directory / "manifest.json").read_text()
            if _cached is None or _cached[0] != directory or _cached[1] != text:
                if EXPECTED_MANIFEST_SHA256 is not None and hashlib.sha256(
                    (directory / "manifest.json").read_bytes()
                ).hexdigest() != EXPECTED_MANIFEST_SHA256:
                    raise ValueError("configured manifest fingerprint does not match publication")
                manifest = ReleaseManifest.model_validate_json(text)
                if REQUIRE_FULL_RELEASE and (manifest.scope != "full" or manifest.references is None):
                    raise ValueError("production requires a full explorer release with references")
                report = validate_release(directory, allow_pilot=not REQUIRE_FULL_RELEASE)
                if not report["valid"]:
                    raise ValueError("; ".join(report["errors"]))
                _cached = directory, text, manifest
            return _cached[0], _cached[2]
    except (OSError, ValueError) as exc:
        raise HTTPException(503, detail="Published artifact unavailable: " + str(exc)) from exc


@asynccontextmanager
async def lifespan(_app):
    _app.state.read_gate = asyncio.Semaphore(2)
    with startup_signals():
        bundle()  # fail closed; no migrations/reingestion/provider initialization
    yield


app = FastAPI(
    title="wcEcoli public explorer",
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)

# Register static catalog routes before the existing numeric detail routes.
_experiment_record, _job_record = install(app, lambda: bundle(), lambda job_id: result(job_id))


@app.middleware("http")
async def reject_writes(request: Request, call_next):
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        return JSONResponse(
            status_code=405,
            content=dict(detail="Read-only explorer; mutations and execution unavailable"),
        )
    try:
        return await call_next(request)
    except OSError:
        return JSONResponse(
            status_code=503, content=dict(detail="Published artifact unavailable; no fallback data")
        )


class BoundedReads:
    """Hold the slot through response transmission, including JSON serialization.

    Matrix columns stay bounded separately. Two simultaneous response builders
    avoid exhausting the 512 MiB preview when many browser tabs open at once.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        async with scope["app"].state.read_gate:
            await self.app(scope, receive, send)


app.add_middleware(BoundedReads)


def result(job_id):
    directory, manifest = bundle()
    exp = next((e for e in manifest.experiments if e.job_id == job_id), None)
    if exp is None:
        raise HTTPException(404, detail="Unpublished/unrun job")
    if not exp.shard:
        raise HTTPException(409, detail=exp.reason or "No artifact for this outcome")
    return directory, manifest, exp


@app.get("/api/health")
def health():
    _, manifest = bundle()
    return dict(status="ok", read_only=True, scope=manifest.scope, synthetic=False)


@app.get("/api/pilot")
def index():
    _, manifest = bundle()
    published = {e.key: e for e in manifest.experiments}
    specs = {e.key: e for e in manifest.campaign.experiments}
    return dict(
        scope=manifest.scope,
        time_basis=manifest.provenance.time_basis,
        unrun=[key for key in specs if key not in published],
        experiments=[
            dict(
                **exp.model_dump(),
                question=specs[exp.key].question,
                controls=[
                    dict(
                        key=link.key,
                        role=link.role,
                        available=link.key in published and bool(published[link.key].shard),
                        reason=""
                        if link.key in published and published[link.key].shard
                        else "Control result has not been run/published",
                    )
                    for link in specs[exp.key].controls
                ],
            )
            for exp in manifest.experiments
        ],
    )


@app.get("/api/jobs/{job_id}")
def job(job_id: int):
    _, _, exp = result(job_id)
    return _job_record(exp)


@app.get("/api/experiments/{experiment_id}")
def experiment(experiment_id: int):
    _, manifest = bundle()
    exp = next((e for e in manifest.experiments if e.experiment_id == experiment_id), None)
    if exp is None:
        raise HTTPException(404, detail="Unpublished experiment")
    return _experiment_record(exp)


@app.get("/api/jobs/{job_id}/timeseries")
def timeseries(job_id: int):
    directory, _, exp = result(job_id)
    channels = {}
    clock_records = {
        r["generation"]: r for r in (exp.execution_provenance or {}).get("generation_clocks", [])
    }

    def division_time(trajectory):
        record = clock_records.get(trajectory.generation, {})
        start, end = record.get("actual_initial_sec"), record.get("actual_final_sec")
        return (
            end - start
            if trajectory.outcome == "completed" and start is not None and end is not None
            else None
        )

    def final_mass(trajectory):
        rows = [
            s for s in channels.get("cell_mass", []) if s["generation"] == trajectory.generation
        ]
        return rows[0]["points"][-1]["value"] if rows and rows[0]["points"] else None

    with h5py.File(directory / exp.shard, "r") as h5:
        for trajectory in exp.trajectories:
            for name, availability in trajectory.channels.items():
                if name in MATRIX_CHANNELS or not availability.available:
                    continue
                group = h5[trajectory.h5_group + "/" + name]
                channels.setdefault(name, []).append(
                    dict(
                        label=f"{exp.key} seed {trajectory.seed}, generation {trajectory.generation}",
                        seed=trajectory.seed,
                        generation=trajectory.generation,
                        time_basis="elapsed_lineage_seconds",
                        generation_start_sec=trajectory.lineage_start_sec,
                        unit=group["value"].attrs["unit"],
                        undefined_samples=availability.undefined_samples,
                        undefined_reason=availability.undefined_reason,
                        points=[
                            dict(time=float(t), value=float(v) if math.isfinite(float(v)) else None)
                            for t, v in zip(group["time"][:], group["value"][:])
                        ],
                    )
                )
    return dict(
        summary=[
            dict(
                job_id=job_id,
                seed=t.seed,
                generation=t.generation,
                divided=t.outcome == "completed",
                terminated=t.outcome == "terminated",
                termination_reason=t.termination_reason,
                division_time_sec=division_time(t),
                final_mass_fg=final_mass(t),
                growth_rate=None,
                doubling_time_min=None,
            )
            for t in exp.trajectories
        ],
        timeseries=channels,
        channel_availability=[t.model_dump() for t in exp.trajectories],
    )


@app.get("/api/jobs/{job_id}/molecules")
def molecule_types(job_id: int):
    directory, _, exp = result(job_id)
    available_types = []
    with h5py.File(directory / exp.shard, "r") as h5:
        for name, kind in MATRIX_CHANNELS.items():
            path = f"reference/{name}_ids"
            if path in h5:
                ids = h5[path].asstr()[:].tolist()
                available_types.append(
                    dict(
                        molecule_type=kind,
                        count=len(ids),
                        total_ids=len(ids),
                        ids=ids[:50],
                        columns=[],
                    )
                )
    return dict(job_id=job_id, available_types=available_types)


def matrix_name(kind):
    name = next((n for n, k in MATRIX_CHANNELS.items() if k == kind), None)
    if name is None:
        raise HTTPException(409, detail="Molecular view was not exported; unavailable")
    return name


@app.get("/api/jobs/{job_id}/molecules/{kind}/ids")
def molecule_ids(
    job_id: int,
    kind: str,
    search: str = "",
    limit: int = Query(100, ge=1, le=10000),
    offset: int = Query(0, ge=0),
):
    directory, _, exp = result(job_id)
    name = matrix_name(kind)
    with h5py.File(directory / exp.shard, "r") as h5:
        path = f"reference/{name}_ids"
        if path not in h5:
            raise HTTPException(409, detail="Source molecular channel unavailable")
        ids = [value for value in h5[path].asstr()[:] if search.lower() in value.lower()]
    return dict(molecule_type=kind, ids=ids[offset : offset + limit], count=len(ids))


@app.get("/api/jobs/{job_id}/molecules/{kind}/timeseries")
def molecule_series(job_id: int, kind: str, ids: str):
    directory, _, exp = result(job_id)
    name = matrix_name(kind)
    series = []
    with h5py.File(directory / exp.shard, "r") as h5:
        path = f"reference/{name}_ids"
        if path not in h5:
            raise HTTPException(409, detail="Source molecular channel unavailable")
        available = h5[path].asstr()[:].tolist()
        selected = [ids] if ids in available else ids.split(",")
        if not 1 <= len(selected) <= 5:
            raise HTTPException(422, detail="Select one to five molecule identifiers")
        if any(molecule not in available for molecule in selected):
            raise HTTPException(404, detail="Molecule identifier not present in published artifact")
        for trajectory in exp.trajectories:
            if not trajectory.channels[name].available:
                continue
            group = h5[trajectory.h5_group + "/" + name]
            for molecule in selected:
                values = group["value"][:, available.index(molecule)]
                series.append(
                    dict(
                        molecule_id=molecule,
                        molecule_type=kind,
                        seed=trajectory.seed,
                        generation=trajectory.generation,
                        time_basis="elapsed_lineage_seconds",
                        generation_start_sec=trajectory.lineage_start_sec,
                        label=f"{molecule}, generation {trajectory.generation}",
                        unit=group["value"].attrs["unit"],
                        points=[
                            dict(time=float(t), value=float(v) if math.isfinite(float(v)) else None)
                            for t, v in zip(group["time"][:], values)
                        ],
                    )
                )
    if not series:
        raise HTTPException(409, detail="No saved samples for selected molecular view")
    return dict(job_id=job_id, molecule_type=kind, molecules=series)
