# Run wcEcoli Campaigns On An External Server

## 1. Start The Platform

Run these commands from the repository root.

### Select The CPU Allocation

Check the available CPU cores:

```bash
nproc
```

Choose the number of simultaneous simulations. Each `runSim.py` process uses one CPU core; separate jobs run in parallel, while generations inside one job run sequentially.

```bash
# Conservative starting point
SIMULATION_CORES=8
CPU_BUDGET=8
```

Examples:

| Server capacity | Initial command | Maximum simulations after Parca |
|---:|---|---:|
| 8 cores | `./interface/start-worker.sh 8 8` | 8 |
| 32 cores | `./interface/start-worker.sh 32 32` | 32 |
| 100 cores | `./interface/start-worker.sh 100 100` | 100 |

Start with 8 and measure memory and disk use before increasing it. CPU count alone is not enough if RAM or storage cannot support the same number of processes.

### Start The Services

```bash
cd interface
docker compose up -d --build api web
cd ..

./interface/start-worker.sh "$SIMULATION_CORES" "$CPU_BUDGET"
```

Parca uses 8 CPU slots on a cold cache and normally runs once. Its valid result is shared by all campaign jobs. After Parca completes, the runner can use the selected cores for independent simulations.

Verify the services and runner capacity:

```bash
cd interface
docker compose ps
curl -fsS http://localhost:8000/api/health
docker compose logs --tail=50 api sim-runner worker
cd ..
```

Do not submit experiments until `api`, `sim-runner`, and `worker` are healthy.

## 2. Validate The Campaigns

Dry runs validate the real submission without creating experiments or jobs:

```bash
cd interface
docker compose exec -T api python -m hf_export.submit_campaign --dry-run --tiers T1 --seeds 1 --generations 1
docker compose exec -T api python -m hf_export.submit_campaign --dry-run --tiers T2_CORE,T2_EXTENDED --seeds 1 --generations 1
docker compose exec -T api python -m hf_export.submit_campaign --dry-run --tiers T3 --seeds 1 --generations 1
docker compose exec -T api python -m hf_export.submit_campaign --dry-run --tiers T4 --seeds 1 --generations 1
docker compose exec -T api python -m hf_export.submit_campaign --dry-run --tiers T5 --seeds 1 --generations 1
cd ..
```

Resolve skipped or non-submittable cells before continuing.

## 3. Run A Small Pilot

```bash
cd interface
docker compose exec -T api python -m hf_export.submit_campaign \
  --tiers T1,T2_CORE,T2_EXTENDED,T3,T4,T5 \
  --sample 12 \
  --campaign-id external_pilot_v1 \
  --seeds 1 \
  --generations 1
cd ..
```

Confirm that the pilot finishes, results open correctly, and no jobs remain `failed`, `cancelling`, or `recovering`.

Measure resource use while the pilot runs:

```bash
cd interface
docker compose ps -q sim-runner | xargs docker stats --no-stream
cd ..
```

Increase concurrency only if CPU, RAM, and disk remain within safe limits.

## 4. Run The Production Campaigns

The commands below use 8 seeds and 4 generations. Run one command at a time for easier monitoring.

```bash
cd interface

docker compose exec -T api python -m hf_export.submit_campaign \
  --tiers T1 --campaign-id t1_external_v1 --seeds 8 --generations 4

docker compose exec -T api python -m hf_export.submit_campaign \
  --tiers T2_CORE,T2_EXTENDED --campaign-id t2_external_v1 --seeds 8 --generations 4

docker compose exec -T api python -m hf_export.submit_campaign \
  --tiers T3 --campaign-id t3_external_v1 --seeds 8 --generations 4

docker compose exec -T api python -m hf_export.submit_campaign \
  --tiers T4 --campaign-id t4_external_v1 --seeds 8 --generations 4

docker compose exec -T api python -m hf_export.submit_campaign \
  --tiers T5 --campaign-id t5_external_v1 --seeds 8 --generations 4

cd ..
```

Reuse the same `--campaign-id` when resuming a campaign. This prevents duplicate campaign cells.

## 5. Expected Scale And Runtime

| Tier | Jobs | 8 cores | 32 cores | 100 cores |
|---|---:|---:|---:|---:|
| T1 | 168 | 8 h 53 min | 2 h 36 min | 55 min |
| T2 Core + Extended | 46,984 | 102.8 days | 25.7 days | 8.23 days |
| T3 | 5,472 | 12.0 days | 3.0 days | 23 h 10 min |
| T4 | 512 | 27 h | 6 h 48 min | 2 h 36 min |
| T5 | 3,000 | 6.57 days | 1.65 days | 12 h 40 min |
| All tiers | 56,136 | 122.8 days | 30.7 days | 9.84 days |

These estimates use the measured baseline of 6.3 minutes per generation and include one 4.3-minute cold-cache Parca run. Add 30-50% for production planning because memory, disk contention, failures, and retries reduce ideal scaling.

For a server that can sustain 100 simultaneous simulations, plan approximately 12.8-14.8 days for all implemented tiers.

## 6. Monitor And Resume

Show logs and job counts:

```bash
cd interface
docker compose logs -f --tail=100 sim-runner worker

docker compose exec -T api python -c "import sqlite3; c=sqlite3.connect('/app/data/wcecoli.db'); print(dict(c.execute('select status,count(*) from simulation_jobs group by status').fetchall()))"
```

After an interruption, restart the services and resubmit the same command with the same campaign ID:

```bash
docker compose restart api sim-runner worker
docker compose ps
```

Do not delete Docker volumes or manually clear `runner_task_id` values.

## 7. Export Completed Results

```bash
cd interface
docker compose exec -T api python -m hf_export.run_export --out /app/eval/hf_campaign
```

For full tensors:

```bash
docker compose exec -T api python -m hf_export.run_export \
  --out /app/eval/hf_campaign_full \
  --full-tensors
```

Review `manifest.json` and `export_qc.jsonl` before publishing the dataset.

