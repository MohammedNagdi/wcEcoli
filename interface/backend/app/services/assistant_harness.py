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
from sqlmodel import Session

from app.config import settings
from app.db.models import (
    AssistantConfirmation,
    AssistantConversation,
    AssistantMessage,
    AssistantProvenance,
)


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
AssistantState = Literal["scaffolded_disabled", "provider_configured_tools_disabled"]
AssistantMessageRole = Literal["user", "assistant", "system"]
ConfirmationStatus = Literal["pending", "approved", "rejected", "cancelled"]


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
    for definition in PROVIDER_DEFINITIONS:
        secret_value = getattr(settings, definition.secret_setting, "") if definition.secret_setting else ""
        endpoint_value = getattr(settings, definition.endpoint_setting, "") if definition.endpoint_setting else ""
        secret_is_configured = configured(secret_value)
        endpoint_is_configured = configured(endpoint_value)
        is_configured = secret_is_configured or endpoint_is_configured
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
            "Health checks are intentionally non-networked at this layer; future adapters can add provider-specific checks.",
            "The scientific platform remains usable when no LLM provider is configured.",
        ],
    )


def get_tool_registry() -> list[AssistantToolSpec]:
    return [
        AssistantToolSpec(
            name="create_experiment",
            label="Create experiment draft",
            description="Prepare a draft experiment from validated variant, condition, timeline, and simulation parameters.",
            status="registered_disabled",
            requires_confirmation=True,
            side_effect=True,
            argument_schema={
                "variant_type": "string",
                "variant_index": "integer",
                "condition": "string",
                "timeline": "string",
                "sim_params": "object",
            },
            result_schema={"experiment_id": "integer", "status": "draft"},
        ),
        AssistantToolSpec(
            name="run_simulation",
            label="Run simulation",
            description="Queue a saved experiment for execution through the simulation worker.",
            status="registered_disabled",
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
            status="registered_disabled",
            requires_confirmation=False,
            side_effect=False,
            argument_schema={"job_id": "integer", "gene": "string"},
            result_schema={"summary": "object", "links": "array"},
        ),
    ]


def get_assistant_harness_status() -> AssistantHarnessStatus:
    provider_configured = get_provider_layer_status().configured_provider_count > 0
    return AssistantHarnessStatus(
        state="provider_configured_tools_disabled" if provider_configured else "scaffolded_disabled",
        provider_required=True,
        provider_configured=provider_configured,
        tool_execution_enabled=False,
        db_persistence_enabled=True,
        confirmation_required_for=CONFIRMATION_REQUIRED_ACTIONS,
        context_contract=CONTEXT_CONTRACT,
        visible_artifacts=VISIBLE_ARTIFACTS,
        tool_registry=get_tool_registry(),
        notes=[
            "This is the durable harness foundation, not a live LLM runtime.",
            "Messages, confirmations, and provenance can be stored before tool execution is enabled.",
            "Future execution must use registered typed tools and explicit confirmation for side effects.",
        ],
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
