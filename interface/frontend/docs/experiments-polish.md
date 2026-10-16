# Experiments UI polish

## Direction and boundaries

Waza UI's focused refinement workflow uses the current wcEcoli workspace as the primary target, with the existing Smartsheet table alignment, Dovetail selection, and Hex technical typography references. Original local implementation; no external source or dependencies added. All wording, scientific values, section order, configuration defaults, record-generation rules, and action sequencing remain in place.

The change covers `/experiments` and its Single experiments, Batches, and Failed jobs views, experiment inspectors, `/experiments/new`, and `/experiments/batch`. Conditions Builder remains visually unchanged. Shared batch components use an internal `experiments` presentation option; the Results presentation and its existing menu/scroll markup remain unchanged.

## Presentation

- 1260px browser width, existing 420px inspector, existing container breakpoints and 340px builder summaries.
- 22px page titles, 18px inspector titles, 16px section headings, 14px explanations, 13px labels/data, tabular numeric values, and retained monospace identifiers and biological gene colors.
- Neutral status surfaces with muted semantic markers and batch progress colors. Progress counts, segment proportions, and status labels are unchanged.
- 10px panels, 8px controls, 6px badges, 16px panel padding, 40px primary form controls, and 36px compact actions. Small help controls remain square at 28px rather than stretching with ordinary buttons.
- Aligned filter label rows, full-width search, wrapped names and batch summaries, and reduced nested timeline panel framing. Numeric event columns accommodate both their editor and unit label.

## Interaction and continuity

`ExperimentScrollRegion` labels and exposes bounded tables to keyboard users, shows an overflow-dependent horizontal hint, and supports Left/Right scrolling only when the region itself has focus. Wheel scrolling propagates normally. Vertically overflowing tables gain bottom clearance; short tables avoid an empty spacer.

`ExperimentActionPopup` positions catalog and batch actions outside clipping ancestors, clamps them to the viewport, and dismisses on outside click or Escape. Keyboard dismissal restores trigger focus. Activating an action focuses the persistent trigger before opening its confirmation so cancellation can restore focus correctly. No live execution or deletion was used during review.

Catalog scrolling is captured before navigation and restored after narrow inspection, retaining horizontal and vertical position. Inspector Home/End keys select the first/last tab consistently. State, requests, polling, validation, payload generation, and scientific action handlers remain with their existing owners.

Contextual help renders in a themed portal, flips its preferred placement when space is limited, and stays within the visual viewport during scrolling and resizing. Long help remains scrollable. Hover, click-to-pin, keyboard focus, outside-click dismissal, and Escape preserve access to the unchanged help text without clipping it at page boundaries.

## Validation (2026-10-16)

Frontend build passed. All 360 mocked Chromium/WebKit checks passed across Experiments, designer, batch, Results, workspace, smoke, theme, accessibility, and Assistant refresh suites. After the final badge/control/checkbox CSS adjustments, 46 affected layout and menu checks passed again.

After the contextual-help fix, all 92 designer, batch, and accessibility checks passed, including six focused viewport, resize, dismissal, and focus checks at 390/768/1440px. Live Chromium and WebKit captures confirmed the complete help text remains visible.

Coverage includes unchanged payloads, duplication/prefilling, preview overrides and restored records, failed-save draft retention, polling, confirmation sequencing, portalled menus, focus restoration, tab keyboard behavior, and catalog scroll preservation. Existing fixtures cover 390/768/1440px, light/dark/system themes, reduced motion, effective 200% zoom, and Assistant dock continuity. Live read-only review covered desktop/mobile layouts, expanded batches and inspectors, and reachable builder footer controls in both engines and both themes. No page-level horizontal overflow was observed.

The existing large-bundle build warning remains. No backend, API, database, package, or homepage screenshot changes are part of this polish. Checkpoint `e520367e9` remains available; pre-existing uncommitted homepage/research work was preserved.
