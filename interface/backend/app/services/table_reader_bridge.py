"""
Bridge to wcEcoli's TableReader binary format.

This module uses the standalone iff_reader (no wholecell dependency) to
extract simulation output data for the web UI and Parquet export.

The simOut directory structure (per simulation run):
    out/<run_id>/<variant_dir>/<seed>/generation_XXXXXX/000000/simOut/
        Mass/           -> time, cellMass, growth, dryMass, proteinMass, ...
        GrowthLimits/   -> ppgpp_conc, instantaneous_growth_rate, ...
        RNACounts/      -> mRNA, rRNA, tRNA counts
        MonomerCounts/  -> individual protein counts
        FBAResults/     -> reactionFluxes, externalExchangeFluxes, ...
        RibosomeData/   -> effectiveElongationRate, ...
        Main/           -> time, simulationStep
        ...

Usage:
    from app.services.table_reader_bridge import SimOutReader

    reader = SimOutReader("/path/to/simOut")
    summary = reader.extract_summary()
    channels = reader.extract_all_channels()
"""

import logging
import re
from pathlib import Path
from typing import Any, Optional

import numpy as np

from app.services.iff_reader import (
    read_column, read_column_slice, read_attribute,
    read_all_attributes, table_exists, list_columns,
)

logger = logging.getLogger(__name__)


class SimOutReader:
    """High-level reader for a single simulation's output directory."""

    def __init__(self, sim_out_path):
        self.path = Path(sim_out_path)
        if not self.path.exists():
            raise FileNotFoundError(f"simOut path does not exist: {self.path}")

    def _read_column(self, table_name, column_name):
        """Read a single column from a simOut table."""
        table_path = self.path / table_name
        if not table_path.exists():
            return None
        try:
            return read_column(table_path, column_name)
        except Exception as e:
            logger.debug("Failed to read %s/%s: %s", table_name, column_name, e)
            return None

    def _read_attribute(self, table_name, attr_name):
        """Read an attribute from a simOut table."""
        table_path = self.path / table_name
        if not table_path.exists():
            return None
        try:
            return read_attribute(table_path, attr_name)
        except (KeyError, Exception):
            return None

    def list_tables(self):
        """List all available simOut tables."""
        return sorted(
            p.name for p in self.path.iterdir()
            if p.is_dir() and (p / "attributes.json").exists()
        )

    # -- Summary extraction --------------------------------------------------

    def extract_summary(self):
        """Extract key summary metrics for the SimulationResult table.

        Division detection strategy:
        1. Look for a >30% mass drop between consecutive timesteps (clear
           division event in the Mass listener).
        2. If no mass drop, check whether final mass roughly doubled from
           initial mass (≥1.8×) — this indicates division occurred at the end
           of the simulation without a recorded post-division timestep.
        3. If neither condition is met, the cell did NOT divide. We set
           division_time_sec = None (not the total sim time), so downstream
           code can distinguish essential-gene knockouts from slow growers.

        The ``divided`` boolean flag is included so callers can unambiguously
        test for division without guessing from None values.
        """
        result = {
            "division_time_sec": None,
            "final_mass_fg": None,
            "growth_rate": None,
            "doubling_time_min": None,
            "divided": False,
        }

        time = self._read_column("Mass", "time")
        cell_mass = self._read_column("Mass", "cellMass")
        growth_rate = self._read_column("Mass", "instantaneous_growth_rate")

        if cell_mass is not None and len(cell_mass) > 0:
            if cell_mass.ndim > 1:
                cell_mass = cell_mass.sum(axis=1)
            result["final_mass_fg"] = float(cell_mass[-1])

            initial_mass = float(cell_mass[0]) if len(cell_mass) > 0 else 0

            # Strategy 1: detect division via sharp mass drop (>30%)
            if len(cell_mass) > 10:
                diffs = np.diff(cell_mass)
                big_drops = np.where(diffs < -cell_mass[:-1] * 0.3)[0]
                if len(big_drops) > 0 and time is not None:
                    div_idx = big_drops[0]
                    result["division_time_sec"] = float(time[div_idx])
                    result["divided"] = True

            # Strategy 2: if no mass drop detected, check mass-doubling ratio
            # (division may have occurred at the very last timestep)
            if not result["divided"] and initial_mass > 0:
                mass_ratio = float(cell_mass[-1]) / initial_mass
                if mass_ratio >= 1.8:
                    # Cell reached ~2× initial mass — division likely occurred
                    if time is not None and len(time) > 0:
                        result["division_time_sec"] = float(time[-1]) - float(time[0])
                    result["divided"] = True

        # If cell never divided, division_time_sec stays None — this is
        # intentional.  Do NOT fall back to total_sec for non-dividing cells.

        if growth_rate is not None and len(growth_rate) > 0:
            if growth_rate.ndim > 1:
                growth_rate = growth_rate.mean(axis=1)
            # Skip first 10% as warmup (Parca initial-condition artifacts)
            warmup = max(1, len(growth_rate) // 10)
            valid = growth_rate[warmup:]
            valid = valid[np.isfinite(valid) & (valid > 0)]
            if len(valid) > 0:
                mean_gr = float(np.mean(valid))
                result["growth_rate"] = mean_gr
                if mean_gr > 0:
                    result["doubling_time_min"] = (np.log(2) / mean_gr) / 60.0

        return result

    # -- Timeseries extraction -----------------------------------------------

    def extract_mass_timeseries(self):
        """Extract full mass time-series for visualization."""
        columns = [
            "time", "cellMass", "dryMass", "proteinMass", "rnaMass",
            "dnaMass", "smallMoleculeMass", "growth",
            "instantaneous_growth_rate", "cellVolume",
        ]
        data = {}
        for col in columns:
            arr = self._read_column("Mass", col)
            if arr is not None:
                if arr.ndim > 1:
                    arr = arr.sum(axis=1)
                data[col] = arr
        return data

    def extract_growth_limits_timeseries(self):
        """Extract growth limits time-series."""
        columns = [
            "time", "ppgpp_conc", "aaPoolSize", "ntpPoolSize",
            "fraction_trna_charged",
            "aa_supply", "aa_synthesis", "aa_import", "aa_export",
            "aa_supply_enzymes_fwd", "aa_supply_enzymes_rev",
            "synthetase_conc", "uncharged_trna_conc", "charged_trna_conc",
            "aa_conc", "ribosome_conc",
        ]
        data = {}
        for col in columns:
            arr = self._read_column("GrowthLimits", col)
            if arr is not None:
                if arr.ndim == 1 or (arr.ndim == 2 and arr.shape[1] == 1):
                    if arr.ndim == 2:
                        arr = arr.ravel()
                    data[col] = arr
                elif arr.ndim == 2:
                    data[col + "_total"] = arr.sum(axis=1)
        return data

    def extract_rna_counts_timeseries(self):
        """Extract RNA count time-series."""
        data = {}
        time = self._read_column("RNACounts", "time")
        if time is not None:
            data["time"] = time

        for col_name in ["mRNA_counts", "mRna_counts"]:
            arr = self._read_column("RNACounts", col_name)
            if arr is not None:
                if arr.ndim == 2:
                    data["mrna_total"] = arr.sum(axis=1)
                elif arr.ndim == 1:
                    data["mrna_total"] = arr
                break

        for name in ["fullMRNA_counts", "fullMRna_counts"]:
            arr = self._read_column("RNACounts", name)
            if arr is not None:
                if arr.ndim == 2:
                    data["full_mrna_total"] = arr.sum(axis=1)
                break

        return data

    def extract_fba_timeseries(self):
        """Extract FBA metabolic flux data."""
        data = {}
        obj = self._read_column("FBAResults", "objectiveValue")
        if obj is not None:
            data["fba_objective"] = obj.ravel() if obj.ndim > 1 else obj

        ext = self._read_column("FBAResults", "externalExchangeFluxes")
        if ext is not None and ext.ndim == 2:
            data["exchange_flux_total"] = np.abs(ext).sum(axis=1)

        fluxes = self._read_column("FBAResults", "reactionFluxes")
        if fluxes is not None and fluxes.ndim == 2:
            data["reaction_flux_total"] = np.abs(fluxes).sum(axis=1)

        shadow = self._read_column("FBAResults", "shadowPrices")
        if shadow is not None and shadow.ndim == 2:
            data["shadow_price_total"] = np.abs(shadow).sum(axis=1)

        return data

    def extract_ribosome_timeseries(self):
        """Extract ribosome activity data."""
        data = {}
        elong = self._read_column("RibosomeData", "effectiveElongationRate")
        if elong is not None:
            data["ribosome_elongation_rate"] = elong.ravel() if elong.ndim > 1 else elong

        actual = self._read_column("RibosomeData", "actualElongations")
        if actual is not None:
            data["ribosome_actual_elongations"] = actual.ravel() if actual.ndim > 1 else actual

        n_active = self._read_column("RibosomeData", "n_ribosomes_on_partial_mRNA_per_transcript")
        if n_active is not None and n_active.ndim == 2:
            data["active_ribosomes_total"] = n_active.sum(axis=1)

        return data

    def extract_replication_timeseries(self):
        """Extract DNA replication data."""
        data = {}
        n_oric = self._read_column("ReplicationData", "numberOfOric")
        if n_oric is not None:
            data["n_oric"] = n_oric.ravel() if n_oric.ndim > 1 else n_oric

        crit_mass = self._read_column("ReplicationData", "criticalMassPerOriC")
        if crit_mass is not None:
            data["critical_mass_per_oric"] = crit_mass.ravel() if crit_mass.ndim > 1 else crit_mass

        return data

    # Per-molecule / per-reaction FULL matrices (the high-dimensional "omics" channels).
    _FULL_MATRIX_SPEC = {
        "mRNA":          ("RNACounts",    "mRNA_counts",            "mRNA_ids",           "molecules"),
        "protein":       ("MonomerCounts", "monomerCounts",         "monomerIds",         "molecules"),
        "reaction_flux": ("FBAResults",   "reactionFluxes",         "reactionIDs",        "mmol/gDCW/h"),
        "exchange_flux": ("FBAResults",   "externalExchangeFluxes", "externalMoleculeIDs", "mmol/gDCW/h"),
    }

    def extract_full_matrix(self, molecule_type):
        """Full (T, N) matrix + column ids + time for a molecule type.

        Unlike the scalar `extract_*_timeseries` (which sum/aggregate), this returns the complete
        per-gene / per-reaction tensor — the scientifically richest channel. Returns None if absent.
        molecule_type in {'mRNA', 'protein', 'reaction_flux', 'exchange_flux'}.
        """
        spec = self._FULL_MATRIX_SPEC.get(molecule_type)
        if spec is None:
            return None
        table, column, ids_attr, unit = spec
        matrix = self._read_column(table, column)
        if matrix is None or matrix.ndim != 2 or matrix.shape[0] == 0:
            return None
        time = self._read_column(table, "time")
        if time is None or len(time) != matrix.shape[0]:
            import numpy as _np
            time = _np.arange(matrix.shape[0])
        ids = self._read_attribute(table, ids_attr)
        return {"time": time, "matrix": matrix, "ids": list(ids) if ids is not None else [], "unit": unit}

    def extract_all_channels(self):
        """Extract all available channels, keyed by channel name."""
        channels = {}
        mass = self.extract_mass_timeseries()

        if "time" not in mass:
            return channels

        time = mass["time"]

        channel_map = {
            "cell_mass":    ("cellMass",    "fg"),
            "dry_mass":     ("dryMass",     "fg"),
            "protein_mass": ("proteinMass", "fg"),
            "rna_mass":     ("rnaMass",     "fg"),
            "dna_mass":     ("dnaMass",     "fg"),
            "small_molecule_mass": ("smallMoleculeMass", "fg"),
            "growth_rate":  ("instantaneous_growth_rate", "1/s"),
            "cell_volume":  ("cellVolume",  "fL"),
        }

        for ch_name, (col, unit) in channel_map.items():
            if col in mass and len(mass[col]) == len(time):
                channels[ch_name] = {"time": time, "values": mass[col], "unit": unit}

        gl = self.extract_growth_limits_timeseries()
        gl_time = gl.get("time", time)
        gl_channels = {
            "ppgpp_conc":            ("ppgpp_conc",            "uM"),
            "aa_pool_size":          ("aaPoolSize",            "counts"),
            "ntp_pool_size":         ("ntpPoolSize",           "counts"),
            "trna_charged_fraction": ("fraction_trna_charged", "fraction"),
            "aa_supply_total":       ("aa_supply_total",       "counts/s"),
            "aa_synthesis_total":    ("aa_synthesis_total",     "counts/s"),
        }
        for ch_name, (col, unit) in gl_channels.items():
            if col in gl and len(gl[col]) == len(gl_time):
                channels[ch_name] = {"time": gl_time, "values": gl[col], "unit": unit}

        rna = self.extract_rna_counts_timeseries()
        rna_time = rna.get("time", time)
        if "mrna_total" in rna and len(rna["mrna_total"]) == len(rna_time):
            channels["mrna_counts"] = {"time": rna_time, "values": rna["mrna_total"], "unit": "molecules"}

        fba = self.extract_fba_timeseries()
        fba_channels = {
            "fba_objective":       ("fba_objective",       "mmol/gDCW/h"),
            "exchange_flux_total": ("exchange_flux_total", "mmol/gDCW/h"),
            "reaction_flux_total": ("reaction_flux_total", "mmol/gDCW/h"),
        }
        for ch_name, (col, unit) in fba_channels.items():
            if col in fba and len(fba[col]) == len(time):
                channels[ch_name] = {"time": time, "values": fba[col], "unit": unit}

        ribo = self.extract_ribosome_timeseries()
        ribo_channels = {
            "ribosome_elongation_rate":    ("ribosome_elongation_rate",    "aa/s"),
            "ribosome_actual_elongations": ("ribosome_actual_elongations", "aa"),
        }
        for ch_name, (col, unit) in ribo_channels.items():
            if col in ribo and len(ribo[col]) == len(time):
                channels[ch_name] = {"time": time, "values": ribo[col], "unit": unit}

        repl = self.extract_replication_timeseries()
        if "n_oric" in repl and len(repl["n_oric"]) == len(time):
            channels["n_oric"] = {"time": time, "values": repl["n_oric"], "unit": "count"}

        return channels

    # -- Per-molecule queries ------------------------------------------------

    def list_molecule_ids(self, molecule_type):
        """List available molecule IDs for a given type.

        Args:
            molecule_type: One of 'protein', 'mRNA', 'rRNA', 'mRNA_cistron',
                'reaction_flux', 'exchange_flux', 'metabolite_delta',
                'metabolite_count', or 'aa_pool'
        """
        attr_map = {
            "protein":       ("MonomerCounts", "monomerIds"),
            "mRNA":          ("RNACounts",     "mRNA_ids"),
            "rRNA":          ("RNACounts",     "rRNA_ids"),
            "mRNA_cistron":  ("RNACounts",     "mRNA_cistron_ids"),
            "rRNA_cistron":  ("RNACounts",     "rRNA_cistron_ids"),
            "reaction_flux": ("FBAResults",    "reactionIDs"),
            "exchange_flux": ("FBAResults",    "externalMoleculeIDs"),
            "metabolite_delta": ("FBAResults", "metaboliteNames"),
            "metabolite_count": ("EnzymeKinetics", "metaboliteNames"),
            "aa_pool":       ("GrowthLimits",  "aaIds"),
        }
        if molecule_type not in attr_map:
            raise ValueError(
                f"Unknown molecule_type: {molecule_type}. "
                f"Use one of {list(attr_map.keys())}"
            )

        table_name, attr_name = attr_map[molecule_type]
        ids = self._read_attribute(table_name, attr_name)
        return ids if ids is not None else []

    def get_molecule_timeseries(self, molecule_type, molecule_ids):
        """Get time-series for specific molecules by ID.

        Args:
            molecule_type: 'protein', 'mRNA', 'rRNA', etc.
            molecule_ids: List of molecule IDs to query.
                Accepts both full IDs ('ADHE-MONOMER[c]') and bare names
                ('ADHE-MONOMER') — compartment tags are resolved automatically.

        Returns:
            Dict of {molecule_id: {"time": arr, "values": arr, "unit": str}}
        """
        type_config = {
            "protein": {
                "table": "MonomerCounts",
                "column": "monomerCounts",
                "ids_attr": "monomerIds",
                "unit": "molecules",
            },
            "protein_free": {
                "table": "MonomerCounts",
                "column": "freeMonomerCounts",
                "ids_attr": "monomerIds",
                "unit": "molecules",
            },
            "mRNA": {
                "table": "RNACounts",
                "column": "mRNA_counts",
                "ids_attr": "mRNA_ids",
                "unit": "molecules",
            },
            "mRNA_full": {
                "table": "RNACounts",
                "column": "full_mRNA_counts",
                "ids_attr": "mRNA_ids",
                "unit": "molecules",
            },
            "rRNA": {
                "table": "RNACounts",
                "column": "partial_rRNA_counts",
                "ids_attr": "rRNA_ids",
                "unit": "molecules",
            },
            "mRNA_cistron": {
                "table": "RNACounts",
                "column": "mRNA_cistron_counts",
                "ids_attr": "mRNA_cistron_ids",
                "unit": "molecules",
            },
            "reaction_flux": {
                "table": "FBAResults",
                "column": "reactionFluxes",
                "ids_attr": "reactionIDs",
                "unit": "mmol/gDCW/h",
            },
            "exchange_flux": {
                "table": "FBAResults",
                "column": "externalExchangeFluxes",
                "ids_attr": "externalMoleculeIDs",
                "unit": "mmol/gDCW/h",
            },
            "metabolite_delta": {
                "table": "FBAResults",
                "column": "deltaMetabolites",
                "ids_attr": "metaboliteNames",
                "unit": "counts",
            },
            "metabolite_count": {
                "table": "EnzymeKinetics",
                "column": "metaboliteCountsFinal",
                "ids_attr": "metaboliteNames",
                "unit": "counts",
            },
            "aa_pool": {
                "table": "GrowthLimits",
                "column": "aaPoolSize",
                "ids_attr": "aaIds",
                "unit": "counts",
            },
        }

        if molecule_type not in type_config:
            raise ValueError(f"Unknown molecule_type: {molecule_type}")

        cfg = type_config[molecule_type]
        table_path = self.path / cfg["table"]
        if not table_path.exists():
            return {}

        # Read the ID list to build index mapping
        all_ids = self._read_attribute(cfg["table"], cfg["ids_attr"])
        if all_ids is None:
            return {}

        id_to_idx = {mid: i for i, mid in enumerate(all_ids)}

        # Also build a bare-name index (strip compartment tags like [c], [i])
        bare_to_full = {}
        for mid in all_ids:
            bare = re.sub(r'\[.*?\]$', '', mid)
            if bare not in bare_to_full:
                bare_to_full[bare] = mid

        # Find which requested IDs exist (try exact match, then bare-name)
        valid = []
        for mid in molecule_ids:
            if mid in id_to_idx:
                valid.append((mid, id_to_idx[mid]))
            elif mid in bare_to_full:
                full_id = bare_to_full[mid]
                valid.append((mid, id_to_idx[full_id]))
        if not valid:
            return {}

        # Read time vector
        time_arr = self._read_column(cfg["table"], "time")
        if time_arr is None:
            time_arr = self._read_column("Mass", "time")
        if time_arr is None:
            return {}

        # Read the data column (full matrix, then slice)
        indices = [idx for _, idx in valid]
        try:
            data = read_column_slice(table_path, cfg["column"], indices)
        except Exception as e:
            logger.warning("Failed to read %s/%s: %s", cfg["table"], cfg["column"], e)
            return {}

        # data shape: (T, len(indices))
        result = {}
        for i, (mid, _) in enumerate(valid):
            if data.ndim == 2:
                vals = data[:, i]
            else:
                vals = data
            n = min(len(time_arr), len(vals))
            result[mid] = {
                "time": time_arr[:n],
                "values": vals[:n],
                "unit": cfg["unit"],
            }

        return result

    def get_molecule_summary(self, molecule_type):
        """Get summary statistics for all molecules of a given type."""
        type_info = {
            "protein": ("MonomerCounts", "monomerIds",
                        ["monomerCounts", "freeMonomerCounts",
                         "monomersElongated", "monomersDegraded"]),
            "mRNA": ("RNACounts", "mRNA_ids",
                     ["mRNA_counts", "full_mRNA_counts", "partial_mRNA_counts"]),
            "rRNA": ("RNACounts", "rRNA_ids", ["partial_rRNA_counts"]),
            "mRNA_cistron": ("RNACounts", "mRNA_cistron_ids",
                             ["mRNA_cistron_counts", "full_mRNA_cistron_counts",
                              "partial_mRNA_cistron_counts"]),
            "reaction_flux": ("FBAResults", "reactionIDs", ["reactionFluxes"]),
            "exchange_flux": ("FBAResults", "externalMoleculeIDs", ["externalExchangeFluxes"]),
            "metabolite_delta": ("FBAResults", "metaboliteNames", ["deltaMetabolites"]),
            "metabolite_count": ("EnzymeKinetics", "metaboliteNames", ["metaboliteCountsFinal"]),
            "aa_pool": ("GrowthLimits", "aaIds", ["aaPoolSize"]),
        }

        if molecule_type not in type_info:
            return {"error": f"Unknown type: {molecule_type}"}

        table_name, ids_attr, columns = type_info[molecule_type]
        ids = self._read_attribute(table_name, ids_attr)
        if ids is None:
            return {"count": 0, "ids": [], "columns": []}

        table_path = self.path / table_name
        available_cols = []
        if table_path.exists():
            try:
                existing = list_columns(table_path)
                available_cols = [c for c in columns if c in existing]
            except Exception:
                pass

        return {
            "count": len(ids),
            "ids": ids[:50],
            "total_ids": len(ids),
            "columns": available_cols,
        }

    # -- Parquet export ------------------------------------------------------

    def to_timeseries_dict(self):
        """Convert mass time-series to a list of dicts suitable for JSON/Parquet."""
        mass = self.extract_mass_timeseries()
        if "time" not in mass:
            return []

        n = len(mass["time"])
        rows = []
        for i in range(n):
            row = {}
            for key, arr in mass.items():
                if arr is not None and i < len(arr):
                    val = arr[i]
                    if hasattr(val, '__len__') and len(val) > 1:
                        row[key] = float(np.sum(val))
                    else:
                        row[key] = float(val)
            rows.append(row)
        return rows

    def export_parquet(self, output_path):
        """Export mass time-series to a Parquet file for HuggingFace."""
        try:
            import pyarrow as pa
            import pyarrow.parquet as pq
        except ImportError:
            logger.warning("pyarrow not available -- falling back to CSV export")
            self._export_csv(output_path)
            return

        rows = self.to_timeseries_dict()
        if not rows:
            logger.warning("No time-series data to export")
            return

        table = pa.Table.from_pylist(rows)
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        pq.write_table(table, str(output_path), compression="snappy")
        logger.info("Exported %d rows to %s", len(rows), output_path)

    def _export_csv(self, output_path):
        """Fallback CSV export when pyarrow is unavailable."""
        import csv

        rows = self.to_timeseries_dict()
        if not rows:
            return

        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)

        with open(output_path, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=rows[0].keys())
            writer.writeheader()
            writer.writerows(rows)
        logger.info("Exported %d rows to %s (CSV fallback)", len(rows), output_path)


def find_sim_outs(run_dir):
    """Find all simOut directories under a run directory."""
    run_dir = Path(run_dir)
    return sorted(run_dir.rglob("simOut"))


def parse_sim_out_path(sim_out_path):
    """Extract seed and generation info from a simOut path."""
    parts = sim_out_path.parts
    result = {"variant_dir": "", "seed": 0, "generation": 0}

    for i, part in enumerate(parts):
        if part == "simOut" and i >= 4:
            try:
                result["generation"] = int(parts[i - 2].split("_")[1])
            except (IndexError, ValueError):
                pass
            try:
                result["seed"] = int(parts[i - 3])
            except (IndexError, ValueError):
                pass
            try:
                result["variant_dir"] = parts[i - 4]
            except IndexError:
                pass
            break

    return result
