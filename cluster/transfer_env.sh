# Environment for pushing campaign output to a Hugging Face bucket. Source it, don't
# execute it:
#
#     source cluster/transfer_env.sh
#
# Layers on top of campaign_env.sh (which supplies WCECOLI_CAMPAIGN_ROOT and the
# micromamba settings). Every knob transfer.py reads is defined here, with its default,
# so this file is the complete list of what can be configured.

_WCE_CLUSTER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${_WCE_CLUSTER_DIR}/campaign_env.sh" >/dev/null
unset _WCE_CLUSTER_DIR

# ── Where ────────────────────────────────────────────────────────────────────
# Destination bucket, as an hf:// URI. Everything lands under it with the campaign's own
# layout: out/<run>/..., logs/..., state/..., transfer/{README.md,symlinks.jsonl}.
export WCECOLI_TRANSFER_DEST="${WCECOLI_TRANSFER_DEST:-hf://buckets/cSynBioSys/well4cell}"
# The transfer's own ledger. A sibling of out/, logs/ and state/, never inside state/,
# because state/ is itself transferred.
export WCECOLI_TRANSFER_ROOT="${WCECOLI_TRANSFER_ROOT:-${WCECOLI_CAMPAIGN_ROOT}/transfer}"

# ── Credentials ──────────────────────────────────────────────────────────────
# huggingface_hub reads the token from this file natively. It must live under $HOME, at
# mode 600, and never under the repo or the campaign root. dispatch refuses otherwise.
export HF_TOKEN_PATH="${HF_TOKEN_PATH:-$HOME/.config/huggingface/well4cell.token}"

# ── The hf CLI ───────────────────────────────────────────────────────────────
# Built by cluster/setup_hf_env.sh. transfer.py itself also runs under this interpreter:
# it is stdlib-only, but the environment is a hard requirement anyway because `hf` lives
# in it, and the system python3 is 3.6.
export WCECOLI_HF_ENV="${WCECOLI_HF_ENV:-wcecoli-hf}"
export WCECOLI_HF_PYTHON="${WCECOLI_HF_PYTHON:-${MAMBA_ROOT_PREFIX}/envs/${WCECOLI_HF_ENV}/bin/python}"
export WCECOLI_HF_BIN="${WCECOLI_HF_BIN:-${MAMBA_ROOT_PREFIX}/envs/${WCECOLI_HF_ENV}/bin/hf}"

# ── Sharding and concurrency ─────────────────────────────────────────────────
# One array task transfers one shard of this many units (an experiment directory is one
# unit). Measured on cpu-g2: a 10-file, ~120 MB unit takes 4-6 s per process, of which
# ~2 s is process start plus the remote listing, so a shard of 100 is ~10 min.
export WCECOLI_TRANSFER_SHARD_SIZE="${WCECOLI_TRANSFER_SHARD_SIZE:-100}"
# The array's %N cap: how many shards upload at once. One process is overhead-bound at
# ~20 MB/s and 8 in parallel on one node reached ~130 MB/s with no per-process loss, so
# this is the throughput knob. klone's measured ceiling is ~348 MB/s. The pilot runs at 1.
export WCECOLI_TRANSFER_CONCURRENCY="${WCECOLI_TRANSFER_CONCURRENCY:-16}"
# Per-unit `hf sync` attempts before the unit is recorded as failed.
export WCECOLI_TRANSFER_RETRIES="${WCECOLI_TRANSFER_RETRIES:-3}"

# ── SLURM ────────────────────────────────────────────────────────────────────
# cpu-g2 is the group's own partition: no time limit, not preemptible. Accounts are tried
# in order; the first one sbatch accepts wins. Note the account and partition strings
# differ (cpu-g2-amath pairs with cpu-g2).
export WCECOLI_TRANSFER_PARTITION="${WCECOLI_TRANSFER_PARTITION:-cpu-g2}"
export WCECOLI_TRANSFER_ACCOUNTS="${WCECOLI_TRANSFER_ACCOUNTS:-cpu-g2-amath,cpu-g2-stf}"
export WCECOLI_TRANSFER_CPUS="${WCECOLI_TRANSFER_CPUS:-2}"
export WCECOLI_TRANSFER_MEM="${WCECOLI_TRANSFER_MEM:-4G}"
# A 100-unit shard is ~10 min nominal; 2 h absorbs a slow period several times over.
export WCECOLI_TRANSFER_TIME="${WCECOLI_TRANSFER_TIME:-02:00:00}"
# Submit with --requeue so a move to a preemptible partition costs nothing. Durability
# comes from the ledger, not from the requeue.
export WCECOLI_TRANSFER_REQUEUE="${WCECOLI_TRANSFER_REQUEUE:-1}"

# ── Guards ───────────────────────────────────────────────────────────────────
# dispatch refuses while any job of $USER whose name starts with one of these prefixes
# is in squeue (campaign arrays are wce-<id>, the loop is wce-tick). Comma-separated.
export WCECOLI_TRANSFER_GUARD_PREFIXES="${WCECOLI_TRANSFER_GUARD_PREFIXES:-wce}"
# Transfer arrays are named with this prefix so they never trip the guard above.
export WCECOLI_TRANSFER_JOB_PREFIX="${WCECOLI_TRANSFER_JOB_PREFIX:-hfx}"

# ── Exclusions ───────────────────────────────────────────────────────────────
# fnmatch patterns against each file's path relative to its unit, comma-separated.
# WCECOLI_TRANSFER_EXCLUDE applies to every unit; the state/ unit adds its own list.
# assistant_secret.key is a secret and must not leave the cluster; the .bak-* files are
# database backups; .lock and -journal are transient.
export WCECOLI_TRANSFER_EXCLUDE="${WCECOLI_TRANSFER_EXCLUDE:-*.tmp}"
export WCECOLI_TRANSFER_STATE_EXCLUDE="${WCECOLI_TRANSFER_STATE_EXCLUDE:-assistant_secret.key,wcecoli.db.bak-*,wcecoli.db.lock,wcecoli.db-journal}"

# ── Which runs ───────────────────────────────────────────────────────────────
# Job statuses (simulation_jobs.status in the campaign database) whose run directories
# are transferred, comma-separated; "all" disables the filter. A failed attempt leaves a
# run directory too (~255 MB, a partial HDF5 plus the modified sim data), so the database,
# not the filesystem, decides what is finished. Parca caches, logs/ and state/ are always
# included. The database path comes from campaign_env.sh (DATABASE_PATH).
export WCECOLI_TRANSFER_STATUSES="${WCECOLI_TRANSFER_STATUSES:-done}"
