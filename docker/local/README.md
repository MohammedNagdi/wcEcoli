# Unified Runtime Workflow (Local + Cluster)

This repo supports one operational model for collaborators:

- Edit code in your host `wcEcoli` checkout.
- Execute in a reproducible runtime (Docker locally, Apptainer on cluster).

## Where to edit code

Always edit files in your host checkout of this repository (the repo root you
run commands from).

Example:

```bash
cd /path/to/wcEcoli
```

Do not edit code inside a running container expecting it to persist.

Run behavior after edits:

- Default mode (`WCECOLI_BIND_SOURCE=0`): code comes from the built image, so rebuild after changes:
  - `docker/local/run.sh build`
- Live-edit mode (`WCECOLI_BIND_SOURCE=1`): container uses your current host repo directly, no rebuild needed for Python-only edits.

## Runtime strategy

| Environment | Recommended runtime | Why |
|---|---|---|
| Local laptop/workstation | Docker (`docker/local`) | Reproducible and quick onboarding |
| University cluster (SLURM) | Apptainer/Singularity (`cluster/`) | HPC-compatible container runtime |
| Containers blocked | Conda fallback (`runtime/setup_conda_fallback.sh`) | Practical non-container backup |

## 1) Local Docker quickstart

Run these commands from the repository root (`wcEcoli/`).

Build image:

```bash
docker/local/run.sh build
```

Open shell in runtime:

```bash
docker/local/run.sh shell
```

Run arbitrary command (pass-through):

```bash
docker/local/run.sh run python -m pytest wholecell/tests/utils/test_units.py -q
```

Run Python script (pass-through):

```bash
docker/local/run.sh py runscripts/manual/analysisMultigen.py sim1
```

Run ParCa and Sim shortcuts (all args forwarded):

```bash
docker/local/run.sh parca sim1
docker/local/run.sh sim --generations 5 --init-sims 10 sim1
```

Enable live host-source editing (bind repo into container):

```bash
WCECOLI_BIND_SOURCE=1 docker/local/run.sh shell
WCECOLI_BIND_SOURCE=1 docker/local/run.sh py runscripts/manual/runSim.py -h
```

## 2) Cluster quickstart (Apptainer + SLURM)

Build SIF image from local Docker image:

```bash
cluster/build_sif.sh
```

Submit command via SLURM:

```bash
cluster/slurm_run.sh -- python runscripts/manual/runParca.py sim1
cluster/slurm_run.sh -- python runscripts/manual/runSim.py --generations 5 --init-sims 10 sim1
```

Dry-run generated sbatch script:

```bash
cluster/slurm_run.sh --dry-run -- python -V
```

Use direct mode (no `sbatch`, useful for login node testing):

```bash
cluster/slurm_run.sh --direct -- python runscripts/manual/runSim.py -h
```

Template with common commands:

- `cluster/slurm_template.sbatch`

## 3) Conda fallback quickstart

If container runtime is unavailable:

```bash
runtime/setup_conda_fallback.sh
```

Or with custom env name:

```bash
runtime/setup_conda_fallback.sh my_wcecoli_env
```

This script preserves the same dependency ordering used in your validated setup notes.

## 4) Extraction + plotting quickstart

Default single-cell target (`wildtype_000000/000000/generation_000000/000000`):

```bash
python tools/extract/run_pipeline.py --sim-dir sim1
```

Process all discovered cells and write CSV summaries:

```bash
python tools/extract/run_pipeline.py --sim-dir sim1 --all --csv-summary
```

Processed outputs are separated from raw sim data:

- Raw simulation output: `out/<sim>/.../simOut`
- Processed output: `out/processed/<sim>/<variant>/<seed>/<generation>/<daughter>/`

Gene targets are configurable in:

- `tools/extract/gene_targets.tsv`

## Logging patterns

Interactive logging to host files:

```bash
mkdir -p out/logs
docker/local/run.sh parca sim1 2>&1 | tee out/logs/parca_sim1.log
docker/local/run.sh sim --generations 5 --init-sims 10 sim1 2>&1 | tee out/logs/sim_sim1.log
```

Detached Docker job + follow logs:

```bash
docker run -d --name wcecoli-parca \
  -v "$PWD/out:/wcEcoli/out" \
  -v "$PWD/cache:/wcEcoli/cache" \
  wcecoli-local \
  python runscripts/manual/runParca.py sim1

docker logs -f wcecoli-parca
```

## Persistence and editing model

The runtime binds host directories:

- `./out -> /wcEcoli/out`
- `./cache -> /wcEcoli/cache`

So results persist after container exit.

You should edit code in the host repo (`wcEcoli`) and rerun commands through runtime wrappers.

Code sync behavior:

- Default mode (`WCECOLI_BIND_SOURCE=0`): runtime uses code baked into image; rebuild after code changes with `docker/local/run.sh build`.
- Live-edit mode (`WCECOLI_BIND_SOURCE=1`): runtime executes your current host checkout via bind mount.
- In live-edit mode, if compiled extensions are missing, run:
  - `WCECOLI_BIND_SOURCE=1 docker/local/run.sh run make clean compile`

## Notes

- Default image name: `wcecoli-local` (override with `WCECOLI_DOCKER_IMAGE`).
- Runtime sets:
  - `PYTHONPATH=/wcEcoli`
  - `OPENBLAS_NUM_THREADS=1`
  - `OMP_NUM_THREADS=1`
