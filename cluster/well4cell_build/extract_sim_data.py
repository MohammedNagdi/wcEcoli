"""Freeze the parts of the campaign's sim_data that the index needs, as plain JSON.

The variants resolve their index against sim_data at run time (gene_knockout.py:33-36 and
multi_gene_knockout.py:49 index ``transcription.rna_data``; tf_activity.py:33 indexes the
sorted ``tf_to_active_inactive_conditions``; the aa-shift variants index
``molecule_groups.amino_acids``). The index stage runs under wcecoli-api, which cannot
unpickle sim_data, so this one-off script (run under wcecoli-sim, ~1 min) writes
``data/sim_data_tables.json`` next to it, keyed by the parca cache it was read from::

    PYTHONPATH=$PWD $WCECOLI_SIM_PYTHON cluster/well4cell_build/extract_sim_data.py \\
        $WCECOLI_CAMPAIGN_ROOT/out/parca_cache_<hash> [more caches...]

With several caches the TU, amino-acid and TF tables must be identical (else it exits
non-zero; later caches may add conditions); the JSON lists
every cache it was checked against under ``parca_caches``.
"""

from __future__ import annotations

import json
import pickle
import sys
from pathlib import Path


def extract(parca_dir: Path) -> dict:
    with (parca_dir / "kb" / "simData.cPickle").open("rb") as stream:
        sim_data = pickle.load(stream)
    transcription = sim_data.process.transcription
    rna_ids = [str(x) for x in transcription.rna_data["id"]]
    cistron_gene_ids = [str(x) for x in transcription.cistron_data["gene_id"]]
    mapping = transcription.cistron_tu_mapping_matrix.tocsc()  # [cistron, TU]
    tu_genes = []
    for column in range(mapping.shape[1]):
        rows = mapping.indices[mapping.indptr[column]:mapping.indptr[column + 1]]
        tu_genes.append([cistron_gene_ids[r] for r in sorted(rows)])
    tfs = sorted(sim_data.tf_to_active_inactive_conditions)
    return {
        "rna_ids": rna_ids,
        "tu_gene_ids": tu_genes,
        "amino_acids": [str(a) for a in sim_data.molecule_groups.amino_acids],
        "tf_list": tfs,
        "tf_nutrients": {tf: {"active": sim_data.tf_to_active_inactive_conditions[tf]["active nutrients"],
                              "inactive": sim_data.tf_to_active_inactive_conditions[tf]["inactive nutrients"]}
                         for tf in tfs},
        "condition_nutrients": {c: sim_data.conditions[c]["nutrients"] for c in sim_data.ordered_conditions},
    }


def main() -> None:
    caches = [Path(arg) for arg in sys.argv[1:]]
    payload = extract(caches[0])
    for other in caches[1:]:
        tables = extract(other)
        for key in ("rna_ids", "tu_gene_ids", "amino_acids", "tf_list", "tf_nutrients"):
            if tables[key] != payload[key]:
                raise SystemExit("sim_data {} differs between {} and {}".format(key, caches[0], other))
        # Later caches may add conditions; a condition's nutrients must never change.
        for name, nutrients in tables["condition_nutrients"].items():
            if payload["condition_nutrients"].setdefault(name, nutrients) != nutrients:
                raise SystemExit("condition {} has different nutrients in {}".format(name, other))
    payload["parca_caches"] = [c.name.replace("parca_cache_", "") for c in caches]
    out = Path(__file__).resolve().parent / "data" / "sim_data_tables.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, indent=1, sort_keys=True) + "\n")
    print("wrote {} ({} TUs, {} TFs)".format(out, len(payload["rna_ids"]), len(payload["tf_list"])))


if __name__ == "__main__":
    main()
