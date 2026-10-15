# well4cell: what to do on klone

Follow-ups from the 2026-10-15 cross-check against the Cellarium corpus. The Hub repo
`cSynBioSys/well4cell` was patched directly from a laptop (caches removed, `kb_sha256` added,
`summary` config, card edits including the translation-collapse paragraph). The build
directory on klone is now behind the Hub and the code. Do these in order.

## 1. Clean up the Parca caches

- Delete `$W4C_ROOT/repo/provenance/parca_cache_*`. `hub upload` skips them now, but they
  should not sit in the repo directory.
- Delete the retired bucket mirror from `cluster/hfx` by hand. It also holds both caches.
- Do not delete `out/parca_cache_*`. Those are the campaign's own copies and stay.

## 2. Rebuild the index

`finalize` now refuses an index without `kb_sha256`, so the local index is stale.

To do first (not implemented yet): add a `translation_collapse` column to `index.py`
(boolean, mean `ribosome_elongation_rate` below 1 aa/s over the generation, next to
`termination_class`), so it lands in this rebuild. Until then the card states the same
predicate as `ribosome_elongation_rate_mean < 1` in `summary`, with counts from finalize.

```
cluster/w4c index build
```

## 3. Summary, finalize, upload

`summarize` checks its rows against the index's core locators, which only `finalize` fills,
and the card and manifest pick the summary up only on the next `finalize`:

```
cluster/w4c finalize
cluster/w4c summarize
cluster/w4c finalize
cluster/w4c hub upload --include summary,manifest
cluster/w4c hub upload --include readme
```

Check that rows per family equal index rows with a non-null `core_file`. If the index
changed in step 2, also upload `index` (before `readme`).

Memory: `summarize` streams each core part a row group at a time (`pre_buffer=False`, fixed
2026-10-15; before that pyarrow's read-ahead grew toward the part size). Measured on a 1.0 GB
synthetic core part: 0.66 GB peak RSS, against 1.67 GB with the old read-ahead. Add the index
and one family's summary rows and the whole stage needs about 1 GB, so memory alone would fit
the login node, but it reads all ~19 GB of core (and, with `--pathways` in step 6, every
expression part as well), which is minutes to hours of I/O. Run it as a batch job rather
than on the login node, from the repo root:

```
sbatch --account=cpu-g2-amath --partition=cpu-g2 --cpus-per-task=1 --mem=8G --time=04:00:00 \
    --output=summarize-%j.out --wrap "cluster/w4c summarize"
```

8G leaves room for the pathway pass; 4G is probably enough for the core-only run. Wait for
the job to finish before the second `finalize`.

## 4. Finish the matrix exports

`expression` and `metabolism` are on the Hub for `wildtype_media` only. Export the other
four families, finalize, and upload. Confirm the storage plan before the 1 s configs.

## 5. Degradation-rate provenance, before the last finalize

New code, `cluster/well4cell_build/deg_rates.py` (`cluster/w4c deg-rates`). For each Parca
cache it unpickles `kb/simData.cPickle` and `kb/rawData.cPickle` under the simulation
environment and classifies every mRNA transcription unit's degradation rate as floor (the
NNLS lower bound), ceiling (clipped at the fastest measured rate), imputed (no cistron
measured, so the mean measured half-life) or determined, weighted by basal expression. It
writes `build/provenance/deg_rates_<parca_cache>.json` with the keys of Cellarium's
`deg_rate_baseline.json`; the next `finalize` copies the files to `repo/provenance/` and adds
a Degradation rates paragraph to the card's Provenance section. It needs only the index (step
2), so run it any time before the finalize in step 6, once per cache, for both
`out/parca_cache_*`:

```
source cluster/well4cell_env.sh
ls -d $WCECOLI_CAMPAIGN_ROOT/out/parca_cache_*      # the two caches
cluster/w4c deg-rates                                # one JSON per cache the index names
ls $W4C_ROOT/build/provenance/                      # expect two deg_rates_<hash>.json
```

If the index names only one of the two caches, run `cluster/w4c deg-rates --cache <hash>` for
the other (finalize only publishes a cache the index names). Each run is two unpickles, about
a minute and a few GB; if the login node kills it, use
`srun --account=cpu-g2-amath --partition=cpu-g2 --mem=8G --time=00:30:00 cluster/w4c deg-rates`.

**Untested against a real cache.** The classification is unit-tested on synthetic arrays; the
loader (attribute names from this repo's `transcription.py`) has never read a cache. Check
the first output before going further:

```
for f in $W4C_ROOT/build/provenance/deg_rates_*.json; do
  python3 -c 'import json, sys
d = json.load(open(sys.argv[1]))
n = {k: d[k]["n_units"] for k in ("on_floor", "on_ceiling", "imputed_average", "not_a_fit", "determined")}
print(sys.argv[1], d["n_mrna_units"], n, d["not_a_fit"]["pct_expression"], "%")
print("  cellarium rule:", d["cellarium_rule"], "warnings:", d.get("warnings"))' "$f"
done
```

- Counts in the same ballpark as Cellarium's 854 of 3,133 units (floor 245, ceiling 7,
  imputed 602) and about 12% of basal mRNA expression. Our caches are a different fit, so
  not identical, but a factor of two off means something is wrong.
- Every unit classified exactly once: floor + ceiling + imputed + determined equals
  `n_mrna_units` (the script refuses otherwise, so a written file passes this).
- `cellarium_rule` (Cellarium's value-only rule, computed alongside) close to the main counts.
- No `warnings` (one means the imputation constant is not the mean of the measured
  half-lives read from `rawData`).

**Licence, before uploading.** These files are derived from the fitted parameters, and ADR
0009 rejected shipping a derived summary of the parameters. Decide whether they may be
published (DESIGN.md section 9). Until then, do not upload `provenance` or `readme` after a
finalize that saw them. To publish without them, delete `build/provenance/deg_rates_*` and
`repo/provenance/deg_rates_*` and finalize again. If they are cleared for publication, step
6's finalize picks them up; add `provenance` to its first upload:
`cluster/w4c hub upload --include summary,provenance,manifest`.

## 6. Pathway fractions, after steps 4 and 5

The code is done (`summarize --pathways`, tested on `wildtype_media`): 13 `pathway_<name>`
columns appended to the summary parts, Cellarium's proteome-fraction definition and gene
lists. It refuses while any family lacks expression parts. Once all five are exported:

```
cluster/w4c summarize --pathways
cluster/w4c finalize
cluster/w4c hub upload --include summary,manifest
cluster/w4c hub upload --include readme
```

Keep `--pathways` on every later `summarize`; a run without it drops the columns.

## 7. After upload

Uploads never delete remotely. Check the Hub viewer has reprocessed the repo and that no
`.cPickle` appears in the file list.
