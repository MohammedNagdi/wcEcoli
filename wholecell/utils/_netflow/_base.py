'''
Base class for netflow interfaces with different solver backends.
All functions required for implementation with modular_fba.py are listed.
'''

class NetworkFlowProblemBase(object):

	def reset_basis(self, presolve=False):
		"""Discard any warm-start state so the next solve starts afresh.

		Solvers that warm-start from the last basis repeat a singular basis
		exactly on a plain retry; overriding this lets `modular_fba.solve`
		make each retry different. `presolve` asks for the solver's presolver
		on the next solve as well. The default does nothing.
		"""
		pass

	_maximize = True
	quadratic_objective = False
	inf = float('inf')

	def setFlowMaterialCoeff(self, flow, material, coefficient):
		raise NotImplementedError()

	def setFlowBounds(self, flow, ub=None, lb=None):
		raise NotImplementedError()

	def setFlowObjectiveCoeff(self, flow, coefficient):
		raise NotImplementedError()

	def getFlowObjectiveCoeff(self, flow):
		raise NotImplementedError()

	def getFlowRates(self, flows):
		raise NotImplementedError()

	def getShadowPrices(self, materials):
		raise NotImplementedError()

	def getReducedCosts(self, materials):
		raise NotImplementedError()

	def getObjectiveValue(self):
		raise NotImplementedError()

	def getSMatrix(self):
		raise NotImplementedError()

	def getFlowNames(self):
		raise NotImplementedError()

	def getMaterialNames(self):
		raise NotImplementedError()

	def getUpperBounds(self):
		raise NotImplementedError()

	def getLowerBounds(self):
		raise NotImplementedError()

	def getObjective(self):
		raise NotImplementedError()

	def buildEqConst(self):
		raise NotImplementedError()

	def maximizeObjective(self, doMax):
		self._maximize = doMax

	def _solve(self):
		raise NotImplementedError()
