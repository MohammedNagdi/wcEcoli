"""Application configuration: reads from environment variables with sensible defaults."""

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
    parca_cpus: int = 8                          # processes used by parallel Parca stages
    parca_lock_timeout: int = 3600                # seconds to wait for another Parca worker

    # Local-first distribution and optional artifact bootstrap
    artifact_bootstrap_source: str = ""          # optional source label, e.g. "huggingface"
    artifact_bootstrap_repo: str = ""            # optional artifact repository/path

    # Optional BYOK/local LLM provider configuration. Values are never returned by API.
    openai_api_key: str = ""
    anthropic_api_key: str = ""
    openrouter_api_key: str = ""
    ollama_base_url: str = ""
    lm_studio_base_url: str = ""
    vllm_base_url: str = ""
    assistant_provider: str = ""                 # optional default provider id, e.g. openai
    assistant_model: str = ""                    # optional default chat model
    assistant_request_timeout_sec: int = 30
    # Local runtimes (Ollama / LM Studio / vLLM) must load large weights on the first call
    # and reason more with tools attached; give them a much higher per-call ceiling.
    assistant_local_timeout_sec: int = 300
    # Keep a local model resident between the agent loop's turns to avoid cold reloads.
    assistant_ollama_keep_alive: str = "30m"
    # Context window sent to Ollama. Bounded (not the model's 32k max) so the KV cache stays small
    # and predictable; large enough for our system prompt + tool results + a few turns.
    assistant_ollama_num_ctx: int = 8192
    # Cap on observe->act->observe iterations per user turn.
    assistant_max_agent_turns: int = 6
    # Context compaction: keep this many recent turns verbatim; summarize older ones once at least
    # `compact_threshold` uncompacted older turns accumulate. Optional model override for the summary.
    assistant_keep_recent_turns: int = 12
    assistant_compact_threshold: int = 6
    assistant_summary_model: str = ""
    # Approx token budget for verbatim recent history in a turn (chars ≈ tokens * 4).
    assistant_context_token_budget: int = 3500
    # How long an approved confirmation stays valid before it must be re-confirmed.
    assistant_confirmation_ttl_sec: int = 900

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
    def environment_molecules_tsv(self) -> Path:
        return self.reconstruction_path / "ecoli" / "flat" / "condition" / "environment_molecules.tsv"

    @property
    def timelines_def_tsv(self) -> Path:
        return self.reconstruction_path / "ecoli" / "flat" / "condition" / "timelines_def.tsv"

    @property
    def media_recipes_tsv(self) -> Path:
        return self.reconstruction_path / "ecoli" / "flat" / "condition" / "media_recipes.tsv"

    @property
    def condition_media_dir(self) -> Path:
        return self.reconstruction_path / "ecoli" / "flat" / "condition" / "media"

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
