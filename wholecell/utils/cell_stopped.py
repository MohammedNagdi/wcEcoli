"""
Marker base class for exceptions that mean "this cell stopped", not "the
simulator broke".

`wholecell.sim.simulation.Simulation.run` treats every subclass as a lineage
termination: it finalizes the dying generation's tables, writes a marker, and
raises `LineageTerminated`, so the job is a result rather than a crash. The
exception's class name becomes the prefix of the recorded termination reason
(`FBASolveFailed: GLP_ESING: ...`, `EquilibriumUnstable: ...`), which keeps
solver failures distinguishable from cells that died (`NegativeCountsError`)
or never divided (`TimeLimitReached`). See issues.md, Issues 4c and 6.

Kept in its own module so model code can subclass it without importing the
simulation.
"""


class CellStoppedError(Exception):
	"""A process could not carry the cell forward; end the lineage here."""
	pass
