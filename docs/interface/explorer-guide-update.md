# Explorer guide completion

6 November 2026. Status: implementation and all local acceptance checks pass;
frozen-image acceptance is complete. Hosted publication and hosted guide
acceptance remain pending the deployment credential.
This is documentation for existing explorer capabilities, not the start of HF-09.

## Boundary and reference lock

The full local guide, routes, shared builders, shell, assistant, themes and global
styles are unchanged. The implementation uses only explorer-profile modules.
`proofs/guide-fix/local-baseline.json` records hashes of all 101 existing
non-explorer frontend source files and the original Dataset inventory.

The visual target is the existing local guide's section navigation, expandable
descriptions and reference tables, with the approved frontend reference lock
(`interface/frontend/docs/frontend-refresh.md`). Inter, neutral surfaces,
semantic theme tokens and violet links remain in their existing roles. No new
imagery, dependency or visual direction is introduced. Guide-only CSS and mobile
navigation avoid changing the shared shell or the local platform's guide.

## Delivered documentation

`/guide` defaults to Overview. Section navigation uses bookmarkable `?section=`
values: `overview`, `variants`, `conditions`, `timelines`, `parameters`,
`workflows`, `results`, `shortcuts`. Reload and browser Back/Forward preserve the
selection. Unknown sections show an explanatory notice and Overview. The old
assistant section explains unavailability without requesting assistant metadata.
The existing workspace `?` shortcut now opens the actual shortcuts section.

- Experiment types: all 29 designer-visible catalog types; three internal
  helpers remain excluded. Curated purpose, hypothesis and limitations accompany
  current published parameter hints. Legacy docstring indices and execution
  instructions are not used as a fallback. Missing/unreviewed mappings remain
  explicitly unavailable. Gene perturbation cards read actual prepared TU and
  co-target examples from existing publication-backed gene endpoints.
- Growth conditions: actual conditions, recipes, stock concentrations and
  TF-condition definitions. Distinguish mmol/L concentrations, mmol ingredient
  amounts, gram weights and litre volumes. Reference doubling times are not
  recorded division durations or compute-time estimates.
- Timelines: explicit initialization versus time-zero medium; ordered changes,
  genuine seconds/minutes, elapsed-lineage versus generation-relative clocks,
  and variant-managed schedules. Malformed or unresolved reference definitions
  never acquire invented events or clocks.
- Parameters and workflows: seed, generations, per-generation simulated duration,
  catalog validation versus readiness; single/batch/environment plans, overlays,
  manual saving, draft organization, dependency-complete JSON transfer, 5 MiB
  imports and the 1,000-design preview limit. Browser storage is origin-specific
  and is neither synchronized nor a backup.
- Results: the four molecular families, units and missing-channel states;
  selected actual generations, initial/endpoint controls, final versus mean
  values, missing/zero comparison denominators, single-seed limitations and
  honest outcomes. No-division is not relabeled as death or infrastructure error.
- Shortcuts: only working explorer controls. Mobile guide navigation provides
  site links and theme controls while hiding the desktop sidebar solely on this
  explorer route. The guide's section content scrolls independently.

## Implementation and data interfaces

The dedicated component, content and stylesheet are
`interface/frontend/src/explorer/ExplorerGuide.tsx`, `guideContent.ts` and
`guide.css`. `ExplorerApp.tsx` registers the component and supplies its guide-only
layout. Existing shared help links are unchanged. The earlier homepage fixes
remain intact.

Reference sections load existing GET routes only when needed: `/api/variants`,
`/api/condition-catalog` and the prepared target examples under `/api/genes/`.
No API, capability, Dataset or artifact schema changes are introduced. Failed or
malformed responses leave static guidance visible and provide an explicit retry
state with error focus. No provider, assistant, mutation or execution request is
required. No normal application startup or simulation dependency is imported.

## Release preparation

Successor package: `interface/.explorer/bundles/4bfa5f25333c865dab7d/`.
Source SHA-256:
`4bfa5f25333c865dab7db35fb4573ee97fbae143d97fc1f121e6cd9e2ab048a1`.
Space source: 2,617,362 bytes. Dataset upload inventory: 1,280,819,447 bytes,
identical to the earlier release, including every scientific payload checksum.
Manifest remains
`5ec44906b5ef88152261a77676959e624fa7cb4ba65dc3bcd517799373228a18`.

Read-only Hub inspection confirms the homepage correction is deployed as private
Space revision `0d6ef2580c7c80be549db4ceed8808c4a5de037e`, RUNNING that revision;
its complete source inventory matches retained package `4f6c04fb2ec4511d2a6b`.
The private Dataset is still pinned to
`a4c3032c37f9bc08a002ed529b1b4f9f84b7eda6`. Hosted variables match the existing
receipt. Evidence: `interface/.publication/proofs/guide-fix/hosted-baseline.json`.

The exact-file update replaces ExplorerApp.tsx and adds the three explorer guide
modules. Publication tooling now supports explicitly approved additions as well
as replacements, with complete baseline/target inventory checks and safe resume.
Remote deletions, unreviewed additions, unexpected contents and parent-revision
mismatches remain rejected. Configuration, runtime secret, Dataset and visibility
are preserved. All older deployed bundles and receipts remain rollback records.

## Verification and handoff

Local tests use real published artifacts and catalog metadata; transport-failure
fixtures are limited to explicit error scenarios. Coverage includes every
section/type, metadata and target comparisons, reference tables/clocks, unknown
sections, Back/Forward, shortcuts, manual draft saving, links, mobile width and
navigation, scrolling and accessibility across desktop/mobile and both themes.
The original homepage and published-list scrolling regressions remain covered.

The local-mode homepage suite passes 17 tests; publication tooling passes 50.
The final frozen AMD64 image passes all 23 guide/homepage/scrolling browser tests,
including accessibility scans for every guide section in mobile/desktop and both
themes. Under the 512 MiB limit, cold strict full-release startup takes 46.42 s
on local AMD64 emulation; this is not a hosted startup measurement. Health reports
read-only, full scope and non-synthetic data. Shutdown exits 0 without an OOM.
All 101 baseline native source hashes remain unchanged. Screenshots are visually
reviewed. Results are under `interface/.publication/proofs/guide-fix/`, including
`review.json`, `production-acceptance.json`, `production-browser-tests.txt` and
`container-exit.json`. Existing Vite bundle-size and Browserslist-age warnings
are unchanged in nature. Intermediate failing development runs are superseded
by the final frozen-image acceptance.

Package-bound permission, build approval and the exact four-file update plan are
prepared against the verified deployed revision. Prior receipts are archived
under `interface/.publication/history/0d6ef2580c7c80be549db4ceed8808c4a5de037e/`.
Two unapproved intermediate guide packages created during implementation were
removed after preserving their small receipts; deployed/final packages and all
required scientific artifacts remain retained.

Publication requires the owner's `HF_PUBLISH_TOKEN`; the secure credential
available to this chat is read-only. Run `./platform.sh publish update-space`
in the token-bearing terminal.
No Dataset upload or new runtime token is needed. Verify the rebuilt hosted
guide's section links, reference values, scrolling and personal-draft links
before recording this correction as deployed. No remote mutation has occurred
during local preparation.

Focused authenticated hosted checks are prepared in
`interface/frontend/e2e/staging/guide.spec.ts` for desktop/light and mobile/dark.
They compare the hosted reference fingerprint and rendered target/catalog data
with the original local serving references, exercise section navigation and
scrolling, and reject assistant/mutation traffic. Authentication is scoped to
the approved HTTPS Space origin; staging traces/video are disabled and proof
files contain no credentials. Test discovery passes, but these two checks have
not been executed because the guide update is not yet deployed. Broader HF-09
acceptance remains separate.

The standalone pending guide update above is now superseded by the combined
guide/contextual-link package `8d1073a8e767bc2a48a8`. The original guide bundle and
its receipts remain retained. See [contextual guide links](contextual-guide-links.md)
for the current prepared publication, verification evidence and unchanged local
behavior boundary. One current `publish update-space` operation publishes both.
