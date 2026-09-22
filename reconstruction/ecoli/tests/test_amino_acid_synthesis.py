"""
The amino acid synthesis rate law must stay finite when an amino acid pool is
empty. issues.md Issue 4a: an auxotroph's pool reaches exactly zero molecules,
the upstream-KM saturation term became 0 / 0 for every unused KM entry, the
NaN spread through the product to all pathways, and the tRNA charging ODE
died with "array must not contain infs or NaNs".

Run with:  python -m pytest reconstruction/ecoli/tests/test_amino_acid_synthesis.py
"""

import numpy as np
import pytest

from reconstruction.ecoli.dataclasses.process.metabolism import amino_acid_synthesis_jit


N = 4


def _params(seed=0):
	rng = np.random.RandomState(seed)
	# Sparse upstream KM matrix, as in the parca output (420 of 441 entries are 0).
	kms = np.zeros((N, N))
	kms[1, 0] = 5.0
	kms[3, 2] = 0.5
	return dict(
		aa_upstream_kms=kms,
		aa_kis=np.array([10.0, np.inf, 20.0, np.inf]),
		aa_reverse_kms=np.array([1.0, np.inf, 2.0, 3.0]),
		aa_degradation_kms=np.array([np.inf, np.inf, 0.1, np.inf]),
		aa_forward_stoich=np.eye(N),
		aa_kcats_fwd=rng.uniform(0.01, 1, N),
		aa_reverse_stoich=np.eye(N),
		aa_kcats_rev=rng.uniform(0.01, 1, N),
		)


def _reference(fwd, rev, conc, p):
	"""The original array formulation, valid wherever conc > 0."""
	km_saturation = np.prod(1 / (1 + p['aa_upstream_kms'] / conc), axis=1)
	forward = 1 / (1 + conc / p['aa_kis']) * km_saturation
	reverse = 1 / (1 + p['aa_reverse_kms'] / conc)
	deg = 1 / (1 + p['aa_degradation_kms'] / conc)
	synthesis = (p['aa_forward_stoich'] @ (p['aa_kcats_fwd'] * fwd * forward)
		- p['aa_reverse_stoich'] @ (p['aa_kcats_rev'] * rev * reverse)
		- p['aa_kcats_rev'] * rev * deg)
	return synthesis, forward, reverse + deg


def _call(fwd, rev, conc, p):
	return amino_acid_synthesis_jit(fwd, rev, conc,
		p['aa_upstream_kms'], p['aa_kis'], p['aa_reverse_kms'],
		p['aa_degradation_kms'], p['aa_forward_stoich'], p['aa_kcats_fwd'],
		p['aa_reverse_stoich'], p['aa_kcats_rev'])


def test_matches_original_formulation_for_positive_concentrations():
	p = _params()
	fwd = np.array([10.0, 20.0, 0.0, 5.0])
	rev = np.array([1.0, 0.0, 3.0, 2.0])
	conc = np.array([2.0, 0.5, 30.0, 0.01])
	got = _call(fwd, rev, conc, p)
	want = _reference(fwd, rev, conc, p)
	for g, w in zip(got, want):
		np.testing.assert_allclose(g, w, rtol=1e-12)


def test_finite_when_a_pool_is_empty():
	p = _params()
	fwd = np.array([10.0, 20.0, 0.0, 5.0])
	rev = np.array([1.0, 0.0, 3.0, 2.0])
	conc = np.array([2.0, 0.0, 30.0, 0.01])   # amino acid 1 has no molecules
	synthesis, forward, loss = _call(fwd, rev, conc, p)
	assert np.all(np.isfinite(synthesis))
	assert np.all(np.isfinite(forward))
	assert np.all(np.isfinite(loss))
	# The empty pool cannot be lost or degraded, and nothing downstream of it
	# (amino acid 1 is upstream of nothing here) is affected.
	assert loss[1] == 0
	# Pathways that do not depend on the empty pool are unchanged.
	nonzero = conc.copy()
	nonzero[1] = 1e-9
	ref = _reference(fwd, rev, nonzero, p)
	np.testing.assert_allclose(synthesis[[0, 2, 3]], ref[0][[0, 2, 3]], rtol=1e-6)


def test_empty_upstream_pool_switches_off_the_dependent_pathway():
	p = _params()
	fwd = np.ones(N)
	rev = np.zeros(N)
	conc = np.array([0.0, 1.0, 1.0, 1.0])   # amino acid 0 is upstream of pathway 1
	synthesis, forward, _ = _call(fwd, rev, conc, p)
	assert forward[1] == 0
	assert synthesis[1] == 0
	assert np.all(np.isfinite(synthesis))


def test_all_pools_empty_is_finite():
	p = _params()
	synthesis, forward, loss = _call(np.ones(N), np.ones(N), np.zeros(N), p)
	assert np.all(np.isfinite(synthesis))
	assert np.all(forward[[1, 3]] == 0)      # pathways with an upstream dependency
	assert np.all(forward[[0, 2]] == 1)      # pathways without one are unsaturated by KI, not by upstream
	assert np.all(loss == 0)
