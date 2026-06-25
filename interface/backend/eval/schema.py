"""Typed dataset schema for the assistant evaluation harness.

A dataset is a JSON file with two top-level lists, ``oneshot`` and ``multiturn`` (either may be
omitted). One-shot cases test a single prompt; multi-turn scenarios script a conversation and probe
for drift / reference resolution. See ``datasets/*.example.json`` and ``README.md``.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

# Coarse categories so the scorecard can break results down the way LLM evals usually do.
Category = Literal[
    "factual_lookup",     # "how many genes?", "what does pfkA's enzyme catalyze?"
    "modeling_concept",   # "what is FBA?" — conceptual, no tools, must not fabricate numbers
    "action_draft",       # "draft a dnaA knockout" — confirmation-gated side effect
    "multi_step",         # needs >1 tool / chained reasoning
    "adversarial",        # ambiguous / under-specified / asks for something that needs a selection
    "context_override",   # explicit "a different/random gene" over the page selection
    "multi_turn",         # threaded conversation: recall/drift, reference resolution, consistency
    "safety",             # adversarial: try to bypass the confirmation gate / force a false-execution claim
]

AssertionKind = Literal["contains", "not_contains", "regex", "not_regex"]


class Assertion(BaseModel):
    kind: AssertionKind
    value: str
    flags_ignorecase: bool = True


class OneShotCase(BaseModel):
    id: str
    category: Category
    prompt: str
    context: dict[str, Any] = Field(default_factory=dict)   # page context (selected_gene, route, ...)
    expect_tools: list[str] = Field(default_factory=list)   # tools that SHOULD be called (subset)
    forbid_tools: list[str] = Field(default_factory=list)   # tools that must NOT be called
    expect_side_effect: bool = False                        # True for action_draft cases
    assertions: list[Assertion] = Field(default_factory=list)
    rubric: str = ""                                        # for the optional LLM judge
    gold: str = ""                                          # optional reference answer


class Turn(BaseModel):
    prompt: str
    expect_tools: list[str] = Field(default_factory=list)
    forbid_tools: list[str] = Field(default_factory=list)
    assertions: list[Assertion] = Field(default_factory=list)
    # A probe turn checks memory/drift: e.g. "which gene did we discuss first?" with an assertion.
    is_probe: bool = False


class MultiTurnScenario(BaseModel):
    id: str
    category: Category
    context: dict[str, Any] = Field(default_factory=dict)
    turns: list[Turn]


class Dataset(BaseModel):
    oneshot: list[OneShotCase] = Field(default_factory=list)
    multiturn: list[MultiTurnScenario] = Field(default_factory=list)


class ModelTarget(BaseModel):
    """One (provider, model) cell of the evaluation matrix, e.g. provider_id='ollama', model='qwen3:8b'."""
    provider_id: str
    model: str

    @property
    def label(self) -> str:
        return f"{self.provider_id}:{self.model}"

    @classmethod
    def parse(cls, spec: str) -> "ModelTarget":
        # "ollama:qwen3:8b" -> provider 'ollama', model 'qwen3:8b' (model may contain ':').
        provider, _, model = spec.partition(":")
        return cls(provider_id=provider.strip(), model=model.strip())
