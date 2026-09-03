# Environment for running wcEcoli campaigns on SLURM.  Source it, don't execute it:
#
#     source cluster/campaign_env.sh
#
# The platform's defaults in interface/backend/app/config.py are Docker container paths
# (/data/..., /app/...). Every one of them has to be redirected at the campaign root here.
# Sourcing this is idempotent and also creates the directory layout on first use.

WCECOLI_REPO_ROOT="${WCECOLI_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
export WCECOLI_REPO_ROOT

export WCECOLI_CAMPAIGN_ROOT="${WCECOLI_CAMPAIGN_ROOT:-/gscratch/amath/$USER/wcecoli-campaign}"

# ── Platform settings (app.config.Settings reads these) ──────────────────────
export RECONSTRUCTION_PATH="${WCECOLI_REPO_ROOT}/reconstruction"
export MODELS_PATH="${WCECOLI_REPO_ROOT}/models"
export WCECOLI_ROOT="${WCECOLI_REPO_ROOT}"
export SIM_OUTPUT_DIR="${WCECOLI_CAMPAIGN_ROOT}/out"
export DATABASE_PATH="${WCECOLI_CAMPAIGN_ROOT}/state/wcecoli.db"

# WAL relies on mmap semantics GPFS does not provide; TRUNCATE is the safe journal mode here.
# Writers are serialized by an flock in slurm_campaign.db_lock, not by SQLite itself.
export SQLITE_JOURNAL_MODE="${SQLITE_JOURNAL_MODE:-TRUNCATE}"
export SQLITE_BUSY_TIMEOUT_MS="${SQLITE_BUSY_TIMEOUT_MS:-60000}"

# ── micromamba ───────────────────────────────────────────────────────────────
export MICROMAMBA_BIN="${MICROMAMBA_BIN:-$HOME/scripts/micromamba}"
export MAMBA_ROOT_PREFIX="${MAMBA_ROOT_PREFIX:-$HOME/storage/micromamba}"
export WCECOLI_SIM_ENV="${WCECOLI_SIM_ENV:-wcecoli-sim}"
export WCECOLI_API_ENV="${WCECOLI_API_ENV:-wcecoli-api}"

# ── SLURM defaults (slurm_backend.SlurmResources.from_env) ───────────────────
# ckpt is preemptible with ~18k CPUs; jobs are ~25 min so a preemption costs little.
# Measured on klone from the first T1 job (39439210_0): MaxRSS 2.03 GB, 1h16m wall for
# 4 generations (~14 min/generation, ~3x the 6.3 min baseline quoted in RUN.md).
# 4G leaves ~2x headroom; 03:00:00 leaves ~2.4x. Re-measure if the model changes.
export WCECOLI_SLURM_ACCOUNT="${WCECOLI_SLURM_ACCOUNT:-ckpt-stf}"
export WCECOLI_SLURM_PARTITION="${WCECOLI_SLURM_PARTITION:-ckpt}"
export WCECOLI_SLURM_CPUS="${WCECOLI_SLURM_CPUS:-1}"
export WCECOLI_SLURM_MEM="${WCECOLI_SLURM_MEM:-4G}"
export WCECOLI_SLURM_TIME="${WCECOLI_SLURM_TIME:-03:00:00}"
export WCECOLI_SLURM_THROTTLE="${WCECOLI_SLURM_THROTTLE:-1}"
# MaxSubmitJobsPU is 2000 on ckpt; stay well below it so sbatch never hits DenyOnLimit.
export WCECOLI_MAX_IN_FLIGHT="${WCECOLI_MAX_IN_FLIGHT:-800}"

# ── Parca cache id ───────────────────────────────────────────────────────────
# Naming the cache means hashing all of reconstruction/ and models/ -- ~54 s. Fine once,
# but ruinous for a loop that ticks every few minutes. parca.sbatch records the id here
# when it builds the cache; pick it up rather than recomputing.
if [[ -z "${WCECOLI_PARCA_RUN_ID:-}" && -r "${WCECOLI_CAMPAIGN_ROOT}/state/parca_run_id" ]]; then
    WCECOLI_PARCA_RUN_ID="$(cat "${WCECOLI_CAMPAIGN_ROOT}/state/parca_run_id")"
    export WCECOLI_PARCA_RUN_ID
fi

# ── BLAS ─────────────────────────────────────────────────────────────────────
# numpy/scipy come from pip wheels that bundle an ILP64 OpenBLAS under numpy.libs/ with
# mangled symbol names, so there is nothing aesara can link against: it reports
# "Using NumPy C-API based implementation for BLAS functions" and falls back to a slow
# path for every dot/gemm. conda-forge's LP64 openblas is installed into the sim env by
# setup_env.sh purely to give aesara a real library.
#
# No -Wl,-rpath here: aesara splits ldflags on commas, which mangles it. LD_LIBRARY_PATH
# is what makes the compiled ops find the library at run time.
_WCE_SIM_LIB="${MAMBA_ROOT_PREFIX}/envs/${WCECOLI_SIM_ENV}/lib"
export AESARA_FLAGS="${AESARA_FLAGS:-blas__ldflags=-L${_WCE_SIM_LIB} -lopenblas}"
export LD_LIBRARY_PATH="${_WCE_SIM_LIB}:${LD_LIBRARY_PATH:-}"
unset _WCE_SIM_LIB

# One thread: many single-core tasks share a node, and multi-threaded OpenBLAS both
# changes results slightly and runs slower under that contention (see requirements.txt).
export OPENBLAS_NUM_THREADS=1
export OMP_NUM_THREADS=1

# ── Output pruning ───────────────────────────────────────────────────────────
# Each task converts its generations to a compressed per-job HDF5 and deletes the raw
# simOut tree. Measured on job 39439210_0: 2.8 GB / 1259 files -> 129 MB / 26 files,
# for ~22 s of CPU. Without this, the full campaign would need ~157 TB and ~70M inodes
# against an allocation of 15M files that is already 98% consumed.
#
# KEEP_TENSORS retains the per-gene and per-reaction matrices that are the dataset's real
# value (mrna_counts, protein_counts, reaction_flux, exchange_flux). run_export reads the
# pruned form transparently -- see hf_export/pruned_reader.py.
export WCECOLI_PRUNE_SIMOUT="${WCECOLI_PRUNE_SIMOUT:-1}"
export WCECOLI_PRUNE_KEEP_TENSORS="${WCECOLI_PRUNE_KEEP_TENSORS:-1}"

export PYTHONPATH="${WCECOLI_REPO_ROOT}/interface/backend"

# Put the control-plane interpreter on PATH so `python -m app.services.slurm_campaign ...`
# just works after sourcing this, the way the runbook describes. Every controller command
# (dispatch, reconcile, status, submit_campaign, run_export) runs in the api environment;
# the sim environment is only ever invoked by the array tasks, by explicit path.
WCECOLI_API_PYTHON="${MAMBA_ROOT_PREFIX}/envs/${WCECOLI_API_ENV}/bin/python"
export WCECOLI_API_PYTHON
case ":${PATH}:" in
    *":${MAMBA_ROOT_PREFIX}/envs/${WCECOLI_API_ENV}/bin:"*) ;;
    *) export PATH="${MAMBA_ROOT_PREFIX}/envs/${WCECOLI_API_ENV}/bin:${PATH}" ;;
esac

# ── Layout ───────────────────────────────────────────────────────────────────
# Checked individually rather than behind one guard: keying the whole block on a single
# directory silently skips the others when that one already exists. Three stats is cheap
# enough for hundreds of array tasks sourcing this file.
for _wce_dir in out state/manifests logs; do
    [[ -d "${WCECOLI_CAMPAIGN_ROOT}/${_wce_dir}" ]] || mkdir -p "${WCECOLI_CAMPAIGN_ROOT}/${_wce_dir}"
done
unset _wce_dir

# wholecell/utils/filepath.py hardcodes OUT_DIR = <repo>/out with no environment override,
# so <repo>/out must BE the campaign output root. This symlink is the SLURM equivalent of
# the sim-output volume that docker-compose mounts at /wcEcoli/out.
if [[ -e "${WCECOLI_REPO_ROOT}/out" && ! -L "${WCECOLI_REPO_ROOT}/out" ]]; then
    echo "WARNING: ${WCECOLI_REPO_ROOT}/out is a real directory, not a link to" >&2
    echo "         ${WCECOLI_CAMPAIGN_ROOT}/out . Move or remove it first." >&2
elif [[ "$(readlink "${WCECOLI_REPO_ROOT}/out" 2>/dev/null)" != "${WCECOLI_CAMPAIGN_ROOT}/out" ]]; then
    ln -sfn "${WCECOLI_CAMPAIGN_ROOT}/out" "${WCECOLI_REPO_ROOT}/out"
fi

echo "campaign root: ${WCECOLI_CAMPAIGN_ROOT}"
echo "database:      ${DATABASE_PATH}"
echo "slurm:         ${WCECOLI_SLURM_ACCOUNT} / ${WCECOLI_SLURM_PARTITION}" \
     "(${WCECOLI_SLURM_CPUS} cpu, ${WCECOLI_SLURM_MEM}, ${WCECOLI_SLURM_TIME})"
