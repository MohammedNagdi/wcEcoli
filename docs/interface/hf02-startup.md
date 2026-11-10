# HF-02: local startup from either directory

Completed 27 October 2026. The full local platform remains the default; no experiment, simulation, dataset publication or Hugging Face deployment was initiated by this task.

## Commands

Run the same commands from the repository root or `interface/`:

```bash
./platform.sh local up -d --build
./platform.sh local ps
./platform.sh local logs --tail=50 api
./platform.sh local stop
```

The full stack contains API, frontend, worker and simulation runner. To start only the website:

```bash
./platform.sh local up -d --build api web
```

To build only the simulation image or validate configuration without starting services:

```bash
./platform.sh local build sim-runner
./platform.sh local config --quiet
```

Plain `docker compose up`, `ps`, `logs` and `stop` also work from either directory. The root Compose file includes the canonical interface configuration. Use Docker Compose v2.20.3 or newer. No generated or duplicated service configuration is maintained.

The root launcher delegates to the interface implementation, which supplies absolute Compose/configuration paths. The scripts use `exec`, preserve argument boundaries and Docker exit codes, and pass termination signals directly to Docker.

## Project and data identity

The default project is `interface`, with the existing network `interface_default` and volumes:

- `interface_api-db`
- `interface_sim-output`

Service names, build contexts, bind mounts, ports (API 8000, frontend 5173), health checks and resource defaults are unchanged. No volume migration is needed. The existing simulation-image helper remains supported.

For an intentional separate project, use an override:

```bash
./platform.sh local -p my-local-stack config --quiet
```

`COMPOSE_PROJECT_NAME` also remains supported. A custom project selects different project-prefixed volumes; it does not rename the existing default stack's data.

## Environment configuration

The launcher explicitly selects `interface/.env` if it exists, otherwise the commented [interface/.env.example](../../interface/.env.example) file. Copy the example to `.env` only when customization is needed. Defaults remain defined in Compose, not duplicated as active values in the example.

Exported shell variables override file values. Environment files are parsed by Compose and never sourced as shell scripts. The launcher avoids unrelated caller/root `.env` and inherited `COMPOSE_FILE` discovery. Explicit Compose CLI arguments are still forwarded normally. Raw `docker compose` commands retain Docker's native environment discovery and precedence; prefer the launcher for deterministic file selection.

The example includes optional resource and provider settings plus a commented custom project name. Keep actual API keys in the private `.env` or exported environment. No credentials were added to the repository or baseline fixture.

## Worker compatibility

From the root:

```bash
./interface/start-worker.sh 4 8
```

From `interface/`:

```bash
./start-worker.sh 4 8
```

The helper retains its existing concurrency/budget validation, capacity calculation and printed summary, then delegates to the shared local launcher. Its positional arguments and exported variables determine the computed allocation before built-in defaults; computed exported values take precedence over resource settings in `.env`.

A dry run validates the allocation without calling Docker:

```bash
START_WORKER_DRY_RUN=1 ./interface/start-worker.sh 4 8
```

## Explorer reservation

At HF-02, `./platform.sh explorer ...` exited with code 2 and an explicit not-available-yet message without invoking Docker. That reservation is superseded by the isolated production launcher in [HF-07](hf07-production.md); local-mode routing and defaults remain unchanged.

## Verification performed

Run the contract suite from the root with Python's standard library:

```bash
python3 -m unittest discover -s interface/tests -p test_compose_launchers.py -v
```

All 12 test methods passed, including their parameterized cases:

- Resolved root/interface/launcher configurations match the sanitized pre-change baseline across all four services, paths, resources, ports, network and volume definitions.
- Optional interface environment-file loading, shell precedence, CLI and environment project-name overrides, and a conflicting caller/root configuration.
- Both launchers from root, interface and unrelated working directories in a disposable checkout whose path contains spaces.
- Argument quoting, exact Docker exit codes, process identity and SIGTERM propagation.
- Worker defaults, explicit budgets, CPU-token capacity, environment overrides, invalid values and dry-run no-launch behavior.
- Help, invalid modes and explorer mode never invoke Docker.
- The legacy simulation-image configuration still resolves to the same image and build context.

Command-routing tests use a fake Docker executable. Real Docker is used by configuration tests only for `config`, which does not create containers or require a running daemon. Test environment files contain dummy values and are confined to temporary checkouts. The pre-change fixture uses `${REPO_ROOT}` placeholders and empty provider credentials.

Additional read-only checks against the existing Docker Desktop stack confirmed:

- Both launchers see exactly the same four existing container IDs.
- API and simulation runner report healthy; frontend and worker are running.
- Both expected existing volumes are present.
- The existing API reports health `ok`, and the existing frontend returns HTTP 200.

The initial sandbox denied Docker-socket access; authorized read-only inspection succeeded. No containers were started, stopped, rebuilt or recreated, and no volumes or database rows were changed. Existing runtime health was checked; a fresh image build/startup was not performed. Source/application file fingerprints were preserved outside this task's intended launch/documentation changes.

Shell syntax validation and diff whitespace checks passed. The root Git ignore policy now explicitly permits the root `compose.yaml`, which would otherwise match the existing personal-YAML exclusion.

## Next task and user action

HF-03: define the twelve-experiment campaign and serving-artifact contract before generating data. No user action is required for HF-02. The user may run `./platform.sh local ps` from either directory to inspect the existing stack.
