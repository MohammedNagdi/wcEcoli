# Campaign Tracker

This tracker describes the campaign that is currently implemented in `hf_export`. The goal is to keep one concise source of truth for what each tier runs, how to validate it, what is still missing, and why the T5 curated knockout classes were selected.

## How To Validate And Run

Dry-run first. A dry-run validates real submission prerequisites without creating experiments or jobs.

```bash
docker exec interface-api-1 python -m hf_export.submit_campaign --dry-run --tiers T1 --seeds 1 --generations 1
docker exec interface-api-1 python -m hf_export.submit_campaign --dry-run --tiers T2_CORE,T2_EXTENDED --seeds 1 --generations 1
docker exec interface-api-1 python -m hf_export.submit_campaign --dry-run --tiers T3 --seeds 1 --generations 1
docker exec interface-api-1 python -m hf_export.submit_campaign --dry-run --tiers T4 --seeds 1 --generations 1
docker exec interface-api-1 python -m hf_export.submit_campaign --dry-run --tiers T5 --seeds 1 --generations 1
```

Submit by removing `--dry-run`. Use a stable `--campaign-id` when resuming a previous real submission so the campaign ledger can reuse cells already created.

```bash
docker exec interface-api-1 python -m hf_export.submit_campaign --tiers T5 --campaign-id t5_v1 --seeds 8 --generations 4
```

Export after jobs finish:

```bash
docker exec interface-api-1 python -m hf_export.run_export --out /app/eval/hf_campaign
docker exec interface-api-1 python -m hf_export.run_export --out /app/eval/hf_campaign_full --full-tensors
```

## Tier Overview

| Tier | CLI value | What it runs | Current status |
|---|---|---|---|
| T1 reference | `T1` | WT across all 21 static conditions. | Implemented. |
| T2 core KO | `T2_CORE` | Single-gene KOs across 5 core static conditions. | Implemented. |
| T2 extended KO | `T2_EXTENDED` | Bounded single-gene KO set across all 21 static conditions. | Implemented. |
| T3 dynamic media | `T3` | Timeline protocols, sinusoidal media, and amino-acid shifts. | Implemented. |
| T4 regulatory | `T4` | Runtime-indexable TF active/inactive states plus ppGpp concentration sweep. | Implemented. |
| T5 multi-gene KO | `T5` | 75 curated two-gene KO pairs across T2 core conditions. | Implemented. |
| T6 genome design | Not exposed | New-gene and rRNA design variants. | Not implemented. |

Default multipliers are `8` seeds and `4` generations. Submission now passes explicit `seed_values`, so `--seeds 8` means `[0, 1, 2, 3, 4, 5, 6, 7]`.

Campaign cell counts are counted before seed and generation multipliers. Expected jobs are `cells x seeds`. Expected exported cell trajectories are `jobs x generations`.

## Cell Count Summary

| Tier | Cell calculation | Expected cells | Default jobs | Default trajectories |
|---|---:|---:|---:|---:|
| T1 reference | `21 WT static conditions` | `21` | `168` | `672` |
| T2 Core | `573 live DB genes x 5 core conditions` | `2865` | `22920` | `91680` |
| T2 Extended standalone | `188 live DB genes x 21 static conditions` | `3948` | `31584` | `126336` |
| T2 Core + Extended combined | `2865 core + 3008 non-overlapping extended cells` | `5873` | `46984` | `187936` |
| T3 | `6 timelines x 101 genotypes + 3 sinusoidal pairs x 4 periods + 66 AA shifts` | `684` | `5472` | `21888` |
| T4 | `22 TFs x 2 states + 10 ppGpp factors x 2 conditions` | `64` | `512` | `2048` |
| T5 | `75 pairs x 5 core conditions` | `375` | `3000` | `12000` |
| T6 | Not implemented | `0` | `0` | `0` |

## T1 Reference

T1 is the WT static-condition reference manifold.

What it runs:

- `variant_type`: `wildtype`
- Conditions: `basal`, `glc_20mM`, `glc_5mM`, `glc_2mM`, `with_aa`, `acetate`, `succinate`, `no_oxygen`, `fumarate`, `malate`, `no_glucose`, `minus_calcium`, `minus_magnesium`, `minus_phosphate`, `plus_arabinose`, `plus_gallate`, `plus_indole`, `plus_nitrate`, `plus_nitrite`, `plus_quercetin`, `plus_tungstate`
- Cell count before seed/generation multipliers: `21`

Expected cell calculation:

- T1 reference cells: `21 WT conditions = 21 cells`
- Default jobs: `21 cells x 8 seeds = 168 jobs`
- Default trajectories: `168 jobs x 4 generations = 672 trajectories`

What it has:

- WT-only guard in tests.
- WT condition validation against the DB.
- `plus_tungstate` included so the static condition count is 21.
- Static `no_glucose` kept separate from dynamic T3 `glucose_starvation`.

## T2 Single-Gene Knockout

T2 tests single-gene KO effects under static media.

### T2 Core

What it runs:

- `variant_type`: `gene_knockout`
- Genes: all KO-ready essential genes found in the repo DB, plus a category-balanced nonessential sample.
- Conditions: `basal`, `glc_20mM`, `acetate`, `succinate`, `with_aa`
- Current live DB dry-run: `573` genes x `5` conditions = `2865` cells.

Expected cell calculation:

- T2 Core cells: `573 genes x 5 conditions = 2865 cells`
- Default jobs: `2865 cells x 8 seeds = 22920 jobs`
- Default trajectories: `22920 jobs x 4 generations = 91680 trajectories`

What it has:

- Essential-first selection.
- Nonessential sampling across KO-ready functional categories.
- Gene validation through KO indices.
- Condition validation before submission.

### T2 Extended

What it runs:

- `variant_type`: `gene_knockout`
- Genes: first 100 KO-ready essentials plus a smaller category-balanced nonessential sample.
- Conditions: all 21 T1 static conditions.
- Current live DB dry-run when combined with T2 Core: `3008` additional cells after deduplication.

Expected cell calculation:

- T2 Extended standalone cells: `188 genes x 21 conditions = 3948 cells`
- T2 Extended additional cells when run with T2 Core: `188 genes x 16 non-core conditions = 3008 cells`
- T2 Core + T2 Extended combined cells: `2865 + 3008 = 5873 cells`
- Default standalone jobs: `3948 cells x 8 seeds = 31584 jobs`
- Default standalone trajectories: `31584 jobs x 4 generations = 126336 trajectories`
- Default combined jobs: `5873 cells x 8 seeds = 46984 jobs`
- Default combined trajectories: `46984 jobs x 4 generations = 187936 trajectories`

What it has:

- Broader media coverage than T2 Core.
- Deduplication when T2 Core and T2 Extended overlap.
- Same runtime path as normal single-gene KO experiments.

## T3 Dynamic Media

T3 tests temporal response and forecasting behavior.

What it runs:

- Timeline cells:
  - `rich_to_minimal`: `0 minimal_plus_amino_acids, 1200 minimal`
  - `minimal_to_acetate`: `0 minimal, 1200 minimal_acetate`
  - `glucose_starvation`: `0 minimal, 1200 minimal_no_glucose`
  - `phosphate_depletion`: `0 minimal, 2400 minimal_minus_phosphate`
  - `cut_oxygen`: `0 minimal, 1200 minimal_minus_oxygen`
  - `add_amino_acids`: `0 minimal, 1200 minimal_plus_amino_acids`
- Timeline genotypes: WT plus 100 selected KOs.
- Sinusoidal media pairs:
  - `minimal` to `minimal_acetate`
  - `minimal` to `minimal_plus_amino_acids`
  - `minimal_GLC_2mM` to `minimal_GLC_20mM`
- Sinusoidal periods: `15`, `30`, `60`, `120` minutes.
- Amino-acid shifts:
  - `add_one_aa_shift`: indices `0..20`
  - `remove_one_aa_shift`: indices `0..20`
  - `remove_aas_shift`: indices `0..23`
- Current live DB dry-run: `684` cells.

Expected cell calculation:

- Timeline cells: `6 protocols x (1 WT + 100 selected KOs) = 606 cells`
- Sinusoidal cells: `3 media pairs x 4 periods = 12 cells`
- Amino-acid shift cells: `21 add-one-AA + 21 remove-one-AA + 24 remove-AA-set = 66 cells`
- T3 total cells: `606 + 12 + 66 = 684 cells`
- Default jobs: `684 cells x 8 seeds = 5472 jobs`
- Default trajectories: `5472 jobs x 4 generations = 21888 trajectories`

What it has:

- One tier, not core/extended.
- Timeline validation requiring non-empty event strings.
- Sinusoidal `SINE_MEDIA_A` and `SINE_MEDIA_B` passed through runtime environment variables.
- Sinusoidal and amino-acid shift variants are WT-only for now because direct variant composition with KOs is not supported.

## T4 Regulatory

T4 tests regulatory perturbations supported by the current runtime.

What it runs:

- `tf_activity`: every runtime-indexable TF x active/inactive state.
- `ppgpp_conc`: all ppGpp factor/condition indices.
- Current live DB dry-run: `64` cells:
  - `44` TF activity cells from `22` mapped TFs.
  - `20` ppGpp cells.

Expected cell calculation:

- TF activity cells: `22 runtime-indexable TFs x 2 states = 44 cells`
- ppGpp cells: `10 factors x 2 conditions = 20 cells`
- T4 total cells: `44 + 20 = 64 cells`
- Default jobs: `64 cells x 8 seeds = 512 jobs`
- Default trajectories: `512 jobs x 4 generations = 2048 trajectories`

What it has:

- Uses the same TF activity mapping helper as runtime submission.
- Rejects `tf_activity` index `0`; T1 already covers WT controls.
- Rejects out-of-range TF and ppGpp indices.
- Validates required ppGpp conditions.
- Reports network TFs missing from `tf_condition.tsv` as uncovered metadata.

What it does not have yet:

- T4 does not cross regulatory variants with KOs.
- T4 does not cross regulatory variants with T3 dynamics.
- T4 does not force TFs that are present in the network but absent from runtime TF-condition metadata.

## T5 Curated Multi-Gene Knockout

T5 tests curated pairwise KO interaction candidates. It is intentionally curated, not exhaustive.

What it runs:

- `variant_type`: `multi_gene_knockout`
- Pair definitions: `75`
- Conditions: `basal`, `glc_20mM`, `acetate`, `succinate`, `with_aa`
- Cell count before seed/generation multipliers: `75 x 5 = 375`
- Default estimate: `3000` jobs and `12000` trajectories at `8` seeds x `4` generations.

Expected cell calculation:

- T5 cells: `75 curated pairs x 5 core conditions = 375 cells`
- Default jobs: `375 cells x 8 seeds = 3000 jobs`
- Default trajectories: `3000 jobs x 4 generations = 12000 trajectories`

What it has:

- Pair validation through the existing multi-gene KO resolver.
- Rejects missing genes, duplicate genes, non-KO-ready genes, and pairs with fewer than two unique KO indices.
- Canonical KO indices are written through the platform `multi_gene_knockout` metadata path.
- Pair classes are stored in campaign cell params for downstream provenance.

What it does not have yet:

- It is not an all-pairs sweep.
- It does not include triples or higher-order KOs.
- It does not cross multi-gene KOs with T3 dynamics, T4 regulatory variants, or all 21 static conditions.

### T5 Pair Classes And References

The references below motivate the classes used for pair selection. They are design-rationale references, not claims that every individual pair is experimentally confirmed synthetic lethal in this repo. All listed pairs were validated against the current repo DB as KO-ready pairs before being added.

| Pair class | Pairs | Rationale references |
|---|---|---|
| `redundant_central_carbon` | `pfkA/pfkB`, `pykF/pykA`, `tktA/tktB`, `talA/talB`, `fumA/fumB`, `fumA/fumC`, `fumB/fumC` | Metabolic redundancy and synthetic lethality in E. coli metabolic networks: [Ghim et al.](https://arxiv.org/abs/q-bio/0411006), [Guell et al.](https://arxiv.org/abs/1309.5209), [Fast-SL](https://arxiv.org/abs/1406.6557). |
| `central_carbon_assimilation` | `ackA/pta`, `pfkA/pykF`, `gdhA/gltB` | Same metabolic-network rationale as above; selected to cover assimilation and central flux coupling. |
| `glucose_routing_ppp_ed` | `pgi/zwf`, `pgi/edd`, `zwf/edd`, `edd/eda` | Parallel carbon routing through glycolysis, pentose phosphate, and Entner-Doudoroff-style alternatives; motivated by metabolic backup-pathway synthetic lethality references above. |
| `energy_respiration` | `nuoA/ndh`, `cyoA/cydA`, `sdhA/frdA`, `cyoA/appB`, `cydA/appB` | Respiratory and redox pathway alternatives; class selected to test backup electron-transfer and aerobic/anaerobic energy modules. |
| `nucleotide_metabolism` | `nrdA/nrdD`, `nrdB/nrdG` | Redundant aerobic/anaerobic ribonucleotide reductase logic; selected as pathway redundancy coverage. |
| `amino_acid_biosynthesis` | `thrA/metL`, `thrA/lysC`, `metL/lysC`, `ilvB/ilvI` | Isoenzyme and branch-point coverage for amino-acid biosynthesis; selected as metabolic redundancy cases. |
| `stress_global_robustness` | `sodA/sodB`, `katE/katG`, `rpoS/crp`, `fis/ihfA`, `hupA/hupB` | Stress buffering, global regulation, and DNA-architecture coupling; oxidative-stress modules are motivated by [oxidation response](https://en.wikipedia.org/wiki/Oxidation_response) and catalase/peroxidase biology. |
| `oxidative_stress_detox` | `ahpC/katG`, `ahpC/katE`, `ahpF/katG` | Hydrogen-peroxide detoxification alternatives; motivated by [oxidation response](https://en.wikipedia.org/wiki/Oxidation_response) and [catalase-peroxidase](https://en.wikipedia.org/wiki/Catalase-peroxidase). |
| `redox_buffering` | `trxA/grxA`, `trxB/gor` | Thioredoxin, glutaredoxin, and glutathione redox buffering; motivated by [thioredoxin reductase](https://en.wikipedia.org/wiki/Thioredoxin_reductase) and [glutaredoxin](https://en.wikipedia.org/wiki/Glutaredoxin). |
| `envelope_biogenesis` | `surA/skp`, `surA/degP`, `skp/degP`, `bamB/surA`, `bamB/skp`, `lpxA/lpxC`, `mrcA/mrcB`, `mrdA/mrcB` | Envelope and membrane robustness; metabolic synthetic-lethality work highlights cell-envelope and lipid/membrane backup structure: [Guell et al.](https://arxiv.org/abs/1309.5209). |
| `transport_efflux` | `tolC/acrA` | Efflux complex coverage; selected as a transport robustness pair. |
| `dna_repair` | `recA/recB`, `recA/uvrA`, `uvrA/uvrB`, `uvrB/uvrC`, `mutS/mutL`, `ruvA/recG`, `ruvC/recG`, `recA/ruvA`, `recA/recN`, `xthA/nfo`, `mutM/mutY`, `nth/nei`, `priA/rep`, `dnaQ/mutS` | Homologous recombination, nucleotide excision repair, mismatch repair, base-excision repair, and replication-repair backup. References: [RecBCD](https://en.wikipedia.org/wiki/RecBCD), [RecA](https://en.wikipedia.org/wiki/RecA), [RecA and RecB live-cell repair study](https://arxiv.org/abs/2110.01573). |
| `regulatory_coupling` | `crp/cyaA`, `crp/malT`, `crp/araC`, `crp/lacI`, `fis/crp`, `arcA/fnr`, `crp/cra`, `fur/oxyR`, `soxR/soxS`, `marA/rob` | Coupled global and pathway-specific regulators; class reflects the genetic-interaction principle that paired perturbations expose buffering and control relationships. General E. coli interaction-screen context: [synthetic genetic array](https://en.wikipedia.org/wiki/Synthetic_genetic_array). |
| `protein_folding_disulfide` | `dsbA/dsbC`, `dsbC/dsbG` | Periplasmic disulfide formation/isomerization coverage; selected as a protein-folding robustness module. |
| `lipid_metabolism` | `fabA/fabB`, `fabB/fabF`, `fabA/fabF` | Fatty-acid and membrane-lipid synthesis coverage; references: [fatty acid synthesis](https://en.wikipedia.org/wiki/Fatty_acid_synthesis), [Guell et al.](https://arxiv.org/abs/1309.5209). |
| `cell_division_envelope` | `ftsA/zipA`, `ftsZ/zipA` | Divisome and envelope-cytokinesis coverage; references: [divisome](https://en.wikipedia.org/wiki/Divisome), [FtsA](https://en.wikipedia.org/wiki/FtsA), [FtsZ](https://en.wikipedia.org/wiki/FtsZ). |

### T5 General Background References

- The KO feasibility assumption follows the E. coli deletion-library tradition, especially the Keio collection: [Keio Collection](https://en.wikipedia.org/wiki/Keio_Collection).
- The pairwise-interaction design follows bacterial synthetic-genetic-interaction screening concepts: [synthetic genetic array](https://en.wikipedia.org/wiki/Synthetic_genetic_array).
- The metabolic pair classes are additionally motivated by E. coli synthetic-lethality and metabolic-network analyses: [Ghim et al.](https://arxiv.org/abs/q-bio/0411006), [Guell et al.](https://arxiv.org/abs/1309.5209), [Fast-SL](https://arxiv.org/abs/1406.6557).

## T6 Genome Design

T6 is not implemented.

Expected cell calculation:

- Current implemented cells: `0`
- Current default jobs: `0`
- Current default trajectories: `0`
- Future candidate formula: `valid genome-design indices x selected static conditions`

What it should cover later:

- `new_gene_internal_shift`
- `rrna_location`
- `rrna_orientation`
- `rrna_operon_knockout`
- A small static-condition core such as `basal` and `with_aa`

What needs to be decided before implementation:

- Which genome-design indices are biologically and runtime-valid.
- Whether rRNA perturbations should include control index `0`.
- Whether T6 should stay WT-only or include a bounded KO cross.
- What QC rules should mark malformed, no-division, partial-lineage, or censored genome-design runs.

## Implemented Reliability Fixes

- Dry-run validation checks variants, conditions, direct variant indices, timeline events, and JSON-serializable `sim_params`.
- Real submission writes a JSONL campaign ledger keyed by campaign id, cell payload, seed values, and generations.
- Worker job claiming uses an atomic pending-to-claimed update before execution.
- Seeds are submitted as explicit `seed_values`.
- Export paths include variant type, variant index, experiment id, job id, seed, and generation to avoid HDF5 path collisions.
- Export writes `export_qc.jsonl` and QC counts in `manifest.json`.

## Open Campaign Issues

- T4 covers runtime-indexable TFs only; TFs absent from `tf_condition.tsv` remain uncovered.
- T4 is not crossed with KOs, T3 dynamic media, or all static conditions.
- T5 is curated, not exhaustive.
- T5 is pairwise only; triples and higher-order KOs are not emitted.
- T5 is not crossed with T3 dynamic media, T4 regulatory variants, or all 21 static conditions.
- T6 is not implemented.
- Future campaign editions could add KO x regulatory, KO x dynamic media, multi-KO x stress media, regulatory x dynamic media, and genome-design x media screens.
- Local SQLite plus polling workers remain suitable for moderate local runs; corpus-scale execution still needs a stronger queue/database/object-store layer.
