#!/usr/bin/env bash
# Build the micromamba environment that pushes campaign output to Hugging Face.
#
#   wcecoli-hf   Python 3.11, huggingface_hub>=2.1  -- provides the `hf` CLI used by
#                                                     cluster/transfer.sbatch
#
# A third environment rather than an addition to wcecoli-api: huggingface_hub pulls in
# hf-xet (a Rust transfer engine) and httpx, neither of which the pinned API environment
# needs, and `hf sync` plus bucket URIs need huggingface_hub>=2.1, which requires
# Python>=3.10. Keeping it separate means a transfer-side upgrade can never break ingestion.
#
# Small enough to build on a login node in a minute. Resumable: re-running installs into
# the existing environment.
#
# Usage:  cluster/setup_hf_env.sh

set -euo pipefail

MAMBA_BIN="${MICROMAMBA_BIN:-$HOME/scripts/micromamba}"
export MAMBA_ROOT_PREFIX="${MAMBA_ROOT_PREFIX:-$HOME/storage/micromamba}"
HF_ENV="${WCECOLI_HF_ENV:-wcecoli-hf}"
HF_HUB_SPEC="${WCECOLI_HF_HUB_SPEC:-huggingface_hub>=2.1,<3}"

if [[ ! -x "${MAMBA_BIN}" ]]; then
  echo "ERROR: micromamba not found at ${MAMBA_BIN} (override with MICROMAMBA_BIN)" >&2
  exit 1
fi

mm() { "${MAMBA_BIN}" "$@"; }

if [[ -d "${MAMBA_ROOT_PREFIX}/envs/${HF_ENV}" ]]; then
  echo "=== ${HF_ENV} already exists; resuming into it ==="
else
  echo "=== Creating ${HF_ENV} (Python 3.11) ==="
  mm create -y -n "${HF_ENV}" -c conda-forge python=3.11 pip
fi

echo "=== Installing ${HF_HUB_SPEC} ==="
mm run -n "${HF_ENV}" pip install --no-cache-dir --upgrade "${HF_HUB_SPEC}"

echo "=== Smoke test ==="
HF_BIN="${MAMBA_ROOT_PREFIX}/envs/${HF_ENV}/bin/hf"
"${HF_BIN}" version
# `hf sync` and hf://buckets/... URIs are what transfer.py is built on; fail loudly if
# the installed CLI lacks them rather than at the first array task.
"${HF_BIN}" sync --help >/dev/null
"${HF_BIN}" buckets --help >/dev/null

echo
echo "Done."
echo "  hf env: ${MAMBA_ROOT_PREFIX}/envs/${HF_ENV}"
echo "  hf cli: ${HF_BIN}"
