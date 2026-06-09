"""Assistant provider and typed harness foundation.

This module deliberately avoids making LLM calls. It defines the provider
registry, context contract, tool metadata, and persistence helpers that future
assistant execution will use.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import HTTPException
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from app.config import settings
from app.db.models import (
    AssistantConfirmation,
    AssistantConversation,
    AssistantMessage,
    AssistantProvenance,
    AssistantToolCall,
    BuilderSectionDraft,
    Condition,
    Experiment,
    SimulationJob,
    SimulationResult,
    Timeline,
    Variant,
)
from app.services.experiment_creation import ExperimentCreateData, create_experiment_record
from app.services.assistant_runtime import RUNTIME_PROVIDER_SPECS


AssistantSurface = Literal[
    "central",
    "workspace",
    "conditions_builder",
    "experiments",
    "results",
    "network",
    "genome",
    "ml",
    "design",
]

ProviderCategory = Literal["hosted_byok", "local_runtime"]
ProviderHealthState = Literal["not_configured", "configured_not_checked"]
AssistantState = Literal["scaffolded_disabled", "provider_configured_tools_disabled", "read_only_tools_enabled"]
AssistantMessageRole = Literal["user", "assistant", "system"]
ConfirmationStatus = Literal["pending", "approved", "rejected", "cancelled", "used"]


CONTEXT_CONTRACT = [
    "route",
    "selected_gene",
    "selected_experiment",
    "selected_job",
    "selected_result",
    "assistant_surface",
]

VISIBLE_ARTIFACTS = [
    "assistant_message",
    "tool_call_record",
    "experiment_proposal",
    "result_reference",
    "pending_confirmation",
]

CONFIRMATION_REQUIRED_ACTIONS = [
    "create_experiment",
    "run_simulation",
    "cancel_simulation",
    "delete_experiment",
    "publish_environment_builder_artifact",
]


class ProviderDefinition(BaseModel):
    provider_id: str
    label: str
    category: ProviderCategory
    secret_setting: str | None = None
    endpoint_setting: str | None = None
    configuration_hint: str


PROVIDER_DEFINITIONS = [
    ProviderDefinition(
        provider_id="openai",
        label="OpenAI",
        category="hosted_byok",
        secret_setting="openai_api_key",
        configuration_hint="Set OPENAI_API_KEY in the local environment.",
    ),
    ProviderDefinition(
        provider_id="anthropic",
        label="Anthropic",
        category="hosted_byok",
        secret_setting="anthropic_api_key",
        configuration_hint="Set ANTHROPIC_API_KEY in the local environment.",
    ),
    ProviderDefinition(
        provider_id="openrouter",
        label="OpenRouter",
        category="hosted_byok",
        secret_setting="openrouter_api_key",
        configuration_hint="Set OPENROUTER_API_KEY in the local environment.",
    ),
    ProviderDefinition(
        provider_id="ollama",
        label="Ollama",
        category="local_runtime",
        endpoint_setting="ollama_base_url",
        configuration_hint="Set OLLAMA_BASE_URL for a local Ollama endpoint.",
    ),
    ProviderDefinition(
        provider_id="lm_studio",
        label="LM Studio",
        category="local_runtime",
        endpoint_setting="lm_studio_base_url",
        configuration_hint="Set LM_STUDIO_BASE_URL for a local LM Studio endpoint.",
    ),
    ProviderDefinition(
        provider_id="vllm",
        label="vLLM",
        category="local_runtime",
        endpoint_setting="vllm_base_url",
        configuration_hint="Set VLLM_BASE_URL for a local vLLM/OpenAI-compatible endpoint.",
    ),
]


class ProviderStatus(BaseModel):
    provider_id: str
    label: str
    category: ProviderCategory
    configured: bool
    health: ProviderHealthState
    configuration_hint: str
    endpoint_configured: bool = False
    secret_configured: bool = False
    runtime_supported: bool = False
    default_model: str = ""
    selected_for_runtime: bool = False


class ProviderLayerStatus(BaseModel):
    mode: str
    configured_provider_count: int
    providers: list[ProviderStatus]
    notes: list[str]


class AssistantToolSpec(BaseModel):
    name: str
    label: str
    description: str
    status: str
    requires_confirmation: bool
    side_effect: bool
    argument_schema: dict[str, Any] = Field(default_factory=dict)
    result_schema: dict[str, Any] = Field(default_factory=dict)


class AssistantHarnessStatus(BaseModel):
    state: AssistantState
    provider_required: bool
    provider_configured: bool
    tool_execution_enabled: bool
    tool_preview_enabled: bool
    execution_enabled_tools: list[str]
    side_effect_execution_enabled: bool
    db_persistence_enabled: bool
    confirmation_required_for: list[str]
    context_contract: list[str]
    visible_artifacts: list[str]
    tool_registry: list[AssistantToolSpec]
    notes: list[str]


class AssistantContext(BaseModel):
    route: str = ""
    selected_gene: str | None = None
    selected_experiment: int | None = None
    selected_job: int | None = None
    selected_result: int | None = None
    assistant_surface: AssistantSurface = "central"


class AssistantConversationCreate(BaseModel):
    title: str = "New assistant conversation"
    assistant_surface: AssistantSurface = "central"
    context: AssistantContext = Field(default_factory=AssistantContext)


class AssistantConversationOut(BaseModel):
    id: int
    title: str
    assistant_surface: AssistantSurface
    status: str
    created_at: str
    updated_at: str


class AssistantMessageCreate(BaseModel):
    content: str
    context: AssistantContext = Field(default_factory=AssistantContext)


class AssistantMessageOut(BaseModel):
    id: int
    conversation_id: int
    role: AssistantMessageRole
    content: str
    context: AssistantContext
    status: str
    created_at: str


class AssistantExchangeOut(BaseModel):
    conversation: AssistantConversationOut
    user_message: AssistantMessageOut
    assistant_message: AssistantMessageOut
    provenance_id: int
    pending_confirmations: list[int] = Field(default_factory=list)
    tool_calls: list[int] = Field(default_factory=list)


class AssistantToolPreviewRequest(BaseModel):
    arguments: dict[str, Any] = Field(default_factory=dict)
    context: AssistantContext = Field(default_factory=AssistantContext)


class AssistantToolPreviewOut(BaseModel):
    tool_name: str
    valid: bool
    requires_confirmation: bool
    side_effect: bool
    execution_enabled: bool
    normalized_arguments: dict[str, Any] = Field(default_factory=dict)
    preview: dict[str, Any] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)


class AssistantToolExecutionRequest(BaseModel):
    arguments: dict[str, Any] = Field(default_factory=dict)
    context: AssistantContext = Field(default_factory=AssistantContext)
    confirmation_id: int | None = None
    conversation_id: int | None = None


class AssistantToolExecutionOut(BaseModel):
    tool_name: str
    executed: bool
    status: str
    requires_confirmation: bool
    confirmation_id: int | None = None
    tool_call_id: int | None = None
    provenance_id: int | None = None
    normalized_arguments: dict[str, Any] = Field(default_factory=dict)
    result: dict[str, Any] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)


class AssistantToolCallOut(BaseModel):
    id: int
    conversation_id: int | None
    message_id: int | None
    tool_name: str
    status: str
    arguments: dict[str, Any]
    result: dict[str, Any]
    created_at: str
    updated_at: str


class ConfirmationCreate(BaseModel):
    action: str
    payload: dict[str, Any] = Field(default_factory=dict)
    conversation_id: int | None = None
    tool_call_id: int | None = None


class ConfirmationResolve(BaseModel):
    status: Literal["approved", "rejected", "cancelled"]
    note: str = ""


class ConfirmationOut(BaseModel):
    id: int
    conversation_id: int | None
    tool_call_id: int | None
    action: str
    status: ConfirmationStatus
    payload: dict[str, Any]
    note: str
    created_at: str
    resolved_at: str


class ProvenanceOut(BaseModel):
    id: int
    conversation_id: int | None
    message_id: int | None
    provider_id: str
    model: str
    prompt_hash: str
    request: dict[str, Any]
    response: dict[str, Any]
    created_at: str


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def to_json(data: Any) -> str:
    try:
        return json.dumps(data, separators=(",", ":"), sort_keys=True)
    except TypeError as exc:
        raise HTTPException(status_code=422, detail=f"Payload must be JSON-serializable: {exc}") from exc


def from_json(raw: str, fallback: Any) -> Any:
    try:
        return json.loads(raw or "")
    except Exception:
        return fallback


def configured(value: str | None) -> bool:
    return bool((value or "").strip())


def get_provider_statuses() -> list[ProviderStatus]:
    statuses: list[ProviderStatus] = []
    selected_provider = (settings.assistant_provider or "").strip()
    for definition in PROVIDER_DEFINITIONS:
        secret_value = getattr(settings, definition.secret_setting, "") if definition.secret_setting else ""
        endpoint_value = getattr(settings, definition.endpoint_setting, "") if definition.endpoint_setting else ""
        secret_is_configured = configured(secret_value)
        endpoint_is_configured = configured(endpoint_value)
        is_configured = secret_is_configured or endpoint_is_configured
        runtime_spec = RUNTIME_PROVIDER_SPECS.get(definition.provider_id)
        statuses.append(
            ProviderStatus(
                provider_id=definition.provider_id,
                label=definition.label,
                category=definition.category,
                configured=is_configured,
                health="configured_not_checked" if is_configured else "not_configured",
                configuration_hint=definition.configuration_hint,
                endpoint_configured=endpoint_is_configured,
                secret_configured=secret_is_configured,
                runtime_supported=runtime_spec is not None,
                default_model=runtime_spec.default_model if runtime_spec else "",
                selected_for_runtime=selected_provider == definition.provider_id,
            )
        )
    return statuses


def get_provider_layer_status() -> ProviderLayerStatus:
    providers = get_provider_statuses()
    configured_count = sum(1 for provider in providers if provider.configured)
    return ProviderLayerStatus(
        mode="bring_your_own_key_or_local_endpoint",
        configured_provider_count=configured_count,
        providers=providers,
        notes=[
            "Provider status reports configuration presence only; API keys are never returned.",
            "Runtime support indicates whether the assistant can call that provider without exposing tools.",
            "Status checks are intentionally non-networked; provider calls happen only when a user sends an assistant message.",
            "The scientific platform remains usable when no LLM provider is configured.",
        ],
    )


def get_tool_registry() -> list[AssistantToolSpec]:
    return [
        AssistantToolSpec(
            name="create_experiment",
            label="Create experiment draft",
            description="Prepare a draft experiment from validated variant, condition, timeline, and simulation parameters.",
            status="confirmation_execution_enabled",
            requires_confirmation=True,
            side_effect=True,
            argument_schema={
                "name": "string",
                "description": "string",
                "variant_type": "string",
                "variant_index": "integer",
                "condition": "string",
                "timeline": "string",
                "sim_params": "object",
                "gene_symbol": "string",
                "gene_symbols": "array",
                "include_wildtype": "boolean",
            },
            result_schema={"experiment_id": "integer", "status": "draft"},
        ),
        AssistantToolSpec(
            name="run_simulation",
            label="Run simulation",
            description="Queue a saved experiment for execution through the simulation worker.",
            status="confirmation_execution_enabled",
            requires_confirmation=True,
            side_effect=True,
            argument_schema={"experiment_id": "integer", "seed": "integer", "generations": "integer"},
            result_schema={"job_id": "integer", "status": "pending"},
        ),
        AssistantToolSpec(
            name="publish_environment_builder_artifact",
            label="Publish builder artifact",
            description="Publish a saved Conditions Builder draft to the local reconstruction files.",
            status="registered_disabled",
            requires_confirmation=True,
            side_effect=True,
            argument_schema={"section": "string", "draft_id": "integer"},
            result_schema={"published_name": "string", "status": "published"},
        ),
        AssistantToolSpec(
            name="inspect_result",
            label="Inspect result",
            description="Read a completed result and return structured links to phenotype, time-series, and model-output views.",
            status="execution_enabled",
            requires_confirmation=False,
            side_effect=False,
            argument_schema={"job_id": "integer", "gene": "string"},
            result_schema={"summary": "object", "links": "array"},
        ),
    ]


def get_assistant_harness_status() -> AssistantHarnessStatus:
    provider_configured = get_provider_layer_status().configured_provider_count > 0
    return AssistantHarnessStatus(
        state="read_only_tools_enabled",
        provider_required=True,
        provider_configured=provider_configured,
        tool_execution_enabled=True,
        tool_preview_enabled=True,
        execution_enabled_tools=["inspect_result", "create_experiment", "run_simulation"],
        side_effect_execution_enabled=True,
        db_persistence_enabled=True,
        confirmation_required_for=CONFIRMATION_REQUIRED_ACTIONS,
        context_contract=CONTEXT_CONTRACT,
        visible_artifacts=VISIBLE_ARTIFACTS,
        tool_registry=get_tool_registry(),
        notes=[
            "This is the durable harness foundation, not a live LLM runtime.",
            "Messages, confirmations, and provenance can be stored before tool execution is enabled.",
            "Registered tools support dry-run validation previews without side effects.",
            "Read-only result inspection can execute immediately.",
            "create_experiment and run_simulation can execute only after approved matching confirmations; other side-effecting tools remain adapter-disabled.",
            "Future execution must use registered typed tools and explicit confirmation for side effects.",
        ],
    )


def get_tool_spec(tool_name: str) -> AssistantToolSpec:
    for tool in get_tool_registry():
        if tool.name == tool_name:
            return tool
    raise HTTPException(status_code=404, detail=f"Unknown assistant tool '{tool_name}'.")


def _string_arg(
    args: dict[str, Any],
    key: str,
    errors: list[str],
    *,
    required: bool = True,
) -> str:
    value = args.get(key)
    if value is None or value == "":
        if required:
            errors.append(f"Missing required string argument '{key}'.")
        return ""
    if not isinstance(value, str):
        errors.append(f"Argument '{key}' must be a string.")
        return ""
    return value.strip()


def _int_arg(
    args: dict[str, Any],
    key: str,
    errors: list[str],
    *,
    required: bool = True,
    minimum: int | None = None,
) -> int | None:
    value = args.get(key)
    if value is None or value == "":
        if required:
            errors.append(f"Missing required integer argument '{key}'.")
        return None
    if isinstance(value, bool):
        errors.append(f"Argument '{key}' must be an integer.")
        return None
    try:
        normalized = int(value)
    except (TypeError, ValueError):
        errors.append(f"Argument '{key}' must be an integer.")
        return None
    if minimum is not None and normalized < minimum:
        errors.append(f"Argument '{key}' must be >= {minimum}.")
        return None
    return normalized


def _object_arg(args: dict[str, Any], key: str, errors: list[str]) -> dict[str, Any]:
    value = args.get(key, {})
    if value is None:
        return {}
    if not isinstance(value, dict):
        errors.append(f"Argument '{key}' must be an object.")
        return {}
    return value


def _bool_arg(
    args: dict[str, Any],
    key: str,
    errors: list[str],
    *,
    required: bool = False,
) -> bool:
    value = args.get(key)
    if value is None or value == "":
        if required:
            errors.append(f"Missing required boolean argument '{key}'.")
        return False
    if not isinstance(value, bool):
        errors.append(f"Argument '{key}' must be a boolean.")
        return False
    return value


def _string_list_arg(args: dict[str, Any], key: str, errors: list[str]) -> list[str]:
    value = args.get(key, [])
    if value is None:
        return []
    if not isinstance(value, list):
        errors.append(f"Argument '{key}' must be an array of strings.")
        return []
    strings: list[str] = []
    for index, item in enumerate(value):
        if not isinstance(item, str):
            errors.append(f"Argument '{key}[{index}]' must be a string.")
            continue
        cleaned = item.strip()
        if cleaned:
            strings.append(cleaned)
    return strings


def _preview_create_experiment(session: Session, args: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    name = _string_arg(args, "name", errors, required=False)
    description = _string_arg(args, "description", errors, required=False)
    variant_type = _string_arg(args, "variant_type", errors)
    variant_index = _int_arg(args, "variant_index", errors, minimum=0)
    condition = _string_arg(args, "condition", errors)
    timeline = _string_arg(args, "timeline", errors, required=False)
    sim_params = _object_arg(args, "sim_params", errors)
    gene_symbol = _string_arg(args, "gene_symbol", errors, required=False)
    gene_symbols = _string_list_arg(args, "gene_symbols", errors)
    include_wildtype = _bool_arg(args, "include_wildtype", errors)

    if variant_type:
        variant = session.exec(select(Variant).where(Variant.name == variant_type)).first()
        if not variant:
            errors.append(f"Variant type '{variant_type}' does not exist.")

    if condition:
        condition_record = session.exec(
            select(Condition).where(Condition.name == condition)
        ).first()
        if not condition_record:
            errors.append(f"Condition '{condition}' does not exist.")
    if timeline:
        timeline_record = session.exec(
            select(Timeline).where(Timeline.name == timeline)
        ).first()
        if not timeline_record:
            errors.append(f"Timeline '{timeline}' does not exist.")
    else:
        warnings.append("No time-varying protocol was supplied; the experiment will use the selected condition without scheduled media shifts.")

    sim_params_json = to_json(sim_params)
    default_name = f"{gene_symbol} {variant_type}".strip() if gene_symbol else f"{variant_type} experiment"

    normalized = {
        "name": name or default_name,
        "description": description,
        "variant_type": variant_type,
        "variant_index": variant_index,
        "condition": condition,
        "timeline": timeline,
        "sim_params": sim_params_json,
        "gene_symbol": gene_symbol,
        "gene_symbols": gene_symbols,
        "include_wildtype": include_wildtype,
    }
    preview = {
        "action": "would_create_experiment_draft",
        "summary": f"Create '{normalized['name']}' as a {variant_type or 'variant'} draft under condition {condition or 'unknown'}.",
        "variant_type": variant_type,
        "condition": condition,
        "timeline": timeline or "No time-varying protocol",
        "include_wildtype": include_wildtype,
        "side_effect_if_executed": "A new experiment row would be created.",
    }
    return normalized, preview, warnings, errors


def _preview_run_simulation(session: Session, args: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    experiment_id = _int_arg(args, "experiment_id", errors, minimum=1)
    seed = _int_arg(args, "seed", errors, required=False, minimum=0)
    generations = _int_arg(args, "generations", errors, required=False, minimum=1)
    experiment = session.get(Experiment, experiment_id) if experiment_id is not None else None
    if experiment_id is not None and not experiment:
        errors.append(f"Experiment {experiment_id} does not exist.")
    if experiment and experiment.status in {"running", "queued"}:
        warnings.append(f"Experiment {experiment_id} is already {experiment.status}.")

    normalized = {
        "experiment_id": experiment_id,
        "seed": 0 if seed is None else seed,
        "generations": 1 if generations is None else generations,
    }
    preview = {
        "action": "would_queue_simulation_job",
        "experiment_name": experiment.name if experiment else "",
        "condition": experiment.condition if experiment else "",
        "side_effect_if_executed": "A simulation job would be queued for the worker.",
    }
    return normalized, preview, warnings, errors


def _preview_publish_builder_artifact(session: Session, args: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    section = _string_arg(args, "section", errors)
    draft_id = _int_arg(args, "draft_id", errors, minimum=1)
    valid_sections = {"media", "mediaRecipe", "condition", "tfCondition", "timeline"}
    if section and section not in valid_sections:
        errors.append(f"Section '{section}' is not publishable.")
    draft = session.get(BuilderSectionDraft, draft_id) if draft_id is not None else None
    if draft_id is not None and not draft:
        errors.append(f"Builder draft {draft_id} does not exist.")
    if draft and section and draft.section != section:
        errors.append(f"Builder draft {draft_id} belongs to section '{draft.section}', not '{section}'.")
    if draft and draft.status == "published":
        warnings.append(f"Builder draft {draft_id} is already published.")

    normalized = {"section": section, "draft_id": draft_id}
    preview = {
        "action": "would_publish_builder_artifact",
        "draft_name": draft.name if draft else "",
        "published_name": draft.published_name if draft else "",
        "side_effect_if_executed": "Local reconstruction files and draft status could be updated.",
    }
    return normalized, preview, warnings, errors


def _preview_inspect_result(session: Session, args: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    job_id = _int_arg(args, "job_id", errors, minimum=1)
    gene = _string_arg(args, "gene", errors, required=False)
    job = session.get(SimulationJob, job_id) if job_id is not None else None
    if job_id is not None and not job:
        errors.append(f"Simulation job {job_id} does not exist.")
    if job and job.status != "done":
        warnings.append(f"Simulation job {job_id} is {job.status}; result data may be incomplete.")

    normalized = {"job_id": job_id, "gene": gene}
    preview = {
        "action": "would_inspect_result",
        "status": job.status if job else "",
        "links": [
            f"/results/{job_id}" if job_id else "",
            f"/results/{job_id}?gene={gene}" if job_id and gene else "",
        ],
        "side_effect_if_executed": "None. This is a read-only inspection tool.",
    }
    return normalized, preview, warnings, errors


def preview_tool(
    session: Session,
    tool_name: str,
    request: AssistantToolPreviewRequest,
) -> AssistantToolPreviewOut:
    spec = get_tool_spec(tool_name)
    if tool_name == "create_experiment":
        normalized, preview, warnings, errors = _preview_create_experiment(session, request.arguments)
    elif tool_name == "run_simulation":
        normalized, preview, warnings, errors = _preview_run_simulation(session, request.arguments)
    elif tool_name == "publish_environment_builder_artifact":
        normalized, preview, warnings, errors = _preview_publish_builder_artifact(session, request.arguments)
    elif tool_name == "inspect_result":
        normalized, preview, warnings, errors = _preview_inspect_result(session, request.arguments)
    else:
        raise HTTPException(status_code=404, detail=f"Unknown assistant tool '{tool_name}'.")

    return AssistantToolPreviewOut(
        tool_name=tool_name,
        valid=not errors,
        requires_confirmation=spec.requires_confirmation,
        side_effect=spec.side_effect,
        execution_enabled=tool_name in {"inspect_result", "create_experiment", "run_simulation"},
        normalized_arguments=normalized,
        preview=preview,
        warnings=warnings,
        errors=errors,
    )


def _record_tool_call(
    session: Session,
    *,
    conversation_id: int | None,
    tool_name: str,
    status: str,
    arguments: dict[str, Any],
    result: dict[str, Any],
) -> AssistantToolCall:
    timestamp = now_iso()
    record = AssistantToolCall(
        conversation_id=conversation_id or 0,
        message_id=None,
        tool_name=tool_name,
        status=status,
        arguments_json=to_json(arguments),
        result_json=to_json(result),
        created_at=timestamp,
        updated_at=timestamp,
    )
    session.add(record)
    session.commit()
    session.refresh(record)
    return record


def _confirmation_allows_execution(
    session: Session,
    *,
    tool_name: str,
    confirmation_id: int | None,
    normalized_arguments: dict[str, Any],
) -> tuple[AssistantConfirmation | None, list[str]]:
    if confirmation_id is None:
        return None, [f"Tool '{tool_name}' requires an approved confirmation before execution."]
    confirmation = session.get(AssistantConfirmation, confirmation_id)
    if not confirmation:
        return None, [f"Confirmation {confirmation_id} does not exist."]
    errors: list[str] = []
    if confirmation.action != tool_name:
        errors.append(f"Confirmation {confirmation_id} is for '{confirmation.action}', not '{tool_name}'.")
    if confirmation.status != "approved":
        errors.append(f"Confirmation {confirmation_id} is {confirmation.status}, not approved.")
    confirmed_payload = from_json(confirmation.payload_json, {})
    if confirmed_payload != normalized_arguments:
        errors.append("Confirmation payload does not match normalized tool arguments.")
    return confirmation, errors


def _execute_inspect_result(
    session: Session,
    normalized_arguments: dict[str, Any],
) -> dict[str, Any]:
    job_id = normalized_arguments.get("job_id")
    gene = normalized_arguments.get("gene") or ""
    job = session.get(SimulationJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Simulation job {job_id} not found.")
    experiment = session.get(Experiment, job.experiment_id)
    results = session.exec(
        select(SimulationResult)
        .where(SimulationResult.job_id == job.id)
        .order_by(SimulationResult.seed, SimulationResult.generation)
    ).all()
    summary_rows = [
        {
            "seed": result.seed,
            "generation": result.generation,
            "division_time_sec": result.division_time_sec,
            "final_mass_fg": result.final_mass_fg,
            "growth_rate": result.growth_rate,
            "doubling_time_min": result.doubling_time_min,
            "divided": result.divided,
        }
        for result in results
    ]
    links = [
        {"label": "Results detail", "path": f"/results/{job.id}"},
        {"label": "Molecule explorer", "path": f"/results/{job.id}?view=model-outputs"},
    ]
    if gene:
        links.append({"label": f"Gene-focused results for {gene}", "path": f"/results/{job.id}?gene={gene}"})
        links.append({"label": f"Workspace context for {gene}", "path": f"/?gene={gene}"})

    return {
        "job": {
            "id": job.id,
            "status": job.status,
            "condition": job.condition,
            "seed": job.seed,
            "generations": job.generations,
            "timeline": job.timeline,
        },
        "experiment": {
            "id": experiment.id if experiment else job.experiment_id,
            "name": experiment.name if experiment else "",
            "variant_type": experiment.variant_type if experiment else job.variant_type,
            "variant_index": experiment.variant_index if experiment else job.variant_index,
            "gene_symbol": experiment.gene_symbol if experiment else gene,
            "condition": experiment.condition if experiment else job.condition,
        },
        "summary": {
            "result_count": len(summary_rows),
            "completed": job.status == "done",
            "rows": summary_rows,
        },
        "links": links,
    }


def _execute_create_experiment(
    session: Session,
    normalized_arguments: dict[str, Any],
) -> dict[str, Any]:
    result = create_experiment_record(
        session,
        ExperimentCreateData.model_validate(normalized_arguments),
    )
    experiment = result.experiment
    return {
        "action": "created_experiment_draft",
        "experiment": {
            "id": experiment.id,
            "name": experiment.name,
            "description": experiment.description,
            "status": experiment.status,
            "variant_type": experiment.variant_type,
            "variant_index": experiment.variant_index,
            "condition": experiment.condition,
            "timeline": experiment.timeline,
            "gene_symbol": experiment.gene_symbol,
            "sim_params": experiment.sim_params,
        },
        "wildtype_experiment_id": result.wildtype_experiment_id,
        "links": [
            {"label": "Experiment queue", "path": f"/experiments?experiment={experiment.id}"},
            {"label": "Edit similar experiment", "path": f"/experiments/new?variant={experiment.variant_type}"},
        ],
    }


def _execute_run_simulation(
    session: Session,
    normalized_arguments: dict[str, Any],
) -> dict[str, Any]:
    from app.services.job_queue import RunJobRequest, create_simulation_jobs_for_experiment

    experiment_id = normalized_arguments.get("experiment_id")
    experiment = session.get(Experiment, experiment_id)
    if not experiment:
        raise HTTPException(status_code=404, detail=f"Experiment {experiment_id} not found.")

    seed = normalized_arguments.get("seed", 0)
    generations = normalized_arguments.get("generations", 1)
    response = create_simulation_jobs_for_experiment(
        experiment,
        RunJobRequest(
            condition=experiment.condition or "basal",
            seeds=[int(seed)],
            generations=int(generations),
        ),
        session,
    )
    session.refresh(experiment)
    return {
        "action": "queued_simulation_job",
        "job_ids": response.job_ids,
        "message": response.message,
        "experiment": {
            "id": experiment.id,
            "name": experiment.name,
            "status": experiment.status,
            "variant_type": experiment.variant_type,
            "variant_index": experiment.variant_index,
            "condition": experiment.condition,
            "timeline": experiment.timeline,
            "gene_symbol": experiment.gene_symbol,
        },
    }


def _mark_confirmation_used(
    session: Session,
    confirmation: AssistantConfirmation,
    *,
    tool_call_id: int | None,
) -> AssistantConfirmation:
    confirmation.status = "used"
    note = f"Used by assistant tool call {tool_call_id}."
    confirmation.note = f"{confirmation.note}\n{note}".strip() if confirmation.note else note
    confirmation.resolved_at = now_iso()
    session.add(confirmation)
    session.commit()
    session.refresh(confirmation)
    return confirmation


def execute_tool(
    session: Session,
    tool_name: str,
    request: AssistantToolExecutionRequest,
) -> AssistantToolExecutionOut:
    spec = get_tool_spec(tool_name)
    preview = preview_tool(
        session,
        tool_name,
        AssistantToolPreviewRequest(arguments=request.arguments, context=request.context),
    )
    if not preview.valid:
        tool_call = _record_tool_call(
            session,
            conversation_id=request.conversation_id,
            tool_name=tool_name,
            status="validation_failed",
            arguments=preview.normalized_arguments,
            result={"errors": preview.errors, "warnings": preview.warnings},
        )
        return AssistantToolExecutionOut(
            tool_name=tool_name,
            executed=False,
            status="validation_failed",
            requires_confirmation=spec.requires_confirmation,
            confirmation_id=request.confirmation_id,
            tool_call_id=tool_call.id,
            normalized_arguments=preview.normalized_arguments,
            result=preview.preview,
            warnings=preview.warnings,
            errors=preview.errors,
        )

    confirmation: AssistantConfirmation | None = None
    confirmation_errors: list[str] = []
    if spec.side_effect:
        confirmation, confirmation_errors = _confirmation_allows_execution(
            session,
            tool_name=tool_name,
            confirmation_id=request.confirmation_id,
            normalized_arguments=preview.normalized_arguments,
        )
        if confirmation_errors:
            tool_call = _record_tool_call(
                session,
                conversation_id=request.conversation_id,
                tool_name=tool_name,
                status="confirmation_required",
                arguments=preview.normalized_arguments,
                result={"errors": confirmation_errors},
            )
            return AssistantToolExecutionOut(
                tool_name=tool_name,
                executed=False,
                status="confirmation_required",
                requires_confirmation=True,
                confirmation_id=request.confirmation_id,
                tool_call_id=tool_call.id,
                normalized_arguments=preview.normalized_arguments,
                result=preview.preview,
                warnings=preview.warnings,
                errors=confirmation_errors,
            )

        if tool_name in {"create_experiment", "run_simulation"}:
            result = (
                _execute_create_experiment(session, preview.normalized_arguments)
                if tool_name == "create_experiment"
                else _execute_run_simulation(session, preview.normalized_arguments)
            )
            tool_call = _record_tool_call(
                session,
                conversation_id=request.conversation_id,
                tool_name=tool_name,
                status="executed",
                arguments=preview.normalized_arguments,
                result=result,
            )
            if confirmation:
                _mark_confirmation_used(session, confirmation, tool_call_id=tool_call.id)
            provenance = record_provenance(
                session,
                conversation_id=request.conversation_id,
                message_id=None,
                provider_id="assistant_harness",
                model="tool_adapter",
                request={
                    "tool_name": tool_name,
                    "arguments": preview.normalized_arguments,
                    "confirmation_id": request.confirmation_id,
                },
                response={"status": "executed", "result_keys": sorted(result.keys())},
            )
            return AssistantToolExecutionOut(
                tool_name=tool_name,
                executed=True,
                status="executed",
                requires_confirmation=True,
                confirmation_id=request.confirmation_id,
                tool_call_id=tool_call.id,
                provenance_id=provenance.id,
                normalized_arguments=preview.normalized_arguments,
                result=result,
                warnings=preview.warnings,
                errors=[],
            )

        adapter_error = f"Tool '{tool_name}' has an approved confirmation, but side-effect execution is not enabled yet."
        tool_call = _record_tool_call(
            session,
            conversation_id=request.conversation_id,
            tool_name=tool_name,
            status="adapter_not_enabled",
            arguments=preview.normalized_arguments,
            result={"errors": [adapter_error], "confirmation_id": confirmation.id if confirmation else None},
        )
        provenance = record_provenance(
            session,
            conversation_id=request.conversation_id,
            message_id=None,
            provider_id="assistant_harness",
            model="tool_adapter",
            request={
                "tool_name": tool_name,
                "arguments": preview.normalized_arguments,
                "confirmation_id": request.confirmation_id,
            },
            response={"status": "adapter_not_enabled", "errors": [adapter_error]},
        )
        return AssistantToolExecutionOut(
            tool_name=tool_name,
            executed=False,
            status="adapter_not_enabled",
            requires_confirmation=True,
            confirmation_id=request.confirmation_id,
            tool_call_id=tool_call.id,
            provenance_id=provenance.id,
            normalized_arguments=preview.normalized_arguments,
            result=preview.preview,
            warnings=preview.warnings,
            errors=[adapter_error],
        )

    if tool_name != "inspect_result":
        raise HTTPException(status_code=404, detail=f"No execution adapter registered for '{tool_name}'.")

    result = _execute_inspect_result(session, preview.normalized_arguments)
    tool_call = _record_tool_call(
        session,
        conversation_id=request.conversation_id,
        tool_name=tool_name,
        status="executed",
        arguments=preview.normalized_arguments,
        result=result,
    )
    provenance = record_provenance(
        session,
        conversation_id=request.conversation_id,
        message_id=None,
        provider_id="assistant_harness",
        model="tool_adapter",
        request={"tool_name": tool_name, "arguments": preview.normalized_arguments},
        response={"status": "executed", "result_keys": sorted(result.keys())},
    )
    return AssistantToolExecutionOut(
        tool_name=tool_name,
        executed=True,
        status="executed",
        requires_confirmation=False,
        confirmation_id=None,
        tool_call_id=tool_call.id,
        provenance_id=provenance.id,
        normalized_arguments=preview.normalized_arguments,
        result=result,
        warnings=preview.warnings,
        errors=[],
    )


def conversation_to_out(record: AssistantConversation) -> AssistantConversationOut:
    return AssistantConversationOut(
        id=record.id or 0,
        title=record.title,
        assistant_surface=record.assistant_surface,  # type: ignore[arg-type]
        status=record.status,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


def message_to_out(record: AssistantMessage) -> AssistantMessageOut:
    return AssistantMessageOut(
        id=record.id or 0,
        conversation_id=record.conversation_id,
        role=record.role,  # type: ignore[arg-type]
        content=record.content,
        context=AssistantContext.model_validate(from_json(record.context_json, {})),
        status=record.status,
        created_at=record.created_at,
    )


def confirmation_to_out(record: AssistantConfirmation) -> ConfirmationOut:
    return ConfirmationOut(
        id=record.id or 0,
        conversation_id=record.conversation_id,
        tool_call_id=record.tool_call_id,
        action=record.action,
        status=record.status,  # type: ignore[arg-type]
        payload=from_json(record.payload_json, {}),
        note=record.note,
        created_at=record.created_at,
        resolved_at=record.resolved_at,
    )


def provenance_to_out(record: AssistantProvenance) -> ProvenanceOut:
    return ProvenanceOut(
        id=record.id or 0,
        conversation_id=record.conversation_id,
        message_id=record.message_id,
        provider_id=record.provider_id,
        model=record.model,
        prompt_hash=record.prompt_hash,
        request=from_json(record.request_json, {}),
        response=from_json(record.response_json, {}),
        created_at=record.created_at,
    )


def tool_call_to_out(record: AssistantToolCall) -> AssistantToolCallOut:
    return AssistantToolCallOut(
        id=record.id or 0,
        conversation_id=record.conversation_id or None,
        message_id=record.message_id,
        tool_name=record.tool_name,
        status=record.status,
        arguments=from_json(record.arguments_json, {}),
        result=from_json(record.result_json, {}),
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


def create_conversation(session: Session, data: AssistantConversationCreate) -> AssistantConversation:
    title = data.title.strip() or "New assistant conversation"
    timestamp = now_iso()
    conversation = AssistantConversation(
        title=title,
        assistant_surface=data.assistant_surface,
        status="open",
        created_at=timestamp,
        updated_at=timestamp,
    )
    session.add(conversation)
    session.commit()
    session.refresh(conversation)
    return conversation


def store_message(
    session: Session,
    conversation: AssistantConversation,
    role: AssistantMessageRole,
    content: str,
    context: AssistantContext,
    status: str = "stored",
) -> AssistantMessage:
    timestamp = now_iso()
    message = AssistantMessage(
        conversation_id=conversation.id or 0,
        role=role,
        content=content.strip(),
        context_json=to_json(context.model_dump()),
        status=status,
        created_at=timestamp,
    )
    conversation.updated_at = timestamp
    session.add(conversation)
    session.add(message)
    session.commit()
    session.refresh(message)
    return message


def record_provenance(
    session: Session,
    *,
    conversation_id: int | None,
    message_id: int | None,
    provider_id: str,
    model: str,
    request: dict[str, Any],
    response: dict[str, Any],
) -> AssistantProvenance:
    prompt_payload = to_json({"request": request, "provider_id": provider_id, "model": model})
    record = AssistantProvenance(
        conversation_id=conversation_id,
        message_id=message_id,
        provider_id=provider_id,
        model=model,
        prompt_hash=hashlib.sha256(prompt_payload.encode("utf-8")).hexdigest(),
        request_json=to_json(request),
        response_json=to_json(response),
        created_at=now_iso(),
    )
    session.add(record)
    session.commit()
    session.refresh(record)
    return record


def create_confirmation(session: Session, data: ConfirmationCreate) -> AssistantConfirmation:
    if data.action not in CONFIRMATION_REQUIRED_ACTIONS:
        raise HTTPException(status_code=422, detail=f"Unknown confirmation action '{data.action}'.")
    timestamp = now_iso()
    confirmation = AssistantConfirmation(
        conversation_id=data.conversation_id,
        tool_call_id=data.tool_call_id,
        action=data.action,
        status="pending",
        payload_json=to_json(data.payload),
        created_at=timestamp,
        resolved_at="",
    )
    session.add(confirmation)
    session.commit()
    session.refresh(confirmation)
    return confirmation


def resolve_confirmation(
    session: Session,
    confirmation: AssistantConfirmation,
    data: ConfirmationResolve,
) -> AssistantConfirmation:
    if confirmation.status != "pending":
        raise HTTPException(status_code=409, detail="Only pending confirmations can be resolved.")
    confirmation.status = data.status
    confirmation.note = data.note.strip()
    confirmation.resolved_at = now_iso()
    session.add(confirmation)
    session.commit()
    session.refresh(confirmation)
    return confirmation
