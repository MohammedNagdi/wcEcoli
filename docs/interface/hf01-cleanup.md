# HF-01 cleanup completion record

Completed 27 October 2026. Scope: documentation organization and generated-file exclusions. No application source, dependency versions, Compose configuration, scientific input or working database was changed.

## Disposition

The [file inventory](hf01-file-inventory.tsv) records all 327 interface files visible to Git at the initial audit, including non-ignored untracked files. It excludes ignored dependencies, caches and generated files; it is not a scientific-output inventory.

| Disposition | Count | Result |
|---|---:|---|
| Keep | 283 | Original paths and contents preserved |
| Archive | 43 | Ten historical reports and 33 design-reference files moved into this documentation tree |
| Relocate | 1 | Local model guide moved to `local-models.md`; WSL configuration links repaired |
| Delete | 0 | No redundant material qualified for removal |

All 389 files captured across interface, documentation, QA output and ignore policies were accounted for at their original or mapped locations. Referenced frontend previews, source tools, tests, attribution notices, research assets and existing working edits were preserved. Files that were untracked before the move remain unstaged; this task did not create a commit.

The only equal-content group found in the interface audit consists of four empty Python package `__init__.py` files. They are required package markers in separate directories and were retained. Similar filenames, responsive images and theme variants were not treated as duplicates.

## Documentation changes

- Added this documentation index and linked it from the interface and main documentation READMEs.
- Archived historical reports under `archive/reports/` and design research under `design-references/`, preserving the research tree's internal layout.
- Updated moved local-model links and report references to their new locations.
- Kept maintained export/evaluation READMEs and active frontend behavior notes alongside their components.
- Left existing runtime instructions intact; Compose command changes belong to HF-02.

## Git and Docker exclusions

Git ignore additions cover generated root `output/`, Ruff caches, backend pytest caches and SQLite sidecars. These additions hide generated files from status; they do not delete the existing files or remove already tracked files.

The root Docker exclusions now cover local Node/Python dependencies, test/browser caches and reports, generated frontend builds, the working backend database directory, generated evaluation baselines, root QA output, root runtime cache and environment files. Example environment filenames remain eligible for inclusion.

Added backend and frontend `.dockerignore` files because each Compose build uses its own subdirectory as context; the root ignore file does not apply to those contexts. Runtime source, package manifests, lockfiles, required public assets and attribution remain available to the builds.

This is not yet the final Hugging Face upload bundle. HF-07 must use a reviewed upload allowlist; copying the entire repository is not the deployment procedure. Finished demo artifacts will live in the Dataset repository, separately from Space code.

## Verification

| Check | Before cleanup | After cleanup |
|---|---|---|
| `npm run build` from the frontend directory | Passed | Passed |
| Fresh DB and API checks from the existing smoke test, in isolated temporary paths | 71 checks passed | 71 checks passed |
| Selected existing Chromium browser tests | 6 passed | 6 passed |
| Production output fingerprint | 82 files captured | All 82 byte-identical |
| Original application/working-file fingerprints | Captured | Preserved; intentional documentation/ignore edits and mapped moves accounted for |
| Working database fingerprint | Captured | Unchanged |
| Moved/indexed Markdown links and archive HTML local assets | Audited | Resolve at new locations |
| Diff whitespace checks and ignore examples | — | Passed |

Browser checks cover home navigation, light/dark previews and accessibility assertions, gene-workspace selection/navigation, designer keyboard selection/save payload, and result metrics/links. They use the existing mocked API fixtures and do not establish real simulator or hosted behavior.

Run the same browser selection from the frontend directory:

```bash
npx playwright test home.spec.ts workspace.spec.ts designer.spec.ts results.spec.ts --project=chromium --workers=2 --retries=0 --grep 'introduction links|previews load|keyboard selection, loaded-row|single gene suggestions|scientific metrics'
```

### Smoke-test harness note

The existing smoke-test module records failures in a list rather than pytest assertions, and its API helper does not enter a lifespan context. Simply running pytest is insufficient evidence that its internal checks passed. Validation explicitly called `test_database_build()` and `test_api_endpoints()`, then checked that the failure list was empty.

The wrapper used separate temporary DB/output paths, imported `app.services.sim_worker` on the main thread before starting the FastAPI TestClient lifespan, and reset the API database path after the fresh-build helper removed its own temporary directory. Without that import, the existing startup path attempts to register signal handlers on the TestClient thread. No runtime code or test source was patched for this documentation task. A future startup/test-harness fix should be tracked separately if needed.

### Limitations and observations

- Vite's existing large-chunk warning remains unchanged; bundle optimization is outside HF-01.
- The initial browser-server start was blocked by the sandbox's local-listen restriction; the authorized local test run succeeded. No credentials or running Docker service were needed.
- No Docker image build, simulation, dataset publication or remote Space validation was performed.
- No visual snapshots were regenerated. Existing frontend work was checked as found, not reverted to HEAD.
- Existing unrelated documentation was not rewritten wholesale; link checks focus on the moved archive, new index and maintained links introduced by this task.

## Next task and user action

HF-02: standardize Compose entry points while preserving project and volume identity. No user action is required to finish HF-01. A manual look at the unchanged website is optional.
