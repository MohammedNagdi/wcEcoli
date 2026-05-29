"""Parse wcEcoli reconstruction TSV files into SQLite on startup.

Runs once when the database doesn't exist or when source files are newer.
"""

import ast
import csv
import hashlib
import json
import logging
import re
from pathlib import Path
from typing import Any

from sqlmodel import Session, SQLModel, create_engine

from app.config import settings
from app.db.models import (
    AAPathway, Complex, Condition, Experiment, Gene, MediaRecipe, SimulationJob,
    SimulationResult, TFEdge, Timeline, UserTimeline, Variant,
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


def _load_authoritative_ko_map() -> dict[str, int] | None:
    """Try to load the ground-truth ko_index mapping extracted from simData.cPickle.

    The authoritative mapping is generated by scripts/extract_ko_map.py which
    reads the actual rna_data ordering from a completed simulation's sim_data.
    This is the only way to get exact indices, because the model's is_valid_molecule
    filter removes ~794 TUs that we cannot identify from TSV files alone.

    Returns None if the file doesn't exist (fall back to TSV-based approximation).
    """
    # Check multiple locations:
    # 1. Next to the database file (inside named volume: /app/data/)
    # 2. In the app source data dir (bind-mounted: /app/app/data/)
    # 3. Next to this Python file (for development)
    candidates = [
        settings.database_path.parent / "ko_index_map.json",
        Path(__file__).parent.parent / "data" / "ko_index_map.json",
        Path(__file__).parent / "data" / "ko_index_map.json",
    ]
    ko_map_path = None
    for p in candidates:
        if p.exists():
            ko_map_path = p
            break
    if ko_map_path is None:
        return None

    try:
        with open(ko_map_path) as f:
            ko_map = json.load(f)
        # Validate it's a {str: int} mapping
        if not isinstance(ko_map, dict):
            return None
        result = {str(k): int(v) for k, v in ko_map.items()}
        logger.info(
            "Loaded authoritative ko_index map from %s: %d genes",
            ko_map_path, len(result),
        )
        return result
    except Exception as e:
        logger.warning("Failed to load ko_index map from %s: %s", ko_map_path, e)
        return None


def _build_ko_index_map() -> dict[str, int]:
    """Build gene_symbol → variant_index mapping for gene_knockout experiments.

    PRIORITY 1: Load from ko_index_map.json (extracted from simData.cPickle).
    This is the ground truth — the model's is_valid_molecule filter removes ~794 TUs
    that shift every index, so TSV-based computation cannot match the model's ordering.

    PRIORITY 2: Fall back to TSV-based approximation (correct ordering but wrong
    indices due to missing is_valid_molecule filter). This is still useful as a
    rough approximation when no simulation has been run yet.

    The gene_knockout variant indexes into sim_data.process.transcription.rna_data.
    Variant index 0 = control; variant index N+1 targets rna_data[N].

    CRITICAL: The model applies prune/join/modify operations to transcription_units.tsv
    before building rna_data (see KnowledgeBaseEcoli._prune_data, _join_data, _modify_data).
    The TSV fallback replicates these operations but cannot replicate is_valid_molecule.

    When operons are ON (the default), many genes share multi-gene TUs.
    For each gene we pick the best TU: prefer a single-gene TU, otherwise
    the smallest multi-gene TU that contains the target gene.
    """
    import ast as _ast

    # 1. Parse gene_id → symbol and gene_id → rna_id from genes.tsv
    gene_rows = _read_tsv_rows(settings.genes_tsv)
    gid_to_symbol: dict[str, str] = {}
    gid_to_rna: dict[str, str] = {}
    for row in gene_rows[1:]:
        gid = _strip_quotes(row[0])
        sym = _strip_html(_strip_quotes(row[1]))
        gid_to_symbol[gid] = sym
        if len(row) > 6:
            try:
                rids = _ast.literal_eval(row[6].strip())
                if rids:
                    gid_to_rna[gid] = _strip_quotes(rids[0])
            except Exception:
                pass

    # 2. Parse transcription units in FILE ORDER (this is the model's ordering)
    tu_rows = _read_tsv_rows(settings.transcription_units_tsv)
    # Each entry: (tu_id, gene_ids)
    tu_data: list[tuple[str, list[str]]] = []
    for row in tu_rows[1:]:
        tu_id = _strip_quotes(row[0])
        try:
            gids = _ast.literal_eval(row[2].strip())
            gids = [_strip_quotes(g) for g in gids]
        except Exception:
            gids = []
        tu_data.append((tu_id, gids))

    n_raw = len(tu_data)

    # 3. PRUNE: remove TUs listed in transcription_units_removed.tsv
    #    (mirrors KnowledgeBaseEcoli._prune_data)
    removed_ids: set[str] = set()
    if settings.transcription_units_removed_tsv.exists():
        removed_rows = _read_tsv_rows(settings.transcription_units_removed_tsv)
        for row in removed_rows[1:]:
            removed_ids.add(_strip_quotes(row[0]))
        tu_data = [(tid, gids) for tid, gids in tu_data if tid not in removed_ids]

    # 4. JOIN: append TUs from transcription_units_added.tsv
    #    (mirrors KnowledgeBaseEcoli._join_data — added rows go at end)
    n_added = 0
    if settings.transcription_units_added_tsv.exists():
        added_rows = _read_tsv_rows(settings.transcription_units_added_tsv)
        for row in added_rows[1:]:
            tu_id = _strip_quotes(row[0])
            try:
                gids = _ast.literal_eval(row[2].strip())
                gids = [_strip_quotes(g) for g in gids]
            except Exception:
                gids = []
            tu_data.append((tu_id, gids))
            n_added += 1

    # 5. MODIFY: update gene lists from transcription_units_modified.tsv
    #    (mirrors KnowledgeBaseEcoli._modify_data — match by id column)
    n_modified = 0
    if settings.transcription_units_modified_tsv.exists():
        mod_rows = _read_tsv_rows(settings.transcription_units_modified_tsv)
        mod_map: dict[str, list[str]] = {}
        for row in mod_rows[1:]:
            mod_id = _strip_quotes(row[0])
            try:
                gids = _ast.literal_eval(row[2].strip())
                mod_map[mod_id] = [_strip_quotes(g) for g in gids]
            except Exception:
                pass
        for i, (tid, gids) in enumerate(tu_data):
            if tid in mod_map:
                tu_data[i] = (tid, mod_map[tid])
                n_modified += 1

    logger.info(
        "TU ordering: %d raw → -%d removed +%d added =%d final (%d modified)",
        n_raw, len(removed_ids), n_added, len(tu_data), n_modified,
    )

    # 6. Build gene_id → rna_id mapping and find covered cistrons
    tu_gene_ids = {tid: gids for tid, gids in tu_data}
    covered: set[str] = set()
    for _, gids in tu_data:
        for gid in gids:
            rna = gid_to_rna.get(gid)
            if rna:
                covered.add(rna)

    # 7. Identify uncovered cistrons (order matches rnas.tsv)
    rna_rows = _read_tsv_rows(settings.rnas_tsv)
    all_cistron_ids = [_strip_quotes(r[0]) for r in rna_rows[1:]]
    uncovered = [c for c in all_cistron_ids if c not in covered]

    # 8. Model rna_data ordering: TU IDs (pruned+joined) then uncovered cistrons
    tu_ids = [tid for tid, _ in tu_data]
    model_ids = tu_ids + uncovered

    # 9. For each gene, find the best TU (prefer single-gene TUs)
    best: dict[str, tuple[int, int]] = {}  # symbol → (variant_index, n_genes_in_tu)
    for tu_idx, (tu_id, gids) in enumerate(tu_data):
        n_genes = len(gids)
        for gid in gids:
            sym = gid_to_symbol.get(gid)
            if not sym:
                continue
            variant_idx = tu_idx + 1  # +1 because variant 0 = control
            if sym not in best or n_genes < best[sym][1]:
                best[sym] = (variant_idx, n_genes)

    # Add uncovered cistrons
    for i, cid in enumerate(uncovered):
        gid = cid.replace("_RNA", "")
        sym = gid_to_symbol.get(gid)
        if sym and sym not in best:
            best[sym] = (len(tu_ids) + i + 1, 1)

    result = {sym: vi for sym, (vi, _) in best.items()}
    logger.info("Built ko_index map: %d genes, rna_data size %d", len(result), len(model_ids))
    return result


def _build_gene_product_map() -> dict[str, dict]:
    """Build gene_id → {monomer_id, monomer_name, complex_ids} from reconstruction TSVs.

    Chain: gene_id → rna_id (rnas.tsv col monomer_ids) → monomer_id
           monomer_id → complex_ids (complexation_reactions.tsv stoichiometry)
           monomer_id → common_name (proteins.tsv)
    """
    # 1. gene_id → monomer_id(s) from rnas.tsv
    gene_to_monomer: dict[str, str] = {}
    rna_rows = _read_tsv_rows(settings.rnas_tsv)
    if rna_rows:
        for row in rna_rows[1:]:
            if len(row) < 7:
                continue
            gene_id = _strip_quotes(row[5])
            monomer_raw = row[6].strip()
            if not gene_id or monomer_raw in ("[]", "null", ""):
                continue
            # Parse first monomer ID from the list
            try:
                monomers = ast.literal_eval(monomer_raw)
                if isinstance(monomers, list) and monomers:
                    gene_to_monomer[gene_id] = monomers[0]
            except (ValueError, SyntaxError):
                pass

    # 2. monomer_id → common_name from proteins.tsv
    monomer_names: dict[str, str] = {}
    prot_path = settings.reconstruction_path / "ecoli" / "flat" / "proteins.tsv"
    prot_rows = _read_tsv_rows(prot_path)
    if prot_rows:
        for row in prot_rows[1:]:
            if len(row) < 2:
                continue
            mid = _strip_quotes(row[0])
            name = _strip_html(_strip_quotes(row[1])) if row[1] != "null" else ""
            if mid:
                monomer_names[mid] = name

    # 3. monomer_id → complex_ids from complexation_reactions.tsv
    monomer_to_complexes: dict[str, list[str]] = {}
    cpx_path = settings.reconstruction_path / "ecoli" / "flat" / "complexation_reactions.tsv"
    cpx_rows = _read_tsv_rows(cpx_path)
    if cpx_rows:
        for row in cpx_rows[1:]:
            if len(row) < 2:
                continue
            try:
                stoich = ast.literal_eval(row[1])
                if not isinstance(stoich, dict):
                    continue
                # Negative stoichiometry = reactant (monomer), positive = product (complex)
                reactants = [k for k, v in stoich.items() if v < 0]
                products = [k for k, v in stoich.items() if v > 0]
                for mon in reactants:
                    if mon not in monomer_to_complexes:
                        monomer_to_complexes[mon] = []
                    monomer_to_complexes[mon].extend(products)
            except (ValueError, SyntaxError):
                pass

    # 4. Combine into gene_id → product info
    result: dict[str, dict] = {}
    for gene_id, monomer_id in gene_to_monomer.items():
        result[gene_id] = {
            "monomer_id": monomer_id,
            "monomer_name": monomer_names.get(monomer_id, ""),
            "complex_ids": monomer_to_complexes.get(monomer_id, []),
        }

    logger.info("Built gene product map: %d genes with monomer IDs, %d with complexes",
                len(result), sum(1 for v in result.values() if v["complex_ids"]))
    return result


def _ingest_genes(session: Session) -> int:
    """Parse genes.tsv → genes table with correct knockout variant indices."""
    rows = _read_tsv_rows(settings.genes_tsv)
    if not rows:
        return 0

    # Try authoritative mapping first, fall back to TSV-based approximation
    ko_map = _load_authoritative_ko_map()
    if ko_map is None:
        logger.warning(
            "No authoritative ko_index_map.json found — using TSV-based approximation. "
            "Run scripts/extract_ko_map.py after first simulation for exact indices."
        )
        ko_map = _build_ko_index_map()
    product_map = _build_gene_product_map()

    count = 0
    for idx, row in enumerate(rows[1:]):
        symbol = _strip_html(_strip_quotes(row[1]))
        ecoli_id = _strip_quotes(row[0])
        left = _safe_int(row[3])
        right = _safe_int(row[4])
        cat = _categorize_gene(symbol)
        products = product_map.get(ecoli_id, {})
        gene = Gene(
            id=idx,
            ecoli_id=ecoli_id,
            symbol=symbol,
            synonyms=row[2] if len(row) > 2 else "",
            left_end_pos=left,
            right_end_pos=right,
            direction=_strip_quotes(row[5]) if len(row) > 5 else None,
            rna_ids=row[6] if len(row) > 6 else "",
            category=cat,
            ko_index=ko_map.get(symbol, -1),  # -1 = no valid KO target
            is_mechanistic=(cat in MECHANISTIC_CATEGORIES),
            monomer_id=products.get("monomer_id"),
            monomer_name=products.get("monomer_name"),
            complex_ids=json.dumps(products.get("complex_ids", [])),
        )
        session.add(gene)
        count += 1
    session.commit()
    logger.info("Ingested %d genes (%d with valid ko_index)", count,
                sum(1 for row in rows[1:] if ko_map.get(_strip_html(_strip_quotes(row[1])), -1) > 0))
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


def _ingest_media_recipes(session: Session) -> int:
    """Parse media_recipes.tsv → media_recipes table."""
    path = settings.media_recipes_tsv
    if not path.exists():
        logger.warning("media_recipes.tsv not found: %s", path)
        return 0
    rows = _read_tsv_rows(path)
    if not rows:
        return 0
    count = 0
    for row in rows[1:]:  # skip header
        if not row or not _strip_quotes(row[0]):
            continue
        recipe = MediaRecipe(
            media_id=_strip_quotes(row[0]),
            base_media=_strip_quotes(row[1]) if len(row) > 1 else "",
            added_media=_strip_quotes(row[3]) if len(row) > 3 else "",
            ingredients=row[5] if len(row) > 5 else "",
        )
        session.add(recipe)
        count += 1
    session.commit()
    logger.info("Ingested %d media recipes", count)
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
#   v5: added media_recipes table (ingested from media_recipes.tsv)
_SCHEMA_VERSION = 8  # v8: use authoritative ko_index from simData.cPickle extraction


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

    # Check if init_db.py itself changed (catches bind-mount edits without version bump)
    code_hash_path = db_path.parent / ".init_db_hash"
    current_hash = hashlib.md5(Path(__file__).read_bytes()).hexdigest()
    if code_hash_path.exists() and code_hash_path.read_text().strip() != current_hash:
        logger.info("init_db.py source changed — forcing rebuild")
        return True

    db_mtime = db_path.stat().st_mtime
    # Check if any source TSV is newer than the database
    source_files = [
        settings.genes_tsv,
        settings.fold_changes_tsv,
        settings.amino_acid_pathways_tsv,
        settings.condition_defs_tsv,
        settings.timelines_def_tsv,
        settings.media_recipes_tsv,
    ]
    for src in source_files:
        if src.exists() and src.stat().st_mtime > db_mtime:
            return True
    return False


def _backup_user_tables(db_path: Path) -> dict[str, list[tuple]]:
    """Back up user-data tables before a schema rebuild.

    Returns {table_name: [(col_names,...), row1, row2, ...]} for each
    non-empty user table.  Returns an empty dict if the DB doesn't exist
    or has no user data.
    """
    import sqlite3

    USER_TABLES = ["experiments", "simulation_jobs", "simulation_results", "user_timelines"]
    backup: dict[str, list[tuple]] = {}

    if not db_path.exists():
        return backup

    try:
        conn = sqlite3.connect(str(db_path))
        cur = conn.cursor()

        # Which of the user tables actually exist?
        cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
        existing = {row[0] for row in cur.fetchall()}

        for table in USER_TABLES:
            if table not in existing:
                continue
            cur.execute(f"SELECT COUNT(*) FROM {table}")
            if cur.fetchone()[0] == 0:
                continue
            # Grab column names
            cur.execute(f"PRAGMA table_info({table})")
            col_names = tuple(row[1] for row in cur.fetchall())
            # Grab all rows
            cur.execute(f"SELECT * FROM {table}")
            rows = cur.fetchall()
            backup[table] = [col_names] + rows
            logger.info("Backed up %d rows from '%s'", len(rows), table)

        conn.close()
    except Exception as exc:
        logger.warning("Could not back up user tables: %s", exc)

    return backup


def _restore_user_tables(engine, backup: dict[str, list[tuple]]) -> None:
    """Restore user-data rows after a schema rebuild.

    Handles column mismatches gracefully: if the new schema added or
    removed columns, only the columns present in BOTH the backup and
    the new table are restored.  Missing columns get their defaults.
    """
    import sqlite3

    if not backup:
        return

    db_url = str(engine.url).replace("sqlite:///", "")
    conn = sqlite3.connect(db_url)
    cur = conn.cursor()

    try:
        for table, data in backup.items():
            if len(data) < 2:          # header-only, no rows
                continue

            backup_cols = data[0]       # tuple of column names from old schema
            rows = data[1:]

            # Get new schema's columns
            cur.execute(f"PRAGMA table_info({table})")
            new_cols = {row[1] for row in cur.fetchall()}

            # Only restore columns that exist in BOTH old and new schemas
            shared_cols = [c for c in backup_cols if c in new_cols]
            if not shared_cols:
                logger.warning("No shared columns for '%s' — skipping restore", table)
                continue

            # Build index mapping: which positions in old rows to keep
            col_indices = [backup_cols.index(c) for c in shared_cols]
            placeholders = ", ".join("?" for _ in shared_cols)
            col_list = ", ".join(shared_cols)

            insert_sql = f"INSERT OR IGNORE INTO {table} ({col_list}) VALUES ({placeholders})"

            restored = 0
            for row in rows:
                values = tuple(row[i] for i in col_indices)
                try:
                    cur.execute(insert_sql, values)
                    restored += 1
                except Exception as exc:
                    logger.warning("Failed to restore row in '%s': %s", table, exc)

            logger.info("Restored %d/%d rows to '%s'", restored, len(rows), table)

        conn.commit()
    except Exception as exc:
        logger.warning("User-table restore failed: %s", exc)
    finally:
        conn.close()


def init_database() -> None:
    """Initialize the database, ingesting all reconstruction data.

    When a schema-version bump triggers a rebuild, user-data tables
    (experiments, simulation_jobs, simulation_results) are backed up
    before the old DB is deleted and restored after the new one is built.
    """
    if not needs_rebuild():
        logger.info("Database is up to date, skipping rebuild")
        return

    logger.info("Building database from reconstruction data...")
    db_path = settings.database_path
    db_path.parent.mkdir(parents=True, exist_ok=True)

    # ── Back up user data before destroying the old DB ──
    user_backup = _backup_user_tables(db_path)
    if user_backup:
        logger.info(
            "Preserved user data: %s",
            ", ".join(f"{t} ({len(d)-1} rows)" for t, d in user_backup.items()),
        )

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
        media_count = _ingest_media_recipes(session)
        var_count = _ingest_variants(session)
        cplx_count = _ingest_complexes(session)

    # Reset reconstruction category cache after ingestion
    global _recon_categories
    _recon_categories = None

    # ── Restore user data that was backed up before rebuild ──
    _restore_user_tables(engine, user_backup)

    # Write schema version and code hash markers
    version_path = db_path.parent / ".schema_version"
    version_path.write_text(str(_SCHEMA_VERSION))
    code_hash_path = db_path.parent / ".init_db_hash"
    code_hash_path.write_text(hashlib.md5(Path(__file__).read_bytes()).hexdigest())

    logger.info(
        "Database built: %d genes, %d TF edges, %d AA pathways, "
        "%d conditions, %d timelines, %d media recipes, %d variants, %d complexes",
        gene_count, tf_count, aa_count, cond_count, tl_count, media_count, var_count, cplx_count,
    )


def get_engine():
    """Get the SQLite engine, initializing the database if needed."""
    init_database()
    return create_engine(f"sqlite:///{settings.database_path}", echo=False)
