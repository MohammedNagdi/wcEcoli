"""Read-only variant metadata shared with offline explorer reference packaging.

No application startup, execution or persistence is imported here.
"""

import csv
from sqlmodel import Session, select
from app.config import settings
from app.db.models import Condition, TFEdge, Variant

PPGPP_FACTORS = [0.2, 0.4, 0.6, 0.8, 1, 1.2, 1.4, 1.6, 1.8, 2]
PPGPP_CONDITION_NAMES = ["basal", "with_aa"]
NEW_GENE_CONDITION_STRIDE = 1000
NEW_GENE_VALID_REMAINDER_RANGE = [0, 20]
NEW_GENE_EXPRESSION_FACTORS = [0, 7, 8, 9, 10]
NEW_GENE_TRANSLATION_EFFICIENCY_VALUES = [10, 5, 1, 0.1, 0]


def _list_conditions_in_variant_order(session: Session) -> list[Condition]:
    """Return conditions in the same order used by the runtime variant indices."""
    return session.exec(select(Condition).order_by(Condition.id)).all()


def _build_condition_index_options(session: Session) -> list[str]:
    options: list[str] = []
    for index, condition in enumerate(_list_conditions_in_variant_order(session)):
        if condition.nutrients:
            options.append(f"{index}: {condition.name} ({condition.nutrients})")
        else:
            options.append(f"{index}: {condition.name}")
    return options


def _load_tf_activity_names(session: Session) -> list[str]:
    """Load TF names in the same order filtered by the runtime reconstruction inputs."""
    known_tfs = {tf_symbol for tf_symbol in session.exec(select(TFEdge.tf_symbol)).all()}
    if not known_tfs:
        return []

    if not settings.tf_condition_tsv.exists():
        return sorted(known_tfs)

    tf_names: set[str] = set()
    with open(settings.tf_condition_tsv, encoding="utf-8") as handle:
        reader = csv.reader(handle, delimiter="\t")
        for row in reader:
            if not row:
                continue
            first_cell = row[0].strip()
            if not first_cell or first_cell.startswith("#"):
                continue
            tf_name = first_cell.strip('"')
            if tf_name == "TF":
                continue
            if tf_name in known_tfs:
                tf_names.add(tf_name)

    return sorted(tf_names)


def _load_tf_activity_specs(session: Session) -> dict[str, dict]:
    """Load user-readable TF active/inactive definitions from tf_condition.tsv."""
    known_tfs = {tf_symbol for tf_symbol in session.exec(select(TFEdge.tf_symbol)).all()}
    if not known_tfs or not settings.tf_condition_tsv.exists():
        return {}

    specs: dict[str, dict] = {}
    with open(settings.tf_condition_tsv, encoding="utf-8") as handle:
        rows = [
            row
            for row in csv.reader(handle, delimiter="\t")
            if row and not row[0].strip().startswith("#")
        ]

    if not rows:
        return specs

    header = [cell.strip().strip('"') for cell in rows[0]]
    for row_values in rows[1:]:
        row = {
            header[index]: row_values[index] for index in range(min(len(header), len(row_values)))
        }
        tf_name = (row.get("TF") or "").strip().strip('"')
        if not tf_name or tf_name not in known_tfs:
            continue
        specs[tf_name] = {
            "active_molecule": (row.get("active TF") or "").strip().strip('"'),
            "active_nutrients": (row.get("active nutrients") or "").strip().strip('"'),
            "active_perturbations": (row.get("active genotype perturbations") or "").strip(),
            "inactive_nutrients": (row.get("inactive nutrients") or "").strip().strip('"'),
            "inactive_perturbations": (row.get("inactive genotype perturbations") or "").strip(),
            "tf_type": (row.get("TF type") or "").strip().strip('"'),
        }

    return specs


def _build_tf_activity_index_options(session: Session) -> tuple[list[str], list[str]]:
    tf_names = _load_tf_activity_names(session)
    options = ["0: control"]
    for offset, tf_name in enumerate(tf_names):
        options.append(f"{2 * offset + 1}: {tf_name} active")
        options.append(f"{2 * offset + 2}: {tf_name} inactive")
    return tf_names, options


def _decode_new_gene_remainder(remainder: int) -> tuple[str, str]:
    translation_index = remainder % len(NEW_GENE_TRANSLATION_EFFICIENCY_VALUES)
    if translation_index == 0:
        expression_index = remainder // len(NEW_GENE_TRANSLATION_EFFICIENCY_VALUES)
    else:
        expression_index = remainder // len(NEW_GENE_TRANSLATION_EFFICIENCY_VALUES) + 1

    expression_factor = 10 ** (NEW_GENE_EXPRESSION_FACTORS[expression_index] - 1)
    translation_efficiency = NEW_GENE_TRANSLATION_EFFICIENCY_VALUES[translation_index]
    return (
        f"expression {expression_factor:g}x",
        f"translation efficiency {translation_efficiency:g}",
    )


def _build_new_gene_index_options(session: Session) -> tuple[list[str], list[str]]:
    conditions = _list_conditions_in_variant_order(session)
    condition_names = [condition.name for condition in conditions]
    options = ["0: control (new gene expression knocked out)"]

    for condition_index, condition_name in enumerate(condition_names):
        base_index = condition_index * NEW_GENE_CONDITION_STRIDE
        if base_index > 0:
            options.append(
                f"{base_index}: {condition_name}, control remainder (no induced new-gene expression)"
            )

        for remainder in range(1, NEW_GENE_VALID_REMAINDER_RANGE[1] + 1):
            expression_label, translation_label = _decode_new_gene_remainder(remainder)
            options.append(
                f"{base_index + remainder}: {condition_name}, {expression_label}, {translation_label}"
            )

    return condition_names, options


def _extract_index_options_from_docstring(docstring: str) -> list[str]:
    """Extract documented expected variant index lines from a variant docstring."""
    lines = docstring.splitlines()
    start = None

    for index, line in enumerate(lines):
        if line.strip().startswith("Expected variant indices"):
            start = index + 1
            break

    if start is None:
        return []

    options: list[str] = []
    for line in lines[start:]:
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("TODO:"):
            break
        options.append(stripped)

    return options


VARIANT_PARAM_HINTS: dict[str, dict] = {
    "gene_knockout": {
        "index_meaning": "Gene index (0 = control, 1-4749 = individual gene KO)",
        "index_range": [0, 4749],
        "supports_gene_lookup": True,
        "timeline_behavior": "composer",
        "index_options": [
            "0: control",
            "1-4749: individual gene knockout index; use gene search to map symbols to indices",
        ],
    },
    "multi_gene_knockout": {
        "index_meaning": "Always 0; selected genes are stored as validated KO indexes in sim_params",
        "index_range": [0, 0],
        "hide_index": True,
        "timeline_behavior": "composer",
        "index_options": [
            "0: multi-gene knockout target set supplied by experiment metadata",
        ],
    },
    "condition": {
        "index_meaning": "Condition index (maps to condition_defs.tsv row)",
        "index_range": [0, 20],
        "supports_gene_lookup": False,
        "timeline_behavior": "internal_override",
        "environment_lock": "fixed",
        "timeline_notice": "This variant presets its timeline internally from the selected condition. Media selection is locked because the selected condition controls the model environment.",
    },
    "timelines": {
        "index_meaning": "Ignored for this experiment type. Use the Timeline Composer to define the effective timeline.",
        "index_range": [0, 0],
        "supports_gene_lookup": False,
        "hide_index": True,
        "timeline_behavior": "composer",
        "timeline_notice": "This experiment type uses the composed timeline directly. Preset timeline selection by parameter index is disabled.",
        "index_options": [
            "This experiment type no longer uses parameter index selection in the UI.",
            "Use the Timeline Composer to define the effective timeline.",
        ],
    },
    "wildtype": {
        "index_meaning": "Always 0 (no modifications)",
        "index_range": [0, 0],
        "supports_gene_lookup": False,
        "timeline_behavior": "composer",
        "index_options": [
            "0: control run with no variant changes",
        ],
    },
    "ppgpp_conc": {
        "index_meaning": "ppGpp concentration index",
        "index_range": [0, 19],
        "supports_gene_lookup": False,
        "timeline_behavior": "internal_override",
        "environment_lock": "fixed",
        "timeline_notice": "This variant selects its runtime condition block internally, then clamps ppGpp concentration. Media selection is locked; choose the condition block above instead.",
    },
    "add_one_aa": {
        "index_meaning": "Amino acid index (0-20, maps to standard AAs)",
        "index_range": [0, 20],
        "supports_gene_lookup": False,
        "timeline_behavior": "internal_override",
        "environment_lock": "fixed",
        "fixed_condition": "basal",
        "fixed_timeline": "0 minimal",
        "timeline_notice": "This variant adds the selected amino acid to the model's minimal medium definition. Media selection is locked so the amino-acid addition is not accidentally bypassed by another medium.",
    },
    "remove_one_aa": {
        "index_meaning": "Amino acid index to remove",
        "index_range": [0, 20],
        "supports_gene_lookup": False,
        "timeline_behavior": "internal_override",
        "environment_lock": "fixed",
        "fixed_condition": "with_aa",
        "fixed_timeline": "0 minimal_plus_amino_acids",
        "timeline_notice": "This variant always runs in minimal_plus_amino_acids and removes the selected amino acid from that internally managed environment.",
    },
    "add_one_aa_shift": {
        "index_meaning": "Amino acid index to add after the internal shift",
        "index_range": [0, 20],
        "supports_gene_lookup": False,
        "timeline_behavior": "internal_override",
        "environment_lock": "fixed",
        "fixed_condition": "basal",
        "fixed_timeline": "0 minimal, 600 minimal_plus_SELECTED_AA",
        "timeline_notice": "This variant defines its own 10-minute shift internally. Media selection is locked so the run uses the variant-managed shift timeline.",
    },
    "remove_one_aa_shift": {
        "index_meaning": "Amino acid index to remove after the internal shift",
        "index_range": [0, 20],
        "supports_gene_lookup": False,
        "timeline_behavior": "internal_override",
        "environment_lock": "fixed",
        "fixed_condition": "with_aa",
        "fixed_timeline": "0 minimal_plus_amino_acids, 600 minimal_plus_amino_acids_without_SELECTED_AA",
        "timeline_notice": "This variant defines its own 10-minute shift internally. Media selection is locked so the run uses the variant-managed shift timeline.",
    },
    "remove_aas_shift": {
        "index_meaning": "Index selects the amino-acid removal branch",
        "index_range": [0, 23],
        "supports_gene_lookup": False,
        "timeline_behavior": "internal_override",
        "environment_lock": "fixed",
        "fixed_condition": "with_aa",
        "fixed_timeline": "0 minimal_plus_amino_acids, 600 selected_amino_acid_media",
        "timeline_notice": "This variant selects a predefined amino-acid media branch. Media selection is locked; choose the branch above instead.",
    },
    "tf_activity": {
        "index_meaning": "Index selects the TF activity state",
        "min_valid_index": 0,
        "supports_gene_lookup": False,
        "timeline_behavior": "internal_conditional_override",
        "environment_lock": "tf_state",
        "timeline_notice": "Non-control TF activity runs set their own nutrient timeline internally. The composer may still matter for the control branch.",
    },
    "sinusoidal_media": {
        "index_meaning": "Period in minutes for the sinusoidal media oscillation",
        "min_valid_index": 1,
        "supports_gene_lookup": False,
        "timeline_behavior": "internal_override",
        "environment_lock": "fixed",
        "fixed_condition": "glc_2mM",
        "fixed_timeline": "sinusoidal minimal <-> minimal_GLC_2mM",
        "timeline_notice": "This variant initializes and updates its environment internally using sinusoidal mixing. Media selection is locked because the runtime uses the variant-managed sinusoidal media definition.",
        "index_options": [
            "1+: oscillation period in minutes",
            "0: invalid because a zero-period sinusoid is not supported",
        ],
    },
    "new_gene_internal_shift": {
        "index_meaning": "Combined condition/expression index",
        "min_valid_index": 0,
        "condition_stride": NEW_GENE_CONDITION_STRIDE,
        "valid_remainder_range": NEW_GENE_VALID_REMAINDER_RANGE,
        "supports_gene_lookup": False,
        "timeline_behavior": "internal_override",
        "timeline_notice": "This variant derives its starting timeline from the selected condition index and then applies internal gene-expression shifts by generation.",
    },
    "rrna_operon_knockout": {
        "index_meaning": "Paper-specific rRNA operon knockout branch",
        "index_range": [0, 18],
        "supports_gene_lookup": False,
        "timeline_behavior": "internal_conditional_override",
        "environment_lock": "conditional",
        "timeline_notice": "Non-control branches encode their own minimal, rich, or minimal-to-rich environment. Media selection is locked for those branches.",
        "index_options": [
            "0: control",
            "1-6: knock out one to six rRNA operons in minimal media",
            "7-12: knock out one to six rRNA operons in rich amino-acid media",
            "13-18: knock out one to six rRNA operons in a minimal-to-rich shift",
        ],
    },
    "rrna_location": {
        "index_meaning": "Paper-specific rRNA location branch",
        "index_range": [0, 3],
        "supports_gene_lookup": False,
        "timeline_behavior": "internal_conditional_override",
        "environment_lock": "conditional",
        "timeline_notice": "Non-control branches encode their own minimal, rich, or minimal-to-rich environment. Media selection is locked for those branches.",
        "index_options": [
            "0: control",
            "1: relocate rRNA genes in minimal media",
            "2: relocate rRNA genes in rich amino-acid media",
            "3: relocate rRNA genes in a minimal-to-rich shift",
        ],
    },
    "rrna_orientation": {
        "index_meaning": "Paper-specific rRNA orientation branch",
        "index_range": [0, 3],
        "supports_gene_lookup": False,
        "timeline_behavior": "internal_conditional_override",
        "environment_lock": "conditional",
        "timeline_notice": "Non-control branches encode their own minimal, rich, or minimal-to-rich environment. Media selection is locked for those branches.",
        "index_options": [
            "0: control",
            "1: reverse rRNA orientation in minimal media",
            "2: reverse rRNA orientation in rich amino-acid media",
            "3: reverse rRNA orientation in a minimal-to-rich shift",
        ],
    },
}


def _build_variant_hints(variant: Variant, session: Session) -> dict:
    hints = dict(
        VARIANT_PARAM_HINTS.get(
            variant.name,
            {
                "index_meaning": "Variant-specific parameter index",
                "supports_gene_lookup": False,
                "timeline_behavior": "composer",
            },
        )
    )

    if variant.name == "condition":
        condition_options = _build_condition_index_options(session)
        if condition_options:
            hints["index_range"] = [0, len(condition_options) - 1]
            hints["index_options"] = condition_options

    elif variant.name == "ppgpp_conc":
        conditions = {
            condition.name: condition for condition in _list_conditions_in_variant_order(session)
        }
        index_options: list[str] = []
        for block_index, condition_name in enumerate(PPGPP_CONDITION_NAMES):
            condition = conditions.get(condition_name)
            condition_label = (
                f"{condition.name} ({condition.nutrients})"
                if condition and condition.nutrients
                else condition_name
            )
            for factor_index, factor in enumerate(PPGPP_FACTORS):
                index = block_index * len(PPGPP_FACTORS) + factor_index
                index_options.append(f"{index}: {condition_label}, {factor}x baseline ppGpp")
        hints["index_range"] = [0, len(index_options) - 1]
        hints["index_options"] = index_options
        hints["condition_names"] = PPGPP_CONDITION_NAMES

    elif variant.name == "tf_activity":
        tf_names, index_options = _build_tf_activity_index_options(session)
        exact_max_index = len(tf_names) * 2
        hints["tf_names"] = tf_names
        hints["tf_state_details"] = _load_tf_activity_specs(session)
        hints["max_exact_index"] = exact_max_index
        hints["control_period"] = exact_max_index + 1
        hints["index_options"] = index_options

    elif variant.name == "new_gene_internal_shift":
        condition_names, index_options = _build_new_gene_index_options(session)
        if condition_names:
            hints["condition_names"] = condition_names
            hints["condition_count"] = len(condition_names)
            hints["max_valid_index"] = (
                len(condition_names) - 1
            ) * NEW_GENE_CONDITION_STRIDE + NEW_GENE_VALID_REMAINDER_RANGE[1]
        hints["index_options"] = index_options

    if "index_options" not in hints:
        index_options = _extract_index_options_from_docstring(variant.docstring)
        if index_options:
            hints["index_options"] = index_options

    return hints
