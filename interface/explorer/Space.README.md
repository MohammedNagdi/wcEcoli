---
title: wcEcoli Explorer
sdk: docker
app_port: 7860
startup_duration_timeout: 30m
license: other
license_name: stanford-wcecoli-noncommercial-restricted
license_link: LICENSE.md
---

Explore twelve precomputed wcEcoli experiment designs and 47 sequential generation
trajectories. Design tools save personal drafts in this browser; they cannot run
experiments. One seed per design does not provide independent replicates.

This explorer uses the Stanford wcEcoli model and associated reference material.
See `LICENSE.md`, `THIRD_PARTY_NOTICES.txt` and `PUBLICATION.md`. This package is
prepared locally. The owner has confirmed hosting permission for this version;
additional features must be communicated first. See `PUBLICATION.md` for scope.

Configure runtime variables `EXPLORER_DATA_MODE=hub`,
`EXPLORER_DATASET_REPO=owner/name`, `EXPLORER_DATASET_REVISION` (the full immutable
40-character Dataset commit SHA), `EXPLORER_DATASET_DIR=release`, and
`EXPLORER_MANIFEST_SHA256` (the reviewed manifest SHA-256). Configure `HF_TOKEN`
as a Space secret with read access to the private Dataset. Never use build args
or frontend variables for tokens. The Dataset package contains `release/`.

The default expected manifest is the reviewed HF-06 release. Startup downloads
only its declared files, checks sizes/checksums, and validates the full real
release before serving. An intact cache of that exact revision can be used
offline. A missing token, mutable revision, corrupt cache or invalid bundle fails
startup; another release is never substituted. Downloading is bounded to 20
minutes. `/data` is an ephemeral cache and can be reconstructed after a restart.

Local testing may instead set `EXPLORER_DATA_MODE=local` and
`EXPLORER_RELEASE=/published`, mounting the unchanged release there read-only.
Build this directory alone with `docker build -t wcecoli-explorer:review .`.
Serve port 7860; the process runs as UID 1000. Health is `/api/health`.
The React site and API share the same origin; deep links work without a proxy.

Browser drafts are specific to the browser and origin. Export them before
changing ports, domains or clearing site storage. No shared database writes,
simulation runner, assistant, provider or training services are included.
