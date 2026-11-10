# Results browser frontend polish

## Reference lock

The primary target is wcEcoli's existing workspace: Inter, JetBrains Mono, neutral theme surfaces, thin borders, violet actions/focus, 10px panels, 8px controls, and 6px badges. All three Results browser tabs retain their cards, fields, values, and actions. Individual result pages and the comparison dashboard are excluded.

Live read-only Inspo MCP searches and records covered Smartsheet, Hex, and Buildkite Pipelines. Smartsheet contributes aligned records and local controls; Buildkite contributes compact grouping of actual batch statuses. Their marketing gradients, headline treatments, and saturated status colors are excluded. Manually adapted 21st.dev Origin UI line tabs, table, and disclosure patterns provide keyboard/focus and alignment guidance. No component runtime, copied external source, or dependency was added.

## Changes

- Responsive Results-only shell navigation and native page scrolling, with Assistant clearance and a 1260px page maximum.
- Separate keyboard-operated line tabs and a neutral coverage strip using existing counting semantics.
- Full-width search, labelled responsive native filters, wrapping metadata/protocols, aligned metric rows, and accessible seed regions.
- An opt-in Results presentation for shared batch cards; default Experiments presentation and action handlers remain intact.
- Muted batch progress segments using unchanged counts and widths; opaque table headers and bounded, keyboard-accessible table scrolling.
- Viewport-clamped portal action menus with outside-pointer dismissal, Escape focus restoration, and local keyboard navigation.
- Results-only dark compatibility overrides, readable hover states, and consistent native select sizing.

No backend, database, API payload, aggregation, polling, scientific formatting, pagination, or sorting change is included. Existing request failures and confirmation flows retain their handlers and text. Live visual inspection used read-only navigation and disclosures; all run/cancel/resume/delete requests in verification used mocked APIs.

## Verification

The content inventory preserves 100 distinct existing JSX labels/help passages and 128 occurrences from commit 1694d7b7d. Deterministic checks verify scientific metrics, confidence intervals, deltas, missing metrics, seed links, filters, tab/query navigation, portal menus, action request methods and bodies, retained records after failures, and empty-state links.

The affected broader run passed all 270 checks outside the new Results suites; its two Results hover-contrast failures were corrected locally. The final Results/content/theme run passed all 60 checks in Chromium and WebKit, including light/dark/system themes, reduced motion, 390/768/1440px layouts, effective 200% zoom, and the Assistant dock. Frontend build and whitespace checks passed.

Read-only screenshots covered all three views in both engines at 390/768/1440px in light and dark themes; representative layouts and the final dark controls/neutral strip were inspected. Only Docker's web service was rebuilt, without volume resets.
