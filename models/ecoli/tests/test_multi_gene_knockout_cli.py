import pickle

import pytest

from models.ecoli.sim.variants import apply_variant
from runscripts.manual.runSim import multi_ko_variant_kwargs
from wholecell.fireworks.firetasks.variantSimData import VariantSimDataTask


def test_multi_ko_variant_kwargs_accepts_arbitrary_unique_indices():
	assert multi_ko_variant_kwargs(
		("multi_gene_knockout", 0, 0),
		[1, 20, 300, 4000],
		False,
	) == {"ko_indices": [1, 20, 300, 4000]}


@pytest.mark.parametrize(
	"variant_spec, ko_indices, require_variants, message",
	[
		(("multi_gene_knockout", 0, 0), None, False, "requires --multi-ko-indices"),
		(("multi_gene_knockout", 0, 0), [1], False, "at least two"),
		(("multi_gene_knockout", 0, 0), [1, 1], False, "Duplicate"),
		(("multi_gene_knockout", 0, 0), [0, 1], False, "positive"),
		(("multi_gene_knockout", 1, 1), [1, 2], False, "requires --variant"),
		(("multi_gene_knockout", 0, 0), [1, 2], True, "does not support --require-variants"),
		(("gene_knockout", 1, 1), [1, 2], False, "only supported"),
	],
)
def test_multi_ko_variant_kwargs_rejects_invalid_combinations(
	variant_spec, ko_indices, require_variants, message
):
	with pytest.raises(ValueError, match=message):
		multi_ko_variant_kwargs(variant_spec, ko_indices, require_variants)


def test_apply_variant_forwards_variant_kwargs(tmp_path, monkeypatch):
	sim_data_file = tmp_path / "simData.cPickle"
	with sim_data_file.open("wb") as stream:
		pickle.dump({"original": True}, stream)

	def parameterized_variant(sim_data, index, ko_indices):
		sim_data["index"] = index
		sim_data["ko_indices"] = ko_indices
		return {"shortName": "test", "desc": "test"}, sim_data

	monkeypatch.setitem(
		apply_variant.nameToFunctionMapping,
		"parameterized_test_variant",
		parameterized_variant,
	)

	_, updated = apply_variant.apply_variant(
		sim_data_file,
		"parameterized_test_variant",
		0,
		{"ko_indices": [1, 2, 3]},
	)

	assert updated["ko_indices"] == [1, 2, 3]


def test_variant_sim_data_task_forwards_variant_kwargs(tmp_path, monkeypatch):
	captured = {}

	def fake_apply_variant(sim_data_file, variant_type, variant_index, variant_kwargs):
		captured.update(
			sim_data_file=sim_data_file,
			variant_type=variant_type,
			variant_index=variant_index,
			variant_kwargs=variant_kwargs,
		)
		return {"shortName": "test", "desc": "test"}, {"updated": True}

	monkeypatch.setattr(apply_variant, "apply_variant", fake_apply_variant)

	task = VariantSimDataTask(
		variant_function="multi_gene_knockout",
		variant_index=0,
		variant_kwargs={"ko_indices": [1, 2, 3]},
		input_sim_data=str(tmp_path / "input.cPickle"),
		output_sim_data=str(tmp_path / "variant" / "simData_Modified.cPickle"),
		variant_metadata_directory=str(tmp_path / "variant" / "metadata"),
	)
	task.run_task({})

	assert captured["variant_kwargs"] == {"ko_indices": [1, 2, 3]}
