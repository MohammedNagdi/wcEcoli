#!/usr/bin/env python3
"""Extract the authoritative gene → ko_index mapping from a simData.cPickle.

Usage (inside the wcEcoli Docker environment):
    python extract_ko_map.py /data/out/<sim_dir>/kb/simData.cPickle

Or with a genes.tsv to resolve gene IDs to symbols:
    python extract_ko_map.py /data/out/<sim_dir>/kb/simData.cPickle --genes /data/reconstruction/ecoli/flat/genes.tsv

Outputs a JSON file: ko_index_map.json
    {gene_symbol: variant_index, ...}

This is the ground truth because it reads the actual rna_data ordering
from sim_data.process.transcription.rna_data, which is what
gene_knockout.py uses at runtime.
"""

import io
import json
import pickle
import sys
from pathlib import Path


def load_gene_symbols(genes_tsv_path: str) -> dict:
    """Load gene_id → symbol mapping from genes.tsv."""
    gid_to_symbol = {}
    with open(genes_tsv_path) as f:
        for line in f:
            line = line.strip()
            if line.startswith('#') or not line:
                continue
            cols = line.split('\t')
            if cols[0].strip('"') == 'id':  # header
                continue
            gid = cols[0].strip('"').strip("'")
            sym = cols[1].strip('"').strip("'")
            # Strip HTML tags from symbol (some have <i> tags)
            import re
            sym = re.sub(r'<[^>]+>', '', sym)
            gid_to_symbol[gid] = sym
    return gid_to_symbol


def extract_ko_map(sim_data_path: str, genes_tsv_path: str = None) -> dict:
    """Load simData.cPickle and extract gene → ko_index mapping."""
    print(f"Loading {sim_data_path} ...")
    with io.open(sim_data_path, "rb") as f:
        sim_data = pickle.load(f)

    rna_data = sim_data.process.transcription.rna_data
    n_rnas = len(rna_data)
    print(f"rna_data has {n_rnas} entries")

    # rna_data["id"] contains TU IDs and cistron IDs
    rna_ids = list(rna_data["id"])

    # The cistron→TU mapping matrix tells us which cistrons each TU covers
    cistron_data = sim_data.process.transcription.cistron_data
    cistron_ids = list(cistron_data["id"])

    # Build gene_id → symbol mapping
    gid_to_symbol = {}

    # Method 1: from genes.tsv (most reliable)
    if genes_tsv_path and Path(genes_tsv_path).exists():
        gid_to_symbol = load_gene_symbols(genes_tsv_path)
        print(f"Loaded {len(gid_to_symbol)} gene symbols from {genes_tsv_path}")

    # Method 2: try raw_data from sim_data
    if not gid_to_symbol:
        for attr_path in [
            "external_state.raw_data",
            "internal_state.raw_data",
        ]:
            try:
                obj = sim_data
                for a in attr_path.split("."):
                    obj = getattr(obj, a)
                gid_to_symbol = {g["id"]: g["symbol"] for g in obj.genes}
                print(f"Loaded {len(gid_to_symbol)} gene symbols from sim_data.{attr_path}")
                break
            except (AttributeError, KeyError, TypeError):
                continue

    # Method 3: use cistron_id → gene_id as fallback
    if not gid_to_symbol:
        print("Warning: no gene symbol source — using gene IDs (EG*) as keys")
        # Will map EG10235 → EG10235 (identity)

    # Get the TU → cistron mapping
    mapping_matrix = sim_data.process.transcription.cistron_tu_mapping_matrix
    # mapping_matrix is (n_cistrons, n_rnas) sparse matrix

    result = {}
    detailed = {}  # For verbose output
    for rna_idx, rna_id in enumerate(rna_ids):
        variant_index = rna_idx + 1  # +1 because variant 0 = control

        # Get cistrons for this rna entry
        col = mapping_matrix.getcol(rna_idx)
        cistron_indices = col.nonzero()[0]
        genes_in_rna = []
        for ci in cistron_indices:
            cid = cistron_ids[ci]
            gid = cid.replace("_RNA", "")
            sym = gid_to_symbol.get(gid, gid)
            genes_in_rna.append(sym)

        n_genes = len(genes_in_rna)
        for sym in genes_in_rna:
            # Prefer single-gene TUs (smallest n_genes wins)
            if sym not in result or n_genes < result[sym]["n_genes"]:
                result[sym] = {
                    "variant_index": variant_index,
                    "rna_id": rna_id,
                    "n_genes": n_genes,
                }

    # Flatten to symbol → variant_index
    ko_map = {sym: info["variant_index"] for sym, info in result.items()}

    # Print summary
    print(f"\nTotal rna_data entries: {n_rnas}")
    print(f"Total genes mapped: {len(ko_map)}")

    # Show all TUs for diagnostic genes (not just best)
    diagnostics_gids = {
        "pfkA": "EG10699", "pfkB": "EG10700", "ftsZ": "EG10347",
        "dnaA": "EG10235", "rpoB": "EG10894", "murA": "EG11358",
        "alaS": "EG10016",
    }
    print(f"\n{'Gene':>8}  {'ko_index':>10}  {'rna_id':>20}  {'n_genes':>8}")
    for sym, gid in diagnostics_gids.items():
        resolved_sym = gid_to_symbol.get(gid, sym)
        info = result.get(resolved_sym, result.get(gid))
        if info:
            print(f"{sym:>8}  {info['variant_index']:>10}  {info['rna_id']:>20}  {info['n_genes']:>8}")
        else:
            print(f"{sym:>8}  {'NOT FOUND':>10}")

    # Also show ALL TUs containing dnaA for debugging
    print(f"\nAll rna_data entries containing dnaA (EG10235):")
    for rna_idx, rna_id in enumerate(rna_ids):
        col = mapping_matrix.getcol(rna_idx)
        cistron_indices = col.nonzero()[0]
        for ci in cistron_indices:
            cid = cistron_ids[ci]
            if "EG10235" in cid:
                genes = []
                for ci2 in col.nonzero()[0]:
                    gid2 = cistron_ids[ci2].replace("_RNA", "")
                    genes.append(gid_to_symbol.get(gid2, gid2))
                print(f"  rna_data[{rna_idx}] (ko={rna_idx+1}): {rna_id} genes={genes}")
                break

    return ko_map


def main():
    if len(sys.argv) < 2:
        print("Usage: python extract_ko_map.py <simData.cPickle> [--genes genes.tsv]")
        sys.exit(1)

    sim_data_path = sys.argv[1]
    genes_tsv_path = None
    if "--genes" in sys.argv:
        idx = sys.argv.index("--genes")
        if idx + 1 < len(sys.argv):
            genes_tsv_path = sys.argv[idx + 1]

    # Auto-detect genes.tsv if not specified
    if not genes_tsv_path:
        for p in [
            "/data/reconstruction/ecoli/flat/genes.tsv",
            "reconstruction/ecoli/flat/genes.tsv",
        ]:
            if Path(p).exists():
                genes_tsv_path = p
                break

    ko_map = extract_ko_map(sim_data_path, genes_tsv_path)

    # Write to /output if mounted (Docker), otherwise /tmp
    for out_dir in [Path("/output"), Path("/tmp")]:
        if out_dir.exists():
            output_path = out_dir / "ko_index_map.json"
            break
    else:
        output_path = Path("ko_index_map.json")

    with open(output_path, "w") as f:
        json.dump(ko_map, f, indent=2, sort_keys=True)

    print(f"\nWrote {len(ko_map)} gene mappings to {output_path}")


if __name__ == "__main__":
    main()
