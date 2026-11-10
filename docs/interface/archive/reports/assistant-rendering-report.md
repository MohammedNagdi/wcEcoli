# Assistant response rendering verification

Implemented 4 October 2026. Preview: [Assistant](http://localhost:5173/assistant).

## Result

Replaced the regular-expression renderer with CommonMark/GFM parsing. Correctly authored ordered sections retain their numbering and nested bullets; explicit starting numbers and intentional list restarts remain intact. Stored, streaming, and interrupted responses share the same renderer and styling.

Responses support semantic headings, blockquotes, tables, footnotes, code blocks, and scientific equations. Wide content scrolls inside the answer. Code copy preserves received indentation, whitespace, and line endings while removing structural list/blockquote prefixes and parser-added newlines. Answer copy and source inspection retain the original response string.

Unfinished live formatting uses Remend only for presentation. Completed content is rendered from the authoritative received message. Frame-coalesced display updates and memoized completed answers keep the existing transport, Stop, interruption recovery, and scroll behavior intact.

Raw HTML remains literal text, image syntax shows alt text without image requests, and links use the existing internal router or HTTP/HTTPS external navigation. Footnotes are namespaced per message and scroll only the conversation.

## Equations and recovery

Supported syntax is `$$expression$$` inline, multiline `$$` display blocks, and fenced `math` blocks. Single-dollar text remains literal. Plain scientific strings such as `10^-3` and unsupported delimiters are not converted by guessing.

The parsed tree is sanitized before KaTeX. Equations use `trust: false`, expansion limit 1000, maximum size 10 em, accessible HTML/MathML, and independent macro state. Unsupported expressions show their source beside a short explanation. Rendering failures fall back to escaped original text with local retry and copy controls; neither retry nor source inspection submits another model request.

The backend now preserves legitimate code fences and ordinary scientific braces. Stream filtering and stored-response recovery share tool-envelope classification, and ordinary labelled code is excluded from textual tool recovery. Existing tool validation, action approval, and legacy proposal protocols remain intact. Shared prompt guidance encourages supported formatting while preserving scientific restrictions.

## Validation

- Frontend TypeScript/Vite build: passed.
- Full frontend suite: **360 passed**, Chromium and WebKit, no retries.
- Affected backend Assistant tests: **172 passed**.
- Added 48 browser cases covering rendering, source/code copying, hostile input, footnotes, equations, failure recovery, streaming/Stop, and performance.
- Page and dock reviewed at 390, 768, and 1440 CSS pixels, light/dark themes, reduced motion, and 200% effective layout zoom. Existing suites also cover system theme and accessibility.
- New Markdown accessibility checks found no serious or critical violations. Twenty-four screenshots are saved in `output/assistant-markdown`.
- Docker web rebuilt using `npm ci`; all four Compose services remain running, API and simulation runner healthy. Assistant page, renderer module, and API health endpoint verified. Existing data volumes retained.
- `git diff --check`: passed.

## Streaming measurements

Browser-driven appends use 8 KB chunks with animation-frame scheduling. Times include test orchestration, parsing, and display; these are usability checks, not isolated parser benchmarks. Composer input, scrolling, and Stop remain usable. Completed-message parse counts remain unchanged during the next streamed turn; the initial count of two comes from React development Strict Mode.

| Browser | Source size | Stream display time | Completed-message parses |
| --- | --- | --- | --- |
| chromium | 100 KB | 2464 ms | 2 → 2 |
| chromium | 20 KB | 256 ms | 2 → 2 |
| webkit | 100 KB | 2676 ms | 2 → 2 |
| webkit | 20 KB | 344 ms | 2 → 2 |

## Dependencies and limits

Pinned: react-markdown 10.1.0, remark-gfm 4.0.1, remend 1.4.0, remark-math 6.0.0, rehype-katex 7.0.1, rehype-sanitize 6.0.0, and KaTeX 0.16.22. The added rendering packages have no advisories in the installation audit. Existing unrelated dependency advisories were not changed through a broad dependency upgrade.

Dependency notices, including available transitive notices and the Apache license, are served at `/assistant-rendering-notices.txt`. No component framework, backend dependency, payload change, or database migration was introduced.

Malformed final Markdown is interpreted according to CommonMark/GFM and remains inspectable as source. Separate malformed lists are not silently joined or renumbered, and scientific content is never rewritten to repair presentation. Existing historical responses are not modified. Code syntax highlighting and executable diagrams are outside this change.

The main JavaScript bundle is approximately 2.24 MB / 670 KB gzip, including the existing application; Vite retains its large-chunk advisory. Rendering libraries and bundled KaTeX fonts increase the application assets.

Research basis: [React Markdown](https://github.com/remarkjs/react-markdown), [GFM](https://github.com/remarkjs/remark-gfm), [Remend](https://github.com/vercel/streamdown/tree/main/packages/remend), [math plugins](https://github.com/remarkjs/remark-math), [sanitization](https://github.com/rehypejs/rehype-sanitize#example-math), and [KaTeX options](https://katex.org/docs/options).
