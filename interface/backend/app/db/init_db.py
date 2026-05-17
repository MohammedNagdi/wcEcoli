"""Parse wcEcoli reconstruction TSV files into SQLite on startup.

Runs once when the database doesn't exist or when source files are newer.
"""

import ast
import csv
import json
import logging
import re
from pathlib import Path
from typing import Any

from sqlmodel import Session, SQLModel, create_engine

from app.config import settings
from app.db.models import (
    AAPathway, Complex, Condition, Experiment, Gene, SimulationJob,
    SimulationResult, TFEdge, Timeline, Variant,
)

logger = logging.getLogger(__name__)

# ── Gene functional categorization ────────────────────────────────────────
#
# Uses three layers (checked in priority order):
#   1. Reconstruction-derived: tRNA/rRNA genes from rnas.tsv, TF genes from
#      transcription_factors.tsv
#   2. Symbol prefix: comprehensive mapping of E. coli gene naming to
#      functional subsystems
#   3. Pattern-based: "y" + 3 letters → uncharacterized, ins/tra → mobile
#
# This replaces the previous prefix-only approach that put ~88% of genes
# into "other".

CATEGORY_PREFIXES: dict[str, str] = {
    # ── Amino acid biosynthesis ──
    "arg": "amino_acid_biosynthesis", "his": "amino_acid_biosynthesis",
    "trp": "amino_acid_biosynthesis", "tyr": "amino_acid_biosynthesis",
    "phe": "amino_acid_biosynthesis", "leu": "amino_acid_biosynthesis",
    "ilv": "amino_acid_biosynthesis", "met": "amino_acid_biosynthesis",
    "cys": "amino_acid_biosynthesis", "thr": "amino_acid_biosynthesis",
    "ser": "amino_acid_biosynthesis", "pro": "amino_acid_biosynthesis",
    "lys": "amino_acid_biosynthesis", "dap": "amino_acid_biosynthesis",
    "ala": "amino_acid_biosynthesis", "asn": "amino_acid_biosynthesis",
    "glt": "amino_acid_biosynthesis", "gln": "amino_acid_biosynthesis",
    "gly": "amino_acid_biosynthesis", "aro": "amino_acid_biosynthesis",
    "asp": "amino_acid_biosynthesis",
    # ── Central carbon (glycolysis, TCA, pentose phosphate) ──
    "acs": "central_carbon", "ace": "central_carbon",
    "fba": "central_carbon", "fum": "central_carbon",
    "gap": "central_carbon", "glk": "central_carbon",
    "gpm": "central_carbon", "icd": "central_carbon",
    "mdh": "central_carbon", "pck": "central_carbon",
    "pfk": "central_carbon", "pgi": "central_carbon",
    "pgk": "central_carbon", "ppc": "central_carbon",
    "pps": "central_carbon", "pta": "central_carbon",
    "pyk": "central_carbon", "sdh": "central_carbon",
    "suc": "central_carbon", "tal": "central_carbon",
    "tkt": "central_carbon", "eno": "central_carbon",
    "zwf": "central_carbon", "gnd": "central_carbon",
    "edd": "central_carbon", "eda": "central_carbon",
    "glc": "central_carbon", "ack": "central_carbon",
    # ── Electron transport / energy ──
    "nuo": "energy", "cyo": "energy", "cyd": "energy",
    "atp": "energy", "ndh": "energy", "app": "energy",
    # ── Transcription machinery ──
    "rpo": "transcription", "nus": "transcription",
    "gre": "transcription", "rho": "transcription",
    "mfd": "transcription", "dks": "transcription",
    "sig": "transcription",
    # ── Translation / ribosome ──
    "rps": "translation", "rpl": "translation",
    "rpm": "translation", "inf": "translation",
    "fus": "translation", "tuf": "translation",
    "tsf": "translation", "prf": "translation",
    "rim": "translation",
    # ── DNA replication / repair ──
    "dna": "dna_replication", "gyr": "dna_replication",
    "top": "dna_replication", "lig": "dna_replication",
    "ssb": "dna_replication", "dam": "dna_replication",
    "rec": "dna_replication", "mut": "dna_replication",
    "uvr": "dna_replication", "lex": "dna_replication",
    "xer": "dna_replication", "din": "dna_replication",
    "pol": "dna_replication", "pri": "dna_replication",
    # ── Cell envelope / membrane / LPS / peptidoglycan ──
    "mur": "cell_envelope", "mra": "cell_envelope",
    "lpp": "cell_envelope", "omp": "cell_envelope",
    "lpt": "cell_envelope", "lps": "cell_envelope",
    "waa": "cell_envelope", "mrd": "cell_envelope",
    # ── Cell division ──
    "fts": "cell_division", "min": "cell_division",
    "zip": "cell_division", "sul": "cell_division",
    # ── Transport ──
    "abc": "transport", "mod": "transport", "pst": "transport",
    "pot": "transport", "mal": "transport", "man": "transport",
    "mdt": "transport", "emr": "transport", "acr": "transport",
    "tol": "transport", "ton": "transport", "exb": "transport",
    "fep": "transport", "fhu": "transport", "fec": "transport",
    "ent": "transport", "pts": "transport", "nar": "transport",
    "nir": "transport", "nap": "transport",
    # ── Nucleotide metabolism ──
    "pur": "nucleotide_metabolism", "pyr": "nucleotide_metabolism",
    "car": "nucleotide_metabolism", "ndk": "nucleotide_metabolism",
    "nrd": "nucleotide_metabolism", "thy": "nucleotide_metabolism",
    "dut": "nucleotide_metabolism", "adk": "nucleotide_metabolism",
    "gmk": "nucleotide_metabolism", "cmk": "nucleotide_metabolism",
    "tmk": "nucleotide_metabolism", "gua": "nucleotide_metabolism",
    # ── Lipid / fatty acid metabolism ──
    "fab": "lipid_metabolism", "acc": "lipid_metabolism",
    "pls": "lipid_metabolism", "fad": "lipid_metabolism",
    # ── Cofactor / vitamin biosynthesis ──
    "bio": "cofactor_biosynthesis", "nad": "cofactor_biosynthesis",
    "fol": "cofactor_biosynthesis", "thi": "cofactor_biosynthesis",
    "rib": "cofactor_biosynthesis", "cob": "cofactor_biosynthesis",
    "men": "cofactor_biosynthesis", "ubi": "cofactor_biosynthesis",
    "hem": "cofactor_biosynthesis", "pdx": "cofactor_biosynthesis",
    "pan": "cofactor_biosynthesis", "lip": "cofactor_biosynthesis",
    "isu": "cofactor_biosynthesis", "isc": "cofactor_biosynthesis",
    "suf": "cofactor_biosynthesis", "moa": "cofactor_biosynthesis",
    "mob": "cofactor_biosynthesis", "moe": "cofactor_biosynthesis",
    "mog": "cofactor_biosynthesis",
    # ── Stress response / chaperone / protease ──
    "gro": "stress_response",
    "clp": "stress_response", "lon": "stress_response",
    "hsl": "stress_response", "htp": "stress_response",
    "ibp": "stress_response", "osr": "stress_response",
    "sox": "stress_response", "oxy": "stress_response",
    "csp": "stress_response", "hde": "stress_response",
    "spy": "stress_response", "deg": "stress_response",
    # ── Flagella / motility / chemotaxis ──
    "flg": "motility", "flh": "motility", "fli": "motility",
    "mot": "motility", "che": "motility", "tar": "motility",
    "tsr": "motility", "aer": "motility",
}

# Sort prefixes longest-first so "aspA" matches "asp" not "as"
_SORTED_PREFIXES = sorted(CATEGORY_PREFIXES.items(), key=lambda p: len(p[0]), reverse=True)


def _load_reconstruction_categories(flat_dir: Path) -> dict[str, str]:
    """Build gene_symbol → category map from reconstruction TSV files.

    Reads rnas.tsv (for tRNA/rRNA genes) and transcription_factors.tsv
    (for TF genes with known binding mechanisms).
    """
    overrides: dict[str, str] = {}

    # ── gene_id → symbol lookup ──
    gene_id_to_sym: dict[str, str] = {}
    genes_path = flat_dir / "genes.tsv"
    if genes_path.exists():
        with open(genes_path, encoding="utf-8") as f:
            for line in f:
                if line.startswith("#") or line.startswith('"id"'):
                    continue
                parts = line.rstrip("\n").split("\t")
                if len(parts) >= 2:
                    gene_id_to_sym[_strip_quotes(parts[0])] = _strip_quotes(parts[1])

    # ── tRNA / rRNA genes from rnas.tsv ──
    rnas_path = flat_dir / "rnas.tsv"
    if rnas_path.exists():
        with open(rnas_path, encoding="utf-8") as f:
            for line in f:
                if line.startswith("#") or line.startswith('"id"'):
                    continue
                parts = line.rstrip("\n").split("\t")
                if len(parts) >= 6:
                    rna_type = _strip_quotes(parts[3])
                    gene_id = _strip_quotes(parts[5])
                    sym = gene_id_to_sym.get(gene_id, "")
                    if sym and rna_type == "tRNA":
                        overrides[sym] = "trna"
                    elif sym and rna_type == "rRNA":
                        overrides[sym] = "rrna"

    # ── Transcription factor genes ──
    tf_path = flat_dir / "transcription_factors.tsv"
    if tf_path.exists():
        with open(tf_path, encoding="utf-8") as f:
            header = None
            for line in f:
                if line.startswith("#"):
                    continue
                parts = line.rstrip("\n").split("\t")
                if header is None:
                    header = [_strip_quotes(h) for h in parts]
                    continue
                row = {
                    header[i]: _strip_quotes(parts[i]) if i < len(parts) else ""
                    for i in range(len(header))
                }
                sym = row.get("TF", "")
                has_mechanism = row.get("oneComponentId", "") or row.get("twoComponentId", "")
                if sym and has_mechanism:
                    # Don't override if already classified as something more specific
                    if sym not in overrides:
                        overrides[sym] = "regulation"

    logger.info(
        "Loaded reconstruction categories: %d tRNA, %d rRNA, %d TF genes",
        sum(1 for v in overrides.values() if v == "trna"),
        sum(1 for v in overrides.values() if v == "rrna"),
        sum(1 for v in overrides.values() if v == "regulation"),
    )
    return overrides


# Module-level cache for reconstruction-derived overrides
_recon_categories: dict[str, str] | None = None


def _get_recon_categories() -> dict[str, str]:
    """Lazily load reconstruction-derived gene categories."""
    global _recon_categories
    if _recon_categories is None:
        flat_dir = settings.genes_tsv.parent
        _recon_categories = _load_reconstruction_categories(flat_dir)
    return _recon_categories


def _categorize_gene(symbol: str) -> str:
    """Assign functional category using reconstruction data + prefix rules.

    Priority order:
      1. Reconstruction-derived (tRNA, rRNA, TF genes)
      2. Symbol prefix matching (longest prefix wins)
      3. Pattern-based heuristics (y-genes → uncharacterized, ins/tra → mobile)
      4. Fallback → "other"
    """
    recon = _get_recon_categories()

    # Priority 1: reconstruction-derived
    if symbol in recon:
        return recon[symbol]

    # Priority 2: prefix-based
    sym_lower = symbol.lower()
    for prefix, category in _SORTED_PREFIXES:
        if sym_lower.startswith(prefix):
            return category

    # Priority 3: pattern-based heuristics
    # y-genes (yaaA, ybcD, etc.) are uncharacterized / hypothetical
    if sym_lower.startswith("y") and len(symbol) <= 4:
        return "uncharacterized"
    # Insertion sequence / transposon genes
    if sym_lower.startswith("ins") or sym_lower.startswith("tra"):
        return "mobile_element"

    return "other"


_HTML_TAG_RE = re.compile(r"<[^>]+>")

# Categories whose genes have mechanistic downstream effects in the model
# (not just transcribed/translated/degraded but actually *do something*)
MECHANISTIC_CATEGORIES = frozenset({
    "amino_acid_biosynthesis", "transport", "cofactor_biosynthesis",
    "regulation", "trna", "translation", "central_carbon",
    "dna_replication", "energy", "lipid_metabolism", "rrna",
    "cell_division", "transcription", "nucleotide_metabolism",
    "cell_envelope", "stress_response", "motility",
})


def _strip_html(val: str) -> str:
    """Strip HTML tags from a string (e.g. '<i>leuZ</i>' → 'leuZ')."""
    return _HTML_TAG_RE.sub("", val)


def _strip_quotes(val: str) -> str:
    """Remove surrounding double quotes from TSV field."""
    if val.startswith('"') and val.endswith('"'):
        return val[1:-1]
    return val


def _safe_float(val: str) -> float | None:
    val = _strip_quotes(val).strip()
    if not val or val == "NaN" or val == "null":
        return None
    try:
        return float(val)
    except ValueError:
        return None


def _safe_int(val: str) -> int | None:
    val = _strip_quotes(val).strip()
    if not val or val == "null":
        return None
    try:
        return int(val)
    except ValueError:
        return None


def _read_tsv_rows(path: Path) -> list[list[str]]:
    """Read TSV file, skipping comment lines (starting with #)."""
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            if line.startswith("#"):
                continue
            rows.append(line.rstrip("\n").split("\t"))
    return rows


def _ingest_genes(session: Session) -> int:
    """Parse genes.tsv → genes table."""
    rows = _read_tsv_rows(settings.genes_tsv)
    if not rows:
        return 0
    # First row is header
    header = rows[0]
    count = 0
    for idx, row in enumerate(rows[1:]):
        symbol = _strip_html(_strip_quotes(row[1]))
        left = _safe_int(row[3])
        right = _safe_int(row[4])
        cat = _categorize_gene(symbol)
        gene = Gene(
            id=idx,  # 0-based index = knockout variant index
            ecoli_id=_strip_quotes(row[0]),
            symbol=symbol,
            synonyms=row[2] if len(row) > 2 else "",
            left_end_pos=left,
            right_end_pos=right,
            direction=_strip_quotes(row[5]) if len(row) > 5 else None,
            rna_ids=row[6] if len(row) > 6 else "",
            category=cat,
            ko_index=idx,
            is_mechanistic=(cat in MECHANISTIC_CATEGORIES),
        )
        session.add(gene)
        count += 1
    session.commit()
    logger.info("Ingested %d genes", count)
    return count


def _ingest_tf_edges(session: Session) -> int:
    """Parse fold_changes.tsv → tf_edges table."""
    rows = _read_tsv_rows(settings.fold_changes_tsv)
    if not rows:
        return 0
    count = 0
    for row in rows[1:]:  # skip header
        if len(row) < 3:
            continue
        edge = TFEdge(
            tf_symbol=_strip_quotes(row[0]),
            target_symbol=_strip_quotes(row[1]),
            log2fc_mean=_safe_float(row[2]) or 0.0,
            log2fc_std=_safe_float(row[3]) if len(row) > 3 else None,
            regulation_direct=_strip_quotes(row[4]) if len(row) > 4 else "",
        )
        session.add(edge)
        count += 1
    session.commit()
    logger.info("Ingested %d TF regulatory edges", count)
    return count


def _ingest_aa_pathways(session: Session) -> int:
    """Parse amino_acid_pathways.tsv → aa_pathways table."""
    rows = _read_tsv_rows(settings.amino_acid_pathways_tsv)
    if not rows:
        return 0
    count = 0
    for row in rows[1:]:  # skip header
        if len(row) < 6:
            continue
        pathway = AAPathway(
            amino_acid=_strip_quotes(row[0]),
            enzymes=row[1],
            reverse_enzymes=row[2],
            kcat=_safe_float(row[3]),
            ki_lower=_safe_float(row[4]),
            ki_upper=_safe_float(row[5]),
            upstream_aas=row[9] if len(row) > 9 else "{}",
            downstream_aas=row[11] if len(row) > 11 else "{}",
            notes=_strip_quotes(row[12]) if len(row) > 12 else "",
        )
        session.add(pathway)
        count += 1
    session.commit()
    logger.info("Ingested %d amino acid pathways", count)
    return count


def _ingest_conditions(session: Session) -> int:
    """Parse condition_defs.tsv → conditions table."""
    rows = _read_tsv_rows(settings.condition_defs_tsv)
    if not rows:
        return 0
    count = 0
    for row in rows[1:]:
        if len(row) < 2:
            continue
        cond = Condition(
            name=_strip_quotes(row[0]),
            nutrients=_strip_quotes(row[1]) if len(row) > 1 else "",
            genotype_perturbations=_strip_quotes(row[2]) if len(row) > 2 else "",
            doubling_time=_safe_float(row[3]) if len(row) > 3 else None,
            active_tfs=row[4] if len(row) > 4 else "",
            inactive_tfs=row[5] if len(row) > 5 else "",
        )
        session.add(cond)
        count += 1
    session.commit()
    logger.info("Ingested %d conditions", count)
    return count


def _ingest_timelines(session: Session) -> int:
    """Parse timelines_def.tsv → timelines table."""
    rows = _read_tsv_rows(settings.timelines_def_tsv)
    if not rows:
        return 0
    count = 0
    for row in rows[1:]:
        if len(row) < 2:
            continue
        tl = Timeline(
            name=_strip_quotes(row[0]),
            definition="\t".join(row[1:]),  # store raw definition
        )
        session.add(tl)
        count += 1
    session.commit()
    logger.info("Ingested %d timelines", count)
    return count


def _ingest_variants(session: Session) -> int:
    """Read variant Python files and extract docstrings."""
    variant_dir = settings.variants_dir
    if not variant_dir.exists():
        logger.warning("Variants directory not found: %s", variant_dir)
        return 0
    count = 0
    for py_file in sorted(variant_dir.glob("*.py")):
        if py_file.name.startswith("__"):
            continue
        name = py_file.stem
        # Extract docstring from first function
        content = py_file.read_text(encoding="utf-8")
        doc_match = re.search(r'"""(.*?)"""', content, re.DOTALL)
        docstring = doc_match.group(1).strip() if doc_match else ""

        variant = Variant(
            name=name,
            docstring=docstring[:2000],
            filename=py_file.name,
        )
        session.add(variant)
        count += 1
    session.commit()
    logger.info("Ingested %d variants", count)
    return count


def _ingest_complexes(session: Session) -> int:
    """Parse complexation_reactions.tsv → complexes table."""
    path = settings.complexation_reactions_tsv
    if not path.exists():
        return 0
    rows = _read_tsv_rows(path)
    if not rows:
        return 0
    count = 0
    for row in rows[1:]:
        if len(row) < 3:
            continue
        reaction_id = _strip_quotes(row[0])
        stoich_raw = row[1]
        name = _strip_quotes(row[2]) if len(row) > 2 else ""

        # Extract the complex product (positive stoichiometry entry)
        complex_id = ""
        try:
            stoich = json.loads(stoich_raw.replace("'", '"'))
            for k, v in stoich.items():
                if isinstance(v, (int, float)) and v > 0:
                    complex_id = k
                    break
        except (json.JSONDecodeError, ValueError):
            complex_id = reaction_id.replace("_RXN", "")

        cplx = Complex(
            reaction_id=reaction_id,
            complex_id=complex_id,
            stoichiometry=stoich_raw,
            name=name,
        )
        session.add(cplx)
        count += 1
    session.commit()
    logger.info("Ingested %d complexes", count)
    return count


# ── Schema version ─────────────────────────────────────────────────────
# Bump this integer whenever you:
#   - Add/remove/rename a column in models.py
#   - Change the ingestion logic (categorization, parsing, etc.)
#   - Add a new table to models.py
#
# On startup, if the stored version < _SCHEMA_VERSION, the entire database
# is deleted and rebuilt from reconstruction TSVs. This ensures every user
# (new clone or existing install) gets a fresh, complete schema.
#
# The runtime migrations in main.py._run_migrations() handle the *live*
# database (inside the Docker volume) where experiments/jobs/results exist
# and a full rebuild would destroy user data. The two mechanisms are
# complementary: schema version forces a clean slate for the seed DB,
# migrations patch the live DB in place.
#
# History:
#   v1: initial schema
#   v2: added conditions, timelines, complexes tables
#   v3: added is_mechanistic flag, HTML-stripped gene symbols
#   v4: added divided (simulation_results), docker_container_id (simulation_jobs),
#       imported all models so create_all() creates complete schema
_SCHEMA_VERSION = 4


def needs_rebuild() -> bool:
    """Check if the database needs rebuilding."""
    db_path = settings.database_path
    if not db_path.exists():
        return True

    # Check schema version marker
    version_path = db_path.parent / ".schema_version"
    if not version_path.exists():
        return True
    try:
        stored_version = int(version_path.read_text().strip())
        if stored_version < _SCHEMA_VERSION:
            logger.info("Schema version %d < %d — forcing rebuild", stored_version, _SCHEMA_VERSION)
            return True
    except (ValueError, OSError):
        return True

    db_mtime = db_path.stat().st_mtime
    # Check if any source TSV is newer than the database
    source_files = [
        settings.genes_tsv,
        settings.fold_changes_tsv,
        settings.amino_acid_pathways_tsv,
        settings.condition_defs_tsv,
        settings.timelines_def_tsv,
    ]
    for src in source_files:
        if src.exists() and src.stat().st_mtime > db_mtime:
            return True
    return False


def init_database() -> None:
    """Initialize the database, ingesting all reconstruction data."""
    if not needs_rebuild():
        logger.info("Database is up to date, skipping rebuild")
        return

    logger.info("Building database from reconstruction data...")
    db_path = settings.database_path
    db_path.parent.mkdir(parents=True, exist_ok=True)

    # Remove old database
    if db_path.exists():
        db_path.unlink()

    engine = create_engine(f"sqlite:///{db_path}", echo=False)
    SQLModel.metadata.create_all(engine)

    with Session(engine) as session:
        gene_count = _ingest_genes(session)
        tf_count = _ingest_tf_edges(session)
        aa_count = _ingest_aa_pathways(session)
        cond_count = _ingest_conditions(session)
        tl_count = _ingest_timelines(session)
        var_count = _ingest_variants(session)
        cplx_count = _ingest_complexes(session)

    # Reset reconstruction category cache after ingestion
    global _recon_categories
    _recon_categories = None

    # Write schema version marker
    version_path = db_path.parent / ".schema_version"
    version_path.write_text(str(_SCHEMA_VERSION))

    logger.info(
        "Database built: %d genes, %d TF edges, %d AA pathways, "
        "%d conditions, %d timelines, %d variants, %d complexes",
        gene_count, tf_count, aa_count, cond_count, tl_count, var_count, cplx_count,
    )


def get_engine():
    """Get the SQLite engine, initializing the database if needed."""
    init_database()
    return create_engine(f"sqlite:///{settings.database_path}", echo=False)
