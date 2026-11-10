# Frontend refresh reference lock

The refresh adds an introduction at `/`, preserves the working workspace at `/explore`, and changes shared colour tokens only. Existing working-page panel geometry and workflows are retained.

| Decision | Reference | Adaptation |
| --- | --- | --- |
| Product explanation followed by actual interface evidence | Dovetail, https://dovetail.com/ | Clear heading, restrained sections, and a large framed product capture. No commercial claims, customer logos, or decorative background animation. |
| Technical readability and product framing | Hex, https://hex.tech/ | Keep Inter, use mono for identifiers, show real model and results interfaces. |
| Neutral surfaces with violet actions | User-approved plan | Preserve biological/status colours; keep light, dark, and system modes. |
| Responsive site header | Simple Header by Efferd, https://21st.dev/@efferd/components/simple-header | Inspected through authenticated MCP `get_component` (demo 7991). Locally written navigation uses the existing theme control and an inline mobile disclosure instead of the source's shadcn sheet. No source code is copied. |
| Product hero | Product Hero with Demo Panel, https://21st.dev/@felipemenezes098/components/hero-14 | Inspected MCP metadata and public usage/dependencies/licence. The source lists AGPL-3.0 and Motion/react-wrap-balancer. No source is imported or copied; the approved wcEcoli layout is implemented locally with CSS. |
| Help section | Centered Accordion FAQ by LN, https://21st.dev/@ln-dev7/components/faqs-01 | Inspected through MCP `get_component` (demo 26912). Public listing identifies MIT. Locally written disclosure controls replace the source's Radix dependencies; the content comes from wcEcoli's existing Guide. No source code is copied. |
| Motion | https://transitions.dev/ | Adapt menu reveal and accordion continuity; use 120/180/200/240ms tokens, explicit properties, and reduced-motion guards. |

21st research: three searches returned 15 candidates; inspected the three named references and retrieved two source bundles within the account's two daily free retrievals. No hosted generation or subscription purchase was performed. No new UI dependencies were introduced.

## Product previews

`public/previews/` contains updated light/dark WebP captures of real local workspace, designer, and Results browser pages at 720/1440/2400px widths. Each crop retains its own aspect ratio; generated `previewDimensions.json` reserves matching layout space. The results are example model output, not experimental measurements. The captures were refreshed on 2026-10-06 without saving configurations or queuing simulations.

To reproduce with the frontend and local API running:

```sh
node scripts/capture-previews.mjs
python scripts/export-previews.py
```

Raw captures default to `/private/tmp/wcecoli-previews`. The exporter uses existing Pillow to create RGB WebP variants and matching layout metadata. The designer crop includes its full Run summary; the Results crop ends after three complete cards. Review the actual local records before exporting them. Raw PNGs remain outside the repository.

## Verification

- Build: `npm run build`.
- Browser regression: `npm run e2e -- home.spec.ts theme.spec.ts smoke.spec.ts a11y.spec.ts --workers=3`.
- Preview: `http://localhost:5173/`; working workspace: `/explore`.
- Legacy root workspace query keys redirect with search/hash intact; normal introduction tracking parameters do not redirect.

Preview refresh verification (2026-10-06): production build and whitespace checks passed; all 66 homepage/theme/accessibility checks passed in Chromium and WebKit. All 18 exported variants match their reserved dimensions and aspect ratios. Light/dark captures were visually reviewed, including a live homepage check. Capture rejects Vite error overlays; no configurations were saved and no simulations were launched.
