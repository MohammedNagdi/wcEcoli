# wcEcoli Platform — How to Run

## Architecture Overview

The platform has three components that run independently:

1. **Backend** (FastAPI) — REST API on port 8000, serves gene/experiment data from SQLite
2. **Frontend** (Vite + React) — dev server on port 5173, proxies `/api` to the backend
3. **Simulation Worker** — polls the database for pending jobs, runs simulations in Docker

The backend and frontend run natively (no Docker). Only the simulation itself runs inside a Docker container, using the existing `docker/local/Dockerfile` that has all wcEcoli dependencies (Cython, NumPy, SciPy, gfortran, etc.).

---

## Prerequisites

- **Python 3.11+** (for the backend)
- **Node.js 18+** and **npm** (for the frontend)
- **Docker Desktop** (for running simulations — not needed for the web UI itself)

---

## 1. Start the Backend

```bash
cd interface/backend

# First time only — install dependencies:
pip install -e ".[dev]"

# Set environment variables to point at the repo data:
export RECONSTRUCTION_PATH="$(cd ../.. && pwd)/reconstruction"
export MODELS_PATH="$(cd ../.. && pwd)/models"
export DATABASE_PATH="$(pwd)/data/wcecoli.db"
export WCECOLI_ROOT="$(cd ../.. && pwd)"

# Create the data directory (first time):
mkdir -p data

# Start the API server:
uvicorn app.main:app --reload --port 8000
```

On first startup, the backend parses all TSV files from `reconstruction/ecoli/flat/` into SQLite. This takes a few seconds. Subsequent starts are instant (skipped if TSVs haven't changed).

Verify it works: open http://localhost:8000/api/health — you should see `{"status":"ok", ...}`.

### Windows (PowerShell)

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

---

## 2. Start the Frontend

In a **second terminal**:

```bash
cd interface/frontend

# First time only — install dependencies:
npm install

# Start the dev server:
npm run dev
```

Open http://localhost:5173 to see the UI. The Vite dev server proxies all `/api` requests to the backend on port 8000.

---

## 3. Build the Simulation Docker Image

This uses the existing `docker/local/Dockerfile` which installs all wcEcoli dependencies. It only needs to be done once (or when dependencies change).

```bash
# From the repo root:
docker build -t wcecoli-sim:latest -f docker/local/Dockerfile .
```

This takes 10-20 minutes the first time (compiling Cython extensions, installing NumPy/SciPy). Subsequent builds use Docker layer cache and are fast.

Verify the image: `docker images wcecoli-sim` should show the image.

---

## 4. Start the Simulation Worker

In a **third terminal** (after the backend is running and the Docker image is built):

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

The worker logs what it's doing:

```
17:30:00 INFO sim_worker — Simulation worker started — polling every 5s
17:30:00 INFO sim_worker — Database: .../interface/backend/data/wcecoli.db
17:30:00 INFO sim_worker — Docker image: wcecoli-sim:latest
17:30:05 INFO sim_worker — Picked up job 1 (experiment 3)
17:30:05 INFO sim_worker — [parca] docker run --rm ...
```

### Windows (PowerShell)

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

## Running a Simulation

1. Open the UI at http://localhost:5173
2. Go to **Genes** → click a gene → **Design knockout experiment**
3. Or go to **Experiments** → **+ New experiment** and configure manually
4. Save the experiment, then click the green **Run simulation** button
5. The worker picks up the job within 5 seconds
6. Watch the job status update in real time (Parca → Simulation → Ingesting → Done)
7. Logs are viewable by clicking "Logs" on each job card

### Simulation pipeline

Each job runs two stages inside Docker:

1. **Parca** (parameter calculator) — `python runscripts/manual/runParca.py out/<run_id>` — generates `kb/simData.cPickle` (~500 MB). Cached: skipped if the pickle already exists for this run.
2. **Simulation** — `python runscripts/manual/runSim.py out/<run_id> --variant <type> <idx> <idx> --seed <s> --generations <g>` — the actual simulation (~30 min per generation on a modern CPU).

Output goes to `out/<run_id>/<variant_dir>/<seed>/generation_000000/000000/simOut/`.

---

## Quick Reference

| Component | Command | Port | Needs Docker? |
|-----------|---------|------|---------------|
| Backend API | `uvicorn app.main:app --reload --port 8000` | 8000 | No |
| Frontend | `npm run dev` (in `interface/frontend`) | 5173 | No |
| Sim Worker | `python -m app.services.sim_worker` | — | Yes (Docker socket) |
| Sim Image Build | `docker build -t wcecoli-sim:latest -f docker/local/Dockerfile .` | — | Yes |

### Stopping everything

- Backend/Frontend: `Ctrl+C` in their terminals
- Worker: `Ctrl+C` (graceful shutdown — finishes current job phase)
- Running simulation: click "Cancel" in the UI, or `docker stop <container_id>`

---

## Alternative: Docker Compose (Full Stack)

If you prefer running the backend and frontend in Docker too:

```bash
cd interface
docker compose up
```

This starts the API on port 8000 and the Vite dev server on port 5173, both containerized. The simulation worker still runs natively (it needs Docker socket access to launch simulation containers).
