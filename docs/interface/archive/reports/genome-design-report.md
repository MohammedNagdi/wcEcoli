# Genome Design implementation and validation

Implemented 4 October 2026. Local page: [Genome Design](http://localhost:5173/design).

## Reference lock and decisions

The approved direction uses wcEcoli’s existing workspace as the primary visual system, [Hex exploration](https://learn.hex.tech/docs/share-insights/explore) for synchronized category/table exploration, and the previously inspected Smartsheet capture for aligned tables and local controls. Live Refero research was unavailable because the subscription was inactive; the user approved proceeding with existing captures and bundled guidance.

| Decision | Reference / requirement | Implementation |
|---|---|---|
| Neutral canvas, Inter, JetBrains Mono, violet actions | Existing wcEcoli workspace | Page-scoped styles inherit existing theme tokens; no platform palette replacement. |
| Inspect evidence from its summary | Hex exploration and approved brief | Category selections open matching records; gene selections open a source-linked inspector. |
| Local, stable controls | Smartsheet capture and audit | One unfiltered overview per condition; search, filters, sorting, and pagination derive locally. |
| Accessible sorting | [W3C sortable table](https://www.w3.org/WAI/ARIA/apg/patterns/table/examples/sortable-table/) | Header buttons, `aria-sort`, missing measurements last, stable symbol tie-breakers. |
| Distinct color roles | [Radix color guidance](https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale) and approved palette | Neutral badge text, small muted data marks, hatched unclassified segments, separate control borders. |
| Source fidelity | Approved scientific evidence scope | Earliest generation per completed job, one experiment at a time, explicit metric sample counts and evidence gaps. |

No copied third-party component source, new dependency, database migration, automatic experiment launch, or synthetic database result was introduced.

## User-visible behavior

- Four coverage figures distinguish eligible genes, experiments, usable results, and unclassified outcomes.
- Gene evidence and category summary views share labelled search and condition/category/phenotype/evidence controls.
- The table shows completed/total jobs, growth in s⁻¹, doubling time in min, and recorded division counts. Local pagination supports 25/50/100 rows.
- Category compositions use each category’s matching-gene denominator and expose all phenotype counts in text.
- A 360px inspector appears beside the catalog when the available workspace is at least 1160px wide. Smaller workspaces replace the catalog with an inspector and a return control. Assistant dock width participates in this decision.
- Query parameters preserve condition, view, search, filters, sorting, page size/page, gene, and source experiment while retaining unrelated parameters. Back/Forward and linked-workspace return retain the catalog position.
- Inspector details include gene identifiers and coordinates, measurements and sample counts, completed jobs, source protocol/duration/generations, compatible wildtype metadata, individual job/result links, and raw evidence.
- Follow-up links open `/experiments/new` with the gene and condition filled for review. They do not create or run simulations.
- Request failures have independent Retry controls. Same-condition refreshes retain the last dataset; previous-condition measurements never appear under a new condition label.
- Assistant context includes the selected condition, gene, inspected experiment, evidence gaps, measurements, and visible summary.

## Backend evidence corrections

`DesignEvidenceCatalog` backs all three design endpoints with seven bulk queries, independent of gene/experiment/job/result count. Existing summary fields and phenotype wire values remain available, with additive coverage, source, baseline, evidence-status, and sample-count fields. `GET /api/design/genes/{symbol}` provides the inspector detail and rejects expression-only genes with a scope explanation.

Default selection chooses the newest experiment with usable completed results, otherwise the newest available experiment, breaking timestamp ties by ID. The inspector can select any source experiment for the gene/condition. Experiments are never silently combined.

Wildtype matching shares run-identity and timeline-normalization helpers, matching condition, resolved media protocol, generation count, and duration while allowing different seed sets. A valid comparison is required before reporting growth maintained or reduced growth. The existing 80% boundary is retained. Missing records, inconsistent division flags, invalid growth comparisons, partial records, and terminated lineages remain unclassified as appropriate; they cannot imply non-division or neutral growth.

The source scope is disclosed: earliest recorded generation per completed job. Measurements from other recorded generations remain inspectable but do not silently contribute to the summary. Nonfinite measurements are excluded from aggregates and their original representation remains available in raw evidence.

## Validation

- Frontend production build passed. The pre-existing Vite large-bundle advisory remains.
- Full mocked frontend regression: **398 passed** in Chromium and WebKit, including Assistant, theme, accessibility, homepage, workspace, Genome Map, Network, and Experiments suites.
- Final page-scoped layout/control checks after the zoom wrapping correction: **38 passed** in Chromium and WebKit.
- Full backend suite: **282 passed, 17 subtests passed**, with `MODELS_PATH` and `RECONSTRUCTION_PATH` pointing to this checkout. Direct Docker collection encountered an existing Slurm module path assumption; the equivalent complete host suite passed with the correct model paths.
- Ruff checks for the changed backend files passed; `git diff --check` passed.
- Bulk-query fixtures verify exactly seven queries as both genes and experiments/jobs/results grow.
- Frontend cases cover stable filters, category denominators, keyboard sorting, missing values, pagination, query restoration, stale condition/gene responses, retained refresh data, independent retries, metric units/sample counts, source selection, links, dock sizing/context, scroll restoration, and keyboard focus.
- Screenshots and accessibility/contrast checks cover 390px, 768px, and 1440px, light/dark/system themes, reduced motion, and 200% effective zoom. Meaningful data marks meet 3:1 contrast; neutral text passes the accessibility checks. Zoom tests verify return-button bounds and actual clickability, plus access to the follow-up action.
- Visual review confirmed thin borders, restrained color, compact table/chart alignment, and readable inspector states against the approved reference lock. The narrow zoom wrapping issue was corrected. No unresolved P0/P1/P2 finding remains.

Screenshots use deterministic test evidence, not database simulations. They and check logs are saved under `output/genome-design-qa/`, with separate Chromium and WebKit folders. This directory is a local QA artifact and does not change application data.

## Live-data check

The running Docker API reports **1,125 eligible mechanistic genes, zero eligible knockout experiments, and zero genes with usable results for basal**. The page explicitly explains that absence, and the live accA inspector correctly shows its product, identifiers, model support, and “No knockout experiment for this condition.” Its description displays `α` rather than the stored `&alpha;` entity while preserving the original field in raw evidence.

Persistent volumes and simulation services were preserved. The API was restarted to load the new read-only service, and the frontend source is served by the existing local web service.
