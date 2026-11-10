# Assistant refresh implementation

Implemented the approved Hex / Beautiful UI direction using wcEcoli's existing violet theme, Inter and JetBrains Mono. No component framework, package, backend endpoint, or backend dependency was added.

## What changed

- Shared workbench with distinct Chat, Settings and Activity views. Full-page view selection uses `assistantView` while preserving context query parameters. The dock uses local view selection.
- A 260px history rail at 1000px of assistant width; labelled drawer otherwise. History searches loaded titles, shows selection, retains failed rename edits, and confirms deletion.
- A 440px panel alongside the workspace when at least 1160px remains after navigation; a modal filling the viewport otherwise. Workspace, Genome Map, Experiments and Network adapt to available content width. The desktop workspace stays interactive.
- Header and auto-growing composer stay inside the panel while messages scroll. Conversation, model, draft and per-chat scroll persist across page/dock transitions. Starter prompts fill the draft. Enter and Ctrl/Cmd+Enter send, Shift+Enter inserts a newline, and IME input does not submit.
- Safe Markdown, copy controls, horizontally scrollable code/tables, evidence links and expandable raw tool data. All proposals are reachable through expandable pagination.
- SSE deltas render immediately. Provider-authored commentary stays separate from the answer. Stop preserves partial output with a local label and does not claim to cancel simulation jobs. Accepted interrupted turns reload stored messages and never automatically resubmit. Synchronous fallback is limited to failures before any application event, including metadata.
- Request generations reject stale responses. Active responses prevent conversation switching, new chats and runtime changes. In-flight runtime selection prevents submission before the selection is saved.
- Action review freezes normalized arguments and page context. A shared lock prevents duplicate execution across surface transitions. Uncertain execution stays blocked until confirmation/tool-call records establish the outcome. Successful action outcomes remain in the conversation.
- Settings retain failed saves, use backend numeric bounds, show field errors and retry states, and protect unsaved changes. Assistant and experiment edits share a sequential navigation guard, including browser Back.
- Activity loads when opened, supports current-chat/global scope, and distinguishes request failure from empty results. Current page context and conversation memory are separate disclosures with memory retry and confirmed clear feedback.
- Modal focus containment, focus restoration and nested Escape handling. Reduced-motion preferences disable added motion.

## Validation

- `npm run build`: passed. Vite still reports its existing large-bundle advisory.
- `npx playwright test --workers=4 --retries=0`: **312 passed**, Chromium and WebKit, 1.4 minutes on the final run.
- Suites: Assistant smoke and refresh, theme, accessibility, homepage, workspace, Genome Map, Network and Experiments.
- Visual matrix: 390px, 768px and 1440px; light/dark/system; reduced motion; 200% effective zoom through a halved layout viewport. All visual-matrix accessibility checks passed.
- Reviewed representative desktop/phone light and dark screenshots. The 18 browser/theme/width captures are in `output/assistant-refresh/`.
- Tests use mocked APIs; Docker and model credentials are not needed.
- `git diff --check`: passed.

## Compatibility notes

Existing backend payloads and action approval order are preserved. Commentary, stream tool evidence and review snapshots are retained in the frontend session; stored messages, proposals, memory and audit records use the existing persistence APIs. Uncertain executions without conclusive records remain blocked rather than automatically retrying.

The patterns were implemented locally for React 18 and Tailwind 3. No Beautiful UI source or paid icons were copied. The approved reference lock and rationale are in [assistant refresh decisions](../../design-references/assistant-refresh-decisions.md).
