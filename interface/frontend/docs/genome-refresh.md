# Genome Map refresh

The reference-locked direction pairs Dovetail's visualization-to-selected-evidence pattern with Hex's readable technical facts, using the existing Inspo product-preview captures. These are bounded visual references, not verified scientific workflows. The map remains a real SVG rendering of wcEcoli gene positions, with the platform theme and biological category colours retained.

## Interaction contract

- Clicking a map gene, search result, or neighboring gene updates the selected gene on `/genome` using URL replacement. It retains camera position and zoom. Only an explicit **Open in workspace** link navigates to `/explore`.
- Initial gene deep links retain their camera focus. Later camera movement requires **Focus gene**, **Fit genome**, zoom controls, panning, or keyboard zoom. Fit preserves selection and category highlights.
- Map rendering receives selection, a selection callback, and a separate focus request. It owns no routing or workspace store access. Drag displacement is converted from rendered pixels to SVG units, and dragging suppresses gene clicks.
- Zoom expands the full SVG inside a scrollable viewport instead of cropping a transformed drawing. Dragging, scrollbars, and keyboard controls reach enlarged chromosome regions; the fixed viewport holds keyboard focus without moving the camera. Ordinary and Shift-wheel scrolling do not zoom the map. Trackpad pinch (Chromium ctrl-wheel and Safari gesture events) and two-finger touch pinch zoom around their midpoint; labelled buttons and keyboard zoom remain available. Pinch updates are coalesced to animation frames, and browser page zoom is suppressed only for pinch events inside the map. The written instructions below the map are removed.
- Search consistently matches symbols, identifiers, and synonyms. Search and selection clear independently. Category emphasis retains all mapped genes.
- The local inspector offers details and legend/statistics tabs. Below 1100px it stacks below the map; navigation compacts, and below 640px navigation becomes a labelled drawer. The entire page can scroll at short heights and browser zoom.
- Progressive genome loading labels provisional counts; failed later batches retain loaded data with a warning. Retry restarts loading without duplicate batches. Gene details and neighboring-gene failures have their own retry actions, and superseded selections cannot display stale details.

## Scientific presentation

Mapped counts and density derive from loaded data and the 4,641,652 bp genome-length constant. Strand tracks and bp/Mbp units are explained in the legend. Reference GC content is labelled as a reference value; ter is described as an approximate marker. Widened glyphs are disclosed, with exact positions and lengths shown in the inspector.

Local badges, contextual help, disclosures, and the genome-context rail are reused. Feedback uses 120ms colours, 180ms inspector reveal (4px), and 200ms disclosures. Camera manipulation is immediate, with no pulsing or glow; reduced motion disables feedback animations.

## Validation

Run `npm run build` and `npm run e2e -- genome.spec.ts workspace.spec.ts home.spec.ts theme.spec.ts smoke.spec.ts a11y.spec.ts --workers=3 --retries=0` from the frontend. Browser tests mock APIs and do not launch simulations. Visual captures from the real local API are stored in `output/genome-refresh/`: light, dark, and system at 390/768/1440px, with a 720×480 effective viewport for 200% zoom. Backend APIs, model data, and package dependencies are unchanged.

Final validation passed: the frontend build and all 164 Chromium/WebKit tests, including 24 Genome Map checks. Button zoom preserves page and viewport dimensions; enlarged canvas edges remain scrollable, and Fit restores the overview. Responsive visual captures were refreshed from the real local API. The existing large-bundle warning remains.

## Zoom performance

Chromosome geometry is computed once per loaded gene batch. The drawing is memoized independently of camera and tooltip state, so zooming, panning, and tooltip movement reuse all gene glyphs. Scientific selection, search, highlights, and theme changes still update the drawing. No animation library or package was added.

A local full-genome benchmark used 4,727 mapped genes, the Vite development build, 18 button zoom samples per browser, and two animation frames per sample. WebKit mean response fell from 268 ms to 81 ms. Chromium was measured with 4× CPU throttling; its optimized mean was 87 ms. These are local measurements, not guarantees for every device. Direct manipulation remains immediate.

Pinch validation: the frontend build and all 30 targeted Chromium/WebKit Genome Map tests passed, including Chromium browser-level two-finger touch input, trackpad pinch event handling, Safari gesture handling, zoom limits, and unchanged route/selection. Safari gesture tests use synthesized events rather than physical trackpad hardware.

## Waza UI polish (2026-10-15)

The existing Dovetail/Hex reference lock and biological palette remain in place. Selected-gene headings use 22px, labels/data 13px, and explanations 14px. Main actions are at least 40px tall, compact map controls 36px, and the desktop inspector is 360px wide. Identity, actions, facts, and genomic context use local spacing and separators. Page and inspector scroll areas include 88px bottom clearance; mobile map/inspector navigation accounts for the shell navigation button.

Coordinate and oriC/ter text now renders at 11px in the fitted view, with 14px organism and 12px genome-length text. Previously 11 SVG units rendered at approximately 4.8px in a 348px mobile map. Annotations are memoized separately from gene glyphs, retaining all positions and the existing zoom scaling. Center-label spacing is also adjusted for fitted viewport size. Tooltips retain their content with a bounded width and viewport-aware positioning.

Category highlighting is a non-modal anchored portal with contained scrolling, viewport clamping, outside-click dismissal, and Escape focus restoration. It retains all categories/counts and does not move the map when opened. Below 1100px available workspace width, View gene details and Back to map move focus and scroll without changing camera, search, highlights, or URL state. Nested Escape dismisses categories before the Assistant dock.

Cold WebKit loads exposed an initial camera-position race: before the map stylesheet applied, the frame had visible overflow and rejected programmatic scrolling. Camera measurement/positioning now waits for the styled scroll frame. A delayed-style regression checks initial focus and subsequent selection continuity. No backend, scientific geometry, API, or package changes were made.

Validation: frontend build passed. All 48 Genome Map checks passed across Chromium/WebKit after the cold-load fix. The final camera hot-path adjustment passed 47/48 checks in one run; the intermittent enlarged-edge scrolling check then passed six isolated repetitions (three per engine). The affected workspace/smoke/theme/accessibility regression run passed its existing checks; the added delayed-style fixture was corrected and verified in the targeted run. Real-data light/dark captures cover 390/768/1440px in both engines; existing mocks additionally cover system theme, reduced motion, effective 200% zoom, and the Assistant dock.

An isolated development-build comparison used the previous map component and the updated component against the same page layout and 4,727 genes, four warm-up interactions and 18 measured alternating zoom interactions, each measured through two animation frames. Chromium averaged 33.4ms before and 33.3ms after; WebKit averaged 84.1ms before and 129.7ms after. The baseline module was transpiled locally for browser interception, so these are diagnostic timings rather than a production benchmark. WebKit's additional zoom cost remains a performance follow-up; glyph attributes remain unchanged during camera updates. No artificial delays or camera animations were added.
