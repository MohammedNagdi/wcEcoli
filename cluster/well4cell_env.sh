# Environment for building and publishing the well4cell dataset. Source it, don't execute it:
#
#     source cluster/well4cell_env.sh
#
# Layers on top of campaign_env.sh (campaign root, database, micromamba) and reuses the
# wcecoli-hf environment from transfer_env.sh for the `hf` CLI. Every knob the builder reads
# is defined here with its default, so this file is the complete list of what can be set.
_W4C_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${_W4C_DIR}/campaign_env.sh" >/dev/null
unset _W4C_DIR

# ── Where ────────────────────────────────────────────────────────────────────
# The build root holds build/ (manifests, sentinels, ledger, logs) and repo/ (the exact
# tree that is uploaded). A sibling of out/, never inside state/.
export W4C_ROOT="${W4C_ROOT:-${WCECOLI_CAMPAIGN_ROOT}/well4cell}"
# Hub dataset repo (namespace/name). Created private by `cluster/w4c hub create`.
export W4C_REPO_ID="${W4C_REPO_ID:-cSynBioSys/well4cell}"
# Dataset version string written into the card and the manifest.
export W4C_VERSION="${W4C_VERSION:-1.0.0-rc1}"

# ── Credentials and CLIs ─────────────────────────────────────────────────────
export HF_TOKEN_PATH="${HF_TOKEN_PATH:-$HOME/.config/huggingface/well4cell.token}"
export WCECOLI_HF_ENV="${WCECOLI_HF_ENV:-wcecoli-hf}"
export WCECOLI_HF_BIN="${WCECOLI_HF_BIN:-${MAMBA_ROOT_PREFIX}/envs/${WCECOLI_HF_ENV}/bin/hf}"
# The builder runs under wcecoli-api (h5py, pyarrow, numpy).
export W4C_PYTHON="${W4C_PYTHON:-${WCECOLI_API_PYTHON}}"

# ── Shape of the data ────────────────────────────────────────────────────────
# Strides are fixed per config in well4cell_build/settings.py (CONFIGS): core and *_1s are
# 1 s, expression and metabolism 10 s.
# Parquet row-group cap (rows) and target file size (bytes, compressed estimate).
export W4C_ROW_GROUP_ROWS="${W4C_ROW_GROUP_ROWS:-2048}"
export W4C_FILE_TARGET_BYTES="${W4C_FILE_TARGET_BYTES:-2000000000}"
# Parquet compression codec.
export W4C_COMPRESSION="${W4C_COMPRESSION:-zstd}"
# Fixed seed for the split_by_* columns of the index.
export W4C_SPLIT_SEED="${W4C_SPLIT_SEED:-20261008}"

# ── SLURM ────────────────────────────────────────────────────────────────────
# Same partition and accounts as the transfer: the group's own nodes, no preemption.
export W4C_PARTITION="${W4C_PARTITION:-cpu-g2}"
export W4C_ACCOUNTS="${W4C_ACCOUNTS:-cpu-g2-amath,cpu-g2-stf}"
export W4C_CPUS="${W4C_CPUS:-2}"
export W4C_MEM="${W4C_MEM:-4G}"
export W4C_TIME="${W4C_TIME:-04:00:00}"
export W4C_CONCURRENCY="${W4C_CONCURRENCY:-32}"
# Runs per scan shard (the scan reads every channels.h5 once).
export W4C_SCAN_SHARD_SIZE="${W4C_SCAN_SHARD_SIZE:-200}"
# Array jobs are named with this prefix; it must not start with "wce".
export W4C_JOB_PREFIX="${W4C_JOB_PREFIX:-w4c}"
