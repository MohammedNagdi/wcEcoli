"""Extract authoritative TU membership inside the simulation environment only."""

import argparse
import csv
import hashlib
import json
import pickle
from pathlib import Path
import re


def extract(model, genes):
    with model.open("rb") as stream:
        sim_data = pickle.load(stream)
    with genes.open() as stream:
        rows = csv.DictReader(
            (line for line in stream if not line.startswith("#")), delimiter="\t"
        )
        symbols = {r["id"]: re.sub("<[^>]+>", "", r["symbol"]) for r in rows}
    transcription = sim_data.process.transcription
    mapping = transcription.cistron_tu_mapping_matrix
    targets = {}
    for index, rna_id in enumerate(transcription.rna_data["id"]):
        members = sorted(
            symbols.get(
                str(transcription.cistron_data["id"][ci]).replace("_RNA", ""),
                str(transcription.cistron_data["id"][ci]).replace("_RNA", ""),
            )
            for ci in mapping.getcol(index).nonzero()[0]
        )
        if len(set(members)) != len(members):
            raise ValueError("ambiguous duplicate cistron symbol in TU " + str(rna_id))
        for gene in members:
            candidate = dict(index=index + 1, rna_id=str(rna_id), genes=members)
            # Same deterministic minimum-size policy as the existing map extractor.
            if gene not in targets or len(members) < len(targets[gene]["genes"]):
                targets[gene] = candidate
    for gene in ["hisG", "trpA", "pgi"]:
        if gene not in targets:
            raise ValueError("missing campaign gene " + gene)
        target = targets[gene]
        index = target["index"] - 1
        actual = [
            symbols.get(
                str(transcription.cistron_data["id"][ci]).replace("_RNA", ""), ""
            )
            for ci in mapping.getcol(index).nonzero()[0]
        ]
        if (
            gene not in actual
            or str(transcription.rna_data["id"][index]) != target["rna_id"]
        ):
            raise ValueError("inconsistent target " + gene)
    return dict(
        model_sha256=hashlib.sha256(model.read_bytes()).hexdigest(),
        provenance="prepared transcription.rna_data and cistron_tu_mapping_matrix",
        selection="smallest TU membership, then first actual RNA order",
        targets=targets,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("model", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    result = extract(args.model, Path("reconstruction/ecoli/flat/genes.tsv"))
    args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
