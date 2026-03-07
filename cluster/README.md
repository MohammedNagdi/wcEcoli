# Cluster Runtime (Apptainer + SLURM)

This directory provides cluster wrappers that mirror local Docker behavior.

## Build SIF image

```bash
cluster/build_sif.sh
```

By default this converts local `wcecoli-local:latest` Docker image into:

- `cluster/images/wcecoli-local.sif`

## Submit commands through SLURM

```bash
cluster/slurm_run.sh -- python runscripts/manual/runParca.py sim1
cluster/slurm_run.sh -- python runscripts/manual/runSim.py --generations 5 --init-sims 10 sim1
cluster/slurm_run.sh -- python tools/extract/run_pipeline.py --sim-dir sim1 --all --csv-summary
```

## Dry-run / direct execution

```bash
cluster/slurm_run.sh --dry-run -- python -V
cluster/slurm_run.sh --direct -- python runscripts/manual/runSim.py -h
```

## Manual sbatch template

- `cluster/slurm_template.sbatch`
