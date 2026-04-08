# Time-Varying Input Experiments

This document describes how to run whole-cell *E. coli* simulations in which the growth
medium is a continuously varying mixture of two named media, with the mixing ratio
following a sinusoidal waveform over time.

---

## Overview

At every simulation timestep the environment is updated with a linearly interpolated
mixture of two base media. The fraction of the second medium (`media_b`) follows:

```
p(t) = ( sin(2π / T · t) + 1 ) / 2
```

and the fraction of the first medium (`media_a`) is the complement:

```
r(t) = 1 − p(t)
```

where `t` is the simulation time in seconds and `T` is the period in seconds.

The concentration of each molecule in the environment at time `t` is:

```
c(t) = r(t) · c_a  +  p(t) · c_b
```

where `c_a` and `c_b` are the concentrations in `media_a` and `media_b` respectively.
Molecules listed as unlimited (concentration = ∞) in either medium remain unlimited in
the mixture.

For the default media pair (`minimal` and `minimal_GLC_2mM`), all molecule concentrations
are identical in the two media except glucose (GLC). The sinusoidal input therefore reduces
to a single varying quantity:

```
GLC(t) = r(t) · 11.101 mM  +  p(t) · 2.0 mM
```

oscillating between 2.0 mM and 11.101 mM with period T.

---

## Prerequisites

### 1. Docker image

Build the image once from the repository root:

```bash
docker/local/run.sh build
```

### 2. Parameter calculator (ParCa)

The simulation reads pre-computed parameters from `out/<sim_dir>/kb/simData.cPickle`.
Run ParCa if you have not done so already:

```bash
docker/local/run.sh parca <sim_dir>
# Example:
docker/local/run.sh parca sim_glc_exp
```

### 3. Cython extensions (live-edit mode only)

If you are using `WCECOLI_BIND_SOURCE=1` to reflect local code edits without rebuilding
the image, compile the Cython extensions inside the container once after each checkout:

```bash
WCECOLI_BIND_SOURCE=1 docker/local/run.sh run make compile
```

This step is not needed when running with the baked image (default mode).

---

## Quick Start

**Step 1.** Create an experiment configuration file (see [YAML Config Reference](#yaml-config-reference)):

```yaml
# experiment_sine_T2min.yaml
sim_dir: sim_glc_exp
media_a: minimal
media_b: minimal_GLC_2mM
period_min: 2
generations: 4
seed: 0
```

**Step 2.** Run the experiment:

```bash
WCECOLI_BIND_SOURCE=1 docker/local/run.sh py \
    runscripts/manual/runExperiment.py \
    experiment_sine_T2min.yaml
```

The script validates the config, runs the simulation, and prints a per-generation
pass/fail table when it finishes:

```
 Gen  Status    Listener data   Daughter files  Path
----------------------------------------------------
   0  PASS      yes             yes             out/sim_glc_exp/sinusoidal_media_000002/.../generation_000000/.../simOut
   1  PASS      yes             yes             out/sim_glc_exp/sinusoidal_media_000002/.../generation_000001/.../simOut
   2  PASS      yes             yes             out/sim_glc_exp/sinusoidal_media_000002/.../generation_000002/.../simOut
   3  PASS      yes             yes             out/sim_glc_exp/sinusoidal_media_000002/.../generation_000003/.../simOut

All 4 generation(s) completed successfully.
```

The process exits with code 0 on success and 1 on any failure, making it safe to use
in pipelines.

---

## YAML Config Reference

The configuration file is a plain YAML mapping. All keys are lowercase.

### Required fields

| Field | Type | Description |
|---|---|---|
| `sim_dir` | string | Directory under `out/` that contains `kb/simData.cPickle` from a prior ParCa run. Absolute paths are also accepted. |
| `media_a` | string | Recipe name of the first medium — carries fraction `r(t) = 1 − p(t)`. Must be a key in `media_recipes.tsv`. |
| `media_b` | string | Recipe name of the second medium — carries fraction `p(t)`. Must be a key in `media_recipes.tsv`. |
| `period_min` | number | Sine period T in **minutes**. Must be > 0. |
| `generations` | integer | Number of consecutive generations to simulate. Must be ≥ 1. |

### Optional fields

| Field | Type | Default | Description |
|---|---|---|---|
| `seed` | integer | `0` | Random seed for the first generation. |

### Example

```yaml
sim_dir: sim_glc_exp
media_a: minimal
media_b: minimal_GLC_2mM
period_min: 2
generations: 4
seed: 0
```

---

## Available Media

Media are identified by their **recipe name** (left column of
`reconstruction/ecoli/flat/condition/media_recipes.tsv`), not by filename.
The table below lists all recipes that are directly relevant to glucose-variation
experiments.

| Recipe name | Base media file | GLC concentration |
|---|---|---|
| `minimal` | `MIX0-57.tsv` | 11.101 mM |
| `minimal_GLC_2mM` | `MIX0-57-GLC-2mM.tsv` | 2.0 mM |
| `minimal_GLC_5mM` | `MIX0-57-GLC-5mM.tsv` | 5.0 mM |
| `minimal_GLC_20mM` | `MIX0-57-GLC-20mM.tsv` | 20.0 mM |
| `minimal_no_glucose` | `MIX0-55.tsv` | 0 mM |

All other recipe names registered in `media_recipes.tsv` are also valid values for
`media_a` and `media_b`. The validator will print the full list if an unrecognised name
is supplied.

---

## Output Structure

Results are written under `out/<sim_dir>/` using the following layout:

```
out/<sim_dir>/
└── sinusoidal_media_<period_min:06d>/    # e.g. sinusoidal_media_000002
    └── <seed:06d>/                        # e.g. 000000
        ├── generation_000000/
        │   └── 000000/
        │       └── simOut/
        │           ├── Environment/       # media concentrations at every timestep
        │           ├── FBAResults/        # flux balance analysis output
        │           ├── Main/              # time, simulation step
        │           ├── Mass/              # dry mass, growth rate, etc.
        │           ├── MonomerCounts/     # protein counts
        │           ├── RNACounts/         # RNA counts
        │           ├── ...                # other listeners
        │           ├── Daughter1_inherited_state.cPickle
        │           └── Daughter2_inherited_state.cPickle
        ├── generation_000001/
        │   └── ...
        └── generation_000003/
            └── ...
```

A generation is considered **complete** when both of the following are present:

- `simOut/Main/` directory (listener data written)
- `simOut/Daughter1_inherited_state.cPickle` (cell division recorded)

These are the two checks performed by `runExperiment.py` after the run.

---

## Reading GLC Over Time

The environment state — including the GLC concentration at every timestep — is recorded
by the `Environment` listener. Use `TableReader` to access it:

```python
import os
from wholecell.io.tablereader import TableReader

# Path to one generation's simOut directory
sim_out_dir = "out/sim_glc_exp/sinusoidal_media_000002/000000/generation_000000/000000/simOut"

main   = TableReader(os.path.join(sim_out_dir, "Main"))
env    = TableReader(os.path.join(sim_out_dir, "Environment"))

time        = main.readColumn("time")                   # seconds
mol_ids     = list(env.readAttribute("objectNames"))    # molecule names
glc_idx     = mol_ids.index("GLC")
glc_conc    = env.readColumn("media_concentrations")[:, glc_idx]  # mM, one value per timestep
```

---

## Troubleshooting

### `Config error: "media_a: ..." is not a known media recipe`

The name supplied for `media_a` or `media_b` is not registered in `media_recipes.tsv`.
The error message lists all valid names. Check spelling and confirm the desired media file
exists in `reconstruction/ecoli/flat/condition/media/`.

### `Config error: simData.cPickle not found`

ParCa has not been run for `sim_dir`, or `sim_dir` points to the wrong directory.
Run ParCa first:

```bash
docker/local/run.sh parca <sim_dir>
```

### `ModuleNotFoundError: No module named 'wholecell.utils.mc_complexation'`

The Cython extensions have not been compiled for the currently bound source tree.
This only occurs in live-edit mode (`WCECOLI_BIND_SOURCE=1`). Fix:

```bash
WCECOLI_BIND_SOURCE=1 docker/local/run.sh run make compile
```

Then re-run the experiment. This step is only needed once per checkout.
