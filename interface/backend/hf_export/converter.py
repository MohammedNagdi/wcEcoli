"""simOut -> HDF5 + metadata converter for the wcEcoli HF dataset (v0).

Packages one completed simulation's per-generation trajectories into a uniform HDF5 layout plus a
flat metadata record (written as JSONL by run_export). v0 ships the ~25 *scalar* trajectory channels
the platform already extracts (masses, growth rate, volume, ppGpp, AA pools, mRNA total, FBA
objective/fluxes, ribosome rates, replication) — enough for the dynamics (T3), growth (T1), and
viability (T2) benchmarks. The per-gene/per-reaction matrices are a v1/v2 "full tensor" addition.

HDF5 layout (one group per cell trajectory):
    /cond=<c>/geno=<g>/seed=<s>/gen=<n>
        attrs: variant_type, ko_gene, condition, seed, generation, job_id, divided, summary metrics…
        <channel>/value  [T] float32
        <channel>/time   [T] float32   (attrs: unit)

The converter core (`write_sim` / `build_record`) is decoupled from the reader so it is unit-testable
with a synthetic channel dict — no real simOut needed.
"""

from __future__ import annotations

from typing import Any

import numpy as np

# v0 channel allow-list (order-stable). Anything the reader returns outside this is ignored for v0.
V0_CHANNELS = [
    "cell_mass", "dry_mass", "protein_mass", "rna_mass", "dna_mass", "small_molecule_mass",
    "growth_rate", "cell_volume", "ppgpp_conc", "aa_pool_size", "ntp_pool_size",
    "trna_charged_fraction", "aa_supply_total", "aa_synthesis_total", "mrna_counts",
    "fba_objective", "exchange_flux_total", "reaction_flux_total", "ribosome_elongation_rate",
    "ribosome_actual_elongations", "n_oric",
]


def group_path(condition: str, genotype: str, seed: int, generation: int) -> str:
    return f"cond={condition}/geno={genotype}/seed={seed}/gen={generation}"


def write_sim(h5file: Any, path: str, channels: dict[str, dict[str, Any]], attrs: dict[str, Any]) -> list[str]:
    """Write one cell trajectory's channels + metadata attrs into ``h5file`` under ``path``.

    Returns the list of channel names actually written. ``channels`` is the reader's
    ``{name: {"time", "values", "unit"}}`` structure.
    """
    grp = h5file.require_group(path)
    for key, value in attrs.items():
        grp.attrs[key] = "" if value is None else value
    written: list[str] = []
    for name in V0_CHANNELS:
        ch = channels.get(name)
        if not ch:
            continue
        time = np.asarray(ch["time"], dtype=np.float32)
        values = np.asarray(ch["values"], dtype=np.float32)
        if time.shape[0] == 0 or time.shape[0] != values.shape[0]:
            continue
        sub = grp.require_group(name)
        sub.create_dataset("time", data=time, compression="gzip", compression_opts=4)
        dset = sub.create_dataset("value", data=values, compression="gzip", compression_opts=4)
        dset.attrs["unit"] = ch.get("unit", "")
        written.append(name)
    grp.attrs["channels"] = ",".join(written)
    grp.attrs["n_timesteps"] = int(channels.get("cell_mass", {}).get("time", np.array([])).__len__())
    return written


def build_record(
    *, path: str, variant_type: str, condition: str, genotype: str, ko_gene: str,
    seed: int, generation: int, job_id: int, channels_written: list[str],
    summary: dict[str, Any], provenance: dict[str, Any],
) -> dict[str, Any]:
    """Flat metadata row for metadata.jsonl (the index used for splits/benchmarks)."""
    return {
        "h5_path": path,
        "variant_type": variant_type,
        "genotype": genotype,
        "ko_gene": ko_gene,
        "condition": condition,
        "seed": seed,
        "generation": generation,
        "job_id": job_id,
        "channels": channels_written,
        "divided": summary.get("divided"),
        "division_time_sec": summary.get("division_time_sec"),
        "final_mass_fg": summary.get("final_mass_fg"),
        "growth_rate": summary.get("growth_rate"),
        "doubling_time_min": summary.get("doubling_time_min"),
        **{f"prov_{k}": v for k, v in provenance.items()},
    }
