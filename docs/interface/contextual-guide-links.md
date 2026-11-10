# Contextual explorer help links

6 November 2026. Implementation and local acceptance pass. Hosted publication
and acceptance remain pending the deployment credential. This corrects existing
help/navigation and does not start broader HF-09 acceptance.

## Boundary and destinations

The owner selected minimal shared-component changes guarded by explorer mode.
The local guide, routes, global styles and link destinations remain unchanged.
Five shared files contain link integration only: WorkspaceHelp, GeneCatalogPage,
ExploreWorkspacePage, GenomeViewerPage and ExperimentDesigner. All other 96
baseline native frontend source files are byte-identical. The exact five-file
diff is retained in `proofs/context-help/shared-integration.diff`.

| Existing source | Explorer target |
| --- | --- |
| Mechanistic help | Overview → Mechanistic genes |
| Expression-only help | Overview → Expression-only genes |
| Knockout index help | Design parameters → Knockout indices and transcription-unit targets |
| Model state IDs help | Overview → Model state identifiers |
| Workspace/Genome Guide; Learn how the model works | Overview → Model coverage and gene context |
| Designer Documentation | Experiment types → current selected type |

General Guide navigation still opens Overview, and `?` opens Keyboard shortcuts.
Existing text-only tooltips do not gain links. In local mode the original
destinations remain `/guide`, including after changing the selected type.

New explanations distinguish model coverage from experimental essentiality,
expression-only coverage from biological dispensability, prepared RNA/TU target
indices from gene identifiers, and recorded molecular identifiers from guessed
relationships. Existing detailed experiment-type explanations are reused.

## Routing and focus contract

The pure `guideLinks.ts` registry imports no UI, API startup or provider. Explicit
typed IDs, rather than displayed labels/help copy, generate URLs such as:

```text
/guide?section=overview&topic=mechanistic
/guide?section=parameters&topic=knockout-index
/guide?section=variants&variant=gene_knockout
```

A recognized target selects its section, normalizing a missing/conflicting
section with history replacement. The guide expands the matching type card
after real metadata loads, scrolls its own content panel and focuses the
heading/summary. Refs, state and layout effects handle readiness once per
navigation; no timer/DOM polling is used. A short theme-token color fade marks
the target; reduced-motion mode uses a static focus cue.

Reload, bookmarks, Back/Forward and same-section target changes work. Ordinary
section navigation clears the target. Unknown topics/types, hidden variants and
simultaneous topic/type targets show explicit notices without selecting another
explanation. Reference errors preserve the target URL for retry. General guide
links remain general, and local-mode links do not acquire explorer parameters.

Links retain ordinary anchor/new-tab behavior and the existing unsaved-draft
guard. Reading documentation never saves a draft, submits a job or executes
anything. No API, capability or Dataset schema changes are introduced.

## Frozen release and verified baseline

Package: `interface/.explorer/bundles/8d1073a8e767bc2a48a8/`.
Source SHA-256:
`8d1073a8e767bc2a48a807a4a590465d7dc3daa0df56988144795a970bbc1f35`.
Space source: 2,626,833 bytes. The complete 1,280,819,447-byte Dataset upload
inventory and all scientific checksums are unchanged. Manifest SHA remains
`5ec44906b5ef88152261a77676959e624fa7cb4ba65dc3bcd517799373228a18`.

Read-only Hub inspection confirms private Space revision
`0d6ef2580c7c80be549db4ceed8808c4a5de037e`, RUNNING that revision, with complete
source inventory matching homepage package `4f6c04fb2ec4511d2a6b`. Dataset stays
pinned to `a4c3032c37f9bc08a002ed529b1b4f9f84b7eda6`; hosted settings match their
existing receipt. No remote mutation was performed.

This single successor combines the previously approved, not-yet-deployed guide
expansion with contextual linking. Ten exact source paths differ from the
deployed package, including four approved new explorer modules. The earlier
guide bundle remains retained. Its pending permission/approval/update receipts
are archived under `interface/.publication/history/prepared-4bfa5f25333c865dab7d/`.
The new exact-file plan and package-bound approval retain the same Dataset,
runtime secret, configuration, hardware and visibility.

## Verification and handoff

- Eighteen focused contextual browser tests pass against real publication data:
  actual workspace/genome/designer links, mouse/keyboard/touch, new tabs, history,
  advanced types, unsaved prompts, delayed loading, failure/retry, invalid
  targets, themes, layout accessibility and reduced motion.
- Fifty-two native workspace/designer regressions and 50 publication-tool tests
  pass. Local guide destinations and the shared-source allowlist are verified.
- The final frozen AMD64 image passes all 41 contextual/guide/homepage/scrolling
  cases under 512 MiB. Strict full-release cold startup takes 44.39 seconds on
  local AMD64 emulation, not hosted hardware. Health reports full scope,
  read-only and non-synthetic data. Shutdown exits 0 without OOM.
- Source/Dataset inventories and screenshots are reviewed. Evidence lives under
  `interface/.publication/proofs/context-help/`, including review and production
  receipts, source audit, browser outputs and screenshots. Explicit transport
  failure fixtures do not replace scientific data. Existing Vite/Browserslist
  warnings remain in nature.

Focused authenticated hosted tests now include the Mechanistic tooltip flow and
selected-type Documentation with unsaved protection. Test discovery passes;
actual execution awaits publication. Credentials are restricted to the approved
HTTPS Space origin, with traces/video disabled and no tokens in proof files.

The available secure credential is read-only. The owner must run
`./platform.sh publish update-space` in the terminal containing `HF_PUBLISH_TOKEN`,
then verify the hosted guide and contextual flows. No Dataset re-upload or new
runtime credential is needed. Do not mark the correction deployed before those
checks pass. No new simulation, Parca run, data cleanup or main-platform startup
is part of this task.

The existing-link inventory also passes a supplemental real-browser check of
Learn how the model works after opening the empty inspector pane. Its output is
`proofs/context-help/page-links-tests.txt`. All temporary verification services
are stopped after the checks; no local containers are left running by this task.
