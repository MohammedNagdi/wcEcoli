"""Every knob, read once from the environment (see cluster/well4cell_env.sh)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _env(name: str, default: str) -> str:
    value = os.environ.get(name, "")
    return value if value.strip() else default


def _env_list(name: str, default: str) -> list[str]:
    return [item.strip() for item in _env(name, default).split(",") if item.strip()]


# The five families, keyed by campaign tier.
FAMILY_BY_TIER = {
    "T1": "wildtype_media",
    "T2": "single_knockout",
    "T3": "dynamic_media",
    "T4": "regulation",
    "T5": "double_knockout",
}
FAMILIES = list(FAMILY_BY_TIER.values())

# Scalar channels, in the order they appear in every product.
SCALAR_CHANNELS = (
    "cell_mass", "dry_mass", "protein_mass", "rna_mass", "dna_mass", "small_molecule_mass",
    "cell_volume", "growth_rate", "ppgpp_conc", "aa_supply_total", "aa_synthesis_total",
    "mrna_counts", "n_oric", "fba_objective", "exchange_flux_total", "reaction_flux_total",
    "ribosome_elongation_rate", "ribosome_actual_elongations",
)
INT_SCALARS = ("mrna_counts", "n_oric")
MATRIX_CHANNELS = ("mrna_counts_matrix", "protein_counts_matrix", "reaction_flux_matrix", "exchange_flux_matrix")
INT_MATRICES = ("mrna_counts_matrix", "protein_counts_matrix")
# Flux noise below this magnitude is numerical, not a negative flux.
FLUX_NOISE = 1e-6


@dataclass(frozen=True)
class Config:
    """One data product."""

    name: str
    stride: int
    matrices: tuple[str, ...]
    # Compressed bytes per row, used only to pack trajectories into files of about
    # W4C_FILE_TARGET_BYTES (pruned columns, zstd).
    bytes_per_row: int


# bytes_per_row was first measured on a 12-run fake reference; core/expression/metabolism are now
# measured on the campaign (below). Re-measure the *_1s configs
# (bytes / rows of the first real ok parts of each config, see `export status`) and update
# these before planning the full export. The strides are part of the published contract
# (the card and DESIGN.md say `expression`/`metabolism` are 10 s), so they are fixed here.
CONFIGS = {
    # core, expression, metabolism: measured on real parts 2026-10-08 (core 59.7 B/row on
    # wildtype_media, 58.9 on regulation; expression 2953 and metabolism 2895 on wildtype_media,
    # reaction flux 3,974/9,612 active columns). The *_1s figures are still the 12-run estimate.
    "core": Config("core", 1, (), 60),
    "expression": Config("expression", 10, ("mrna_counts_matrix", "protein_counts_matrix"), 2950),
    "metabolism": Config("metabolism", 10, ("reaction_flux_matrix", "exchange_flux_matrix"), 2900),
    "expression_1s": Config("expression_1s", 1, ("mrna_counts_matrix", "protein_counts_matrix"), 1250),
    "metabolism_1s": Config("metabolism_1s", 1, ("reaction_flux_matrix", "exchange_flux_matrix"), 2800),
}

# The per-trajectory summary (summarize.py, ADR 0010): one row per trajectory, computed from
# core. Deliberately not in CONFIGS: CONFIGS drives export planning and the index locator
# columns, and the summary is neither exported from channels.h5 nor located in the index.
SUMMARY_CONFIG = "summary"
# Statistics per scalar channel, in column order: <channel>_<stat>.
SUMMARY_STATS = ("mean", "min", "max", "first", "last")
# Cellarium's `translation_collapse`: mean ribosome elongation rate over the generation below
# this many aa/s, an order of magnitude below the slowest rate measured in E. coli (Dai et al.
# 2016). finalize counts `ribosome_elongation_rate_mean < COLLAPSE_RATE` in the summary config.
COLLAPSE_RATE = 1.0


@dataclass
class Settings:
    campaign_root: Path
    root: Path
    database: Path
    repo_id: str
    version: str
    token_path: Path
    hf_bin: str
    row_group_rows: int
    file_target_bytes: int
    compression: str
    split_seed: int
    partition: str
    accounts: list[str]
    cpus: int
    mem: str
    time_limit: str
    concurrency: int
    scan_shard_size: int
    job_prefix: str
    repo_root: Path
    # Command line of a python that can unpickle sim_data (wcecoli-sim); only deg-rates uses it.
    sim_python: str = ""

    @classmethod
    def from_env(cls) -> "Settings":
        repo_root = Path(__file__).resolve().parent.parent.parent
        root = _env("WCECOLI_CAMPAIGN_ROOT", "")
        if not root:
            raise SystemExit("WCECOLI_CAMPAIGN_ROOT is not set; source cluster/well4cell_env.sh")
        campaign_root = Path(root).expanduser()
        return cls(
            campaign_root=campaign_root,
            root=Path(_env("W4C_ROOT", str(campaign_root / "well4cell"))),
            database=Path(_env("DATABASE_PATH", str(campaign_root / "state" / "wcecoli.db"))),
            repo_id=_env("W4C_REPO_ID", "cSynBioSys/well4cell"),
            version=_env("W4C_VERSION", "1.0.0-rc1"),
            token_path=Path(_env("HF_TOKEN_PATH", "~/.config/huggingface/well4cell.token")).expanduser(),
            hf_bin=_env("WCECOLI_HF_BIN", "hf"),
            row_group_rows=int(_env("W4C_ROW_GROUP_ROWS", "2048")),
            file_target_bytes=int(_env("W4C_FILE_TARGET_BYTES", "2000000000")),
            compression=_env("W4C_COMPRESSION", "zstd"),
            split_seed=int(_env("W4C_SPLIT_SEED", "20261008")),
            partition=_env("W4C_PARTITION", "cpu-g2"),
            accounts=_env_list("W4C_ACCOUNTS", "cpu-g2-amath,cpu-g2-stf"),
            cpus=int(_env("W4C_CPUS", "2")),
            mem=_env("W4C_MEM", "4G"),
            time_limit=_env("W4C_TIME", "04:00:00"),
            concurrency=int(_env("W4C_CONCURRENCY", "32")),
            scan_shard_size=int(_env("W4C_SCAN_SHARD_SIZE", "200")),
            job_prefix=_env("W4C_JOB_PREFIX", "w4c"),
            repo_root=repo_root,
            sim_python=_env("W4C_SIM_PYTHON", ""),
        )

    # -- layout ---------------------------------------------------------------
    @property
    def out_dir(self) -> Path:
        return self.campaign_root / "out"

    @property
    def build_dir(self) -> Path:
        return self.root / "build"

    @property
    def repo_dir(self) -> Path:
        return self.root / "repo"

    @property
    def manifest_dir(self) -> Path:
        return self.build_dir / "manifests"

    @property
    def log_dir(self) -> Path:
        return self.build_dir / "logs"

    @property
    def scan_dir(self) -> Path:
        return self.build_dir / "scan"

    @property
    def ledger(self) -> Path:
        return self.build_dir / "ledger.jsonl"

    @property
    def dispatch_log(self) -> Path:
        return self.build_dir / "dispatch_log.jsonl"

    @property
    def index_path(self) -> Path:
        return self.repo_dir / "index.parquet"

    @property
    def reference_dir(self) -> Path:
        return self.repo_dir / "provenance" / "reference"

    def config(self, name: str) -> Config:
        if name not in CONFIGS:
            raise SystemExit("unknown config {!r}; choose from {}".format(name, ", ".join(CONFIGS)))
        return CONFIGS[name]

    def ensure_layout(self) -> None:
        for path in (self.manifest_dir, self.log_dir, self.scan_dir, self.repo_dir / "data",
                     self.repo_dir / "stats", self.reference_dir):
            path.mkdir(parents=True, exist_ok=True)
