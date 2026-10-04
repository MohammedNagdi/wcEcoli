# Assistant refresh decision ledger

## Locked direction

Approved by the user in the implementation plan. Primary reference: Hex conversation and evidence patterns in `inspo-research.json`. Component-pattern supplement: https://www.beautifului.dev/ and https://github.com/slev12397/beautiful-ui. Fresh Inspo research was unavailable; existing research was explicitly approved. Refero access was unavailable in the research session.

Keep wcEcoli's Inter / JetBrains Mono, violet actions, neutral surfaces, biological and status colours. Open assistant answers, restrained user messages, and authoritative tool evidence attached to the answer. Local radii: 6px chips, 8px controls, 10px cards, 14px panels. No gradients, simulated text delays, invented confidence, or decorative progress.

## Implementation decisions

- One conversation surface, shared provider state, separate Chat / Settings / Activity views. A 260px history rail appears at 1000px of assistant width; otherwise use a labelled drawer.
- The dock uses 440px of shell space when the space after global navigation is at least 1160px; otherwise it is a modal filling the viewport. Workspace container queries and measured-width hooks account for that space. Experiments use a 1000px content breakpoint for a 420px inspector and readable catalog; Network stacks its inspector below the canvas when the content area is narrow beside the dock.
- Keep only messages scrollable. Header, context summary, and auto-growing composer stay within the panel. Scroll follows arriving content only while the reader follows the latest turn.
- Keep draft, selected runtime, conversation, per-chat scroll, proposal reviews, commentary and tool evidence in AssistantProvider. The page and dock share presentation modules.
- SSE transport records every parsed application event, including metadata. Synchronous fallback is available only before an event. Accepted interrupted turns reconcile stored messages; they never resubmit automatically. Stop aborts the frontend response request and does not claim to cancel simulations.
- Review freezes normalized arguments and current context. An in-memory lock prevents double execution, including across surface transitions. A failed execution request blocks retries; confirmation usage and its recorded tool-call identifier establish a reconciled outcome. Missing records remain uncertain. Known failed execution requires another explicit preview before another attempt.
- Settings and experiment edits share one router navigation blocker with sequential guard ownership. Failed saves retain drafts. Numeric limits match the backend runtime bounds. Activity fetches on opening and does not confuse failures with empty results.
- Preserve existing backend endpoints, payload formats, action confirmation sequence, query parameters and links. Add `assistantView` for full-page presentation only.
- Source was written locally for React 18 / Tailwind 3. No Beautiful UI source or paid icon code was copied; no new packages or backend dependencies were added. Beautiful UI is used as an MIT-licensed pattern reference, not a runtime dependency.

## Verification

Deterministic browser API mocks cover behavior and failure boundaries. Chromium / WebKit matrix: 390, 768 and 1440 CSS px; light / dark / system; reduced motion; 200% effective zoom (halved layout viewport). Saved screenshots are under `output/assistant-refresh/` and are test fixtures, never product data. Final test/build results are recorded in the implementation report.
