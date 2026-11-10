# wcEcoli: Inspo design references and templates

Prepared 3 October 2026. All external design resources came directly from Inspo hosted MCP. Five topic searches produced 50 result slots and 43 unique matches after slug deduplication. All 43 thumbnails were compared; 16 full-page captures were inspected; nine references and three React templates were shortlisted. No end-to-end application flow was tested.

**Best overall reference: Dovetail.** Its captured research workspace connects a filtered chart of named themes to a count of selected data points and an inspectable item list. Adapt its information structure to the simulator and preserve a light, approachable wcEcoli visual foundation.

Visual report: `output/pdf/wcecoli-inspo-design-report.pdf`. HTML: `docs/interface/design-references/inspo-report.html`. Complete MCP evidence: `docs/interface/design-references/inspo-research.json`.

## 1. [Dovetail](https://0nme3pk5am3urwa9.public.blob.vercel-storage.com/captures/dovetail-com/full.1440.webp?v=1777916793)

**Pattern:** Filterable chart + theme list + data points. **Use:** Main research workspace and insight review. **Captured:** 2026-05-04.

**Observed:** One captured product view combines a research theme chart, a date range, a Themes / Data points switch, a count of selected themes and points, and a corresponding item list. Names connect the visualization to the underlying records.

**Apply:** Use this pattern as the central Analyze workspace: compare result groups above, then keep the contributing runs and conditions in a linked table. Make the selected interval and number of included runs explicit. Treat the list as a route to inspect raw evidence.

**Limit:** Best overall reference for a research workspace, not a full simulation application. The captured product is for customer feedback; its revenue labels and dark grid do not transfer to cell biology. It does not show a setup or teaching flow.

## 2. [Statsig](https://0nme3pk5am3urwa9.public.blob.vercel-storage.com/captures/statsig-com/hero.1440.webp?v=1778749911)

**Pattern:** Test framing + summary metrics + comparison charts. **Use:** Experiment metric and variant overview. **Captured:** 2026-05-14.

**Observed:** The page frames the product around testing each release and pairs the headline with dashboard cards containing metrics and comparison charts. The compact top navigation and plain copy are easier to scan than a dense tool interface.

**Apply:** Borrow only the framing: state the question or variant comparison, then label outcomes and cohorts directly. For the simulator, name the baseline and altered condition and keep units and seeds visible.

**Limit:** The dashboard is a tilted marketing preview. No experiment configuration, statistical method, uncertainty explanation, or run history is legible or verified. It is a focused concept reference, not the overall app template.

## 3. [Smartsheet](https://0nme3pk5am3urwa9.public.blob.vercel-storage.com/captures/smartsheet-com/full.1440.webp?v=1777918441)

**Pattern:** Aligned table + local toolbar. **Use:** Experiment and batch catalog. **Captured:** 2026-05-04.

**Observed:** The project plan has aligned columns for task, description, risk, assignee, and status. A toolbar puts table controls, search, and filtering directly above the rows. A compact icon rail sits beside the table.

**Apply:** List experiment name, variant, condition, seeds, status, and updated time. Keep search and filters next to the catalog. Let a row open its details, and make compare selection explicit. Pair any icon navigation with text labels.

**Limit:** This is a small product preview. Sorting, bulk selection, pagination, and editing were not exercised. A research catalog should avoid adopting every spreadsheet control.

## 4. [Buildkite Pipelines](https://0nme3pk5am3urwa9.public.blob.vercel-storage.com/captures/buildkite-com--platform-pipelines/full.1440.webp?v=1778613736)

**Pattern:** Stage checklist + overall run state. **Use:** Run monitoring. **Captured:** 2026-05-12.

**Observed:** A pipeline card identifies a run and branch, states Passed in 5s, and shows named steps with check marks. The overall result is separated from individual steps. A Rebuild action remains local to that run.

**Apply:** Show actual backend stages such as preparation, simulation, and analysis only where supported. Display elapsed time and state in text. Open logs from a selected stage. Explain failures in plain language and retain configuration for a deliberate retry.

**Limit:** Only a successful build is pictured. Queued, active, partial, and failed states are design requirements for wcEcoli, not observed examples. Do not invent progress percentages.

## 5. [Hex](https://0nme3pk5am3urwa9.public.blob.vercel-storage.com/captures/hex-tech/full.1440.webp?v=1780313156)

**Pattern:** Notebook evidence + filtered data view. **Use:** Results and reproducible analysis. **Captured:** 2026-06-01.

**Observed:** The collage combines code cells, a data table, a line chart, a bar chart, and a filtered dashboard. The notebook and dashboard have readable titles; the dashboard shows metrics alongside sector and quarter selectors.

**Apply:** Lead with named biological metrics and time series. Keep condition, units, seeds, and control beside the view. Offer advanced users the configuration and analysis code behind an outcome, while students start with an explanation and worked example.

**Limit:** These are overlapping product previews, not a verified analysis journey. Conversational claims and revenue semantics do not establish scientific validity or a suitable simulation comparison method.

## 6. [Lucide Docs](https://0nme3pk5am3urwa9.public.blob.vercel-storage.com/captures/lucide-dev--guide-vue/hero.1440.webp?v=1778691671)

**Pattern:** Topic rail + article + page outline. **Use:** Guide and visual foundation. **Captured:** 2026-05-13.

**Observed:** A grouped left topic rail highlights Vue as the active item. The central article has a clear heading and concise feature bullets. Getting started and migration links sit beneath it; an On this page outline occupies the right side.

**Apply:** Use a quiet white canvas, readable sans-serif hierarchy, and labeled topic navigation. Organize the Guide around first simulation, experiment types, parameters, interpreting outcomes, and troubleshooting. Link parameter help to exact article sections.

**Limit:** Search behavior and responsive navigation were not tested. Inspo labels this Portfolio Grid, but the visible pattern is documentation navigation; the screenshot takes precedence over that automatic tag.

## 7. [Astro Docs](https://0nme3pk5am3urwa9.public.blob.vercel-storage.com/captures/docs-astro-build/hero.1440.webp?v=1777903815)

**Pattern:** Search + stable topic rail + grouped sections. **Use:** Global Guide navigation. **Captured:** 2026-05-04.

**Observed:** Search stays in the header. A stable left rail separates Tutorial, Guide, Reference, and Ecosystem, with nested topics and a selected state. The homepage explains the documentation and presents a concrete start action.

**Apply:** Use the same top-level map for Learn, Guide, Reference, and Examples, then mark the current topic in the rail. Give novices a short “start here” path while letting researchers jump directly to parameters or methods.

**Limit:** This is a documentation home, not an embedded help pane or simulator workspace. The avatar illustration does not aid the simulator task; copy and action labels need wcEcoli content.

## 8. [LocalCan Quick start](https://0nme3pk5am3urwa9.public.blob.vercel-storage.com/captures/localcan-com--docs/hero.1440.webp?v=1789050890)

**Pattern:** Numbered instructions + next steps. **Use:** First simulation walkthrough. **Captured:** 2026-09-10.

**Observed:** Quick start is selected in the left rail. Four numbered instructions use bold action phrases, inline examples, and short explanations. A Next steps section points readers to related topics after the sequence.

**Apply:** Create a first-simulation lesson: choose a supplied example, explain its settings, review and launch, then interpret one plot. State what the learner should see at each step and link to deeper help. Preserve access to the complete parameter reference.

**Limit:** The source teaches local networking, not biology. The numbered article is not an interactive setup wizard. Expected outputs and scientific explanations must come from wcEcoli content.

## 9. [Glyphs Tutorials](https://0nme3pk5am3urwa9.public.blob.vercel-storage.com/captures/glyphsapp-com--learn/hero.1440.webp?v=1789050355)

**Pattern:** Search + topic filters + starter path. **Use:** Learning library. **Captured:** 2026-09-10.

**Observed:** The page places a large search field above topic filters and tutorial cards. A prominent Getting Started card contains six ordered lessons. Below the index, a Handbook groups deeper reference topics, followed by courses and books.

**Apply:** Offer a visible Start here learning path and a searchable tutorial library. Use topics such as biological context, configuring runs, comparisons, and troubleshooting. Separate worked examples from the technical reference without hiding either.

**Limit:** The orange feature card is a teaching aid, not a recommended scientific palette. Search results and saved-learning behavior were not verified. Tutorial structure needs domain-specific academic content.

## Reusable Inspo templates

### Breadcrumb navigation

`get_reference_jsx(nav, breadcrumb)`. Source: `docs/interface/design-references/inspo-templates/NavBreadcrumb.jsx`.

Visible location within an experiment or Guide hierarchy. Use Experiments / batch name / run name. Keep global phase navigation visible. Replace placeholder destinations and mark the current page.

### Search navigation

`get_reference_jsx(nav, search-first)`. Source: `docs/interface/design-references/inspo-templates/NavSearchFirst.jsx`.

A wide search field with quiet utility links. Use for gene, experiment, or Guide lookup in a clearly labeled scope. Add a real input label, search handling, and mobile navigation. The pictured shortcut is not wired in the source.

### Searchable help

`get_reference_jsx(faq, search-led)`. Source: `docs/interface/design-references/inspo-templates/FaqSearchLed.jsx`.

Client-side filtering of visible question-and-answer rows. Use for short definitions and troubleshooting. Replace sample questions with scientific explanations; label the input, handle Enter, and announce result counts. It is not a full documentation search service.

## Best for by reference

* **Dovetail:** overall research workspace, filtered result review, and source-record tracing.
* **Statsig:** framing conditions, variants, and metric comparisons; the screen is a limited marketing mockup.
* **Smartsheet:** experiment and batch catalog tables with nearby search and filters.
* **Buildkite:** named run stages, overall status, and a local retry action.
* **Hex:** analysis connecting notebook/code, data, plots, and dashboard views.
* **Astro Docs:** top-level Guide navigation, search, and grouped help topics.
* **Lucide Docs:** deep technical articles with an active topic and page outline.
* **LocalCan Quick start:** short numbered first-run lesson and next steps.
* **Glyphs Tutorials:** searchable tutorial index with a visible starter sequence.

Dovetail wins overall because one screen connects a research-focused chart with named themes and inspectable records. Hex is stronger for code and notebooks; Smartsheet for the catalog; Astro Docs for global wayfinding; LocalCan for teaching a first run. No single source shows the entire simulator workflow.

## Reusable Inspo templates

## Recommendation

Use Dovetail as the main analysis-workspace reference. Pair its chart-to-record relationship with Astro Docs’ Guide navigation and LocalCan’s first-run lesson. Add Smartsheet for the catalog, Statsig for framing a variant comparison, Buildkite for monitoring, Hex for reproducible analysis, Lucide for deep technical pages, and Glyphs for an organized tutorial library. Keep Explore -> Simulate -> Analyze visible, with Guide always available.

Scientific units, seeds, control, configuration, and uncertainty are proposed adaptations. No complete simulation template or verified wizard was found.

## Method

Direct JSON-RPC MCP tools/list and tools/call. Five topical searches returned 50 result slots and 43 unique sites/screens after deduplication. Compared all 43 thumbnails, then inspected the 16 closest candidate captures at full-page resolution. Shortlisted nine references and retrieved three canonical React templates. Dovetail ranks first as the broadest research-workspace reference; the ranking is a reasoned design judgment, not a usability score. Site page sets are captured coverage, not verified journeys. Design extraction used live=false.

The shortlisted five marketing captures and four documentation/learning pages provide distinct task patterns. Linear, Ghost, Coda, and Kaggle were close alternatives, but fit fewer simulator tasks. Automatic tags and color roles are heuristic. Rankings are reasoned judgments, not usability scores.

[Inspo MCP documentation](https://inspomcp.dev/mcp).