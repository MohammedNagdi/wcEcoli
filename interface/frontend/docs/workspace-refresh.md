# Gene workspace refresh

The `/explore` refresh preserves the gene catalog, underlying API requests, biological visualizations, simulation destinations, and Assistant context. `/genes` retains its existing catalog layout.

## Reference lock

| Reference | Bounded role | Local adaptation |
| --- | --- | --- |
| Smartsheet, existing Inspo capture | Primary: aligned records with a local toolbar | Search first, scoped filters, explicit result count and loaded-row sorting. |
| Dovetail, existing Inspo capture | Selection connected to inspectable evidence | Violet row marker, populated context chips, linked inspector. |
| Hex, existing Inspo capture | Readable technical evidence | Mono identifiers, units, product description, contextual definitions. |
| [ReUI Resizable](https://21st.dev/@sean0205/components/resizable-1/handle) | Panel resizing | Locally written pointer capture and keyboard separator, bounded to 440px/360px minimum panels. Public usage/dependencies and MIT listing inspected; no source copied and no library added. |
| [Origin UI Tooltip](https://21st.dev/@originui/components/tooltip) | Small contextual hints | Hover hints plus pinned keyboard/touch help and Guide links. Public usage, Radix dependency, and MIT listing inspected; local React portal implementation. |
| [LN Accordion](https://21st.dev/@ln-dev7/components/faqs-01) | Progressive disclosure | Independently controlled scientific sections. Source inspected during prior 21st MCP research; no source copied or Radix dependencies added. |
| [Transitions.dev](https://transitions.dev/) | Feedback and continuity | 120ms colour/content feedback; 180ms help/panel reveal (4px maximum); 200ms disclosure grid/chevron; no movement for rows, data, or direct resizing. Reduced motion disables animation and transitions. |

The three Inspo detail captures were reviewed again before this implementation. They are marketing product previews rather than validated scientific workflows. Current 21st public listings supplemented the prior authenticated MCP research; no new MCP source retrieval or paid generation was used.

## Behavior

- Desktop starts at 55/45. Below 1100px, browsing and inspection are separate views with the catalog mounted to retain filters and scroll. Navigation becomes compact; below 640px it is a labelled, focus-contained drawer.
- Narrow-screen gene selection transfers keyboard focus into the inspector. Returning to browsing restores both vertical and horizontal catalog scroll.
- Facts and experiment actions remain visible above the inspector scroll area. Genomic context opens initially; model IDs, pathways, and regulation are independently collapsed. Open choices survive gene switches.
- Condition is labelled experiment context, never a catalog filter. Search/category/model-coverage behavior, lazy loading, and loaded-row sorting remain local to the existing catalog.
- Gene detail requests are cancellable and key-bound, with distinct loading, unavailable, and error/retry states. Catalog requests discard superseded results and offer retry for both initial and additional pages.
- Green gene text uses accessible light/dark shades while retaining its biological role. Biological chart/status colours remain unchanged. The genome SVG is an accessible group so its existing keyboard-selectable genes are exposed.

## Validation

Run `npm run build` and `npm run e2e -- workspace.spec.ts home.spec.ts theme.spec.ts smoke.spec.ts a11y.spec.ts --workers=3 --retries=0` from the frontend. Tests mock API responses; they do not launch simulations. Check 390/768/1440px, light/dark/system, reduced motion, and a 720×480 effective viewport representing 200% zoom on a 1440×960 window. Short windows allow page scrolling rather than clipping the table and inspector.

Implementation validation: build passed; all 140 tests passed across Chromium and WebKit, including 30 workspace checks. Real local API previews were reviewed at the three target widths in all theme modes and the effective zoom viewport. Captures are in `output/workspace-refresh/`. The build retains the existing large-bundle warning; no dependencies, backend routes, or data models were changed.
