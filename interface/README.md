# wcEcoli Web Platform

Interactive experiment designer, simulation runner, and analysis suite for the whole-cell *E. coli* model.

The platform provides a browser-based interface for designing gene knockout experiments, launching simulations inside Docker containers, visualising time-series results, training surrogate ML models, and exploring genome-wide essentiality.

---

## Architecture

The platform has three runtime components plus a simulation Docker image:

| Component | Technology | Port | Runs in Docker? |
|-----------|-----------|------|-----------------|
| **Backend API** | FastAPI + SQLite | 8000 | Optional |
| **Frontend** | Vite + React + Tailwind | 5173 | Optional |
| **Simulation Worker** | Python process | — | No (launches Docker containers) |
| **Simulation Image** | `wcecoli-sim:latest` | — | Yes (contains all model dependencies) |

The backend and frontend can run either natively or inside Docker (via `docker compose`). The simulation worker always runs natively because it needs Docker socket access to launch simulation containers. The actual simulations run inside `wcecoli-sim:latest` containers that have all wcEcoli dependencies (Cython, NumPy, SciPy, gfortran, etc.).

### How Docker is used

Docker serves a single purpose in this setup: **isolating the heavy simulation environment**. The wcEcoli model requires a specific set of compiled C/Fortran extensions, Cython modules, and large numerical libraries. Rather than requiring every developer to build these locally, we package them into a Docker image.

The flow is:

1. The **worker** polls the SQLite database for pending simulation jobs.
2. When it finds one, it calls `docker run wcecoli-sim:latest` with the appropriate arguments, mounting the repo's `reconstruction/` and `models/` directories into the container.
3. Inside the container, two stages run sequentially:
   - **Parca** (parameter calculator) — generates `simData.cPickle` (~500 MB). This is cached and reused across runs with the same parameters.
   - **Simulation** — the actual whole-cell simulation (~30 min per generation on a modern CPU).
4. Output files land in `out/<run_id>/` on the host filesystem.
5. The worker ingests the results back into SQLite and updates the job status.

The backend API and frontend do **not** need Docker — they're lightweight Python/Node processes. `docker compose` is provided as a convenience for running all three together, but native execution is simpler for development.

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

### 4. Start the Simulation Worker

In a third terminal (after the backend is running and the Docker image is built):

```bash
# From the repo root:
./interface/start-worker.sh
```

Or manually:

```bash
cd interface/backend

export RECONSTRUCTION_PATH="$(cd ../.. && pwd)/reconstruction"
export MODELS_PATH="$(cd ../.. && pwd)/models"
export DATABASE_PATH="$(pwd)/data/wcecoli.db"
export WCECOLI_ROOT="$(cd ../.. && pwd)"
export SIM_OUTPUT_DIR="$(cd ../.. && pwd)/out"
export DOCKER_IMAGE="wcecoli-sim:latest"
export PYTHONPATH="$(cd ../.. && pwd)"

python -m app.services.sim_worker
```

**Windows (PowerShell):**

```powershell
cd interface\backend

$env:RECONSTRUCTION_PATH = (Resolve-Path "..\..\reconstruction")
$env:MODELS_PATH = (Resolve-Path "..\..\models")
$env:DATABASE_PATH = "$(Get-Location)\data\wcecoli.db"
$env:WCECOLI_ROOT = (Resolve-Path "..\..").Path
$env:SIM_OUTPUT_DIR = (Resolve-Path "..\..\out").Path
$env:DOCKER_IMAGE = "wcecoli-sim:latest"
$env:PYTHONPATH = (Resolve-Path "..\..").Path

python -m app.services.sim_worker
```

---

## Quick Start — Docker Compose

If you prefer running the backend and frontend in Docker too:

```bash
cd interface
docker compose up --build
```

This starts three containers (API on 8000, worker, frontend on 5173). The worker container mounts the Docker socket to launch simulation containers. You still need to build `wcecoli-sim:latest` separately (step 3 above).

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

Each job runs two Docker stages:
- **Parca**: `python runscripts/manual/runParca.py out/<run_id>` — cached after first run
- **Simulation**: `python runscripts/manual/runSim.py out/<run_id> --variant <type> <idx> <idx> --seed <s> --generations <g>`

Output goes to `out/<run_id>/<variant_dir>/<seed>/generation_000000/000000/simOut/`.

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
| `SIM_OUTPUT_DIR` | Worker | Where simulation output is written |
| `DOCKER_IMAGE` | Worker | Simulation Docker image name (default: `wcecoli-sim:latest`) |
| `PYTHONPATH` | Worker | Must include repo root for wcEcoli imports |

The `interface/.env` file contains `WCECOLI_HOST_PATH` — the absolute host path passed to `docker run -v` for volume mounts. This file is machine-specific and excluded from version control.

---

## Project Structure

```
interface/
├── README.md                          # ← this file
├── .env                               # Host-specific settings (git-ignored)
├── .gitignore
├── docker-compose.yml                 # Backend + Worker + Frontend (all-in-one)
├── docker-compose.sim.yml             # Simulation image build only
├── start-worker.sh                    # Convenience script for native worker
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
│           ├── sim_worker.py          # Job executor — polls DB, runs Docker containers
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
- Docker socket path (`/var/run/docker.sock`) works out of the box.
- Apple Silicon (M1/M2/M3): the sim image builds natively — no Rosetta needed.

**Linux:**
- Ensure your user is in the `docker` group (`sudo usermod -aG docker $USER`), or the worker won't launch containers.
- Docker Engine works directly — no Docker Desktop needed.

---

## Stopping Everything

| Component | How to stop |
|-----------|-------------|
| Backend / Frontend | `Ctrl+C` in their terminals |
| Worker | `Ctrl+C` (graceful — finishes current job phase) |
| Running simulation | Click "Cancel" in the UI, or `docker stop <container_id>` |
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
