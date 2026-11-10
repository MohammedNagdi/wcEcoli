# Interface documentation

The [interface README](../../interface/README.md) is the entry point for the current local platform. Historical design reports are retained here as implementation evidence, not deployment instructions.

## Maintained guides

- [Local platform setup and operation](../../interface/README.md)
- [Local LLM setup and troubleshooting](local-models.md)
- [Dataset export](../../interface/backend/hf_export/README.md)
- [Assistant evaluations](../../interface/backend/eval/README.md)
- [Frontend behavior and verification notes](../../interface/frontend/docs/frontend-refresh.md)
- [Hugging Face task catalog](../huggingface-deployment-tracker.md)
- [HF-01 cleanup record and deployment exclusions](hf01-cleanup.md)
- [HF-02 local startup and verification](hf02-startup.md)
- [HF-03 demo campaign and serving-data contract](hf03-campaign-and-contract.md)
- [HF-04 completed isolated pilot](hf04-pilot.md)
- [HF-05 full campaign and verified raw cleanup](hf05-full-campaign.md)
- [HF-06 public explorer and acceptance](hf06-explorer.md)
- [HF-07 production packaging and startup](hf07-production.md)
- [HF-08 private staging preparation and publication gates](hf08-private-staging.md)
- [Explorer personal draft transfer format](explorer-drafts-v1.md)
- [HF-01 file-by-file disposition inventory](hf01-file-inventory.tsv)

## Historical reports

Paths and commands inside historical reports may describe the original interface-relative working directory. They are not current deployment instructions.

- [assistant refresh report](archive/reports/assistant-refresh-report.md)
- [assistant rendering report](archive/reports/assistant-rendering-report.md)
- [batch designer report](archive/reports/batch-designer-report.md)
- [design reference report](archive/reports/design-reference-report.md)
- [environment builder report](archive/reports/environment-builder-report.md)
- [environment workbench report](archive/reports/environment-workbench-report.md)
- [experiment designer report](archive/reports/experiment-designer-report.md)
- [genome design report](archive/reports/genome-design-report.md)
- [result detail report](archive/reports/result-detail-report.md)
- [results browser report](archive/reports/results-browser-report.md)

## Design references

- [Assistant refresh decisions](design-references/assistant-refresh-decisions.md)
- [Inspo reference report](design-references/inspo-report.html)
- [Refero reference report](design-references/refero-report.html)
- [Reference templates](design-references/inspo-templates/README.md)

The reference tree includes original research records and assets. It is preserved for maintainers and excluded from the repository-root Docker context with the other documentation. Current app previews and their generation scripts remain under the frontend.
