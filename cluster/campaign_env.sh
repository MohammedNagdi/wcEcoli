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
# mem/time are starting points -- retune from `sacct -o MaxRSS,Elapsed` after the first tier.
export WCECOLI_SLURM_ACCOUNT="${WCECOLI_SLURM_ACCOUNT:-ckpt-stf}"
export WCECOLI_SLURM_PARTITION="${WCECOLI_SLURM_PARTITION:-ckpt}"
export WCECOLI_SLURM_CPUS="${WCECOLI_SLURM_CPUS:-1}"
export WCECOLI_SLURM_MEM="${WCECOLI_SLURM_MEM:-8G}"
export WCECOLI_SLURM_TIME="${WCECOLI_SLURM_TIME:-02:00:00}"
export WCECOLI_SLURM_THROTTLE="${WCECOLI_SLURM_THROTTLE:-1}"
# MaxSubmitJobsPU is 2000 on ckpt; stay well below it so sbatch never hits DenyOnLimit.
export WCECOLI_MAX_IN_FLIGHT="${WCECOLI_MAX_IN_FLIGHT:-800}"

export PYTHONPATH="${WCECOLI_REPO_ROOT}/interface/backend"

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
