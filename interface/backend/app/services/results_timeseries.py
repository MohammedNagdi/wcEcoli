"""Result time-series models + extraction (real simOut or synthetic fallback).

Extracted from the results router so other services (e.g. the assistant harness) can read the same
data the Molecule Explorer plots, without importing the router (which pulls ``app.main`` and would
create a circular import).
"""

from __future__ import annotations

import logging
import math
import random

from pydantic import BaseModel

from app.config import settings
from app.db.models import SimulationJob

logger = logging.getLogger(__name__)


class TimeseriesPoint(BaseModel):
    time: float  # seconds
    value: float


class TimeseriesData(BaseModel):
    label: str
    unit: str
    points: list[TimeseriesPoint]


# Channel display metadata (label overrides for the frontend).
CHANNEL_LABELS: dict[str, str] = {
    "cell_mass": "Cell mass",
    "dry_mass": "Dry mass",
    "protein_mass": "Protein mass",
    "rna_mass": "RNA mass",
    "dna_mass": "DNA mass",
    "small_molecule_mass": "Small-molecule mass",
    "growth_rate": "Growth rate",
    "cell_volume": "Cell volume",
    "ppgpp_conc": "ppGpp concentration",
    "aa_pool_size": "Amino-acid pool",
    "ntp_pool_size": "NTP pool",
    "trna_charged_fraction": "tRNA charged fraction",
    "aa_supply_total": "AA supply rate",
    "aa_synthesis_total": "AA synthesis rate",
    "mrna_counts": "mRNA count",
    "fba_objective": "FBA objective",
    "exchange_flux_total": "Exchange flux (total)",
    "reaction_flux_total": "Reaction flux (total)",
    "ribosome_elongation_rate": "Ribosome elongation rate",
    "ribosome_actual_elongations": "Ribosome elongations",
    "n_oric": "Origins of replication",
}


def load_real_timeseries(job: SimulationJob) -> dict[str, list[TimeseriesData]] | None:
    """Try to load timeseries from simOut via the bridge. Returns None if unavailable."""
    if not job.sim_dir:
        return None

    sim_out_base = settings.sim_output_dir / job.sim_dir
    try:
        from app.services.table_reader_bridge import SimOutReader, find_sim_outs
        sim_outs = find_sim_outs(sim_out_base)
        if not sim_outs:
            return None
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to locate simOut dirs for job %s: %s", job.id, exc)
        return None

    timeseries: dict[str, list[TimeseriesData]] = {}

    for sim_out_path in sim_outs:
        try:
            reader = SimOutReader(sim_out_path)
            channels = reader.extract_all_channels()
        except Exception as exc:  # noqa: BLE001
            logger.warning("extract_all_channels failed for %s: %s", sim_out_path, exc)
            continue

        seed_label = f"seed {job.seed}"

        for ch_name, ch_data in channels.items():
            time_arr = ch_data["time"]
            val_arr = ch_data["values"]
            unit = ch_data["unit"]
            label = CHANNEL_LABELS.get(ch_name, ch_name)

            points = [
                TimeseriesPoint(time=float(t), value=float(v))
                for t, v in zip(time_arr, val_arr)
                if math.isfinite(float(v))
            ]
            if not points:
                continue

            timeseries.setdefault(ch_name, []).append(TimeseriesData(
                label=f"{label} ({seed_label})" if len(sim_outs) > 1 else label,
                unit=unit,
                points=points,
            ))

    return timeseries if timeseries else None


def generate_mock_timeseries(
    seed: int,
    duration_sec: float = 7200.0,
    dt: float = 2.0,
) -> dict[str, TimeseriesData]:
    """Generate biologically plausible mock time-series for one cell (development/demo)."""
    rng = random.Random(seed + 42)
    n_points = int(duration_sec / dt)
    times = [i * dt for i in range(n_points)]

    mu = 0.00028 + rng.gauss(0, 0.00002)  # ~40 min doubling

    m0 = 300.0 + rng.gauss(0, 10)  # initial dry mass in fg
    masses = []
    for t in times:
        noise = rng.gauss(0, 2)
        masses.append(m0 * math.exp(mu * t) + noise)

    growth_rates = []
    for i, t in enumerate(times):
        gr = mu + rng.gauss(0, 0.00003)
        if t < 300:
            gr *= (0.5 + 0.5 * t / 300)
        growth_rates.append(gr)

    protein = [m * (0.55 + rng.gauss(0, 0.01)) for m in masses]
    rna = [m * (0.20 + rng.gauss(0, 0.005)) for m in masses]

    dna_base = 4.6
    dna = []
    replication_start = duration_sec * (0.3 + rng.uniform(-0.05, 0.05))
    replication_end = duration_sec * (0.7 + rng.uniform(-0.05, 0.05))
    for t in times:
        if t < replication_start:
            dna.append(dna_base + rng.gauss(0, 0.1))
        elif t < replication_end:
            frac = (t - replication_start) / (replication_end - replication_start)
            dna.append(dna_base * (1 + frac) + rng.gauss(0, 0.1))
        else:
            dna.append(dna_base * 2 + rng.gauss(0, 0.1))

    mrna = [int(2000 + 1000 * m / m0 + rng.gauss(0, 100)) for m in masses]
    trna_charged = [0.80 + 0.05 * math.sin(2 * math.pi * t / 3600) + rng.gauss(0, 0.02) for t in times]

    def to_series(label, unit, values):
        return TimeseriesData(
            label=label,
            unit=unit,
            points=[TimeseriesPoint(time=t, value=v) for t, v in zip(times, values)],
        )

    return {
        "cell_mass": to_series("Cell mass", "fg", masses),
        "growth_rate": to_series("Growth rate", "1/s", growth_rates),
        "protein_mass": to_series("Protein mass", "fg", protein),
        "rna_mass": to_series("RNA mass", "fg", rna),
        "dna_mass": to_series("DNA mass", "fg", dna),
        "mrna_counts": to_series("mRNA count", "molecules", mrna),
        "trna_charged": to_series("tRNA charged fraction", "fraction", trna_charged),
    }
