"""
The process-level failures that only happen in a cell that has stopped growing
end the lineage (issues.md, Issues 4c and 6) instead of failing the job, and
each keeps its own class name as the reason prefix.

Run with:  python -m pytest models/ecoli/tests/test_cell_stopped.py
"""

import numpy as np
import pytest

from wholecell.utils.cell_stopped import CellStoppedError
from wholecell.utils.modular_fba import FBASolveFailed
from reconstruction.ecoli.dataclasses.process.equilibrium import EquilibriumUnstable
from wholecell.sim.simulation import LINEAGE_TERMINATING_EXCEPTIONS
from models.ecoli.processes.polypeptide_elongation import ppgpp_metabolite_changes
from wholecell.utils import units


def test_process_failures_are_lineage_terminations_with_distinct_prefixes():
	for cls in (FBASolveFailed, EquilibriumUnstable):
		assert issubclass(cls, CellStoppedError)
		assert issubclass(cls, LINEAGE_TERMINATING_EXCEPTIONS)
	# The reason prefix is the class name, so the two must differ from each
	# other and from the death / no-division reasons.
	names = {FBASolveFailed.__name__, EquilibriumUnstable.__name__, 'NegativeCountsError', 'TimeLimitReached'}
	assert len(names) == 4


class _Solver:
	"""Fails `fail_times` solves, recording what the retry ladder does."""
	def __init__(self, fail_times):
		self.fail_times = fail_times
		self.calls = 0
		self.resets = []

	def _solve(self):
		self.calls += 1
		if self.calls <= self.fail_times:
			raise RuntimeError('GLP_ESING: Basis matrix is singular')

	def reset_basis(self, presolve=False):
		self.resets.append(presolve)


def _fba_with(solver):
	from wholecell.utils.modular_fba import FluxBalanceAnalysis
	fba = FluxBalanceAnalysis.__new__(FluxBalanceAnalysis)
	fba._solver = solver
	return fba


def test_retry_ladder_resets_the_basis_and_presolves_last():
	solver = _Solver(fail_times=2)
	_fba_with(solver).solve(3)
	assert solver.calls == 3
	assert solver.resets == [False, False]      # two failures, two fresh bases


def test_retry_ladder_presolves_on_the_final_retry_and_reraises():
	solver = _Solver(fail_times=10)
	with pytest.raises(RuntimeError, match='GLP_ESING'):
		_fba_with(solver).solve(3)
	assert solver.calls == 4
	assert solver.resets == [False, False, True]


def test_solve_zero_iterations_is_a_single_attempt():
	solver = _Solver(fail_times=1)
	with pytest.raises(RuntimeError):
		_fba_with(solver).solve(0)
	assert solver.calls == 1 and solver.resets == []


def _ppgpp_call(limits):
	conc = units.umol / units.L
	n = 3
	params = dict(
		KD_RelA=np.full(n, 0.3), k_RelA=75.0, k_SpoT_syn=2.6, k_SpoT_deg=0.23, KI_SpoT=np.full(n, 20.0),
		# one metabolite consumed by both synthesis and degradation
		ppgpp_reaction_stoich=np.array([[-1, -1], [1, 0], [0, 1]]),
		synthesis_index=0, degradation_index=1)
	charging = dict(krta=1.0, krtf=500.0, max_elong_rate=22.0)
	return ppgpp_metabolite_changes(
		conc * np.full(n, 5.0), conc * np.full(n, 10.0), conc * 10.0, np.full(n, 1 / n),
		conc * 1.0, conc * 1.0, conc * 50.0, conc * 0.01, 5.0,
		charging, params, 1.0, limits=limits, random_state=np.random.RandomState(0))


def test_ppgpp_falls_back_to_no_reactions_when_limits_cannot_be_met():
	delta, n_syn, n_deg, *_ = _ppgpp_call(limits=np.array([0, 0, 0]))
	assert n_syn == 0 and n_deg == 0
	assert np.all(delta == 0)


def test_ppgpp_still_reacts_when_limits_allow():
	delta, n_syn, n_deg, *_ = _ppgpp_call(limits=np.array([10**9, 10**9, 10**9]))
	assert n_syn + n_deg > 0
	assert np.all(delta + 10**9 >= 0)
