# HF-08 — private staging release

**HF-08 complete: private staging is published and verified.** Permission covers
the current website only; additional features must be communicated first.
The dated preparation/blocker records below describe the earlier workflow; the
completion record at the end is current.

## Agreed destinations and access

- Private Dataset: `Safrot/wcecoli-demo-v1`.
- Private Docker Space: `Safrot/wcecoli-explorer`, CPU Basic, ephemeral storage.
- Explicit releases only. GitHub remains the development repository; no Actions,
  automatic mirroring, Git commits or GitHub pushes were added.

Read-only inspection confirms the configured account is `Safrot`, reports PRO,
and uses a **read-only** token. Both repository names return 404 under that
account. This observation is rechecked before publication and is not permanent
proof that a name remains available. No credential values were printed.

## Commands

From either the repository root or `interface/`:

```bash
./platform.sh publish check
./platform.sh publish dataset
./platform.sh publish space
./platform.sh publish status
```

The launcher uses the isolated HF-07 Python environment. `check` hashes both
frozen upload trees, strictly validates the real full release, checks account
and repository metadata read-only, and writes a local readiness report. It exits
successfully when checks complete, even if `ready_to_publish` is false. The
`dataset` and `space` commands exit 2 before creating a Hub client for mutations
when local gates are pending. `status` shows the last recorded observations; it
does not repeatedly poll logs or start services.

State lives in ignored `interface/.publication/`, separately from frozen bundles.
Files are replaced atomically and a process lock prevents overlapping release
commands. State includes package fingerprint, approved inventories, repository
IDs, commit SHAs and progress. It never stores token values. Git HEAD and dirty
status are recorded separately: the frozen source fingerprint identifies the
actual upload, not an assertion that GitHub contains uncommitted changes.

The existing accepted bundle `3263273270e2fea67c9f` remains intact. Running
`publish check` does not regenerate it or make additional bundles.

## Required gates and later execution

The user must first confirm permission covering the included materials and
intended private hosting. The agent then records a sanitized confirmation in
`permission.json`: `confirmed_by_user`, `confirmed_on`, `scope`, `conditions`,
`evidence_reference`, `account`, ordered `repositories` (Dataset then Space), and
`package_sha256`. Do not set confirmation based on attribution, private visibility
or this implementation request. Do not upload private correspondence.

Once confirmation is received, update the publication notices and README
templates accurately. Create an approved successor package while preserving the
HF-07 bundle and every scientific payload checksum. `approval.json` binds
`package_sha256`, `manifest_sha256`, `build_and_startup_passed` and an
`evidence_reference` to the reviewed successor. Changed inventories or pending
publication notices block release. These records are operator-controlled local
gates, not cryptographic attestations or legal verification.

Securely configure:

- `HF_PUBLISH_TOKEN`: a separate Safrot deployment credential with the required
  creation, upload and Space-settings permissions. The existing read token does
  not qualify. Do not pass tokens in command arguments or save them in JSON.
- `HF_DATASET_READ_TOKEN`: a distinct fine-grained read credential. Dataset
  publication verifies read-only permissions and genuine downloads. Before
  installing this token into the Space, restrict it exclusively to the selected
  Dataset; the Space command rejects broader/global scope or write permissions.
  If the token UI needs an existing repository for resource selection, its scope
  must be narrowed after Dataset creation/publication and before Space startup.
  Unknown scope metadata fails closed and requires review against HF's actual
  response; it is not treated as proof of read-only access.

After gates pass, `dataset` creates the private Dataset, uses explicit file-add
operations for the approved upload tree, captures the completed commit and
verifies every remote file. It downloads the pinned scientific release into a
clean temporary directory with the read credential and validates it strictly.
Only then is `dataset.json` marked verified. Temporary verification copies are
removed; the original data and frozen package remain.

`space` requires that verified Dataset receipt and matching package. It creates
the private Docker Space on CPU Basic, sets the agreed Hub-mode variables and
Dataset SHA/manifest hash, then installs only the Dataset-read token as the
`HF_TOKEN` Space secret. Configuration precedes application upload. Existing
settings/credential changes need review rather than automatic overwrite.

Uploads resume only against a matching local ownership journal and exact remote
content. Missing approved files can be added; unexpected/differing content fails.
The only replacement exception is the exact README generated by HF during our
own fresh Space creation, whose initial hash is recorded. `.gitattributes` is
accounted for separately as Hub metadata. Parent commit checks reject concurrent
changes. A crash between repository creation and ownership journaling requires
manual review; no unknown repository is silently adopted. Nothing is deleted
from the Hub, and no image, hardware, storage or visibility upgrade is automatic.

The Space command itself monitors readiness locally at **60-second intervals**,
with a **45-minute overall limit**. It checkpoints progress and stops on build,
runtime or paused/stopped states. Once running it records **awaiting hosted
acceptance**, not completion. Use a persistent terminal process for deployment;
an interrupted controller is resumed explicitly using its recorded state. Agent
updates should announce meaningful transitions, not unchanged logs.

## Verification tools

`interface/tests/check_full_demo_api.py` and its per-experiment helper now support
`HF_VERIFY_TOKEN` through the shared HTTP reader. Authentication is confined to
the exact HTTPS origin `https://safrot-wcecoli-explorer.hf.space`; redirects are
not followed and credentials cannot be sent to localhost or another host. Local
verification remains available with that variable unset. Runtime Dataset access
and private-Space verification are separate credential purposes.

After authorized deployment, compare all twelve experiments/four molecular
families through the authenticated HTTP verifier against independent local
HDF5. Test anonymous repository/application access separately, authenticated
health/capabilities, 405 mutations and unavailable admin/assistant routes. Keep
tokens out of diagnostic output; do not record complete request headers.

`playwright.staging.config.ts` provides a separate hosted smoke test. It is
skipped unless `HF08_STAGING_ACCEPTANCE=1` and requires `HF_VERIFY_TOKEN`.
Authentication is injected only into the exact Space origin, never global
headers; traces and videos are disabled. It checks published browsing, a real
chart, actual series in four molecular families, and browser draft save/reload
and download. Screenshots show UI only. It has not been executed against HF.

The complete HF-08 acceptance still requires remote inventories, genuine private
download, visibility checks, hosted scientific comparisons, browser smoke and
sanitized build/startup evidence bound to remote commits. HF-09 retains broader
browser, restart/cache recovery, resource and public-access decisions.

## Evidence and current handoff

Local proofs: `interface/.publication/proofs/`; readiness report:
`interface/.publication/check.json`. The verified serving release remains
1,280,813,520 bytes, all twelve experiments / 47 trajectories, manifest SHA-256
`5ec44906b5ef88152261a77676959e624fa7cb4ba65dc3bcd517799373228a18`.

The owner’s permission confirmation is recorded for the current website only.
A metadata-only successor updates the notices; the original application and
scientific files are unchanged. Deployment/runtime credentials remain missing. No secret or permission evidence was fabricated; the confirmation comes from
the owner’s direct statement in this chat and local approval requires an actual
build/startup check. Original platform, Parca and local rollback previews
remain available; no simulations or raw-data cleanup were performed.

HF-08 remains blocked on deployment/runtime credentials. HF-09 is not ready.


## Current-version permission record

Owner confirmation on 30 October 2026 covers the current website only; additional
features must be communicated first. The confirmation and conditions are bound
to successor `2a339158cfce8ce52d4c`, whose only upload-file differences from HF-07
are the top-level README and publication notices. Application and scientific
files are unchanged. Both architecture builds pass; native full-release startup
and clean shutdown passed. Actual evidence is saved in
`interface/.publication/proofs/permission-build-startup.json` and local
`approval.json`. No credentials or private correspondence are included.

The original HF-07 bundle is retained for rollback. Remaining publication gates
are secure deployment/write access and a distinct fine-grained Dataset-read
credential. No repositories, hosted settings or uploads were created by this
permission update. Future application-feature changes do not inherit this
package-bound permission automatically.


## Safe error diagnostics

Publication failures now identify the fixed operation stage, exception class and
numeric HTTP status, without printing the exception body, URL, headers or token.
`interface/.publication/last-error.json` stores that sanitized detail and
`publish status` includes it. HTTP 401 indicates rejected authentication; 403
indicates denied access; 429 indicates rate limiting. A generic earlier error
does not establish which of these occurred. Tokens exported in the user’s
terminal are not inherited by an already-running Codex process; retry the check
in that same terminal to collect the diagnostic.


## Runtime scope identity correction

The exclusive Dataset guard previously compared the token scope display name
with the full `owner/repository` path. It now resolves the selected Dataset
through the runtime reader and compares its authoritative `_id` with typed
Dataset scope entries. A typed full repository path remains a fallback only
when the scope entry has no ID; a conflicting ID cannot be overridden by a
matching display name. Global permissions, other resource types/IDs and
unresolved short names still fail closed. Failures report only global/scoped
counts and per-entry match booleans, saved in `runtime-scope-error.json`; no
credentials, whoami payload or resource IDs are logged. The user must retry
from their token-bearing terminal to establish whether this resolves their
actual scope failure. No token replacement or Dataset re-upload is required
just to test this correction.


The runtime scope validator now excludes entries whose permission list is empty:
these entries grant no access. Active grants to another entity and all global
permissions still fail. Diagnostics additionally report active resource counts
and per-entry permission counts. The user’s screenshot shows only the selected
Dataset with read permission; the API reported two entries, but whether the
second was empty is not yet established. Retry the corrected validator without
replacing credentials or repeating the completed Dataset publication.


## Completed private staging

- Dataset: https://huggingface.co/datasets/Safrot/wcecoli-demo-v1, private;
  commit `a4c3032c37f9bc08a002ed529b1b4f9f84b7eda6`.
- Space: https://huggingface.co/spaces/Safrot/wcecoli-explorer, private;
  commit `4b77e2869b7a4ebac6b4b3fe2e30f46abfc8af04`.
- Runtime: RUNNING, CPU Basic, full validated real release; configuration pins
  the Dataset commit and original manifest SHA-256.
- Acceptance: 48 experiment/family checks, 3,948 exact scientific comparisons,
  authenticated private-browser smoke including charts/four molecular families
  and draft save/reload/export, plus denied writes/admin routes and anonymous
  access. Original local platform/data/preparation identities are unchanged.
- Actual scientific chart screenshot visually inspected; sanitized build/runtime
  logs and consolidated `proofs/hosted-acceptance.json` retained. No credential
  values or authentication traces are saved.

`publish status` reports verified staging when its acceptance receipt matches
its Space revision/package. No Dataset or Space republishing is required.
HF-09 is Ready for restart/cache/resource/broader browser verification; it has
not started. Neither the Space nor the Dataset was made public.


## Post-deployment scrolling correction

The published Results/Experiments lists inherited hidden overflow from the native
workspace shell and did not respond to wheel input. Explorer-only vertical page
scrolling is corrected locally, with real-input browser coverage across mobile,
desktop and both themes. Individual result detail pages already scrolled in
hosted checks. Local build and 17 native result-detail regressions pass. This
fix is not yet in the deployed Space; publishing the frontend update requires
a reviewed application update against the existing Space commit. Do not repeat
the Dataset upload or bypass the initial-release state guards.


## Reviewed Space-only update: scrolling fix

Prepared production package `interface/.explorer/bundles/8c77169040e08a4ab519/`
restores wheel scrolling on the published Results/Experiments lists. Exactly
two served source files differ from the deployed package:
`frontend/src/components/layout/Shell.tsx` and
`frontend/src/explorer/explorer.css`. Dataset files are byte-identical. ARM64
and AMD64 builds pass; a temporary production container passed all four
mobile/desktop/light/dark real-wheel tests and clean shutdown. The 17 native
result-detail tests also pass. Old bundles and receipts remain rollback records.

Run from the same terminal that holds the deployment token:

```bash
./platform.sh publish update-space
```

This command requires only `HF_PUBLISH_TOKEN`, reuses the existing hosted runtime
secret and variables, and never uploads the Dataset or changes visibility. It
requires package-bound permission/approval and an exact-file update plan in
`space-update.json`. Before committing it verifies the private Dataset revision,
configuration, complete original Space inventory and baseline commit
`4b77e2869b7a4ebac6b4b3fe2e30f46abfc8af04`. It commits only the two approved
files using that parent commit. Unexpected changes stop the update. A completed
matching update resumes without duplicate commits. Local status remains pending
until the write command is executed and hosted scrolling acceptance passes.

The agent process has only the existing read credential; the deployment token
remains in the user's terminal. The computer-use tool disallows access to the
Terminal app, so the final write command must be run there by the user. No
credential copying, privilege expansion or fallback to public access is used.
After deployment, verify actual wheel scrolling on the hosted list routes,
private access, pinned configuration and unchanged scientific data.

The update monitor also checks HF runtime metadata `sha` against the new commit,
so an old container still marked RUNNING cannot be mistaken for the rebuilt
version. Polling remains once per minute; no additional agent polling is needed.

## Homepage correction — 2026-11-06

Read-only Hub verification confirms that the scrolling update was subsequently
published as `c0a709462f3af20eadafb01303eea6c8d9302d42`; the private Space is RUNNING
that revision and its complete source inventory matches package
`8c77169040e08a4ab519`. The older deployment-pending notes above describe the
earlier handoff, rather than the currently observed revision.

The owner approved three existing-homepage corrections: preserve the primary
button's white label on hover, remove the duplicate campaign note below the
buttons, and replace the footer with “Explorer guide” plus “Save drafts in this
browser, or download a JSON copy to keep or share.” The shared homepage link
hover rule previously overrode the primary action's label colour. Explorer-only
selectors now preserve contrast, add hover feedback, and provide a visible
keyboard focus outline. No new capability is introduced.

Prepared successor: `interface/.explorer/bundles/4f6c04fb2ec4511d2a6b/`, source SHA
`4f6c04fb2ec4511d2a6b8edc8296e33e0379f1e277bf897bebe0bf2de8c47974`.
Only `frontend/src/explorer/ExplorerApp.tsx` and
`frontend/src/explorer/explorer.css` differ from the deployed package. The
complete Dataset inventory, scientific files and manifest fingerprint are
unchanged. Prior bundle and publication receipts remain rollback references.

Verification: explorer production build and AMD64 image build pass; eight real
artifact browser cases pass both against the compiled frontend and the frozen
production image (mobile/desktop, light/dark, hover contrast, Tab/focus, footer,
navigation and list scrolling). The production image starts within the existing
512 MiB limit and shuts down with exit 0 without OOM. Seventeen native homepage
regressions and 46 publication-tool tests pass. Screenshots were visually
reviewed. Evidence is under `interface/.publication/proofs/homepage-fix/`, with
test logs alongside that directory. Existing Vite chunk-size and Browserslist
age warnings remain.

The new exact-file update plan is prepared against commit `c0a7094…`, retaining
the same Dataset, configuration, secrets and private visibility. This chat has
only a read credential; no remote mutation was attempted. Run
`./platform.sh publish update-space` from the terminal containing
`HF_PUBLISH_TOKEN`. Then verify the actual hosted homepage before marking this
correction deployed. No Dataset re-upload or runtime-token replacement is needed.
