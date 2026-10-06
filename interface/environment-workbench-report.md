# Conditions Builder document workbench

## Checkpoint

The previous implementation is preserved in local commit `759c8187f` (“Checkpoint Conditions Builder visual polish”). The workbench changes remain separate from that checkpoint for review. No reconstruction data or persistent volumes were reset.

## Presentation

The existing neutral/violet palette is retained. The header pairs a small code-native flask emblem with the title, a restrained violet top border, and a separate utilities area while preserving the full description and draft badge. A 220px section rail appears from 1000px available width; narrower containers use a labelled section menu. Navigation opens the selected section, updates a stable hash while preserving query parameters, and focuses its heading after layout. Passive scrolling updates the current section without moving focus or adding history entries. The optional registry stays in the dependency reference and stock editor rather than the navigation rail. Its reference action opens the stock editor in existing mode, without switching modes, jumping backward to another reference, or saving a draft.

The five workflow sections use distinct neutral bordered panels and quiet header surfaces. Numbered navigation follows their actual page order, with Catalog status directly after the dependency overview/reference and before the five editing sections. Scroll tracking selects the section occupying the largest readable viewport area; deliberate navigation keeps its target highlighted during scrolling, and user scrolling interrupts that intent without moving focus. Existing create-mode instructions appear in always-visible Guidance regions, beside the editor from 1000px section width and before it below that. Essential hints, format examples and warnings stay visible. The full overview, catalog, dependency reference and Build summary are retained; Build summary is now at the document's end. Each disclosure uses its own local Show/Hide control; the global guidance buttons were removed from the navigation rail. Existing inputs remain mounted during navigation/collapse. Stacked molecule fields repeat their existing labels and units for readability.

References: the user-selected document workbench, wcEcoli's established appearance, GOV.UK heading/anchor/disclosure guidance, and Carbon contextual form guidance. Presentation helpers and CSS are local; no frameworks or dependencies were added.

## Content and validation

`frontend/e2e/fixtures/environment-content.json` maps 311 checkpoint text entries and dependency metadata to their workbench owners and source lines. Automated AST checks retain verbatim text and repeated occurrences. API/state logic remains in the existing page; no draft/publish payload or backend changes were introduced.

The frontend build and whitespace checks passed. All 514 checks in the preceding full Chromium/WebKit regression run passed. After the preparation order, local disclosure controls, and header refinement, the final dedicated run passed 36 checks, adding registry navigation coverage and verifying content preservation, navigation/focus/Back/direct links, draft values, save/publish sequencing, errors, guidance, accessibility, themes, reduced motion, mobile/desktop layouts, effective 200% zoom, and Assistant continuity. Screenshots reviewed the overview, guidance layout, numbered navigation, and distinct panel boundaries in both engines; stacked controls and units remain readable. All automated API writes used mocks, with no live draft saves or reconstruction publication.

## Aesthetic refinement reference lock

The existing wcEcoli workspace remains the primary target: Inter, neutral theme surfaces, thin borders, 10px panels, violet action/focus roles, and no broad saturated fills. Live Refero style search again returned NO_SUBSCRIPTION; the existing Inspo captures were inspected instead.

| Decision | Reference / role | Adaptation |
| --- | --- | --- |
| Compact connected dependency sequence | Saved Buildkite stage grouping; setup dependency order already defined by wcEcoli | One neutral surface with five numbered rows, current identifiers, existing status labels, and working section actions. No invented progress. |
| Aligned question and identifier columns | Saved Smartsheet aligned records | Wide layouts align the explanation and current value; narrow layouts stack them while retaining every field. |
| Scan-friendly section identity | wcEcoli forms and bundled Refero typography guidance | Existing section names appear above their full questions; subdued headers and separators retain clear panel boundaries. |
| Consistent reference/catalog disclosure rows | Existing wcEcoli disclosure pattern | Matching padding, local Show/Hide text, directional chevrons, and existing reduced-motion behavior. |

No scientific copy, save/publish logic, ordering, default, dependency, or platform theme changes accompany this refinement.
