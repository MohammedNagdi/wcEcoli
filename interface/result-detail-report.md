# Individual result visual refresh

## Reference lock and scope

wcEcoli workspace supplies the neutral theme, Inter/JetBrains Mono, violet actions/focus, and restrained panel/control treatment. Inspected saved Inspo Hex captures supply metric/chart alignment; Buildkite supplies compact status grouping. Origin UI's 21st.dev accordion supplies disclosure presentation guidance. These are original manual adaptations: no source/package dependency was copied or added.

Only individual `/results/:jobId` pages and their two output explorers are refreshed. The main Results browser and comparison dashboard retain their implementation and appearance. Checkpoint `1cbed4a9b` remains available; this refresh is uncommitted.

## Presentation

- Metrics, Recommended next step, then full-width Run context replace the tall side-by-side summary. Context preserves field order, with a full-width timeline and data-source explanation.
- The original four anchor links form a compact divided navigation strip. All original numbered analysis sections remain in order, with consistent section headers, restrained inner borders, and readable typography.
- Time-series controls and plots now occupy the same section. Available-width container queries govern metric/context/chart grids, search/selection panels, and output tiles, including with the Assistant dock open.
- Neutral notices and badges use small muted semantic accents; channel, seed, and molecule colors use the approved independent light/dark palette. Existing generation dash patterns remain, with extra patterns when colors repeat.
- Result-only responsive shell navigation, one main page scroll region, Assistant bottom clearance, semantic disclosures, and contained keyboard-focusable tables preserve access at narrow widths. Wide state-variable records keep a 760px table minimum instead of crushing columns.

All existing wording, units, scientific formatting, data transformations, request parameters, chart sampling/interpolation, query behavior, disclosures' initial states, and actions are preserved. No API, backend, database, aggregation, or dependency change is included. The pre-edit content fixture records the original JSX labels, help passages, and unit attributes.

## Verification

- Frontend production build and whitespace checks pass.
- The broad mocked regression run passed 200 existing checks across Results, theme, accessibility, workspace, smoke, and Assistant refresh in Chromium/WebKit. Its only failures were two new pending-WT fixture expectations; those expectations were corrected to the existing `WT Running (Sim)` wording.
- The corrected combined Results/detail/theme run passed all 90 checks.
- Final post-review detail checks passed all 32 checks in Chromium/WebKit, covering scientific values/content inventory, WT present/missing/pending, mock notices, failures, multiple generations/seeds, presets, channel toggles, molecule request values and retained selection/search, scrolling, system theme, text contrast, responsive layouts, effective 200% zoom, and the Assistant dock.
- Read-only pre-edit live capture and post-edit mocked screenshots cover the summary, plots, and populated explorers. Screenshots include light/dark at 390/768/1440px and effective 200% zoom; representative images were visually inspected.

Docker web rebuilt successfully after a temporary Docker Hub metadata delay. The result route returned HTTP 200, and read-only live review confirmed the refreshed page. Only web was rebuilt; persistent volumes and scientific records were preserved.

## Typography and spacing refinement

Follow-up screenshot feedback identified inconsistent text sizes and scattered context fields. Removed the broad paragraph-selector specificity conflict and established a consistent scale: 13px labels/metadata, 14px reading text, 16px section headings, 18px metric values, and a 22px page title. Chart axes/legends use 13px. Context labels and local subheadings now use their original sentence case rather than visual all-caps styling.

Run context uses two aligned label/value columns at larger available widths, with a full-width timeline and stacked pairs on small screens. This preserves field order while eliminating the empty grid slots. Panel-header/metric/callout fills are lighter, semantic accent lines thinner, and next-step links have quiet control borders.

Content/contrast/theme checks passed; the final dedicated Chromium/WebKit run passed all 34 detail checks, including computed font-size assertions. Production build and whitespace checks passed. Read-only live review confirmed the revised appearance; no wording, measurements, links, or actions changed.
