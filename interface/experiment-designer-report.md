# Experiment designer frontend polish

Implemented 5 October 2026 for `/experiments/new`. The current application is available at http://localhost:5173/experiments/new.

## Result and preserved behavior

The designer now uses neutral status chips and scientific notices, readable dark-mode text, muted media colors, consistent controls, and a container-based summary layout. The redundant Environment/Media protocol badges above the Run summary were removed at the user's explicit request; those values remain in the summary and media section.

All existing scientific copy, sections, defaults, experiment selection rules, saved configuration, duplication, query-prefilled designs, and save/navigation behavior remain. No backend, payload, database, dependency, or simulation approval changes were made. Saving an experiment still creates a draft. The shared media composer retains its original palette outside the new experiment designer.

## Reference lock and decisions

| Decision | Reference | Adaptation |
| --- | --- | --- |
| Neutral surfaces, violet actions, Inter and JetBrains Mono | Existing wcEcoli workspace | Page-scoped tokens and CSS; no global palette replacement |
| Quiet navigation and aligned search/focus treatment | Existing Inspo NavBreadcrumb/NavSearchFirst templates | Preserve the Back link and existing search; borrow spacing and state discipline |
| Gene suggestions and existing disclosures | [21st Combobox](https://21st.dev/@coss.com/components/combobox), [Accordion](https://21st.dev/@designali-in/components/accordion-01-1) | Native local keyboard/ARIA implementation with existing state; no component framework |
| Menu and panel feedback | [transitions.dev](https://github.com/Jakubantalik/transitions.dev/tree/main/transitions) | 120ms colors, 180ms menus, 200ms disclosures, maximum 4px movement, reduced-motion override |
| Muted timeline colors | Approved Genome Design palette and user constraint | Slate, rose, ochre, teal, blue and violet; neutral marker labels and matching media dots |

These are manually adapted patterns. No third-party component source was copied. Existing Inspo captures/templates are available in `interface/design-references`; they do not establish a verified experiment-configuration flow.

## Implementation details

- Two columns start at 1100px of actual designer width; the summary remains 340px and becomes sticky only when its complete contents fit the viewport. Otherwise it follows Experiment details.
- The designer shell explicitly retains native vertical scrolling; the gene workspace clipping rule no longer blocks wheel scrolling. Save/Cancel remain reachable without a second summary scroll region. Bottom scroll clearance keeps the floating Assistant launcher from covering these actions at mobile widths and 200% zoom.
- `/experiments/new` now participates in the shell's existing compact/mobile navigation, so navigation and the Assistant dock do not squeeze the form into an unusable column.
- Simulation fields stack below 600px. Timeline event fields stack below 700px, retain full media identifiers, and expose uniquely named numeric time editors as the keyboard alternative to dragging.
- Single- and multi-gene suggestions support arrows, Enter, Escape, visible active state and retained input focus. Unavailable multi-gene targets are skipped. Stale search results cannot replace suggestions for a newer query.
- Existing labels and hints are associated with inputs. Preset/vial disclosures expose expanded state; closed contents are absent from the tab order. The summary's description-list markup is now valid.
- Explicit actual-control contrast checks cover light and dark mode; status text uses neutral theme tokens. No numbers, scientific values or drag positions are animated.

## Validation

- Frontend production build passed. The existing Vite large-bundle advisory remains.
- Full mocked Chromium/WebKit regression suite: **442 passed**, including experiment duplication/payload, Assistant, scientific Markdown, theme, accessibility, homepage, workspace, Genome Map, Network, Genome Design and smoke checks.
- Final dedicated designer suite: **52 passed**, including save payloads, failed-save retention, keyboard suggestions, presets, numeric editing, pointer dragging, dock continuity, actual border/palette contrast, long identifiers, dense protocols and real mouse-wheel scrolling to Save/Cancel at all three widths.
- Layout and axe checks cover 390px, 768px and 1440px in light/dark/system modes and reduced motion. Effective 200% zoom is checked with half-size CSS viewports; visible controls remain contained and actions reachable.
- Docker Compose was built and started without volume resets. API and simulation runner health checks passed, with no simulations queued or running during final verification.
- Live before/after images and mocked browser captures are local QA artifacts under `output/experiment-designer-qa/`; they contain no newly generated simulation evidence.

The full regression run preceded the final scoped event-row, contrast and scroll refinements; the final designer suite and production build verify those refinements. No live experiment was saved or launched for verification.
