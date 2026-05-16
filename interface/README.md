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

The interface has 7 navigation tabs:

| Tab | Page | Description |
|-----|------|-------------|
| **Genes** | Gene catalog | Searchable/filterable table of all 1,592 genes with categories, mechanistic status, and links to TF regulation |
| **TF Network** | Transcription factor network | Interactive Cytoscape.js graph of TF → target regulatory connections |
| **Experiments** | Experiment designer | Create single or batch knockout experiments, configure conditions and timelines |
| **Results** | Results browser | Time-series charts (mass, growth rate, RNA/DNA/protein), summary cards, molecule explorer with per-gene/mRNA/protein trajectories |
| **ML** | Machine learning | Train surrogate classifiers (Random Forest, Gradient Boosting) on simulation features — essentiality prediction with cross-validation metrics |
| **Design** | Genome design | Genome-wide essentiality overview with phenotype classification (essential / growth defect / neutral), stacked bar charts by category |
| **Guide** | Documentation | In-platform reference for experiment configuration options, variant types, and conditions |

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
│
├── backend/
│   ├── Dockerfile                     # Backend container image
│   ├── pyproject.toml                 # Python dependencies (FastAPI, SQLModel, h5py, scikit-learn)
│   ├── .schema_version               # Tracks DB schema version for auto-reingest
│   └── app/
│       ├── __init__.py
│       ├── main.py                    # FastAPI app with lifespan, migrations, auto-reingest
│       ├── config.py                  # Pydantic Settings (env var loading)
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
│       ├── App.tsx                    # Router setup (7 routes)
│       ├── api/
│       │   └── client.ts             # Typed API client (all 47 endpoints)
│       ├── types/
│       │   ├── index.ts              # TypeScript interfaces for all API responses
│       │   └── react-cytoscapejs.d.ts
│       ├── hooks/
│       │   └── useGenes.ts           # Gene search hook with debounce
│       ├── utils/
│       │   └── labels.ts             # Human-readable category/variant labels
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
│           ├── experiments/
│           │   ├── ExperimentListPage.tsx  # Experiment list with status polling
│           │   ├── ExperimentDesigner.tsx  # Create/edit experiment form
│           │   ├── ExperimentDetailPanel.tsx # Detail panel with job cards
│           │   └── ExperimentGuidePage.tsx # In-platform documentation
│           ├── results/
│           │   ├── ResultsBrowserPage.tsx  # Top-level results browser
│           │   ├── ResultsPage.tsx        # Charts, summary cards, seed aggregation
│           │   └── MoleculeExplorer.tsx   # Per-molecule timeseries explorer
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

**OneDrive sync conflicts:** If the repo lives inside a OneDrive-synced folder, you may see truncated files, git lock errors, and slow git operations. The fix is to either exclude the folder from OneDrive sync (right-click → "Free up space" or move the repo outside OneDrive) or use `git checkout -- <file>` to restore truncated files from the committed version.

**Stale git lock files:** If git complains about `.lock` files after a crash or timeout, delete them manually:
```powershell
Remove-Item .git\*.lock -Force -ErrorAction SilentlyContinue
Remove-Item .git\refs\heads\*.lock -Force -Recurse -ErrorAction SilentlyContinue
Remove-Item .git\refs\remotes\*.lock -Force -Recurse -ErrorAction SilentlyContinue
```

**Simulation image not found:** Run `docker images wcecoli-sim` to check. If missing, build with `docker build -t wcecoli-sim:latest -f docker/local/Dockerfile .` from the repo root.

**Worker can't connect to Docker:** Ensure the Docker daemon is running and your user has socket access. On Linux: `sudo usermod -aG docker $USER` then re-login.

**Database reingest:** If you change the backend schema or need to rebuild the gene database, delete `interface/backend/data/wcecoli.db` and restart the backend. It will re-parse all TSV files automatically.
