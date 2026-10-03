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

`public/previews/` contains light/dark WebP captures of real local platform pages (1440×960), plus 720×480 variants. The results are example model output, not experimental measurements. They were captured on 2026-10-03 without saving configurations or queuing simulations.

To reproduce with the frontend and local API running:

```sh
node scripts/capture-previews.mjs
```

The default output is `/private/tmp/wcecoli-previews`. Optimize those PNGs with Pillow to RGB WebP: quality 90/method 6 at native size; quality 86/method 6 for 720×480. Place the resulting images in `public/previews/` with the same filenames. Do not commit raw PNGs. Review the results preview before refreshing it because it reflects the local session's data.

## Verification

- Build: `npm run build`.
- Browser regression: `npm run e2e -- home.spec.ts theme.spec.ts smoke.spec.ts a11y.spec.ts --workers=3`.
- Preview: `http://localhost:5173/`; working workspace: `/explore`.
- Legacy root workspace query keys redirect with search/hash intact; normal introduction tracking parameters do not redirect.
