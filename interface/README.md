# wcEcoli Platform — Web Interface

Interactive experiment designer and simulation runner for the whole-cell *E. coli* model.

## Quick start

```bash
# 1. Build the simulation image (from the repo root, one-time)
cd /path/to/wcEcoli
docker build -t wcecoli-sim:latest -f docker/local/Dockerfile .

# 2. Launch the platform (from the interface/ directory)
cd interface
docker compose up --build
```

Open **http://localhost:5173** in your browser. That's it — all three services (API, worker, frontend) start together.

## Architecture

`docker compose up` launches three containers:

| Service  | Role | Port |
|----------|------|------|
| **api**  | FastAPI backend — gene catalog, experiment CRUD, job management | 8000 |
| **worker** | Polls for pending jobs, runs Parca + simulation via Docker | — |
| **web**  | Vite dev server — React frontend, proxies `/api` to the backend | 5173 |

The worker launches `wcecoli-sim:latest` containers for each simulation job. It accesses the host's Docker daemon via the mounted Docker socket.

## Platform compatibility

The platform runs on **Windows, macOS, and Linux** — anywhere Docker Desktop (or Docker Engine) is available.

**Windows-specific notes:**
- Line endings: the repo's `.gitattributes` should enforce LF for shell scripts. If `entrypoint.sh` has CRLF endings, run `sed -i 's/\r$//' docker/local/entrypoint.sh` and rebuild the sim image.
- Docker Desktop must have WSL2 backend enabled (default on modern Windows).
- The `.env` file in `interface/` sets `WCECOLI_HOST_PATH` — this is no longer needed since the sim image has code baked in, but won't cause issues if present.

**macOS notes:**
- Docker socket path (`/var/run/docker.sock`) works out of the box with Docker Desktop.
- On Apple Silicon (M1/M2/M3), the sim image builds natively — no Rosetta needed since all Python dependencies have ARM wheels.

**Linux notes:**
- Ensure your user is in the `docker` group, or the worker won't be able to launch containers.
- No Docker Desktop needed — Docker Engine works directly.

## Development without Docker

If you prefer running services directly:

```bash
# Terminal 1: Backend
cd interface/backend
pip install -e ".[dev]"
uvicorn app.main:app --reload --port 8000

# Terminal 2: Frontend
cd interface/frontend
npm install
npm run dev

# Terminal 3: Worker (optional, for running simulations)
cd interface/backend
python -m app.services.sim_worker
```

## Project structure

```
interface/
├── backend/
│   ├── app/
│   │   ├── main.py              # FastAPI app + lifespan
│   │   ├── config.py            # Settings (env vars)
│   │   ├── db/
│   │   │   ├── init_db.py       # TSV → SQLite ingestion
│   │   │   └── models.py        # SQLModel schemas
│   │   ├── routers/
│   │   │   ├── genes.py         # Gene catalog API
│   │   │   ├── pathways.py      # AA pathways API
│   │   │   ├── experiments.py   # Experiment CRUD + variants
│   │   │   ├── jobs.py          # Job submission + polling
│   │   │   └── results.py       # Timeseries + mock data
│   │   └── services/
│   │       ├── sim_worker.py    # Job executor (Docker runner)
│   │       └── table_reader_bridge.py  # wcEcoli binary format reader
│   ├── Dockerfile
│   └── pyproject.toml
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── genes/           # Gene catalog + detail pages
│   │   │   ├── experiments/     # Designer, list, detail panel
│   │   │   ├── results/         # Chart.js timeseries viewer
│   │   │   └── tf-network/      # TF regulatory network
│   │   ├── api/client.ts        # Typed API client
│   │   ├── types/index.ts       # TypeScript interfaces
│   │   └── utils/labels.ts      # Human-readable labels
│   ├── Dockerfile
│   └── package.json
├── docker-compose.yml
├── .env                         # Host-specific settings
└── README.md                    # ← you are here
```

## Data flow

1. **Startup**: `init_db.py` reads TSV files from `reconstruction/ecoli/flat/` and builds a SQLite database with genes, TF networks, pathways, conditions, timelines, and variant metadata.
2. **Experiment design**: user selects an experiment type, configures parameters (gene for knockouts, conditions, timeline), and saves.
3. **Simulation**: clicking "Run" creates a job. The worker picks it up, runs Parca (parameter calculator) then the simulation inside a `wcecoli-sim` Docker container.
4. **Results**: after completion, the worker ingests output files and the UI shows time-series plots (cell mass, growth rate, protein/RNA/DNA mass, etc.).
