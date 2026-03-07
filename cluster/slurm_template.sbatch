#!/bin/bash
#SBATCH --job-name=wcecoli
#SBATCH --time=12:00:00
#SBATCH --cpus-per-task=8
#SBATCH --mem=32G
#SBATCH --output=out/slurm/%x-%j.out

set -euo pipefail

WORKDIR="/path/to/wcEcoli"
SIF_IMAGE="${WORKDIR}/cluster/images/wcecoli-local.sif"
APPTAINER_BIN="apptainer"  # or singularity

mkdir -p "${WORKDIR}/out" "${WORKDIR}/cache" "${WORKDIR}/out/slurm"

# Use a single bind spec to keep runtime paths consistent with docker/local/run.sh.
BIND_SPEC="${WORKDIR}:/wcEcoli,${WORKDIR}/out:/wcEcoli/out,${WORKDIR}/cache:/wcEcoli/cache"

# Example commands (pick one):
# COMMAND="python runscripts/manual/runParca.py sim1"
# COMMAND="python runscripts/manual/runSim.py --generations 5 --init-sims 10 sim1"
# COMMAND="python runscripts/manual/analysisMultigen.py sim1"
# COMMAND="python tools/extract/run_pipeline.py --sim-dir sim1 --all --csv-summary"

COMMAND="python -V"

cd "${WORKDIR}"
"${APPTAINER_BIN}" exec --bind "${BIND_SPEC}" "${SIF_IMAGE}" bash -lc "${COMMAND}"
