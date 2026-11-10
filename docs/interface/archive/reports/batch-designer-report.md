# Batch builder polish

Reference lock: wcEcoli's existing workspace and polished `/experiments/new`, existing Inspo navigation/search captures and Smartsheet table alignment, and the previously selected 21st.dev disclosure and transitions.dev reveal patterns. All presentation is implemented locally; no external component source or dependencies were added.

The batch builder now reuses the designer's neutral theme and restrained timeline palette. Container width controls the 340px summary layout, and its measured height determines whether it can be sticky. The batch route uses the designer's scrollable shell and Assistant clearance. Gene and preview tables keep bounded, labelled keyboard-accessible scrolling and opaque headers. Gene identifiers wrap and use neutral monospace text.

Removed redundant header and protocol badges, the second clear-selection action, and repeated validation reasons. Retained the full scientific explanations, preview combination counts, row controls, and summary data. Inputs now have associated labels; repeated row controls have unique accessible names. Creation errors remain beside Create batch until another submission, with drafts retained.

Batch generation, filtering, defaults, API payloads, and navigation remain in the existing builder. No backend, database, dependency, or simulation launch changes.

Validation: frontend TypeScript/Vite build and whitespace checks passed. The full Chromium/WebKit run passed 476 checks; six new tests had incorrect exact heading selectors and were corrected. A final dedicated batch run covers 32 checks, including those six cases, payloads, index variants, multi-targets, protocol expansion, preview editing, failures, accessibility, real scrolling, themes, effective 200% zoom, dense records, long names, and Assistant continuity. Dark-mode page and timeline screenshots were inspected in both engines. QA captures are in `/tmp/batch-*-*.png`; Docker volumes were retained.
