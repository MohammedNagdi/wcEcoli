# HF-07 — production container and local upload packages

Completed locally on 28 October 2026. No files have been uploaded to
Hugging Face. Publication permission, account eligibility, repository selection
and real Hub authentication remain HF-08 prerequisites.

## Local operation

Run these from the repository root or `interface/`:

```bash
./platform.sh explorer bundle
./platform.sh explorer up -d --build
./platform.sh explorer ps
./platform.sh explorer logs --tail=50
./platform.sh explorer config --quiet
./platform.sh explorer stop
```

The production explorer is at **http://localhost:7860**. Project
`wcecoli-explorer` contains one web service, limited locally to two CPUs and
512 MiB. The API and compiled React site share one origin. No workers or
simulation service start. Local startup mounts the reviewed dataset read-only;
the container root is read-only, with a bounded temporary filesystem. It runs
as UID/GID 1000 and has no Docker socket.

The launcher resolves its paths independently of the working directory, ignores
inherited Compose project/file overrides for this isolated mode, preserves
argument boundaries and delegates signals/exit codes to Docker. Port 7860 must
be free unless this exact explorer service is already running. `stop` retains
the cache volume, packages and proofs. There is no pruning or volume deletion
command. `config` requires `--quiet` to avoid printing secrets. Full local
platform commands and the existing preview at port 5175 remain available.

No credentials, account setup, manual cleanup, Parca or experiments are needed
for these local commands. Docker Desktop must be running. Drafts on port 7860
have a different browser origin from drafts on port 5175: export/import JSON to
transfer them.

## Frozen upload directories

`explorer bundle` prints the exact versioned directory under
`interface/.explorer/bundles/`. This ignored local directory contains:

| Directory | Contents |
|---|---|
| `space/` | Root Dockerfile and Space README; exact runtime dependency lock; allowlisted backend modules; frontend source/build configuration, lockfile and four explorer captures; original license and third-party notices |
| `dataset/` | Unchanged HF-06 bundle under `release/`; top-level Dataset README, license and publication-status notice |
| `evidence/` | Per-file sizes/SHA-256, source fingerprint, image tag, package byte counts and frozen host launch scripts |

`interface/.explorer/current.json` identifies the current package. Generated
Compose configuration contains only a token interpolation placeholder; no token
value is saved. Input fingerprints include required uncommitted files. A new
input fingerprint produces a new package/tag. Reusing a package verifies its
inventory rather than silently editing frozen source.

The Dataset copy is first validated and byte-verified independently of the
original publication. Additional generated package versions share only this
generated checkpoint via hard links; they do not link to HF-05/HF-06 originals.
Do not edit a generated package. Every file in the Dataset upload directory
counts toward the 10 GB ceiling, including its top-level documentation. Target
remains below 5 GB. No samples, columns, dtypes or timestamps are changed.

The source allowlist excludes the working database, raw listener output, Parca
preparation, scientific model/runtime source, credentials, provider data, tests,
QA output, dependencies and unrelated local homepage captures. The final image
contains only the eight allowlisted `hf_export` modules, campaign JSON, compiled
static frontend, dependency lock and notices. The build stage has frontend
development dependencies, but they are absent from the runtime image. The
dedicated entry point does not import the native execution or pilot applications.

To reproduce a build, use **only the printed `space/` directory as context**:

```bash
docker build -t wcecoli-explorer:review /absolute/path/to/package/space
docker buildx build --platform linux/amd64 --load \
  -t wcecoli-explorer:review-amd64 /absolute/path/to/package/space
```

Node/Python base images are pinned to multi-architecture OCI digests. Frontend
dependencies use `npm ci`; Python direct and transitive dependencies are pinned
in `interface/explorer/requirements.lock`, installed without dependency
resolution and checked with `pip check`. ARM64 and AMD64 image IDs are recorded
separately. Emulation verifies compatibility; it is not hosted performance data.

## Production data startup

The Space defaults to Hub mode; the local launcher explicitly selects local
mode. Runtime configuration is:

| Variable | Meaning |
|---|---|
| `EXPLORER_DATA_MODE` | `local` or `hub`; Docker image default is `hub` |
| `EXPLORER_RELEASE` | Read-only local mount, or cache activation path (`/data/current`) |
| `EXPLORER_DATASET_REPO` | Private Dataset `owner/name`; required for a Hub cache miss |
| `EXPLORER_DATASET_REVISION` | Full immutable 40-character commit SHA; branches/tags rejected |
| `EXPLORER_DATASET_DIR` | `release` |
| `EXPLORER_MANIFEST_SHA256` | Reviewed manifest hash; defaults to the HF-06 hash below |
| `HF_TOKEN` | Runtime-only read token for the private Dataset; configure as a Space secret |
| `EXPLORER_CACHE` | Ephemeral cache root, default `/data` |

No actual repository ID, Dataset commit or token is configured in HF-07.
The expected manifest SHA-256 is:

```text
5ec44906b5ef88152261a77676959e624fa7cb4ba65dc3bcd517799373228a18
```

Startup downloads the manifest first and authenticates its fingerprint before
trusting its inventory. It then downloads only declared payloads sequentially,
checks exact sizes/hashes and activates the complete copy atomically. SDK cache
metadata stays outside the strict release directory. Xet parallel downloads,
telemetry and implicit credentials are disabled. Retries are bounded; the whole
download phase has a 20-minute deadline. Storage is checked for both the SDK
cache and clean copy. Failure messages omit tokens, headers and signed URLs.

An intact cache of the same repository, immutable revision and manifest may be
used offline without a token. Corrupt caches, partial files, unavailable
revisions and wrong fingerprints fail closed. An older release is never served
as a fallback. Nothing listens until full structural validation passes; pilot,
synthetic or reference-free bundles cannot start production. Validation is
single-flight within the one serving worker. Health is `GET /api/health`.

After preparation, `exec` replaces the downloader with one Uvicorn process on
`0.0.0.0:7860`, releasing SDK memory and removing `HF_TOKEN` from its environment.
Two response slots remain held through transmission. SQLite is immutable/read
only; API writes return 405. Missing API routes and assets return real 404s;
React deep links receive the SPA document. SIGTERM uses Uvicorn's bounded
graceful shutdown after readiness. During synchronous startup validation, a
temporary signal handler cancels the scan promptly; intentional startup
cancellation exits with Uvicorn code 3 and restores normal handlers. Space startup timeout is 30 minutes.

Default Space storage is ephemeral; this cache can be reconstructed. Paid
persistent storage is not required for this design. A private Dataset does not
hide values exposed by a public explorer API.

## Verification and handoff

Local evidence is recorded under `interface/.explorer/proofs/`:

- `backend-tests.txt`: campaign/export, production, worker and local launcher contracts.
- `bootstrap.json`: real pinned SDK, dummy private local HTTP transport and all real scientific release bytes; no Hub account was contacted.
- `native-build.log`, `amd64-build.log`, `amd64-build.json`: standalone package builds.
- `runtime.json`, `final/runtime.json`, `runtime-inventory.json`: production restart, shutdown, imports, resources and immutable payloads.
- `amd64-runtime.json`: emulated full-release startup, real mass clocks/values and graceful exit.
- `strict-validation.json`: full release validation without pilot/synthetic flags.
- `live-http-final/`: all twelve designs/four matrix families compared independently with original HDF5.
- `api-acceptance.json`: reference routes, 94 derived-metric comparisons and eight concurrent clients.
- `browser-final/`, `browser-final.txt`: real published pages/results/controls/drafts, JSON transfer, desktop/mobile, themes and accessibility.
- `final/isolation-resources.json`: main DB/container/image identities, preparation checksums and verified raw-removal states.

The production transport test deliberately emulates Hub HTTP using a dummy
token and real files; genuine private Hub access can only be accepted in HF-08.
The existing Vite large-chunk warning is retained; no visual redesign is part of
packaging. Final package identities and measured results are recorded below.

Rollback remains the unchanged HF-06 serving bundle/images behind
`./platform.sh demo preview`, and the original HF-05 publication is retained.
Stopping the production explorer does not change either. No upload, repository
creation, billing change or rights request is implemented by these commands.

Before HF-08, clarify redistribution rights for the specific included materials
and numerical outputs, choose account/repository names and visibility, confirm
current Space eligibility, and configure upload/read credentials through normal
secure account flows. Never paste tokens into chat or commit them to packages.

Official references checked for this task: [Docker Spaces](https://huggingface.co/docs/hub/spaces-sdks-docker),
[Space configuration](https://huggingface.co/docs/hub/spaces-config-reference),
[pinned downloads](https://huggingface.co/docs/huggingface_hub/guides/download),
[download environment controls](https://huggingface.co/docs/huggingface_hub/package_reference/environment_variables).


## Completion record

Final package: `interface/.explorer/bundles/3263273270e2fea67c9f/`.

- Source fingerprint: `3263273270e2fea67c9f11625347c4d664bd5a2bd82a265124956829e3d2aba5`.
- Space upload tree: **134 files, 2,568,167 bytes**.
- Dataset upload tree: **21 files, 1,280,819,515 bytes** (1.28 GB decimal).
- Unchanged scientific serving bundle: **18 files, 1,280,813,520 bytes**;
  12 experiments / 47 trajectories / identical HDF5 checksums.
- ARM64 tag: `wcecoli-explorer:3263273270e2fea67c9f`;
  image ID `sha256:0b99a60c3959cec52b278b0c54ae1a3aa21a861c5b5bc421329d4b077456c73e`.
- AMD64 tag: `wcecoli-explorer:3263273270e2fea67c9f-amd64`;
  image ID `sha256:01c54ae70f3e6b30ce4910e9f8313e3f6e59d77aa3c4c3fdba2651075719dd70`.
- Docker-reported image sizes: **87,894,509 bytes ARM64**, **88,652,202 bytes AMD64**.

Verification passed: **226 backend tests and 46 subtests**, **14 final production
explorer browser tests**, **62 isolated local-mode browser regressions**, **48
experiment/family HTTP checks with 3,948 exact source comparisons**, **94 derived
metric comparisons**, and **18 requests with eight concurrent clients**. Strict
validation reports `valid: true`, no pilot/synthetic opt-ins and below-target
size. Original publication files, original containers/images/DB contents and
Parca readiness match their baselines. All twelve verified raw directories
remain removed. No experiments, preparation or uploads ran.

Measured native process cold restart: **53.44 seconds**; warm health response
**4.45 ms** during the restart check; ready-process graceful stop **0.51 seconds**.
Startup-validation cancellation took **0.14 seconds**, without forced kill.
AMD64 startup under ARM64 emulation: **59.35 seconds**, real mass/time values
match, graceful exit 0. These are local observations with existing filesystem
caches, not private-Hub download or hosted performance estimates.

Both architectures stayed within the configured **512 MiB** cgroup ceiling with
**zero OOM/OOM-kill events**. The measured peak reached that ceiling: Linux
reclaimed filesystem page cache during scans; this is not a claim of spare
memory headroom. The final native resource probe measured **314,798,080 bytes**
(about 300.2 MiB), including the extra integrity-probe process. The two-response
bound remains active. Final available storage: **48,342,568,960 host bytes**
(about 45.0 GiB), **396,484,542,464 Docker-storage bytes** (about 369.3 GiB).

Static-asset acceptance exposed the minimal Python image's missing WebP MIME
mapping; explicit WebP/font/JS/CSS types fixed it. A shutdown probe also revealed
that synchronous validation delayed ordinary Uvicorn signals; startup
cancellation is now tested independently from ready-process graceful shutdown.
Final screenshots of real results, dark desktop environment design and light
mobile design were visually inspected; the approved visual system is preserved.

`interface/.explorer/proofs/acceptance.json` binds these results to the final
package and image IDs. `upload-inventory.tsv` lists every upload file's size and
checksum. Early diagnostic runs are retained separately; `browser-final/`,
`live-http-final/` and `final/` are the final verification evidence. Both temporary
smoke containers were stopped and removed; the production explorer remains
running at http://localhost:7860. The HF-06 rollback preview remains at port 5175.

**HF-07 Done. HF-08 Ready for preparation; uploading remains gated** on publication
rights clarification, account eligibility, repository choices and configured
access. No real Hugging Face authentication or hosted behavior is claimed here.


## Bundle cleanup — 30 October 2026

Removed the three superseded generated bundles (`103a3bdffe35d18634fe`,
`8ee9ab2b63d7789e4cad`, `0508069f90a3f49a830e`) at the user’s request.
Only the final accepted `3263273270e2fea67c9f` bundle remains. Its Space and
Dataset inventories were verified unchanged before and after removal. Small
historical receipts/scripts were retained under `.explorer/proofs/superseded-bundles/`.
The supporting dataset checkpoint, scientific preparation, HF-05/HF-06 rollback
publications, Docker images/volumes and running services were retained.
Cleanup receipt: `.explorer/proofs/bundle-cleanup-2026-10-30.json`.
