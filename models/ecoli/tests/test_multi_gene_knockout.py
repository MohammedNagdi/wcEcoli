from types import SimpleNamespace

import numpy as np
import pytest

from models.ecoli.sim.variants.multi_gene_knockout import multi_gene_knockout


class FakeSimData:
	def __init__(self, n_rnas=5):
		self.process = SimpleNamespace(
			transcription=SimpleNamespace(
				rna_data=np.array(
					[(f"RNA{i}",) for i in range(n_rnas)],
					dtype=[("id", "U10")],
				)
			)
		)
		self.adjusted = None

	def adjust_final_expression(self, indexes, factors):
		self.adjusted = (list(indexes), list(factors))


def test_multi_gene_knockout_converts_ko_indexes_to_zero_based_rna_indexes():
	sim_data = FakeSimData()

	info, updated = multi_gene_knockout(sim_data, 0, ko_indices=[1, 3, 5])

	assert updated is sim_data
	assert sim_data.adjusted == ([0, 2, 4], [0.0, 0.0, 0.0])
	assert info["shortName"] == "3target_KO"


@pytest.mark.parametrize(
	"ko_indices, message",
	[
		(None, "must be a list"),
		([], "at least two"),
		([1], "at least two"),
		([1, 1], "Duplicate"),
		([0, 1], "positive"),
		([1, "2"], "integers"),
		([1, 6], "out of range"),
	],
)
def test_multi_gene_knockout_rejects_bad_payloads(ko_indices, message):
	with pytest.raises(ValueError, match=message):
		multi_gene_knockout(FakeSimData(), 0, ko_indices=ko_indices)


def test_multi_gene_knockout_requires_variant_index_zero():
	with pytest.raises(ValueError, match="variant index 0"):
		multi_gene_knockout(FakeSimData(), 1, ko_indices=[1, 2])
