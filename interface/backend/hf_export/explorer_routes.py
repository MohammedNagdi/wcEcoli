"""Allowlisted publication-backed APIs. No app startup, ORM, model or worker imports."""

from contextlib import contextmanager
import json
import math
import sqlite3
from threading import RLock

from fastapi import APIRouter, HTTPException, Query
import h5py


def install(app, get_bundle, get_result):
    router = APIRouter(prefix="/api")
    reference_cache = {}
    lock = RLock()

    @contextmanager
    def database():
        root, _ = get_bundle()
        db = sqlite3.connect((root / "catalog.sqlite").as_uri() + "?mode=ro&immutable=1", uri=True)
        try:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA query_only=ON")
            yield db
        finally:
            db.close()

    def references():
        root, manifest = get_bundle()
        if manifest.references is None:
            raise HTTPException(409, "Explorer reference metadata is unavailable for this release")
        with lock:
            if root not in reference_cache:
                reference_cache.clear()
                reference_cache[root] = json.loads((root / manifest.references.path).read_text())
            return reference_cache[root]

    def table(name):
        with database() as db:
            return [dict(r) for r in db.execute("SELECT * FROM " + name)]

    def published():
        _, m = get_bundle()
        return m, {e.key: e for e in m.experiments}, {s.key: s for s in m.campaign.experiments}

    def experiment_record(exp):
        _, _, specs = published()
        spec = specs[exp.key]
        try:
            recorded = references()["execution_settings"].get(exp.key, {})
        except HTTPException:
            recorded = {}
        params = dict(
            recorded,
            seed_values=[0],
            seeds=1,
            generations=4,
            initial_condition=spec.initial_condition,
        )
        return dict(
            id=exp.experiment_id,
            name=exp.key,
            description=spec.question,
            variant_type=spec.variant,
            variant_index=exp.variant_index,
            condition=exp.initial_condition,
            timeline=", ".join(f"{e['time_sec']:g} {e['media']}" for e in exp.events),
            sim_params=json.dumps(params),
            status="done",
            created_at="",
            updated_at="",
            batch_id="",
            gene_symbol=spec.gene or "",
            job_id=exp.job_id,
            outcome=exp.outcome,
            reason=exp.reason,
            actual_generations=[t.generation for t in exp.trajectories],
            controls=[c.model_dump() for c in spec.controls],
            transcription_unit_id=exp.transcription_unit_id,
            co_targeted_genes=exp.co_targeted_genes,
            source="published_artifact",
            runtime_ready=False,
        )

    def job_record(exp):
        record = experiment_record(exp)
        return dict(
            id=exp.job_id,
            experiment_id=exp.experiment_id,
            status="done",
            variant_type=record["variant_type"],
            variant_index=exp.variant_index,
            condition=exp.initial_condition,
            seed=0,
            generations=4,
            timeline=record["timeline"],
            created_at="",
            started_at="",
            completed_at="",
            error="",
            progress="",
            lineage_terminated=exp.outcome == "terminated",
            termination_reason=exp.reason,
            outcome=exp.outcome,
            actual_generations=record["actual_generations"],
        )

    def metrics(exp, generation):
        root, _, _ = get_result(exp.job_id)
        trajectory = next((t for t in exp.trajectories if t.generation == generation), None)
        if trajectory is None:
            return dict(
                available=False, reason=f"No saved generation {generation}", generation=generation
            )
        with h5py.File(root / exp.shard, "r") as h5:

            def last(name):
                if not trajectory.channels[name].available:
                    return None
                value = float(h5[trajectory.h5_group + "/" + name + "/value"][-1])
                return value if math.isfinite(value) else None

            clocks = (exp.execution_provenance or {}).get("generation_clocks", [])
            clock = next((c for c in clocks if c["generation"] == generation), {})
            start, end = clock.get("actual_initial_sec"), clock.get("actual_final_sec")
            duration = (
                end - start
                if trajectory.outcome == "completed" and start is not None and end is not None
                else None
            )
            return dict(
                available=True,
                generation=generation,
                seed=0,
                independent_seeds=1,
                final_saved_mass_fg=last("cell_mass"),
                final_saved_growth_rate_per_sec=last("growth_rate"),
                division_duration_sec=duration,
                outcome=trajectory.outcome,
                uncertainty=None,
                reason="One seed; sequential generations are not independent replicates",
            )

    @router.get("/capabilities")
    def capabilities():
        root, manifest = get_bundle()
        refs = references() if manifest.references else None
        return dict(
            mode="explorer",
            read_only=True,
            execution=False,
            shared_persistence=False,
            assistant=False,
            training=False,
            browser_drafts=True,
            references_available=refs is not None,
            molecular_views=["mRNA", "protein", "reaction_flux", "exchange_flux"],
            campaign_sha256=manifest.campaign_sha256,
            reference_sha256=next(
                (f.sha256 for f in manifest.files if f.path == "references.json"), None
            ),
            model_sha256=manifest.provenance.prepared_model_sha256,
            source_sha256=manifest.provenance.simulation_source_sha256,
            schema_version="explorer-capabilities-v1",
        )

    @router.get("/genes/categories")
    def categories():
        with database() as db:
            return [
                dict(r)
                for r in db.execute(
                    "SELECT category,count(*) AS count FROM genes GROUP BY category ORDER BY count DESC"
                )
            ]

    @router.get("/genes/search")
    def search_genes(
        q: str = Query(..., min_length=1, max_length=200), limit: int = Query(20, ge=1, le=100)
    ):
        with database() as db:
            return [
                dict(r)
                for r in db.execute(
                    "SELECT * FROM genes WHERE symbol LIKE ? OR synonyms LIKE ? ORDER BY lower(symbol)=lower(?) DESC,symbol LIMIT ?",
                    ("%" + q + "%", "%" + q + "%", q, limit),
                )
            ]

    @router.get("/genes/by-ko-index/{index}")
    def by_index(index: int):
        with database() as db:
            matches = [
                dict(r)
                for r in db.execute(
                    "SELECT * FROM genes WHERE ko_index=? ORDER BY symbol", (index,)
                )
            ]
        if len(matches) != 1:
            raise HTTPException(
                409 if matches else 404,
                "Transcription-unit index is ambiguous or unavailable; select a gene by symbol",
            )
        return matches[0]

    @router.get("/genes")
    def genes(
        q: str = Query("", max_length=200),
        category: str | None = None,
        mechanistic: bool | None = None,
        page: int = Query(1, ge=1),
        page_size: int = Query(50, ge=1, le=5000),
    ):
        clauses, args = ["(symbol LIKE ? OR synonyms LIKE ?)"], ["%" + q + "%", "%" + q + "%"]
        if category:
            clauses.append("category=?")
            args.append(category)
        if mechanistic is not None:
            clauses.append("is_mechanistic=?")
            args.append(int(mechanistic))
        where = " AND ".join(clauses)
        with database() as db:
            count = db.execute("SELECT count(*) FROM genes WHERE " + where, args).fetchone()[0]
            rows = [
                dict(r)
                for r in db.execute(
                    "SELECT * FROM genes WHERE " + where + " ORDER BY symbol LIMIT ? OFFSET ?",
                    [*args, page_size, (page - 1) * page_size],
                )
            ]
        return dict(genes=rows, total=count, page=page, page_size=page_size)

    def edge(row):
        return dict(
            gene=row["target_symbol"],
            tf=row["tf_symbol"],
            target=row["target_symbol"],
            log2fc=row["log2fc_mean"],
            regulation="activation" if row["log2fc_mean"] >= 0 else "repression",
            type="activation" if row["log2fc_mean"] >= 0 else "repression",
            direct=row["regulation_direct"],
            **dict(row),
        )

    @router.get("/genes/{symbol}")
    def gene(symbol: str):
        with database() as db:
            row = db.execute(
                "SELECT * FROM genes WHERE lower(symbol)=lower(?)", (symbol,)
            ).fetchone()
            if row is None:
                raise HTTPException(404, "Gene not present in the published catalog")
            data = dict(row)
            data["regulated_by"] = [
                edge(r)
                for r in db.execute(
                    "SELECT * FROM tf_edges WHERE target_symbol=?", (row["symbol"],)
                )
            ]
            data["regulates"] = [
                edge(r)
                for r in db.execute("SELECT * FROM tf_edges WHERE tf_symbol=?", (row["symbol"],))
            ]
        data["expression_target"] = references()["gene_targets"].get(data["symbol"])
        return data

    @router.get("/tf-network")
    def network():
        groups = {}
        for row in table("tf_edges"):
            groups.setdefault(row["tf_symbol"], []).append(edge(row))
        return dict(
            tfs=[
                dict(symbol=k, tf=k, targets=v, target_count=len(v), n_targets=len(v))
                for k, v in sorted(groups.items())
            ],
            total_tfs=len(groups),
            total_edges=sum(map(len, groups.values())),
        )

    @router.get("/tf-network/{symbol}")
    def subnetwork(symbol: str):
        return next(
            (t for t in network()["tfs"] if t["tf"].lower() == symbol.lower()),
            dict(tf=symbol, targets=[], n_targets=0),
        )

    @router.get("/pathways/amino-acids")
    def pathways():
        return table("aa_pathways")

    @router.get("/conditions")
    def conditions():
        return table("conditions")

    @router.get("/media-recipes")
    def recipes():
        return table("media_recipes")

    @router.get("/timelines")
    def timelines():
        return table("timelines")

    @router.get("/condition-catalog")
    def condition_catalog():
        return references()["condition_catalog"]

    @router.get("/variants")
    def variants():
        return references()["variants"]

    @router.get("/experiments/variants/{name}")
    def variant_detail(name: str):
        result = next((v for v in variants() if v["name"] == name), None)
        if result is None:
            raise HTTPException(404, "Unknown catalog variant")
        return result

    @router.get("/experiments/batches")
    def batches():
        return []  # No published batch groups exist; personal batches stay in browser storage.

    @router.get("/experiments")
    def experiments():
        return [experiment_record(e) for e in get_bundle()[1].experiments]

    @router.get("/jobs/failed")
    def failed_jobs():
        return []

    @router.get("/jobs")
    def jobs(experiment_id: int | None = None):
        return [
            job_record(e)
            for e in get_bundle()[1].experiments
            if experiment_id is None or e.experiment_id == experiment_id
        ]

    @router.get("/user-timelines")
    def user_timelines():
        return []  # Personal timelines are supplied by the browser adapter.

    @router.get("/explorer/comparison")
    def compare(ids: str = Query(..., max_length=100), generation: int = Query(0, ge=0, le=3)):
        try:
            selected = list(dict.fromkeys(int(i) for i in ids.split(",")))
        except ValueError:
            raise HTTPException(422, "Experiment IDs must be integers")
        if not 1 <= len(selected) <= 4:
            raise HTTPException(422, "Select one to four published experiments")
        manifest, by_key, specs = published()
        output = []
        for eid in selected:
            exp = next((e for e in manifest.experiments if e.experiment_id == eid), None)
            if exp is None:
                raise HTTPException(404, "Unpublished experiment")
            item = dict(experiment_record(exp), metrics=metrics(exp, generation), controls=[])
            for link in specs[exp.key].controls:
                target = by_key.get(link.key)
                baseline = (
                    metrics(target, generation)
                    if target
                    else dict(available=False, reason="Unrun control")
                )
                delta = {}
                if (
                    link.role == "matched"
                    and baseline.get("available")
                    and item["metrics"].get("available")
                ):
                    for key in (
                        "final_saved_mass_fg",
                        "final_saved_growth_rate_per_sec",
                        "division_duration_sec",
                    ):
                        a, b = item["metrics"][key], baseline[key]
                        delta[key] = (
                            (a - b) / b * 100
                            if a is not None and b is not None and b != 0
                            else None
                        )
                item["controls"].append(
                    dict(key=link.key, role=link.role, metrics=baseline, percent_change=delta)
                )
            output.append(item)
        return dict(
            generation=generation,
            independent_seeds=1,
            confidence_intervals=None,
            experiments=output,
        )

    @router.get("/explorer/evidence")
    def evidence(symbol: str = Query("", max_length=100)):
        manifest, _, specs = published()
        matches = []
        for exp in manifest.experiments:
            if not specs[exp.key].gene:
                continue
            members = [specs[exp.key].gene, *(exp.co_targeted_genes or [])]
            if not symbol or symbol.lower() in {g.lower() for g in members}:
                matches.append(
                    dict(
                        experiment_record(exp), requested_gene=specs[exp.key].gene, targets=members
                    )
                )
        return dict(
            experiments=matches,
            classification="unclassified",
            scope="Published TU expression perturbations only; not genome-wide essentiality evidence",
        )

    def molecule_context(job_id, symbol, generation=0):
        root, manifest, exp = get_result(job_id)
        detail = gene(symbol)
        enzymes = set(json.loads(detail.get("complex_ids") or "[]"))
        if detail.get("monomer_id"):
            enzymes.add(detail["monomer_id"])
        enzymes |= {name.split("[")[0] for name in enzymes}
        reactions = [r for r in references()["reactions"] if enzymes & set(r["catalysts"])][:12]
        with h5py.File(root / exp.shard, "r") as h5:
            ids = {
                name: h5[f"reference/{name}_ids"].asstr()[:].tolist()
                for name in (
                    "mrna_counts_matrix",
                    "protein_counts_matrix",
                    "reaction_flux_matrix",
                    "exchange_flux_matrix",
                )
                if f"reference/{name}_ids" in h5
            }
        return root, manifest, exp, detail, enzymes, reactions, ids

    @router.get("/jobs/{job_id}/molecules/search")
    def search_molecules(job_id: int, q: str = Query(..., min_length=1, max_length=200)):
        root, _, exp = get_result(job_id)
        from .converter import MATRIX_CHANNELS

        found = {}
        with h5py.File(root / exp.shard, "r") as h5:
            for name, kind in MATRIX_CHANNELS.items():
                path = f"reference/{name}_ids"
                found[kind] = (
                    [s for s in h5[path].asstr()[:] if q.lower() in s.lower()][:50]
                    if path in h5
                    else []
                )
        return dict(query=q, results=found, total_matches=sum(map(len, found.values())))

    @router.get("/jobs/{job_id}/stoichiometry-neighborhood")
    def stoichiometry(job_id: int, gene: str):
        _, _, _, detail, enzymes, reactions, ids = molecule_context(job_id, gene)
        output = []
        for reaction in reactions:
            reactants, products = [], []
            for molecule, coefficient in reaction["stoichiometry"].items():
                value = float(coefficient)
                (reactants if value < 0 else products).append(
                    dict(
                        id=molecule,
                        coefficient=value,
                        role="reactant" if value < 0 else "product",
                        available_types=[],
                    )
                )
            output.append(
                dict(
                    id=reaction["id"],
                    direction=reaction["direction"],
                    catalysts=reaction["catalysts"],
                    reactants=reactants,
                    products=products,
                    reaction_flux_available=reaction["id"] in ids.get("reaction_flux_matrix", []),
                )
            )
        return dict(
            job_id=job_id,
            focus_gene=detail["symbol"],
            enzyme_ids=sorted(enzymes),
            reactions=output,
            note="Frozen reference stoichiometry; metabolite concentration/count channels are not in this release",
        )

    @router.get("/jobs/{job_id}/state-explorer")
    def state_explorer(job_id: int, gene: str, generation: int = Query(0, ge=0, le=3)):
        root, manifest, exp, detail, _, reactions, ids = molecule_context(job_id, gene, generation)
        target = detail.get("expression_target")
        candidates = []
        if target:
            candidates.append(("mrna_counts_matrix", "mRNA", target["rna_id"]))
        monomer = detail.get("monomer_id")
        if monomer:
            available = ids.get("protein_counts_matrix", [])
            actual = next(
                (s for s in available if s.split("[")[0] == monomer.split("[")[0]), monomer
            )
            candidates.append(("protein_counts_matrix", "protein", actual))
        candidates += [("reaction_flux_matrix", "reaction_flux", r["id"]) for r in reactions]
        _, by_key, specs = published()
        control = next(
            (by_key.get(c.key) for c in specs[exp.key].controls if c.role == "matched"), None
        )

        def saved_value(experiment, name, molecule):
            if experiment is None:
                return None
            trajectory = next(
                (t for t in experiment.trajectories if t.generation == generation), None
            )
            if trajectory is None or not trajectory.channels[name].available:
                return None
            with h5py.File(root / experiment.shard, "r") as h5:
                available = h5[f"reference/{name}_ids"].asstr()[:].tolist()
                if molecule not in available:
                    return None
                value = float(
                    h5[trajectory.h5_group + "/" + name + "/value"][-1, available.index(molecule)]
                )
                return value if math.isfinite(value) else None

        variables, nodes, edges = (
            [],
            [
                dict(
                    id=detail["symbol"],
                    label=detail["symbol"],
                    node_type="gene",
                    role="focus",
                    available=True,
                )
            ],
            [],
        )
        for name, kind, molecule in candidates:
            value, baseline = saved_value(exp, name, molecule), saved_value(control, name, molecule)
            delta = value - baseline if value is not None and baseline is not None else None
            variables.append(
                dict(
                    id=molecule,
                    molecule_type=kind,
                    display_type=kind,
                    role="reference_link",
                    gene_symbol=detail["symbol"],
                    gene_name=detail.get("monomer_name"),
                    available=value is not None,
                    final_value=value,
                    wt_final_value=baseline,
                    delta=delta,
                    delta_pct=delta / baseline * 100
                    if delta is not None and baseline != 0
                    else None,
                    rank_score=None,
                )
            )
            nodes.append(
                dict(
                    id=molecule,
                    label=molecule,
                    node_type=kind,
                    role="reference_link",
                    available=value is not None,
                )
            )
            edges.append(
                dict(
                    source=detail["symbol"],
                    target=molecule,
                    edge_type="catalog_link",
                    label="Reference relationship",
                    log2fc=None,
                    regulation="",
                )
            )
        return dict(
            job_id=job_id,
            wt_job_id=control.job_id if control else None,
            focus_gene=detail["symbol"],
            generation=generation,
            variables=variables,
            nodes=nodes,
            edges=edges,
            unavailable_count=sum(not v["available"] for v in variables),
        )

    app.include_router(router)
    return experiment_record, job_record
