"""SQLModel ORM models for wcEcoli reconstruction data."""

from typing import Optional
from sqlalchemy import UniqueConstraint
from sqlmodel import Field, SQLModel


class Gene(SQLModel, table=True):
    __tablename__ = "genes"

    id: int = Field(primary_key=True)
    ecoli_id: str = Field(index=True)           # EcoCyc ID, e.g. "EG10001"
    symbol: str = Field(index=True)              # gene symbol, e.g. "alr"
    synonyms: str = ""                           # JSON array of synonyms
    left_end_pos: Optional[int] = None
    right_end_pos: Optional[int] = None
    direction: Optional[str] = None              # "+" or "-"
    rna_ids: str = ""                            # JSON array
    category: str = "other"                      # functional category
    ko_index: int = 0                            # index for gene_knockout variant
    is_mechanistic: bool = False                 # True if gene has downstream mechanistic effects
    monomer_id: Optional[str] = None             # protein monomer ID, e.g. "6PFK-1-MONOMER"
    monomer_name: Optional[str] = None           # protein common name, e.g. "6-phosphofructokinase 1"
    complex_ids: str = ""                        # JSON array of complex IDs this monomer participates in


class TFEdge(SQLModel, table=True):
    __tablename__ = "tf_edges"

    id: Optional[int] = Field(default=None, primary_key=True)
    tf_symbol: str = Field(index=True)
    target_symbol: str = Field(index=True)
    log2fc_mean: float = 0.0
    log2fc_std: Optional[float] = None
    regulation_direct: str = ""


class AAPathway(SQLModel, table=True):
    __tablename__ = "aa_pathways"

    id: Optional[int] = Field(default=None, primary_key=True)
    amino_acid: str = Field(index=True)
    enzymes: str = ""                            # JSON array of complex IDs
    reverse_enzymes: str = ""                    # JSON array
    kcat: Optional[float] = None
    ki_lower: Optional[float] = None
    ki_upper: Optional[float] = None
    upstream_aas: str = "{}"                     # JSON dict
    downstream_aas: str = "{}"                   # JSON dict
    notes: str = ""


class Condition(SQLModel, table=True):
    __tablename__ = "conditions"

    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(index=True)
    nutrients: str = ""
    genotype_perturbations: str = ""
    doubling_time: Optional[float] = None
    active_tfs: str = ""
    inactive_tfs: str = ""


class Timeline(SQLModel, table=True):
    __tablename__ = "timelines"

    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(index=True)
    definition: str = ""                         # JSON of timeline steps


class MediaRecipe(SQLModel, table=True):
    __tablename__ = "media_recipes"

    id: Optional[int] = Field(default=None, primary_key=True)
    media_id: str = Field(index=True)            # key used in timeline event strings, e.g. "minimal_acetate"
    base_media: str = ""                         # base stock, e.g. "MIX0-57"
    added_media: str = ""                        # supplemental stock, e.g. "5X_supplement_EZ"
    ingredients: str = ""                        # JSON array of extra molecule IDs


class UserTimeline(SQLModel, table=True):
    __tablename__ = "user_timelines"

    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(index=True)                # user-given name
    definition: str = ""                         # raw event string e.g. "0 minimal, 1200 minimal_acetate"
    created_at: str = ""                         # ISO timestamp


class BuilderSectionDraft(SQLModel, table=True):
    __tablename__ = "builder_section_drafts"

    id: Optional[int] = Field(default=None, primary_key=True)
    section: str = Field(index=True)             # media | mediaRecipe | condition | tfCondition | timeline
    name: str = Field(index=True)                # user-owned draft label within a section
    payload: str = "{}"                          # JSON snapshot of the section state
    status: str = "draft"                        # draft | published
    created_at: str = ""                         # ISO timestamp
    updated_at: str = ""                         # ISO timestamp
    published_at: str = ""                       # ISO timestamp
    published_name: str = ""                     # canonical name after publish


class AssistantConversation(SQLModel, table=True):
    __tablename__ = "assistant_conversations"

    id: Optional[int] = Field(default=None, primary_key=True)
    title: str = Field(index=True)
    assistant_surface: str = Field(index=True)
    status: str = "open"                         # open | archived
    provider_id: str = ""
    model: str = ""
    created_at: str = ""                         # ISO timestamp
    updated_at: str = ""                         # ISO timestamp


class AssistantMessage(SQLModel, table=True):
    __tablename__ = "assistant_messages"

    id: Optional[int] = Field(default=None, primary_key=True)
    conversation_id: int = Field(index=True)
    role: str = Field(index=True)                # user | assistant | system
    content: str = ""
    context_json: str = "{}"                     # sanitized route/page context
    status: str = "stored"                       # stored | blocked_not_enabled
    created_at: str = ""                         # ISO timestamp


class AssistantToolCall(SQLModel, table=True):
    __tablename__ = "assistant_tool_calls"

    id: Optional[int] = Field(default=None, primary_key=True)
    conversation_id: int = Field(index=True)
    message_id: Optional[int] = Field(default=None, index=True)
    tool_name: str = Field(index=True)
    status: str = "proposed"                     # proposed | pending_confirmation | executed | rejected | failed
    arguments_json: str = "{}"                   # typed tool arguments snapshot
    result_json: str = "{}"                      # typed tool result/error snapshot
    created_at: str = ""                         # ISO timestamp
    updated_at: str = ""                         # ISO timestamp


class AssistantConfirmation(SQLModel, table=True):
    __tablename__ = "assistant_confirmations"

    id: Optional[int] = Field(default=None, primary_key=True)
    conversation_id: Optional[int] = Field(default=None, index=True)
    tool_call_id: Optional[int] = Field(default=None, index=True)
    action: str = Field(index=True)
    status: str = "pending"                      # pending | approved | rejected | cancelled | used
    payload_json: str = "{}"                     # action payload shown to the user
    note: str = ""
    nonce: str = ""                              # random token bound to this confirmation (anti-replay)
    expires_at: str = ""                         # ISO timestamp after which approval is invalid
    created_at: str = ""                         # ISO timestamp
    resolved_at: str = ""                        # ISO timestamp


class AssistantProvenance(SQLModel, table=True):
    __tablename__ = "assistant_provenance"

    id: Optional[int] = Field(default=None, primary_key=True)
    conversation_id: Optional[int] = Field(default=None, index=True)
    message_id: Optional[int] = Field(default=None, index=True)
    provider_id: str = ""
    model: str = ""
    prompt_hash: str = ""
    request_json: str = "{}"                     # sanitized prompt/context metadata
    response_json: str = "{}"                    # sanitized response/tool metadata
    created_at: str = ""                         # ISO timestamp


class AssistantRuntimeSettings(SQLModel, table=True):
    """Single-row, UI-editable runtime knobs that override the environment defaults."""
    __tablename__ = "assistant_runtime_settings"

    id: Optional[int] = Field(default=1, primary_key=True)
    request_timeout_sec: int = 30
    local_timeout_sec: int = 300
    ollama_keep_alive: str = "30m"
    max_agent_turns: int = 6
    keep_recent_turns: int = 12
    compact_threshold: int = 6
    context_token_budget: int = 3500
    confirmation_ttl_sec: int = 900
    summary_model: str = ""
    updated_at: str = ""


class AssistantProviderConfig(SQLModel, table=True):
    __tablename__ = "assistant_provider_configs"

    id: Optional[int] = Field(default=None, primary_key=True)
    provider_id: str = Field(index=True)          # openai | anthropic | ollama | ...
    label: str = ""
    secret_value: str = ""                        # local-only; never returned by API; encrypted at rest
    secret_encrypted: bool = False                # whether secret_value is ciphertext
    endpoint_url: str = ""
    model: str = ""
    is_active: bool = False
    created_at: str = ""                         # ISO timestamp
    updated_at: str = ""                         # ISO timestamp


class AssistantProviderModel(SQLModel, table=True):
    __tablename__ = "assistant_provider_models"
    __table_args__ = (UniqueConstraint("provider_id", "model_id"),)

    id: Optional[int] = Field(default=None, primary_key=True)
    provider_id: str = Field(index=True)
    model_id: str = Field(index=True)
    is_builtin: bool = False
    created_at: str = ""
    updated_at: str = ""


class Variant(SQLModel, table=True):
    __tablename__ = "variants"

    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(index=True)
    docstring: str = ""
    filename: str = ""
    parameter_count: Optional[int] = None


class Complex(SQLModel, table=True):
    __tablename__ = "complexes"

    id: Optional[int] = Field(default=None, primary_key=True)
    reaction_id: str = Field(index=True)
    complex_id: str = Field(index=True)
    stoichiometry: str = ""                      # JSON dict
    name: str = ""


class Experiment(SQLModel, table=True):
    __tablename__ = "experiments"

    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(index=True)
    description: str = ""
    variant_type: str = ""                       # e.g. "gene_knockout"
    variant_index: int = 0                       # e.g. 884 for rpoB
    condition: str = "basal"                     # growth condition name
    timeline: str = ""                           # timeline name (if any)
    sim_params: str = "{}"                       # JSON: seeds, timesteps, etc.
    status: str = "draft"                        # draft | queued | running | done | failed
    created_at: str = ""                         # ISO timestamp
    updated_at: str = ""                         # ISO timestamp
    gene_symbol: str = ""                        # for gene_knockout: the target gene
    batch_id: str = ""                           # UUID grouping batch-created experiments


class SimulationJob(SQLModel, table=True):
    """Tracks a single simulation run through the Docker pipeline."""
    __tablename__ = "simulation_jobs"

    id: Optional[int] = Field(default=None, primary_key=True)
    experiment_id: int = Field(index=True)       # FK to experiments.id
    status: str = "pending"                      # pending | running_parca | running_sim | ingesting | done | failed
    phase: str = ""                              # current phase description for UI
    sim_dir: str = ""                            # e.g. "out/20260510_120000_rpoB_KO"
    docker_container_id: str = ""                # for cancellation
    log_tail: str = ""                           # last N lines of stdout/stderr
    started_at: str = ""                         # ISO timestamp
    finished_at: str = ""                        # ISO timestamp
    error_message: str = ""                      # error detail on failure
    created_at: str = ""                         # ISO timestamp

    # Simulation parameters (denormalized from Experiment for worker independence)
    variant_type: str = ""
    variant_index: int = 0
    condition: str = "basal"                     # growth condition name
    seed: int = 0
    generations: int = 1
    timeline: str = ""


class SimulationResult(SQLModel, table=True):
    """Summary metrics extracted from a completed simulation."""
    __tablename__ = "simulation_results"

    id: Optional[int] = Field(default=None, primary_key=True)
    job_id: int = Field(index=True)              # FK to simulation_jobs.id
    experiment_id: int = Field(index=True)       # FK to experiments.id
    seed: int = 0
    generation: int = 0
    division_time_sec: Optional[float] = None    # time to cell division (None = never divided)
    final_mass_fg: Optional[float] = None        # cell mass at end of sim (fg)
    growth_rate: Optional[float] = None          # average growth rate (1/s)
    doubling_time_min: Optional[float] = None    # derived doubling time (min)
    divided: bool = True                         # did the cell divide?
    created_at: str = ""                         # ISO timestamp
