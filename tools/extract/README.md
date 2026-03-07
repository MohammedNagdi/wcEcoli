# Extraction Pipeline

Use this pipeline after simulations to produce processed outputs separate from raw `simOut` tables.

## Command

```bash
python tools/extract/run_pipeline.py --sim-dir sim1
```

## Default target

If `--all` is not set, the default target is:

- `wildtype_000000/000000/generation_000000/000000/simOut`

Override with:

- `--variant`
- `--seed`
- `--generation`
- `--daughter`

## Process all cells

```bash
python tools/extract/run_pipeline.py --sim-dir sim1 --all --csv-summary
```

## Output structure

Processed artifacts are written to:

- `out/processed/<sim>/<variant>/<seed>/<generation>/<daughter>/`

Each target folder includes:

- `<category>_data.npz` (NPZ primary output)
- optional `<category>_summary.csv` when `--csv-summary` is used
- category preview plots `category_<category>.png`
- gene target plots when mRNA data is available
- `metadata.json`

## Gene target configuration

Edit `tools/extract/gene_targets.tsv` to control which genes are plotted.
