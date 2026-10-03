# Network loading, reset, and contextual help

This is a focused maintenance change. The existing toolbar, inspector, scientific colours, regulation classifier, node sizes, relationships, and biological destinations remain the visual/functional reference.

## Decisions and references

| Decision | Source | Implementation |
| --- | --- | --- |
| Preserve network arrangement | User's implementation correction | Retain the original 300-iteration CoSE parameters, original starting positions, and first canvas aspect ratio; do not use the proposed 100-iteration grid-seeded arrangement. |
| One-click return to overview | Approved plan | Reset network clears search, gene selection, mode, regulation filter, hub threshold, and camera. |
| Small question-mark help | User's implementation correction | Reuse the existing WorkspaceHelp primitive, adapted earlier from Origin UI's tooltip pattern; no newly copied external source or framework. |
| Keep explanations out of the canvas | Approved plan | Consolidate scientific context/source in help. Remove the API-path and internal simulation-overlay status messages. |

The help primitive already supplies hover, click/touch, Escape, keyboard navigation, viewport positioning, theme tokens, and reduced-motion handling. No new animation language is introduced. The existing filter-count text uses full opacity to pass light/dark text-contrast checks; graph colours are unchanged.

## Loading lifecycle

- Browser-session promises share API data and full-network worker work across StrictMode mounts and route returns. Failed work is evicted so Retry starts a fresh attempt.
- Layout positions are keyed by serialized graph content. New content receives a separate layout; viewport, search, filters, selection, and theme do not invalidate successful positions.
- The worker uses the existing Cytoscape package. Its internal request includes elements, content key, and first canvas dimensions; the result contains positions or an error. The backend interface is unchanged.
- Full-network force layout runs only in the worker. A single mounted renderer applies preset positions. Focused views retain the existing concentric layout and camera behavior.
- Cached position objects are copied into the renderer: Cytoscape's mutable positions must not corrupt the cache when a focused layout runs.
- The renderer removes handlers and disconnects its ResizeObserver on unmount. Page subscriptions ignore work that completes after navigation. Shared in-flight work may finish for a later route return; workers terminate on success/failure/timeout.
- Controls remain usable during data/layout loading; both failure stages offer Retry. Assistant context reflects these loading/failure states.

## Reset contract

Reset restores Full, All regulation types, threshold 1, no search/selection, and the fitted full-network camera. It reuses cached positions and cancels scheduled/active focus animations. The workspace store and Assistant context are updated, while one URL replacement removes only `gene` and `mode`. Unrelated query parameters survive.

## Measurements

Three fresh contexts per browser, 1440 × 960, reduced motion, local Vite development server and real API (705 nodes / 907 edges). The baseline was captured before editing; graph-ready includes navigation, data, layout, rendering, and two animation frames. StrictMode remains enabled in both runs. Warm return uses an ordinary Workspace → Network navigation without reload.

| Browser | Median baseline | Median updated | Reduction | Warm return |
| --- | ---: | ---: | ---: | ---: |
| Chromium | 8,515 ms | 4,366 ms | 48.7% | 269 ms |
| WebKit | 9,543 ms | 4,781 ms | 49.9% | 265 ms |

Chromium's previous multi-second main-thread layout tasks disappeared; remaining measured long tasks were about 50–112 ms for rendering. WebKit does not expose the same Long Tasks observer. The worker boundary is exercised in both browsers.

Retaining the original 300 iterations, as subsequently requested, takes precedence over the earlier 100-iteration/50% target. The measured reduction is approximately half rather than claiming both browsers strictly exceeded 50%. Results are local development measurements, not production guarantees.

## Verification

Build passes. All 26 dedicated Network browser checks pass, including cached work, renderer teardown, focused-view reset, filter/camera reset, URL preservation, pending focus cancellation, keyboard help, destinations, retries, stale subscriptions, Assistant context, light/dark accessibility, and mobile help bounds. Network plus smoke: 66 checks passed. The complete frontend run passed 191/192; the existing Genome Map scroll-extrema test failed intermittently in the combined run and passed in the focused Network/Genome run (52/52). No Genome Map source or tests were changed.

Visual review covers light/dark controls and help at 1440, 768, and 390px. At 390px the existing sidebar can be collapsed for usable canvas width; navigation layout was retained within the agreed scope.
