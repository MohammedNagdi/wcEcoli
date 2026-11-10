# Inspo reference templates

Retrieved directly from Inspo MCP on 3 October 2026. These are original reference sources, not installed application components.

## Breadcrumb navigation

`get_reference_jsx(nav, breadcrumb)`

Visible location within an experiment or Guide hierarchy. Use Experiments / batch name / run name. Keep global phase navigation visible. Replace placeholder destinations and mark the current page.

## Search navigation

`get_reference_jsx(nav, search-first)`

A wide search field with quiet utility links. Use for gene, experiment, or Guide lookup in a clearly labeled scope. Add a real input label, search handling, and mobile navigation. The pictured shortcut is not wired in the source.

## Searchable help

`get_reference_jsx(faq, search-led)`

Client-side filtering of visible question-and-answer rows. Use for short definitions and troubleshooting. Replace sample questions with scientific explanations; label the input, handle Enter, and announce result counts. It is not a full documentation search service.

The sources require React, Tailwind, Inspo utility classes (including rule, text-meta, and font-display), and the token aliases returned by MCP. The search navigation source is visual markup; the help source implements local string filtering. No backend integration or usability testing has been performed. Source metadata is saved in inspo-research.json.
