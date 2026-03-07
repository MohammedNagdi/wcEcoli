#!/usr/bin/env python3
"""
Extract simulation data from wcEcoli simOut tables and generate summary plots.

Default target cell:
  wildtype_000000 / 000000 / generation_000000 / 000000

Outputs are written under:
  out/processed/<sim>/<variant>/<seed>/<generation>/<daughter>/
"""

from __future__ import annotations

import argparse
import ast
import csv
import json
import math
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

os.environ.setdefault("MPLCONFIGDIR", "/tmp/wcecoli-mpl-cache")

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from wholecell.io.tablereader import DoesNotExistError, SUBCOLUMNS_KEY, TableReader


CATEGORY_BY_TABLE = {
    "BulkMolecules": "metabolite",
    "Mass": "mass",
    "MonomerCounts": "protein",
    "RNACounts": "rna",
    "FBAResults": "flux",
    "RibosomeData": "ribosome",
    "RnaSynthProb": "transcription",
    "RnapData": "rnap",
    "RnaDegradationListener": "rna_degradation",
    "EnzymeKinetics": "enzyme",
    "ComplexationListener": "complex",
    "TranscriptElongationListener": "transcript_elongation",
    "RnaMaturationListener": "rna_maturation",
    "EquilibriumListener": "equilibrium",
    "GrowthLimits": "growth_limit",
    "Environment": "environment",
    "EvaluationTime": "timing",
    "UniqueMoleculeCounts": "unique_molecule_counts",
    "UniqueMolecules": "unique_molecules",
    "ReplicationData": "replication",
    "DnaSupercoiling": "dna_supercoiling",
    "Main": "main",
}

PREFERRED_MRNA_COLUMNS = [
    "mRNA_cistron_counts",
    "full_mRNA_cistron_counts",
    "mRNA_counts",
    "full_mRNA_counts",
]

DEFAULT_GENE_TARGETS = [
    ("acrA", "transport", "Multi-drug efflux pump"),
    ("ftsZ", "division", "Cell division protein"),
    ("groS", "chaperone", "Chaperone system"),
    ("tufA", "translation", "Elongation factor Tu"),
    ("lpp", "envelope", "Major lipoprotein"),
    ("ompA", "envelope", "Outer membrane protein"),
    ("gapA", "glycolysis", "Glyceraldehyde-3P dehydrogenase"),
    ("acpP", "lipid", "Acyl carrier protein"),
    ("recA", "dna_repair", "DNA recombination/repair"),
    ("rpoD", "transcription", "Sigma 70 factor"),
]


@dataclass
class TargetCell:
    sim_out: Path
    variant: str
    seed: str
    generation: str
    daughter: str


@dataclass
class ExtractResult:
    output_dir: Path
    category_files: Dict[str, Path]
    mRNA_file: Optional[Path]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Extract and plot wcEcoli simulation outputs")
    parser.add_argument("--sim-dir", required=True,
                        help="Simulation root directory (absolute, repo-relative, or under out/).")
    parser.add_argument("--variant", default="wildtype_000000",
                        help="Variant folder for single-target mode (default: wildtype_000000)")
    parser.add_argument("--seed", default="000000",
                        help="Seed folder for single-target mode (default: 000000)")
    parser.add_argument("--generation", default="generation_000000",
                        help="Generation folder or index for single-target mode (default: generation_000000)")
    parser.add_argument("--daughter", default="000000",
                        help="Daughter folder for single-target mode (default: 000000)")
    parser.add_argument("--all", action="store_true",
                        help="Process every discovered simOut under --sim-dir")
    parser.add_argument("--output-root", default="out/processed",
                        help="Root output folder for processed data")
    parser.add_argument("--csv-summary", action="store_true",
                        help="Write CSV summaries for each category")
    parser.add_argument("--gene-list", default="tools/extract/gene_targets.tsv",
                        help="TSV file of gene targets: symbol<TAB>category<TAB>description")
    parser.add_argument("--genes-tsv", default="reconstruction/ecoli/flat/genes.tsv",
                        help="Path to genes.tsv used to map RNA IDs to gene symbols")
    parser.add_argument("--max-category-traces", type=int, default=10,
                        help="Max traces per category plot (default: 10)")
    parser.add_argument("--skip-plots", action="store_true",
                        help="Extract data only; skip category/gene plotting")
    parser.add_argument("--dry-run", action="store_true",
                        help="Resolve targets and print actions without writing output")
    return parser.parse_args()


def to_snake_case(name: str) -> str:
    value = re.sub(r"(.)([A-Z][a-z]+)", r"\1_\2", name)
    value = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", value)
    return value.replace("-", "_").lower()


def normalize_index_folder(value: str) -> str:
    value = str(value)
    if value.isdigit():
        return f"{int(value):06d}"
    return value


def normalize_generation(value: str) -> str:
    value = str(value)
    if value.startswith("generation_"):
        return value
    if value.isdigit():
        return f"generation_{int(value):06d}"
    return value


def resolve_sim_dir(sim_dir: str) -> Path:
    candidate = Path(sim_dir)
    if candidate.exists():
        return candidate.resolve()

    out_candidate = Path.cwd() / "out" / sim_dir
    if out_candidate.exists():
        return out_candidate.resolve()

    raise FileNotFoundError(
        f"Simulation directory not found: {sim_dir}. "
        f"Tried '{candidate}' and '{out_candidate}'.")


def discover_targets(sim_root: Path, args: argparse.Namespace) -> List[TargetCell]:
    if args.all:
        targets: List[TargetCell] = []
        for sim_out in sorted(sim_root.rglob("simOut")):
            try:
                daughter = sim_out.parent.name
                generation = sim_out.parent.parent.name
                seed = sim_out.parent.parent.parent.name
                variant = sim_out.parent.parent.parent.parent.name
            except IndexError:
                continue
            if not generation.startswith("generation_"):
                continue
            targets.append(TargetCell(
                sim_out=sim_out,
                variant=variant,
                seed=seed,
                generation=generation,
                daughter=daughter,
            ))
        return targets

    variant = args.variant
    seed = normalize_index_folder(args.seed)
    generation = normalize_generation(args.generation)
    daughter = normalize_index_folder(args.daughter)

    sim_out = sim_root / variant / seed / generation / daughter / "simOut"
    if not sim_out.exists():
        raise FileNotFoundError(
            "Target simOut not found. Expected: "
            f"{sim_out}\n"
            "Try --all to discover available cells automatically.")

    return [TargetCell(
        sim_out=sim_out,
        variant=variant,
        seed=seed,
        generation=generation,
        daughter=daughter,
    )]


def read_time_vector(sim_out: Path) -> np.ndarray:
    reader = TableReader(str(sim_out / "Main"))
    return np.asarray(reader.readColumn("time"), dtype=np.float64).reshape(-1)


def to_time_matrix(data: np.ndarray, n_time: int) -> Optional[np.ndarray]:
    array = np.asarray(data)

    if array.ndim == 0:
        return None

    if array.ndim == 1:
        if array.shape[0] == n_time:
            return array.reshape(n_time, 1)
        return None

    if array.shape[0] == n_time:
        return array.reshape(n_time, -1)

    if array.shape[1] == n_time:
        return np.swapaxes(array, 0, 1).reshape(n_time, -1)

    return None


def get_column_labels(reader: TableReader, column: str, n_cols: int) -> List[str]:
    try:
        subcolumns = reader.readAttribute(SUBCOLUMNS_KEY)
    except DoesNotExistError:
        subcolumns = {}

    labels: List[str] = []
    if isinstance(subcolumns, dict) and column in subcolumns:
        attr_name = subcolumns[column]
        try:
            raw_labels = reader.readAttribute(attr_name)
            labels = [str(x) for x in raw_labels]
        except DoesNotExistError:
            labels = []

    if len(labels) == n_cols:
        return labels

    if n_cols == 1:
        return [column]

    return [f"{column}_{idx:04d}" for idx in range(n_cols)]


def write_csv_summary(path: Path, names: Sequence[str], matrix_t_by_v: np.ndarray) -> None:
    with path.open("w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["variable_name", "min", "max", "mean", "std", "last", "nonzero_fraction"])
        for name, values in zip(names, matrix_t_by_v.T):
            try:
                series = np.asarray(values, dtype=np.float64)
            except (TypeError, ValueError):
                continue
            finite = np.isfinite(series)
            if not finite.any():
                row = [name, "nan", "nan", "nan", "nan", "nan", "nan"]
            else:
                clean = series[finite]
                nonzero_fraction = float(np.count_nonzero(clean)) / float(clean.size)
                row = [
                    name,
                    float(clean.min()),
                    float(clean.max()),
                    float(clean.mean()),
                    float(clean.std()),
                    float(clean[-1]),
                    nonzero_fraction,
                ]
            writer.writerow(row)


def sample_indices(n_items: int, max_items: int) -> List[int]:
    if n_items <= max_items:
        return list(range(n_items))
    return np.linspace(0, n_items - 1, num=max_items, dtype=int).tolist()


def keep_numeric_columns(matrix_t_by_v: np.ndarray, names: Sequence[str]) -> Tuple[Optional[np.ndarray], List[str]]:
    numeric_cols: List[np.ndarray] = []
    numeric_names: List[str] = []
    for idx, name in enumerate(names):
        try:
            column = np.asarray(matrix_t_by_v[:, idx], dtype=np.float64)
        except (TypeError, ValueError):
            continue
        numeric_cols.append(column)
        numeric_names.append(name)

    if not numeric_cols:
        return None, []

    return np.column_stack(numeric_cols), numeric_names


def plot_category(category: str, npz_path: Path, max_traces: int) -> Optional[Path]:
    data = np.load(npz_path, allow_pickle=True)
    matrix = np.asarray(data["data"])  # shape: variables x time
    names = [str(x) for x in data["variable_names"]]
    time = np.asarray(data["time"], dtype=np.float64)

    if matrix.ndim != 2 or matrix.shape[0] == 0:
        return None

    indices = sample_indices(matrix.shape[0], max_traces)
    n = len(indices)
    n_cols = 2
    n_rows = int(math.ceil(n / n_cols))
    fig, axes = plt.subplots(n_rows, n_cols, figsize=(14, max(4, 2.8 * n_rows)))
    axes_arr = np.array(axes).reshape(-1)

    time_minutes = time / 60.0

    for ax, idx in zip(axes_arr, indices):
        series = np.asarray(matrix[idx], dtype=np.float64)
        name = names[idx] if idx < len(names) else f"var_{idx}"
        ax.plot(time_minutes, series, linewidth=1.0)
        ax.set_title(name[:60], fontsize=9)
        ax.set_xlabel("Time (min)")
        ax.set_ylabel("Value")
        ax.grid(True, alpha=0.3)

    for ax in axes_arr[n:]:
        ax.axis("off")

    fig.suptitle(f"Category preview: {category}", fontsize=13, fontweight="bold")
    fig.tight_layout()
    out_path = npz_path.with_name(f"category_{category}.png")
    fig.savefig(out_path, dpi=140, bbox_inches="tight")
    plt.close(fig)
    return out_path


def load_gene_symbol_mapping(genes_tsv: Path) -> Dict[str, str]:
    mapping: Dict[str, str] = {}
    if not genes_tsv.exists():
        return mapping

    with genes_tsv.open() as f:
        lines = [line for line in f if not line.startswith("#")]

    reader = csv.DictReader(lines, delimiter="\t")
    for row in reader:
        symbol = row.get("symbol", "")
        rna_ids_raw = row.get("rna_ids", "[]")
        try:
            rna_ids = ast.literal_eval(rna_ids_raw)
        except (ValueError, SyntaxError):
            rna_ids = []
        for rna_id in rna_ids:
            mapping[str(rna_id)] = symbol

    return mapping


def strip_compartment_suffix(value: str) -> str:
    return re.sub(r"\[[a-z]\]$", "", value)


def extract_mrna_dataset(reader: TableReader, n_time: int, time: np.ndarray,
                         gene_symbol_map: Dict[str, str], output_dir: Path) -> Optional[Path]:
    columns = sorted([name for name in reader._columnNames if name != "attributes.json"])
    selected = None
    for candidate in PREFERRED_MRNA_COLUMNS:
        if candidate in columns:
            selected = candidate
            break

    if selected is None:
        return None

    raw = reader.readColumn(selected, squeeze=False)
    matrix_t_by_v = to_time_matrix(raw, n_time)
    if matrix_t_by_v is None:
        return None

    labels = get_column_labels(reader, selected, matrix_t_by_v.shape[1])
    clean_ids = [strip_compartment_suffix(label) for label in labels]
    gene_symbols = [gene_symbol_map.get(rna_id, rna_id) for rna_id in clean_ids]

    matrix_t_by_v, keep_names = keep_numeric_columns(matrix_t_by_v, clean_ids)
    if matrix_t_by_v is None:
        return None
    gene_symbols = [gene_symbol_map.get(rna_id, rna_id) for rna_id in keep_names]

    out_path = output_dir / "mRNA_expression.npz"
    np.savez_compressed(
        out_path,
        data=matrix_t_by_v.T,
        variable_names=np.asarray(keep_names, dtype=object),
        gene_symbols=np.asarray(gene_symbols, dtype=object),
        time=time,
        source_column=selected,
    )
    return out_path


def load_gene_targets(path: Path) -> List[Tuple[str, str, str]]:
    if not path.exists():
        return list(DEFAULT_GENE_TARGETS)

    rows: List[Tuple[str, str, str]] = []
    with path.open() as f:
        for line in f:
            text = line.strip()
            if not text or text.startswith("#"):
                continue
            parts = text.split("\t")
            symbol = parts[0].strip()
            category = parts[1].strip() if len(parts) > 1 else "unspecified"
            description = parts[2].strip() if len(parts) > 2 else ""
            if symbol:
                rows.append((symbol, category, description))

    return rows or list(DEFAULT_GENE_TARGETS)


def plot_gene_targets(mrna_npz: Path, targets: Sequence[Tuple[str, str, str]],
                      output_dir: Path) -> List[Path]:
    data = np.load(mrna_npz, allow_pickle=True)
    matrix = np.asarray(data["data"], dtype=np.float64)  # variables x time
    gene_symbols = [str(x) for x in data["gene_symbols"]]
    variable_names = [str(x) for x in data["variable_names"]]
    time = np.asarray(data["time"], dtype=np.float64) / 60.0

    index_map: Dict[str, int] = {}
    for idx, symbol in enumerate(gene_symbols):
        key = symbol.lower()
        if key not in index_map:
            index_map[key] = idx
    for idx, name in enumerate(variable_names):
        key = name.lower()
        if key not in index_map:
            index_map[key] = idx

    selected: List[Tuple[str, str, str, int]] = []
    for symbol, category, desc in targets:
        idx = index_map.get(symbol.lower())
        if idx is not None:
            selected.append((symbol, category, desc, idx))

    if not selected:
        return []

    n = len(selected)
    n_cols = 2
    n_rows = int(math.ceil(n / n_cols))
    fig, axes = plt.subplots(n_rows, n_cols, figsize=(14, max(4, n_rows * 2.8)))
    axes_arr = np.array(axes).reshape(-1)

    for ax, (symbol, category, desc, idx) in zip(axes_arr, selected):
        ax.plot(time, matrix[idx], linewidth=1.1)
        suffix = f" ({category})" if category else ""
        ax.set_title(f"{symbol}{suffix}: {desc}"[:80], fontsize=9)
        ax.set_xlabel("Time (min)")
        ax.set_ylabel("mRNA")
        ax.grid(True, alpha=0.3)

    for ax in axes_arr[n:]:
        ax.axis("off")

    fig.suptitle("Gene expression targets", fontsize=13, fontweight="bold")
    fig.tight_layout()
    timeseries_path = output_dir / "gene_expression_targets.png"
    fig.savefig(timeseries_path, dpi=140, bbox_inches="tight")
    plt.close(fig)

    heatmap_matrix = np.array([matrix[idx] for _, _, _, idx in selected])
    fig2, ax2 = plt.subplots(figsize=(14, max(3, 0.35 * len(selected) + 1.5)))
    im = ax2.imshow(heatmap_matrix, aspect="auto", cmap="viridis", interpolation="nearest")
    ax2.set_yticks(np.arange(len(selected)))
    ax2.set_yticklabels([symbol for symbol, _, _, _ in selected], fontsize=9)
    ax2.set_xlabel("Time index")
    ax2.set_title("Gene expression heatmap (target genes)", fontsize=12)
    fig2.colorbar(im, ax=ax2, label="mRNA")
    heatmap_path = output_dir / "gene_expression_targets_heatmap.png"
    fig2.tight_layout()
    fig2.savefig(heatmap_path, dpi=140, bbox_inches="tight")
    plt.close(fig2)

    return [timeseries_path, heatmap_path]


def extract_cell(target: TargetCell, sim_name: str, output_root: Path,
                 csv_summary: bool, gene_targets: Sequence[Tuple[str, str, str]],
                 gene_symbol_map: Dict[str, str], max_category_traces: int,
                 skip_plots: bool, dry_run: bool) -> ExtractResult:
    output_dir = output_root / sim_name / target.variant / target.seed / target.generation / target.daughter

    if dry_run:
        print(f"[dry-run] would process {target.sim_out} -> {output_dir}")
        return ExtractResult(output_dir=output_dir, category_files={}, mRNA_file=None)

    output_dir.mkdir(parents=True, exist_ok=True)
    time = read_time_vector(target.sim_out)
    n_time = len(time)

    category_files: Dict[str, Path] = {}
    mRNA_file: Optional[Path] = None
    metadata = {
        "sim_out": str(target.sim_out),
        "variant": target.variant,
        "seed": target.seed,
        "generation": target.generation,
        "daughter": target.daughter,
        "time_points": n_time,
        "categories": {},
    }

    table_dirs = sorted([p for p in target.sim_out.iterdir() if p.is_dir()])
    for table_dir in table_dirs:
        table_name = table_dir.name
        try:
            reader = TableReader(str(table_dir))
        except Exception:
            continue

        column_names = sorted([name for name in reader._columnNames if name != "attributes.json"])
        matrices: List[np.ndarray] = []
        variable_names: List[str] = []

        for column in column_names:
            try:
                raw = reader.readColumn(column, squeeze=False)
            except Exception:
                continue

            matrix_t_by_v = to_time_matrix(raw, n_time)
            if matrix_t_by_v is None:
                continue

            labels = get_column_labels(reader, column, matrix_t_by_v.shape[1])
            if len(labels) != matrix_t_by_v.shape[1]:
                labels = [f"{column}_{idx:04d}" for idx in range(matrix_t_by_v.shape[1])]

            if matrix_t_by_v.shape[1] == 1 and labels[0] == column:
                names = [column]
            else:
                names = [f"{column}/{label}" for label in labels]

            numeric_matrix, numeric_names = keep_numeric_columns(matrix_t_by_v, names)
            if numeric_matrix is None:
                continue

            matrices.append(numeric_matrix)
            variable_names.extend(numeric_names)

        if not matrices:
            continue

        category = CATEGORY_BY_TABLE.get(table_name, to_snake_case(table_name))
        merged_t_by_v = np.concatenate(matrices, axis=1)

        out_file = output_dir / f"{category}_data.npz"
        np.savez_compressed(
            out_file,
            data=merged_t_by_v.T,
            variable_names=np.asarray(variable_names, dtype=object),
            time=time,
            table_name=table_name,
        )
        category_files[category] = out_file

        metadata["categories"][category] = {
            "table": table_name,
            "variables": int(merged_t_by_v.shape[1]),
            "time_points": int(merged_t_by_v.shape[0]),
            "file": out_file.name,
        }

        if csv_summary:
            summary_file = output_dir / f"{category}_summary.csv"
            write_csv_summary(summary_file, variable_names, merged_t_by_v)

        if table_name == "RNACounts":
            extracted = extract_mrna_dataset(reader, n_time, time, gene_symbol_map, output_dir)
            if extracted is not None:
                mRNA_file = extracted

    plot_files: List[str] = []
    if not skip_plots:
        for category, npz_file in category_files.items():
            plot_file = plot_category(category, npz_file, max_traces=max_category_traces)
            if plot_file is not None:
                plot_files.append(plot_file.name)

        if mRNA_file is not None:
            gene_plots = plot_gene_targets(mRNA_file, gene_targets, output_dir)
            plot_files.extend([path.name for path in gene_plots])

    metadata["plots"] = plot_files
    metadata_path = output_dir / "metadata.json"
    metadata_path.write_text(json.dumps(metadata, indent=2))

    return ExtractResult(output_dir=output_dir, category_files=category_files, mRNA_file=mRNA_file)


def main() -> None:
    args = parse_args()

    sim_root = resolve_sim_dir(args.sim_dir)
    sim_name = sim_root.name
    output_root = Path(args.output_root)
    if not output_root.is_absolute():
        output_root = (Path.cwd() / output_root).resolve()

    gene_targets = load_gene_targets(Path(args.gene_list))
    gene_symbol_map = load_gene_symbol_mapping(Path(args.genes_tsv))

    targets = discover_targets(sim_root, args)
    if not targets:
        raise RuntimeError("No simOut targets found. Check --sim-dir or remove filters.")

    print(f"Simulation root: {sim_root}")
    print(f"Targets: {len(targets)}")
    print(f"Output root: {output_root}")

    processed = 0
    for idx, target in enumerate(targets, start=1):
        print("-" * 80)
        print(f"[{idx}/{len(targets)}] Processing {target.sim_out}")
        result = extract_cell(
            target=target,
            sim_name=sim_name,
            output_root=output_root,
            csv_summary=args.csv_summary,
            gene_targets=gene_targets,
            gene_symbol_map=gene_symbol_map,
            max_category_traces=args.max_category_traces,
            skip_plots=args.skip_plots,
            dry_run=args.dry_run,
        )
        if not args.dry_run:
            print(f"Output: {result.output_dir}")
            print(f"Categories: {len(result.category_files)}")
        processed += 1

    if args.dry_run:
        print("Dry-run completed.")
    else:
        print("=" * 80)
        print(f"Completed processing for {processed} target(s).")


if __name__ == "__main__":
    main()
