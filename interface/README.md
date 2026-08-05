# wcEcoli Web Platform

Interactive experiment designer, simulation runner, and analysis suite for the whole-cell *E. coli* model.

The platform provides a browser-based interface for designing gene knockout experiments, launching simulations inside Docker containers, visualising time-series results, training surrogate ML models, and exploring genome-wide essentiality.

---

## Architecture

The platform has four runtime components:

| Component | Technology | Port | Runs in Docker? |
|-----------|-----------|------|-----------------|
| **Backend API** | FastAPI + SQLite | 8000 | Optional |
| **Frontend** | Vite + React + Tailwind | 5173 | Optional |
| **Simulation Worker** | Python scheduler | — | Yes |
| **Simulation Runner** | `wcecoli-sim:latest` | — | Yes (runs parallel subprocesses) |

The backend and frontend can run natively or through Docker Compose. Simulation execution uses one persistent `wcecoli-sim:latest` container containing the compiled model dependencies. The worker schedules database jobs into isolated subprocesses inside that runner.

### How Docker is used

Docker isolates the heavy simulation environment. The wcEcoli model requires compiled C/Fortran extensions, Cython modules, and numerical libraries, which are packaged in the persistent runner image.

The flow is:

1. The **worker** polls the SQLite database for pending simulation jobs.
2. The worker submits the job over a Unix socket to the persistent runner.
3. The runner executes two stages:
   - **Parca** (parameter calculator) — generates `simData.cPickle` (~500 MB). This is cached and reused across runs with the same parameters.
   - **Simulation** — the actual whole-cell simulation (~30 min per generation on a modern CPU).
4. Independent jobs run concurrently as subprocesses; generations in one lineage remain sequential.
5. Output files land in `out/<run_id>/` on the shared volume.
6. The worker ingests the results back into SQLite and updates the job status.

The backend API and frontend do not require Docker for browsing or experiment design. Simulation execution uses Docker Compose so the worker and runner share the database and output volumes.

---

## Prerequisites

- **Python 3.11+** (backend)
- **Node.js 18+** and **npm** (frontend)
- **Docker Desktop** or **Docker Engine** (simulation only — not needed to browse data or design experiments)

---

## Quick Start — Native (recommended for development)

### 1. Start the Backend

```bash
cd interface/backend

# First time only:
pip install -e ".[dev]"

# Set environment variables:
export RECONSTRUCTION_PATH="$(cd ../.. && pwd)/reconstruction"
export MODELS_PATH="$(cd ../.. && pwd)/models"
export DATABASE_PATH="$(pwd)/data/wcecoli.db"
export WCECOLI_ROOT="$(cd ../.. && pwd)"

mkdir -p data

# Launch:
uvicorn app.main:app --reload --port 8000
```

On first startup, the backend parses all TSV files from `reconstruction/ecoli/flat/` into SQLite. This takes a few seconds. Subsequent starts skip ingestion if the TSVs haven't changed.

Verify: http://localhost:8000/api/health should return `{"status":"ok", ...}`.

**Windows (PowerShell):**

```powershell
cd interface\backend
pip install -e ".[dev]"

$env:RECONSTRUCTION_PATH = (Resolve-Path "..\..\reconstruction")
$env:MODELS_PATH = (Resolve-Path "..\..\models")
$env:DATABASE_PATH = "$(Get-Location)\data\wcecoli.db"
$env:WCECOLI_ROOT = (Resolve-Path "..\..").Path

mkdir -Force data
uvicorn app.main:app --reload --port 8000
```

### 2. Start the Frontend

In a second terminal:

```bash
cd interface/frontend

# First time only:
npm install

# Launch:
npm run dev
```

Open http://localhost:5173. The Vite dev server proxies all `/api` requests to the backend on port 8000.

### 3. Build the Simulation Docker Image

Only needed if you want to run simulations (not required for browsing data or designing experiments):

```bash
# From the repo root:
docker build -t wcecoli-sim:latest -f docker/local/Dockerfile .
```

This takes 10–20 minutes the first time (compiling Cython extensions). Subsequent builds use Docker layer cache.

### 4. Start Simulation Execution

The persistent runner and worker are designed to run through Docker Compose:

```bash
cd interface
SIM_RUNNER_CONCURRENCY=4 SIM_RUNNER_CPU_BUDGET=8 docker compose up -d sim-runner worker
```

Concurrency defaults to `1`. Increase it only after measuring peak memory per simulation. The Compose API, worker, and runner must use the same SQLite and output volumes.

From the repository root, the launcher accepts concurrency and an optional CPU budget:

```bash
./interface/start-worker.sh 4 8
```

Without the second argument, the budget is `max(concurrency * SIM_CPUS_PER_JOB, PARCA_CPUS)`.
The launcher prints the requested and effective simulation capacity before starting Compose.

---

## Quick Start — Docker Compose

If you prefer running the backend and frontend in Docker too:

```bash
cd interface
docker compose up --build
```

This starts four containers: API, frontend, worker, and one persistent simulation runner. `docker compose up --build` builds the runner image when needed.

Source code is bind-mounted into the containers (`./backend/app:/app/app` and `./frontend/src:/app/src`), so most changes are picked up automatically: the backend uses `uvicorn --reload` and the frontend uses Vite HMR. If hot reload doesn't pick up changes (new files, config changes, dependency updates), restart the relevant service:

```bash
# Restart just the frontend:
docker compose restart web

# Restart backend + worker:
docker compose restart api worker

# Full rebuild (nuclear option — needed after dependency changes):
docker compose down && docker compose up -d --build
```

After restarting the frontend, do a hard refresh in the browser (`Ctrl+Shift+R`) to clear Vite's module cache.

---

## Running a Simulation

1. Open http://localhost:5173
2. Go to **Genes** → click a gene → **Design knockout experiment**
3. Or go to **Experiments** → **+ New experiment** and configure manually
4. Save the experiment, then click **Run simulation**
5. The worker picks up the job within 5 seconds
6. Watch the job status update in real time: Parca → Simulation → Ingesting → Done
7. View results on the **Results** tab — time-series charts, summary cards, molecule explorer

Each job runs two subprocess stages inside the persistent runner container:
- **Parca**: `python runscripts/manual/runParca.py -c $PARCA_CPUS <parca_cache_id>` — content-addressed and shared across jobs with identical reconstruction/model inputs
- **Simulation**: `python runscripts/manual/runSim.py out/<run_id> --variant <type> <idx> <idx> --seed <s> --generations <g>`

Output goes to `out/<run_id>/<variant_dir>/<seed>/generation_000000/000000/simOut/`.

The runner defaults to `PARCA_CPUS=8` and permits one Parca process at a time.
Duplicate requests for the same cache key attach to the same runner task. A cache entry is reused only after all expected KB files and
its completion manifest exist. Changes under `reconstruction/ecoli`,
`models/ecoli`, the configured Docker image, or Parca defaults create a new
cache key and rerun Parca.

Set `SIM_RUNNER_CONCURRENCY=N` to run up to `N` independent simulations. The
shared `SIM_RUNNER_CPU_BUDGET` covers simulations and Parca. With the default
budget of eight, an 8-CPU Parca temporarily uses the entire budget. Simulation
subprocesses set BLAS, OpenMP, and MKL thread counts to one.
`runSim.py` remains single-core for each job; speedup comes from running independent jobs concurrently.
Generations in one lineage remain sequential because each daughter depends on the prior generation.

Job claims use `(worker_id, attempt)` as a fencing token and renew a lease throughout Parca,
simulation, parsing, export, and database ingestion. Cancellation is durable: an active job remains
`cancelling` until its runner subprocess has stopped. A partial lineage or unreadable `simOut` fails
the job and cannot replace previously ingested summaries.

Check runner capacity and activity through the API health endpoint:

```bash
curl -s http://localhost:8000/api/health
docker compose logs -f sim-runner worker
```

For a development smoke check without submitting campaign jobs:

```bash
cd ..
PYTHONPATH='.:interface/backend' python -m unittest runscripts.manual.test_simRunner -v
```

---

## UI Pages

The interface uses a three-stage workflow navigation — **Explore → Simulate → Analyze** — with a secondary sub-nav for stages that contain multiple pages:

| Stage | Page | Description |
|-------|------|-------------|
| **Explore** | Genes | Searchable/filterable table of all 1,592 genes with categories, mechanistic status, and links to TF regulation |
| **Explore** | Network | Interactive Cytoscape.js graph of TF → target regulatory connections |
| **Explore** | Genome | Circular chromosome map with gene annotations, zoom/rotate, and click-through to gene catalog |
| **Explore** | Pathways | Essentiality heatmap by functional category and amino acid biosynthesis pathway diagram |
| **Simulate** | Experiments | Create single or batch knockout experiments, configure conditions and timelines, optional WT control, cost estimator |
| **Simulate** | Batch | Screen presets (all mechanistic, by category) or explicit gene lists with parallel experiment creation |
| **Analyze** | Results | Time-series charts (mass, growth rate, RNA/DNA/protein), summary cards, WT delta comparison, molecule explorer with multi-identifier search |
| **Analyze** | ML | Train surrogate classifiers (Random Forest, Gradient Boosting) on simulation features — essentiality prediction with cross-validation metrics |
| **Analyze** | Design | Genome-wide essentiality overview with phenotype classification (essential / growth defect / neutral), stacked bar charts by category |

A **Guide** icon in the header provides in-platform reference for experiment configuration, variant types, and conditions.

---

## API Endpoints

The backend exposes 47 routes across 8 routers:

### Genes (`/api/genes`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/genes` | Paginated gene list with search, category, and mechanistic filters |
| GET | `/api/genes/search` | Quick typeahead search |
| GET | `/api/genes/categories` | Category counts |
| GET | `/api/genes/by-ko-index/{ko_index}` | Lookup by knockout index |
| GET | `/api/genes/{symbol}` | Gene detail with TF regulation |

### Pathways & Reference Data (`/api`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tf-network` | Full TF regulatory network |
| GET | `/api/tf-network/{tf_symbol}` | Single TF subnetwork |
| GET | `/api/pathways/amino-acids` | Amino acid biosynthesis pathways |
| GET | `/api/conditions` | Growth conditions |
| GET | `/api/timelines` | Simulation timeline definitions |
| GET | `/api/variants` | Variant types (gene_knockout, etc.) |

### Experiments (`/api/experiments`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/experiments` | List experiments (optionally filter by status) |
| POST | `/api/experiments` | Create single experiment |
| GET | `/api/experiments/{id}` | Get experiment detail |
| PATCH | `/api/experiments/{id}` | Update experiment |
| DELETE | `/api/experiments/{id}` | Delete experiment |
| POST | `/api/experiments/{id}/run` | Launch simulation (accepts seeds, generations, condition overrides) |
| GET | `/api/experiments/{id}/results` | Aggregated results across seeds (mean ± CI) |
| GET | `/api/experiments/variants/{name}` | Variant type detail with parameter hints |
| POST | `/api/experiments/batch` | Batch creation — explicit list or screen presets (`all_mechanistic`, `gene_knockout_all`, `gene_knockout_category:<cat>`) |

### Jobs (`/api/jobs`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/jobs` | List jobs (filter by experiment_id, status) |
| GET | `/api/jobs/{id}` | Job detail with log tail |
| GET | `/api/jobs/{id}/results` | Per-seed simulation results |
| DELETE | `/api/jobs/{id}` | Cancel running job |
| POST | `/api/jobs/{id}/reingest` | Re-extract results from simulation output |

### Results & Timeseries (`/api`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/jobs/{id}/timeseries` | Time-series data (mass, growth rate, RNA, DNA, protein) |
| GET | `/api/features` | ML feature matrix (JSON) across all completed experiments |
| GET | `/api/features/csv` | Same as above, CSV download |
| GET | `/api/jobs/{id}/debug` | Raw debug info for a job's simulation output |

### Molecules (`/api/jobs/{id}/molecules`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/jobs/{id}/molecules` | Available molecule types and counts for a job |
| GET | `/api/jobs/{id}/molecules/{type}/ids` | Molecule IDs with search and pagination |
| GET | `/api/jobs/{id}/molecules/{type}/timeseries` | Time-series for specific molecule IDs |
| GET | `/api/jobs/{id}/molecules/search` | Cross-type molecule search |

### Machine Learning (`/api/ml`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/ml/data-summary` | Dataset summary (experiments, genes, conditions) |
| POST | `/api/ml/train` | Train a classifier/regressor and return metrics + feature importances |
| GET | `/api/ml/models` | List trained models |

### Genome Design (`/api/design`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/design/overview` | All genes with KO phenotype classification |
| GET | `/api/design/essentiality` | Essentiality breakdown by gene category |

### System
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |

---

## Environment Variables

| Variable | Used by | Description |
|----------|---------|-------------|
| `RECONSTRUCTION_PATH` | Backend, Worker | Path to `reconstruction/` directory |
| `MODELS_PATH` | Backend | Path to `models/` directory |
| `DATABASE_PATH` | Backend, Worker | Path to SQLite database file |
| `WCECOLI_ROOT` | Backend, Worker | Repo root (for resolving relative paths) |
| `SIM_OUTPUT_DIR` | Worker | Shared output and runner control directory |
| `SIM_RUNNER_CONCURRENCY` | Worker, Runner | Maximum concurrent simulation subprocesses; default `1` |
| `SIM_RUNNER_CPU_BUDGET` | Worker, Runner | CPU tokens and runner-container CPU limit; default `8` |
| `SIM_CPUS_PER_JOB` | Worker | CPU tokens allocated to each simulation; default `1` |
| `SIM_RUNNER_MEMORY_LIMIT` | Runner | Optional container-wide Docker memory limit |
| `SIM_RUNNER_SOCKET` | API, Worker, Runner | Shared Unix control socket |
| `PARCA_CPUS` | Worker | CPU tokens allocated to Parca; default `8` |
| `WORKER_LEASE_TIMEOUT` | Worker | Seconds before an unrenewed job is recoverable |

---

## Project Structure

```
interface/
├── README.md                          # ← this file
├── .env                               # Host-specific settings (git-ignored)
├── .gitignore
├── docker-compose.yml                 # API + Worker + Persistent Runner + Frontend
├── docker-compose.sim.yml             # Simulation image build only
├── start-worker.sh                    # Compose runner launcher: concurrency + optional CPU budget
├── tests/
│   └── smoke_test_fresh_clone.py      # Fresh-clone validation (schema, data, API)
│
├── backend/
│   ├── Dockerfile                     # Backend container image
│   ├── pyproject.toml                 # Python dependencies (FastAPI, SQLModel, h5py, scikit-learn)
│   ├── .schema_version               # Tracks DB schema version for auto-reingest
│   └── app/
│       ├── __init__.py
│       ├── main.py                    # FastAPI app with lifespan, migrations, auto-reingest
│       ├── config.py                  # Pydantic Settings (env var loading)
│       ├── data/
│       │   └── ko_index_map.json     # Ground-truth gene→ko_index mapping from simData
│       ├── db/
│       │   ├── __init__.py
│       │   ├── init_db.py            # TSV → SQLite ingestion pipeline
│       │   └── models.py             # SQLModel table definitions
│       ├── routers/
│       │   ├── __init__.py
│       │   ├── genes.py              # Gene catalog API (search, filter, detail)
│       │   ├── pathways.py           # TF network, amino acid pathways, conditions, timelines, variants
│       │   ├── experiments.py        # Experiment CRUD, batch creation, run, aggregation
│       │   ├── jobs.py               # Job queue, status polling, cancel, reingest
│       │   ├── results.py            # Timeseries extraction, feature matrix, CSV export
│       │   ├── molecules.py          # Per-molecule timeseries (mRNA, protein, metabolite)
│       │   ├── ml.py                 # ML training (Random Forest, Gradient Boosting, cross-val)
│       │   └── design.py             # Genome-wide essentiality overview
│       ├── scripts/
│       │   └── extract_ko_map.py      # Extract ko_index mapping from simData.cPickle
│       └── services/
│           ├── __init__.py
│           ├── sim_worker.py          # Fenced job executor and persistent-runner client
│           ├── sim_runner_client.py   # Unix-socket protocol client
│           ├── table_reader_bridge.py # Standalone wcEcoli binary format (.npy-like) reader
│           └── iff_reader.py          # IFF (internal file format) reader utility
│
├── frontend/
│   ├── Dockerfile                     # Frontend container image
│   ├── package.json                   # Dependencies (React, Chart.js, Cytoscape.js, Zustand)
│   ├── tsconfig.json
│   ├── vite.config.ts                 # Vite config with /api proxy to backend
│   ├── tailwind.config.js
│   ├── postcss.config.js
│   ├── index.html
│   └── src/
│       ├── main.tsx                   # React entry point
│       ├── App.tsx                    # Router setup (13 routes)
│       ├── api/
│       │   └── client.ts             # Typed API client (all 47 endpoints)
│       ├── types/
│       │   ├── index.ts              # TypeScript interfaces for all API responses
│       │   └── react-cytoscapejs.d.ts
│       ├── hooks/
│       │   └── useGenes.ts           # Gene search hook with debounce
│       ├── utils/
│       │   ├── labels.ts             # Human-readable category/variant labels
│       │   └── genome.ts             # Coordinate math for circular chromosome (bpToAngle, arcPath)
│       ├── styles/
│       │   └── globals.css           # Tailwind base + custom styles
│       └── components/
│           ├── common/
│           │   ├── Badge.tsx          # Colored status badges
│           │   ├── HelpTip.tsx        # Inline contextual help tooltips
│           │   ├── Pagination.tsx     # Page navigation
│           │   ├── SearchInput.tsx    # Debounced search input
│           │   └── Skeleton.tsx       # Loading placeholders
│           ├── layout/
│           │   └── Shell.tsx          # App shell with navigation tabs
│           ├── genes/
│           │   ├── GeneCatalogPage.tsx    # Gene table with filters and infinite scroll
│           │   └── GeneDetailPanel.tsx    # Gene detail with TF regulation
│           ├── network/
│           │   └── TFNetworkPage.tsx      # Interactive TF regulatory graph
│           ├── genome/
│           │   ├── GenomeViewerPage.tsx    # Circular genome viewer page
│           │   └── CircularGenomeMap.tsx   # SVG circular chromosome with gene arcs
│           ├── pathways/
│           │   ├── PathwaysPage.tsx        # Tab toggle between heatmap and pathway views
│           │   ├── EssentialityHeatmap.tsx # Gene essentiality grid by functional category
│           │   └── AAPathwayDiagram.tsx    # Amino acid biosynthesis node-link diagram
│           ├── experiments/
│           │   ├── ExperimentListPage.tsx  # Experiment list with status polling
│           │   ├── ExperimentDesigner.tsx  # Create/edit form with gene impact preview, cost estimator
│           │   ├── BatchCreator.tsx        # Batch experiment creation with screen presets
│           │   ├── BatchDashboard.tsx      # Batch run overview and progress
│           │   ├── FailedJobsPanel.tsx     # Failed job diagnostics
│           │   ├── ExperimentDetailPanel.tsx # Detail panel with job cards
│           │   └── ExperimentGuidePage.tsx # In-platform documentation
│           ├── results/
│           │   ├── ResultsBrowserPage.tsx  # Top-level results browser
│           │   ├── ComparisonDashboard.tsx # Side-by-side experiment comparison
│           │   ├── ResultsPage.tsx        # Charts, summary cards, WT delta, seed aggregation
│           │   └── MoleculeExplorer.tsx   # Per-molecule timeseries (gene/monomer/complex/RNA search)
│           ├── ml/
│           │   └── MLPage.tsx             # ML training interface with metrics
│           └── design/
│               └── DesignPage.tsx         # Genome-wide essentiality dashboard
```

---

## Platform Compatibility

**Windows:**
- Docker Desktop must have WSL2 backend enabled (default on modern Windows).
- Line endings: if `entrypoint.sh` has CRLF endings, run `sed -i 's/\r$//' docker/local/entrypoint.sh` and rebuild.
- OneDrive sync can corrupt files and cause git lock conflicts. Consider excluding the repo folder from sync (see Troubleshooting below).

**macOS:**
- Apple Silicon (M1/M2/M3): the sim image builds natively — no Rosetta needed.

**Linux:**
- Docker Engine works directly; the worker does not require the Docker socket.

---

## Stopping Everything

| Component | How to stop |
|-----------|-------------|
| Backend / Frontend | `Ctrl+C` in their terminals |
| Worker | `docker compose stop worker` (stops claiming and drains active jobs) |
| Running simulation | Click "Cancel" in the UI; the job remains `cancelling` until subprocess termination is confirmed |
| Simulation runner | `docker compose stop -t 1800 sim-runner` |
| Docker Compose | `Ctrl+C` or `docker compose down` |

---

## Troubleshooting

**OneDrive sync conflicts:** If the repo lives inside a OneDrive-synced folder, you may see truncated files, git lock errors, phantom "modified" files, and slow git operations. **Strongly recommended:** move the repo outside OneDrive entirely (e.g. `C:\dev\wcEcoli`). If already in OneDrive, use `robocopy /E` to copy the full repo out, verify with `git status`, then delete the OneDrive copy. For individual truncated files, `git checkout -- <file>` restores from the committed version.

**Stale git lock files:** If git complains about `.lock` files after a crash or timeout, delete them manually:
```powershell
Remove-Item .git\*.lock -Force -ErrorAction SilentlyContinue
Remove-Item .git\refs\heads\*.lock -Force -Recurse -ErrorAction SilentlyContinue
Remove-Item .git\refs\remotes\*.lock -Force -Recurse -ErrorAction SilentlyContinue
```

**Simulation image not found:** Run `docker images wcecoli-sim` to check. If missing, build with `docker build -t wcecoli-sim:latest -f docker/local/Dockerfile .` from the repo root.

**Worker can't connect to Docker:** Ensure the Docker daemon is running and your user has socket access. On Linux: `sudo usermod -aG docker $USER` then re-login.

**Database reingest:** If you change the backend schema or need to rebuild the gene database, delete `interface/backend/data/wcecoli.db` and restart the backend. It will re-parse all TSV files automatically. Schema version bumps (in `init_db.py`) trigger automatic rebuilds — user data (experiments, jobs, results) is backed up before the rebuild and restored afterwards, so simulation history survives schema upgrades.

**Smoke test:** To verify a fresh clone works end-to-end, run the smoke test from the `interface/` directory:
```bash
cd interface
python -m pytest tests/smoke_test_fresh_clone.py -v
```
This validates that all 10 database tables are created, user-data tables are empty (no data leaks), the gene catalog is populated, API endpoints respond, and the schema version is tracked correctly.
