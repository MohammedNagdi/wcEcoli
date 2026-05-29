"""Application configuration — reads from environment variables with sensible defaults."""

from pathlib import Path
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    reconstruction_path: Path = Path("/data/reconstruction")
    models_path: Path = Path("/data/models")
    database_path: Path = Path("/app/data/wcecoli.db")
    wcecoli_root: Path = Path("/data")

    # Simulation settings
    sim_output_dir: Path = Path("/data/out")     # where simulation outputs go
    docker_image: str = "wcecoli-sim:latest"     # Docker image for simulation worker
    worker_poll_interval: int = 5                # seconds between job polls
    log_tail_lines: int = 200                    # lines of log to keep in DB

    # Derived paths for key data files
    @property
    def genes_tsv(self) -> Path:
        return self.reconstruction_path / "ecoli" / "flat" / "genes.tsv"

    @property
    def fold_changes_tsv(self) -> Path:
        return self.reconstruction_path / "ecoli" / "flat" / "fold_changes.tsv"

    @property
    def amino_acid_pathways_tsv(self) -> Path:
        return self.reconstruction_path / "ecoli" / "flat" / "amino_acid_pathways.tsv"

    @property
    def condition_defs_tsv(self) -> Path:
        return self.reconstruction_path / "ecoli" / "flat" / "condition" / "condition_defs.tsv"

    @property
    def tf_condition_tsv(self) -> Path:
        return self.reconstruction_path / "ecoli" / "flat" / "condition" / "tf_condition.tsv"

    @property
    def timelines_def_tsv(self) -> Path:
        return self.reconstruction_path / "ecoli" / "flat" / "condition" / "timelines_def.tsv"

    @property
    def media_recipes_tsv(self) -> Path:
        return self.reconstruction_path / "ecoli" / "flat" / "condition" / "media_recipes.tsv"

    @property
    def proteins_tsv(self) -> Path:
        return self.reconstruction_path / "ecoli" / "flat" / "proteins.tsv"

    @property
    def complexation_reactions_tsv(self) -> Path:
        return self.reconstruction_path / "ecoli" / "flat" / "complexation_reactions.tsv"

    @property
    def rnas_tsv(self) -> Path:
        return self.reconstruction_path / "ecoli" / "flat" / "rnas.tsv"

    @property
    def transcription_units_tsv(self) -> Path:
        return self.reconstruction_path / "ecoli" / "flat" / "transcription_units.tsv"

    @property
    def transcription_units_removed_tsv(self) -> Path:
        return self.reconstruction_path / "ecoli" / "flat" / "transcription_units_removed.tsv"

    @property
    def transcription_units_added_tsv(self) -> Path:
        return self.reconstruction_path / "ecoli" / "flat" / "transcription_units_added.tsv"

    @property
    def transcription_units_modified_tsv(self) -> Path:
        return self.reconstruction_path / "ecoli" / "flat" / "transcription_units_modified.tsv"

    @property
    def transcription_factors_tsv(self) -> Path:
        return self.reconstruction_path / "ecoli" / "flat" / "transcription_factors.tsv"

    @property
    def variants_dir(self) -> Path:
        return self.models_path / "ecoli" / "sim" / "variants"

    model_config = {"env_prefix": "", "case_sensitive": False}


settings = Settings()
