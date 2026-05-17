"""SQLModel ORM models for wcEcoli reconstruction data."""

from typing import Optional
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
    division_time_sec: Optional[float] = None    # time to cell division
    final_mass_fg: Optional[float] = None        # cell mass at division (fg)
    growth_rate: Optional[float] = None          # average growth rate (1/hr)
    doubling_time_min: Optional[float] = None    # observed doubling time (min)
    created_at: str = ""                         # ISO timestamp
