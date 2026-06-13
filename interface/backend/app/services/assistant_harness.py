"""Assistant provider and typed harness foundation.

This module deliberately avoids making LLM calls. It defines the provider
registry, context contract, tool metadata, and persistence helpers that future
assistant execution will use.
"""

from __future__ import annotations

import hashlib
import json
import re
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from fastapi import HTTPException
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from app.config import settings
from app.db.models import (
    AssistantConfirmation,
    AssistantConversation,
    AssistantMessage,
    AssistantProviderConfig,
    AssistantProvenance,
    AssistantRuntimeSettings,
    AssistantToolCall,
    BuilderSectionDraft,
    Condition,
    Experiment,
    Gene,
    MediaRecipe,
    SimulationJob,
    SimulationResult,
    TFEdge,
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
    "selected_condition",
    "selected_variant_type",
    "selected_builder_section",
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
    "save_condition",
    "save_timeline",
    "save_recipe",
    "save_tf_condition",
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
    selected_provider_id: str = ""
    active_runtime_provider_id: str = ""
    active_runtime_model: str = ""
    runtime_ready: bool = False
    runtime_issue: str = ""
    providers: list[ProviderStatus]
    notes: list[str]


class AssistantProviderConfigOut(BaseModel):
    provider_id: str
    label: str
    category: ProviderCategory
    configured: bool
    secret_configured: bool
    endpoint_configured: bool
    endpoint_url: str = ""
    model: str = ""
    is_active: bool = False
    runtime_supported: bool = False
    default_model: str = ""
    requires_secret: bool = False
    requires_endpoint: bool = False
    configuration_hint: str = ""
    updated_at: str = ""


class AssistantProviderConfigUpdate(BaseModel):
    api_key: str = ""
    endpoint_url: str = ""
    model: str = ""
    label: str = ""
    make_active: bool = True


class OllamaModelOut(BaseModel):
    name: str
    model: str = ""
    family: str = ""
    parameter_size: str = ""
    quantization_level: str = ""
    size: int | None = None
    modified_at: str = ""


class OllamaModelListOut(BaseModel):
    endpoint_url: str
    reachable: bool
    models: list[OllamaModelOut] = Field(default_factory=list)
    error: str = ""


PermissionTier = Literal["read_only", "draft", "queue", "publish_destructive"]

# Policy as data: which tiers require explicit user confirmation, and a human label.
PERMISSION_POLICY: dict[str, dict[str, Any]] = {
    "read_only": {"requires_confirmation": False, "label": "Read-only — runs on click, no data changes."},
    "draft": {"requires_confirmation": True, "label": "Creates a draft — needs confirmation."},
    "queue": {"requires_confirmation": True, "label": "Queues compute — needs confirmation."},
    "publish_destructive": {"requires_confirmation": True, "label": "Publishes/overwrites — needs confirmation."},
}


def tier_requires_confirmation(tier: str) -> bool:
    return PERMISSION_POLICY.get(tier, PERMISSION_POLICY["publish_destructive"])["requires_confirmation"]


class AssistantToolSpec(BaseModel):
    name: str
    label: str
    description: str
    status: str
    requires_confirmation: bool
    side_effect: bool
    permission_tier: PermissionTier = "read_only"
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
    permission_policy: dict[str, Any] = Field(default_factory=dict)
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
    selected_condition: str | None = None
    selected_variant_type: str | None = None
    selected_builder_section: str | None = None
    assistant_surface: AssistantSurface = "central"


class AssistantConversationCreate(BaseModel):
    title: str = "New assistant conversation"
    assistant_surface: AssistantSurface = "central"
    context: AssistantContext = Field(default_factory=AssistantContext)


class AssistantConversationUpdate(BaseModel):
    title: str


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


class AssistantExchangeOut(BaseModel):
    conversation: AssistantConversationOut
    user_message: AssistantMessageOut
    assistant_message: AssistantMessageOut
    provenance_id: int
    pending_confirmations: list[int] = Field(default_factory=list)
    tool_calls: list[int] = Field(default_factory=list)
    proposals: list[AssistantToolCallOut] = Field(default_factory=list)


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
    expires_at: str = ""
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


def _provider_definition(provider_id: str) -> ProviderDefinition | None:
    return next((definition for definition in PROVIDER_DEFINITIONS if definition.provider_id == provider_id), None)


def _provider_configs_by_id(session: Session | None) -> dict[str, AssistantProviderConfig]:
    if session is None:
        return {}
    records = session.exec(select(AssistantProviderConfig)).all()
    return {record.provider_id: record for record in records}


def _active_provider_config(session: Session | None) -> AssistantProviderConfig | None:
    if session is None:
        return None
    return session.exec(
        select(AssistantProviderConfig)
        .where(AssistantProviderConfig.is_active == True)  # noqa: E712
        .order_by(AssistantProviderConfig.updated_at.desc())
    ).first()


def _provider_secret_configured(
    definition: ProviderDefinition,
    config: AssistantProviderConfig | None,
) -> bool:
    if config and configured(config.secret_value):
        return True
    secret_value = getattr(settings, definition.secret_setting, "") if definition.secret_setting else ""
    return configured(secret_value)


def _provider_endpoint_configured(
    definition: ProviderDefinition,
    config: AssistantProviderConfig | None,
) -> bool:
    if config and configured(config.endpoint_url):
        return True
    endpoint_value = getattr(settings, definition.endpoint_setting, "") if definition.endpoint_setting else ""
    return configured(endpoint_value)


def _provider_model(definition: ProviderDefinition, config: AssistantProviderConfig | None) -> str:
    runtime_spec = RUNTIME_PROVIDER_SPECS.get(definition.provider_id)
    if config and config.model:
        return config.model.strip()
    if settings.assistant_model:
        return settings.assistant_model.strip()
    return (runtime_spec.default_model if runtime_spec else "").strip()


def _provider_configured_for_status(
    definition: ProviderDefinition,
    config: AssistantProviderConfig | None,
) -> bool:
    secret_is_configured = _provider_secret_configured(definition, config)
    endpoint_is_configured = _provider_endpoint_configured(definition, config)
    runtime_spec = RUNTIME_PROVIDER_SPECS.get(definition.provider_id)
    if runtime_spec and runtime_spec.secret_setting:
        return secret_is_configured
    if runtime_spec and runtime_spec.endpoint_setting and not runtime_spec.secret_setting:
        return endpoint_is_configured
    return secret_is_configured or endpoint_is_configured


def get_provider_statuses(session: Session | None = None) -> list[ProviderStatus]:
    statuses: list[ProviderStatus] = []
    configs_by_id = _provider_configs_by_id(session)
    active_config = _active_provider_config(session)
    selected_provider = active_config.provider_id if active_config else (settings.assistant_provider or "").strip()
    for definition in PROVIDER_DEFINITIONS:
        config = configs_by_id.get(definition.provider_id)
        secret_is_configured = _provider_secret_configured(definition, config)
        endpoint_is_configured = _provider_endpoint_configured(definition, config)
        is_configured = _provider_configured_for_status(definition, config)
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
                default_model=_provider_model(definition, config),
                selected_for_runtime=selected_provider == definition.provider_id,
            )
        )
    return statuses


def get_provider_layer_status(session: Session | None = None) -> ProviderLayerStatus:
    providers = get_provider_statuses(session)
    configured_count = sum(1 for provider in providers if provider.configured)
    active_config = _active_provider_config(session)
    selected_provider = active_config.provider_id if active_config else (settings.assistant_provider or "").strip()
    runtime_provider_id = ""
    runtime_model = ""
    runtime_ready = False
    runtime_issue = ""

    if selected_provider:
        selected_status = next((provider for provider in providers if provider.provider_id == selected_provider), None)
        runtime_spec = RUNTIME_PROVIDER_SPECS.get(selected_provider)
        if not selected_status:
            runtime_issue = f"Selected provider '{selected_provider}' is not registered."
        elif not runtime_spec:
            runtime_issue = f"Selected provider '{selected_provider}' has no runtime adapter yet."
        elif not selected_status.configured:
            runtime_provider_id = selected_provider
            runtime_model = selected_status.default_model or runtime_spec.default_model
            runtime_issue = f"Selected provider '{selected_provider}' is not configured."
        else:
            runtime_provider_id = selected_provider
            runtime_model = selected_status.default_model or runtime_spec.default_model
            runtime_ready = True
    else:
        for provider in providers:
            runtime_spec = RUNTIME_PROVIDER_SPECS.get(provider.provider_id)
            if provider.configured and runtime_spec:
                runtime_provider_id = provider.provider_id
                runtime_model = provider.default_model or runtime_spec.default_model
                runtime_ready = True
                break
        if not runtime_ready:
            runtime_issue = "No provider key or local endpoint is configured."

    return ProviderLayerStatus(
        mode="bring_your_own_key_or_local_endpoint",
        configured_provider_count=configured_count,
        selected_provider_id=selected_provider,
        active_runtime_provider_id=runtime_provider_id,
        active_runtime_model=runtime_model,
        runtime_ready=runtime_ready,
        runtime_issue=runtime_issue,
        providers=providers,
        notes=[
            "Provider status reports configuration presence only; API keys are never returned.",
            "Runtime support indicates whether the assistant can call that provider without exposing tools.",
            "Browser-saved provider setup is local to this installation and takes precedence over environment variables.",
            "Status checks are intentionally non-networked; provider calls happen only when a user sends an assistant message.",
            "The scientific platform remains usable when no LLM provider is configured.",
        ],
    )


def provider_configs_to_out(session: Session) -> list[AssistantProviderConfigOut]:
    configs_by_id = _provider_configs_by_id(session)
    outputs: list[AssistantProviderConfigOut] = []
    for definition in PROVIDER_DEFINITIONS:
        config = configs_by_id.get(definition.provider_id)
        runtime_spec = RUNTIME_PROVIDER_SPECS.get(definition.provider_id)
        outputs.append(
            AssistantProviderConfigOut(
                provider_id=definition.provider_id,
                label=definition.label,
                category=definition.category,
                configured=_provider_configured_for_status(definition, config),
                secret_configured=_provider_secret_configured(definition, config),
                endpoint_configured=_provider_endpoint_configured(definition, config),
                endpoint_url=config.endpoint_url if config else (
                    getattr(settings, definition.endpoint_setting, "") if definition.endpoint_setting else ""
                ),
                model=_provider_model(definition, config),
                is_active=bool(config and config.is_active),
                runtime_supported=runtime_spec is not None,
                default_model=runtime_spec.default_model if runtime_spec else "",
                requires_secret=bool(runtime_spec and runtime_spec.secret_setting),
                requires_endpoint=bool(runtime_spec and runtime_spec.endpoint_setting and not runtime_spec.secret_setting),
                configuration_hint=definition.configuration_hint,
                updated_at=config.updated_at if config else "",
            )
        )
    return outputs


def upsert_provider_config(
    session: Session,
    provider_id: str,
    data: AssistantProviderConfigUpdate,
) -> AssistantProviderConfig:
    definition = _provider_definition(provider_id)
    if not definition:
        raise HTTPException(status_code=404, detail=f"Unknown assistant provider '{provider_id}'.")
    if provider_id not in RUNTIME_PROVIDER_SPECS:
        raise HTTPException(status_code=422, detail=f"Provider '{provider_id}' does not have a runtime adapter.")

    timestamp = now_iso()
    record = session.exec(select(AssistantProviderConfig).where(AssistantProviderConfig.provider_id == provider_id)).first()
    if not record:
        record = AssistantProviderConfig(
            provider_id=provider_id,
            label=data.label.strip() or definition.label,
            created_at=timestamp,
        )
    record.label = data.label.strip() or definition.label
    if data.api_key.strip():
        from app.services.assistant_secrets import encrypt_secret

        record.secret_value = encrypt_secret(data.api_key.strip())
        record.secret_encrypted = True
    record.endpoint_url = data.endpoint_url.strip()
    record.model = data.model.strip()
    record.updated_at = timestamp

    if data.make_active:
        for config in session.exec(select(AssistantProviderConfig)).all():
            config.is_active = False
            session.add(config)
        record.is_active = True

    session.add(record)
    session.commit()
    session.refresh(record)
    return record


def delete_provider_config(session: Session, provider_id: str) -> None:
    record = session.exec(select(AssistantProviderConfig).where(AssistantProviderConfig.provider_id == provider_id)).first()
    if not record:
        return
    session.delete(record)
    session.commit()


def get_ollama_models(
    session: Session,
    endpoint_url: str = "",
) -> OllamaModelListOut:
    config = session.exec(select(AssistantProviderConfig).where(AssistantProviderConfig.provider_id == "ollama")).first()
    resolved_endpoint = (
        endpoint_url.strip()
        or (config.endpoint_url.strip() if config else "")
        or settings.ollama_base_url.strip()
        or "http://host.docker.internal:11434"
    ).rstrip("/")
    try:
        with urllib.request.urlopen(f"{resolved_endpoint}/api/tags", timeout=5) as response:
            raw = response.read().decode("utf-8")
        payload = json.loads(raw or "{}")
        models: list[OllamaModelOut] = []
        for item in payload.get("models", []):
            if not isinstance(item, dict):
                continue
            details = item.get("details", {}) if isinstance(item.get("details"), dict) else {}
            models.append(
                OllamaModelOut(
                    name=str(item.get("name") or item.get("model") or ""),
                    model=str(item.get("model") or item.get("name") or ""),
                    family=str(details.get("family") or ""),
                    parameter_size=str(details.get("parameter_size") or ""),
                    quantization_level=str(details.get("quantization_level") or ""),
                    size=item.get("size") if isinstance(item.get("size"), int) else None,
                    modified_at=str(item.get("modified_at") or ""),
                )
            )
        return OllamaModelListOut(endpoint_url=resolved_endpoint, reachable=True, models=models)
    except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
        return OllamaModelListOut(
            endpoint_url=resolved_endpoint,
            reachable=False,
            models=[],
            error=f"{type(exc).__name__}: {exc}",
        )


# ── Runtime settings (DB-backed overrides applied over env) ──────────────────

# DB column -> settings attribute it overrides.
RUNTIME_SETTING_FIELDS = {
    "request_timeout_sec": "assistant_request_timeout_sec",
    "local_timeout_sec": "assistant_local_timeout_sec",
    "ollama_keep_alive": "assistant_ollama_keep_alive",
    "max_agent_turns": "assistant_max_agent_turns",
    "keep_recent_turns": "assistant_keep_recent_turns",
    "compact_threshold": "assistant_compact_threshold",
    "context_token_budget": "assistant_context_token_budget",
    "confirmation_ttl_sec": "assistant_confirmation_ttl_sec",
    "summary_model": "assistant_summary_model",
}

_INT_SETTING_BOUNDS = {
    "request_timeout_sec": (5, 600),
    "local_timeout_sec": (30, 1800),
    "max_agent_turns": (1, 12),
    "keep_recent_turns": (2, 50),
    "compact_threshold": (1, 50),
    "context_token_budget": (500, 20000),
    "confirmation_ttl_sec": (30, 86400),
}


class AssistantRuntimeSettingsOut(BaseModel):
    request_timeout_sec: int
    local_timeout_sec: int
    ollama_keep_alive: str
    max_agent_turns: int
    keep_recent_turns: int
    compact_threshold: int
    context_token_budget: int
    confirmation_ttl_sec: int
    summary_model: str
    updated_at: str


class AssistantRuntimeSettingsUpdate(BaseModel):
    request_timeout_sec: int | None = None
    local_timeout_sec: int | None = None
    ollama_keep_alive: str | None = None
    max_agent_turns: int | None = None
    keep_recent_turns: int | None = None
    compact_threshold: int | None = None
    context_token_budget: int | None = None
    confirmation_ttl_sec: int | None = None
    summary_model: str | None = None


def _get_or_create_runtime_settings(session: Session) -> AssistantRuntimeSettings:
    row = session.get(AssistantRuntimeSettings, 1)
    if row:
        return row
    row = AssistantRuntimeSettings(
        id=1,
        request_timeout_sec=int(settings.assistant_request_timeout_sec or 30),
        local_timeout_sec=int(settings.assistant_local_timeout_sec or 300),
        ollama_keep_alive=settings.assistant_ollama_keep_alive or "30m",
        max_agent_turns=int(settings.assistant_max_agent_turns or 6),
        keep_recent_turns=int(settings.assistant_keep_recent_turns or 12),
        compact_threshold=int(settings.assistant_compact_threshold or 6),
        context_token_budget=int(settings.assistant_context_token_budget or 3500),
        confirmation_ttl_sec=int(settings.assistant_confirmation_ttl_sec or 900),
        summary_model=settings.assistant_summary_model or "",
        updated_at=now_iso(),
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    return row


def apply_runtime_settings_to_env(row: AssistantRuntimeSettings) -> None:
    """Mutate the global settings singleton so all `settings.assistant_*` reads see the overrides."""
    for db_field, attr in RUNTIME_SETTING_FIELDS.items():
        setattr(settings, attr, getattr(row, db_field))


def _runtime_settings_out(row: AssistantRuntimeSettings) -> AssistantRuntimeSettingsOut:
    return AssistantRuntimeSettingsOut(
        request_timeout_sec=row.request_timeout_sec,
        local_timeout_sec=row.local_timeout_sec,
        ollama_keep_alive=row.ollama_keep_alive,
        max_agent_turns=row.max_agent_turns,
        keep_recent_turns=row.keep_recent_turns,
        compact_threshold=row.compact_threshold,
        context_token_budget=row.context_token_budget,
        confirmation_ttl_sec=row.confirmation_ttl_sec,
        summary_model=row.summary_model,
        updated_at=row.updated_at,
    )


def get_runtime_settings(session: Session) -> AssistantRuntimeSettingsOut:
    row = _get_or_create_runtime_settings(session)
    apply_runtime_settings_to_env(row)
    return _runtime_settings_out(row)


def update_runtime_settings(session: Session, data: AssistantRuntimeSettingsUpdate) -> AssistantRuntimeSettingsOut:
    row = _get_or_create_runtime_settings(session)
    for field, value in data.model_dump(exclude_none=True).items():
        if field in _INT_SETTING_BOUNDS:
            low, high = _INT_SETTING_BOUNDS[field]
            value = max(low, min(high, int(value)))
        setattr(row, field, value)
    row.updated_at = now_iso()
    session.add(row)
    session.commit()
    session.refresh(row)
    apply_runtime_settings_to_env(row)
    return _runtime_settings_out(row)


def get_tool_registry() -> list[AssistantToolSpec]:
    return [
        AssistantToolSpec(
            name="create_experiment",
            label="Create experiment draft",
            description="Prepare a draft experiment from validated variant, condition, timeline, and simulation parameters.",
            status="confirmation_execution_enabled",
            requires_confirmation=True,
            side_effect=True,
            permission_tier="draft",
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
            permission_tier="queue",
            argument_schema={"experiment_id": "integer", "seed": "integer", "generations": "integer"},
            result_schema={"job_id": "integer", "status": "pending"},
        ),
        AssistantToolSpec(
            name="save_condition",
            label="Save condition draft",
            description=(
                "Prepare a Conditions Builder *condition* draft (nutrients/media recipe, doubling time, "
                "active/inactive transcription factors, genotype perturbations) for the user to review and "
                "publish. Use this when the user wants to create or edit a growth condition or recipe and apply "
                "it. Optionally clone an existing condition with `base_condition` and override only what changes. "
                "This does NOT publish to the reconstruction — it creates a reviewable draft; the user publishes "
                "from the Conditions Builder. Read current conditions/recipes with `list_conditions` first."
            ),
            status="confirmation_execution_enabled",
            requires_confirmation=True,
            side_effect=True,
            permission_tier="draft",
            argument_schema={
                "name": "string",
                "nutrients": "string",
                "doubling_time": "number",
                "active_tfs": "array",
                "inactive_tfs": "array",
                "genotype_perturbations": "object",
                "base_condition": "string",
            },
            result_schema={"draft_id": "integer", "status": "draft"},
        ),
        AssistantToolSpec(
            name="save_timeline",
            label="Save timeline draft",
            description=(
                "Prepare a Conditions Builder *timeline* draft — a media-shift schedule as an event string like "
                "'0 minimal, 1200 minimal_acetate' (time in seconds -> media id). Use when the user wants to create "
                "a time-varying protocol. Read existing timelines/recipes with `list_conditions` first so the media "
                "ids are real. Writes a reviewable draft, not a published file."
            ),
            status="confirmation_execution_enabled",
            requires_confirmation=True,
            side_effect=True,
            permission_tier="draft",
            argument_schema={"name": "string", "events": "string"},
            result_schema={"draft_id": "integer", "status": "draft"},
        ),
        AssistantToolSpec(
            name="save_recipe",
            label="Save media-recipe draft",
            description=(
                "Prepare a Conditions Builder *media-recipe* draft: a media formulation id built from a base growth "
                "medium (and optional added medium + extra ingredient molecule ids). Use when the user wants to "
                "define a new medium recipe. Read existing media stocks/recipes with `list_conditions` first so "
                "`base_media` is a real medium. Writes a reviewable draft, not a published file."
            ),
            status="confirmation_execution_enabled",
            requires_confirmation=True,
            side_effect=True,
            permission_tier="draft",
            argument_schema={
                "media_id": "string",
                "base_media": "string",
                "added_media": "string",
                "ingredients": "array",
            },
            result_schema={"draft_id": "integer", "status": "draft"},
        ),
        AssistantToolSpec(
            name="save_tf_condition",
            label="Save TF-condition draft",
            description=(
                "Prepare a Conditions Builder *TF-condition* draft — a transcription-factor regulation rule: which "
                "TF is active vs inactive under which media (nutrients) and its TF type. Use when the user wants to "
                "add a TF regulation rule. Read existing TF rules/recipes with `list_conditions` first so the "
                "active/inactive nutrients are real media recipes. Writes a reviewable draft, not a published file."
            ),
            status="confirmation_execution_enabled",
            requires_confirmation=True,
            side_effect=True,
            permission_tier="draft",
            argument_schema={
                "name": "string",
                "tf": "string",
                "active_tf": "string",
                "active_nutrients": "string",
                "inactive_nutrients": "string",
                "tf_type": "string",
                "active_genotype_perturbations": "object",
                "inactive_genotype_perturbations": "object",
            },
            result_schema={"draft_id": "integer", "status": "draft"},
        ),
        AssistantToolSpec(
            name="publish_environment_builder_artifact",
            label="Publish builder artifact",
            description="Publish a saved Conditions Builder draft to the local reconstruction files.",
            status="registered_disabled",
            requires_confirmation=True,
            side_effect=True,
            permission_tier="publish_destructive",
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
        AssistantToolSpec(
            name="inspect_gene",
            label="Inspect gene",
            description="Read validated Genes Table metadata for a gene and return model-state links plus safe follow-up targets.",
            status="execution_enabled",
            requires_confirmation=False,
            side_effect=False,
            argument_schema={"gene": "string"},
            result_schema={"gene": "object", "links": "array"},
        ),
        AssistantToolSpec(
            name="gene_catalog",
            label="Gene catalog summary",
            description=(
                "Count and summarize the genes supported in the platform. Optionally filter by functional category "
                "or a symbol/name search. Use this for questions like 'how many genes are supported' or 'which "
                "knockout-ready genes exist'. Returns totals and a matching subset, not per-gene mechanistic detail."
            ),
            status="execution_enabled",
            requires_confirmation=False,
            side_effect=False,
            argument_schema={"category": "string", "search": "string", "limit": "integer"},
            result_schema={"totals": "object", "genes": "array"},
        ),
        AssistantToolSpec(
            name="inspect_tf_network",
            label="Inspect TF regulation network",
            description=(
                "Read the transcription-factor regulation neighborhood of a gene from the curated TF edge table: "
                "upstream regulators and downstream targets with log2 fold-change and activation/repression direction. "
                "Backs the Network page and the Workspace TF mini-network."
            ),
            status="execution_enabled",
            requires_confirmation=False,
            side_effect=False,
            argument_schema={"gene": "string", "limit": "integer"},
            result_schema={"regulators": "array", "targets": "array"},
        ),
        AssistantToolSpec(
            name="list_conditions",
            label="List growth conditions",
            description=(
                "Read the Conditions Builder surface in full: growth conditions (nutrients, active/inactive "
                "transcription factors, genotype perturbations, doubling time), media-recipe compositions (base/added "
                "media + ingredients), timelines WITH their event schedule (media shifts over time), and "
                "TF-condition rules (which TF is active/inactive under which nutrients, and TF type). Use for any "
                "question about conditions, recipes, timelines, or TF regulation rules. Optional name search."
            ),
            status="execution_enabled",
            requires_confirmation=False,
            side_effect=False,
            argument_schema={"search": "string", "limit": "integer"},
            result_schema={"totals": "object", "conditions": "array"},
        ),
        AssistantToolSpec(
            name="list_experiments",
            label="List experiments",
            description=(
                "Summarize experiments in the Experiments page: counts by status, batch groupings, and a recent "
                "subset. Optional filter by status or batch_id. Read-only; does not create or queue anything."
            ),
            status="execution_enabled",
            requires_confirmation=False,
            side_effect=False,
            argument_schema={"status": "string", "batch_id": "string", "limit": "integer"},
            result_schema={"totals": "object", "experiments": "array"},
        ),
        AssistantToolSpec(
            name="inspect_experiment",
            label="Inspect experiment",
            description=(
                "Read one experiment's definition (variant, condition, timeline, sim params, gene target) plus a "
                "summary of its simulation jobs and result metrics. Use before proposing to run or compare it."
            ),
            status="execution_enabled",
            requires_confirmation=False,
            side_effect=False,
            argument_schema={"experiment_id": "integer"},
            result_schema={"experiment": "object", "jobs": "array"},
        ),
        AssistantToolSpec(
            name="model_structure",
            label="Query model structure",
            description=(
                "Look up the STATIC metabolic model structure (not dynamics): reactions by id, reactions that a "
                "gene's enzyme catalyzes, or reactions involving a metabolite — with stoichiometry, reversibility, "
                "and catalysts, plus whole-network totals (reactions, reversible split, FBA-expanded flux count). "
                "Use for 'what reactions involve X', 'what does enzyme/gene Y catalyze', 'is reaction R reversible', "
                "'how many reactions are there'. For dynamic values (fluxes/counts over time) run a simulation and "
                "inspect the result instead — structure here is condition-independent."
            ),
            status="execution_enabled",
            requires_confirmation=False,
            side_effect=False,
            argument_schema={"query": "string", "kind": "string", "limit": "integer"},
            result_schema={"reactions": "array", "network_totals": "object"},
        ),
        AssistantToolSpec(
            name="explain_modeling",
            label="Explain the model & FBA",
            description=(
                "Explain what the whole-cell model represents and how: dynamic state variables vs FBA-derived "
                "terms, what Flux Balance Analysis is and what each of its terms does, what the mechanistic "
                "processes (transcription, translation, complexation, metabolism) describe, and what the Molecule "
                "Explorer output series/trajectories mean. Use this for conceptual 'what is FBA', 'what are reaction "
                "fluxes', 'what do the mechanistic equations describe', or 'what is being modelled' questions. "
                "Optional `topic` narrows the answer. Describe term roles only — do not reproduce literal equations."
            ),
            status="execution_enabled",
            requires_confirmation=False,
            side_effect=False,
            argument_schema={"topic": "string"},
            result_schema={"topic": "string", "explanation": "object"},
        ),
        AssistantToolSpec(
            name="platform_guide",
            label="Platform & page guide",
            description=(
                "Return authoritative descriptions of the platform's pages and the tools available on each: what "
                "the page is for, what data it shows, and which assistant tools apply. Use this for 'what does this "
                "page do', 'explain each page', or 'where do I do X' instead of guessing. Optional `page` arg "
                "(route or name) narrows to one page."
            ),
            status="execution_enabled",
            requires_confirmation=False,
            side_effect=False,
            argument_schema={"page": "string"},
            result_schema={"pages": "array"},
        ),
        AssistantToolSpec(
            name="inspect_molecule_trajectories",
            label="Inspect result trajectories",
            description=(
                "Report the per-molecule trajectory scope of a SINGLE completed job for the Molecule Explorer: how "
                "many lineage trajectories (generations x seeds, including daughter cells) belong to THIS job, and "
                "which molecule IDs map to an optional focus gene. Use this to explain trajectory counts correctly "
                "instead of conflating all results."
            ),
            status="execution_enabled",
            requires_confirmation=False,
            side_effect=False,
            argument_schema={"job_id": "integer", "gene": "string"},
            result_schema={"trajectory_scope": "object", "molecules": "array"},
        ),
        AssistantToolSpec(
            name="list_results",
            label="List results",
            description=(
                "List completed (and optionally pending/running) simulation results — each with its job_id, "
                "experiment, condition, status, and a quick phenotype summary. Use this to FIND a result when the "
                "user asks you to 'pick a result', 'break down the findings', or compare results but none is "
                "currently selected: list them, choose a completed one, then inspect_result/compare_results by "
                "job_id. Optional `status` filter (default completed) and `limit`. Read-only."
            ),
            status="execution_enabled",
            requires_confirmation=False,
            side_effect=False,
            argument_schema={"status": "string", "limit": "integer"},
            result_schema={"totals": "object", "results": "array"},
        ),
        AssistantToolSpec(
            name="compare_results",
            label="Compare results",
            description=(
                "Compare phenotype metrics across MULTIPLE completed results in one call — growth rate, division "
                "time, final mass, and doubling time, aggregated (mean/min/max) per job across its seeds and "
                "generations. Pass `job_ids` and/or `experiment_ids` (experiments expand to their jobs). Use for "
                "'compare WT vs the dnaA knockout', 'which condition grew fastest', or ranking results. Read-only."
            ),
            status="execution_enabled",
            requires_confirmation=False,
            side_effect=False,
            argument_schema={"job_ids": "array", "experiment_ids": "array", "metric": "string"},
            result_schema={"comparison": "array", "ranking": "array"},
        ),
        AssistantToolSpec(
            name="read_result_series",
            label="Read result time-series",
            description=(
                "Read the actual NUMERIC time-series of one output channel for a completed job (the values behind "
                "the Molecule Explorer / phenotype plots) — e.g. cell mass, growth rate, protein/RNA/DNA mass, mRNA "
                "counts. Returns downsampled time/value points plus stats (min/max/mean/first/last). Call with no "
                "`series` (or an unmatched one) to list the available channels first. Flags whether the data is "
                "real simOut or synthetic. Use for 'what was the growth rate over time', 'how did mass change'. "
                "Read-only; for static model structure use model_structure instead."
            ),
            status="execution_enabled",
            requires_confirmation=False,
            side_effect=False,
            argument_schema={"job_id": "integer", "series": "string", "seed": "integer", "max_points": "integer"},
            result_schema={"series": "object", "available_series": "array"},
        ),
    ]


# Read-only tools the agent loop may auto-execute (no confirmation, no side effect).
READ_ONLY_TOOLS = (
    "inspect_result",
    "inspect_gene",
    "gene_catalog",
    "inspect_tf_network",
    "list_conditions",
    "list_experiments",
    "inspect_experiment",
    "inspect_molecule_trajectories",
    "list_results",
    "compare_results",
    "read_result_series",
    "platform_guide",
    "explain_modeling",
    "model_structure",
)


# Curated, authoritative modeling explanations. Describe what each term represents and DOES; never
# reproduce the literal governing equation. Counts are per-cell catalog figures (see output_series).
MODELING_GUARDRAIL = (
    "Explain what each term represents and what it does, and you may give an illustrative example of "
    "the terms — but do NOT write out or reproduce the actual governing differential/stochastic/LP equation."
)

MODELING_TOPICS: dict[str, dict[str, Any]] = {
    "overview": {
        "title": "Whole-cell model overview",
        "summary": (
            "wcEcoli is a hybrid whole-cell model of E. coli K-12 MG1655. Many submodels share one pool of "
            "molecule counts and are advanced together in small time steps. Two regimes coexist: (1) dynamic "
            "state variables — molecule counts that evolve over time and carry memory (gene expression, "
            "complexation, growth); and (2) metabolism, solved each step by Flux Balance Analysis (FBA), which "
            "is an optimization, not an integration."
        ),
        "see_also": ["state_variables", "fba", "processes", "output_series"],
    },
    "state_variables": {
        "title": "Dynamic state variables (counts)",
        "summary": (
            "Molecule counts tracked over time and updated each step by stochastic/ODE-style processes; a value "
            "depends on its history. Plottable families (per cell): protein monomers (~4,310), mRNA transcription "
            "units (~3,133), the same mRNA at gene/cistron granularity (~4,346), rRNA species (~7), homeostatic "
            "metabolite pools (~172), and amino-acid pools (~21) — about 12,000 series, all in molecule-count units."
        ),
        "see_also": ["processes", "output_series"],
    },
    "fba": {
        "title": "Flux Balance Analysis (metabolism)",
        "summary": (
            "Metabolism is solved each time step as a constraint-based optimization, not integrated like a "
            "differential equation. Intuitively: given the enzymes and nutrients available right now, what set of "
            "reaction rates best meets the cell's metabolic demands while no internal metabolite piles up?"
        ),
        "terms": [
            {"term": "stoichiometric matrix", "role": "the fixed wiring of metabolism — which metabolites each reaction consumes and produces."},
            {"term": "flux vector", "role": "the unknowns solved for: one rate per reaction (units mmol/gDCW/h). This is what 'reaction flux' plots show."},
            {"term": "mass-balance constraint", "role": "requires internal metabolites to be produced and consumed at equal rates within a step, so nothing accumulates unphysically."},
            {"term": "flux bounds", "role": "per-reaction lower/upper limits; in wcEcoli they are set from current enzyme counts and turnover rates — this is how metabolism couples to the dynamic state."},
            {"term": "objective", "role": "what the optimization favors — here, producing the biomass/metabolite demands the cell needs to grow at its current rate."},
            {"term": "reversible split", "role": "a reversible reaction is represented as two non-negative fluxes (forward and reverse), which is why the FBA reaction count (~9,612) exceeds the ~6,770 base reactions."},
            {"term": "exchange flux", "role": "boundary reactions importing nutrients or secreting byproducts (~87 series)."},
            {"term": "metabolite delta", "role": "the net change FBA assigns to tracked metabolite pools each step (~172 series)."},
        ],
        "guardrail": MODELING_GUARDRAIL,
        "see_also": ["output_series", "processes"],
    },
    "processes": {
        "title": "Mechanistic processes — what the equations describe",
        "summary": (
            "Each submodel advances specific molecules using a rate law whose TERMS represent biological "
            "quantities. The descriptions below explain what those terms are and do, not the literal formula."
        ),
        "examples": [
            {"process": "transcription", "describes": "RNA polymerase initiating on promoters and elongating RNA. Terms represent available RNA polymerase, promoter strength/regulation (transcription factors, ppGpp), NTP availability, and an elongation rate. Produces mRNA/rRNA/tRNA counts."},
            {"process": "translation", "describes": "ribosomes reading mRNA into protein monomers. Terms represent free-ribosome availability, per-mRNA ribosome loading, amino-acid/charged-tRNA availability, and an elongation rate. Produces protein monomer counts."},
            {"process": "complexation", "describes": "monomers assembling into protein complexes. Terms represent monomer availability and assembly stoichiometry."},
            {"process": "metabolism", "describes": "solved by Flux Balance Analysis — an optimization over reaction rates, not an integrated rate law (see the fba topic)."},
            {"process": "replication_and_division", "describes": "DNA replication and growth setting cell mass and the division cycle. Terms represent replication initiation/elongation and mass accumulation."},
        ],
        "guardrail": MODELING_GUARDRAIL,
        "see_also": ["fba", "state_variables"],
    },
    "output_series": {
        "title": "What the Molecule Explorer series/trajectories are",
        "summary": (
            "For one cell the platform exposes ~21,860 plottable output series: ~12,000 dynamic state-variable "
            "counts plus ~9,871 FBA terms (reaction fluxes ~9,612, exchange fluxes ~87, metabolite deltas ~172). "
            "This is a per-cell column count, constant across runs — NOT a total across seeds, generations, or "
            "other jobs. It exceeds the number of distinct biological entities because mRNA is offered at both "
            "transcription-unit and gene/cistron granularity, and reversible reactions appear as forward+reverse "
            "fluxes. When you plot one molecule you get one trajectory per cell lineage in that job — i.e. "
            "(number of seeds) x (number of generations)."
        ),
        "see_also": ["fba", "state_variables"],
    },
}

_MODELING_TOPIC_ALIASES = {
    "fba": "fba", "flux": "fba", "fluxes": "fba", "reaction flux": "fba", "reaction_flux": "fba",
    "metabolism": "fba", "metabolic": "fba", "exchange": "fba", "stoichiometry": "fba",
    "state": "state_variables", "state variable": "state_variables", "state_variables": "state_variables",
    "counts": "state_variables",
    "process": "processes", "processes": "processes", "equation": "processes", "equations": "processes",
    "mechanistic": "processes", "transcription": "processes", "translation": "processes",
    "complexation": "processes",
    "series": "output_series", "trajectory": "output_series", "trajectories": "output_series",
    "output": "output_series", "molecule explorer": "output_series", "how many": "output_series",
    "overview": "overview", "model": "overview",
}


# Authoritative, curated page guide. Keeps the model from inventing page descriptions.
PLATFORM_PAGES = [
    {
        "name": "Workspace",
        "route": "/",
        "purpose": "Home/explore surface for inspecting a single gene and its model context.",
        "data": "Gene metadata, model-state IDs, local regulation and pathway context.",
        "assistant_tools": ["inspect_gene", "inspect_tf_network", "gene_catalog"],
    },
    {
        "name": "Gene catalog",
        "route": "/genes",
        "purpose": "Browse and search every gene supported by the platform.",
        "data": "Genes table: symbol, EcoCyc id, category, knockout index, mechanistic flag, protein monomer.",
        "assistant_tools": ["gene_catalog", "inspect_gene"],
    },
    {
        "name": "Network",
        "route": "/network",
        "purpose": "Transcription-factor regulation network: who regulates whom.",
        "data": "Curated TF edges with log2 fold-change and activation/repression direction.",
        "assistant_tools": ["inspect_tf_network"],
    },
    {
        "name": "Genome Map",
        "route": "/genome",
        "purpose": "Circular/linear genome view of gene positions and strands.",
        "data": "Gene left/right coordinates and strand from the Genes table.",
        "assistant_tools": ["inspect_gene", "gene_catalog"],
    },
    {
        "name": "Conditions Builder",
        "route": "/environment-builder",
        "purpose": "Define and review growth conditions, media recipes, and timelines.",
        "data": "Conditions (nutrients, active/inactive TFs, doubling time), media recipes, timelines, TF rules.",
        "assistant_tools": [
            "list_conditions",
            "save_condition (confirmation-gated)",
            "save_timeline (confirmation-gated)",
            "save_recipe (confirmation-gated)",
            "save_tf_condition (confirmation-gated)",
        ],
    },
    {
        "name": "Experiments",
        "route": "/experiments",
        "purpose": "List, group, and open experiments and their runs.",
        "data": "Experiments by status/variant/batch, with linked simulation jobs and results.",
        "assistant_tools": ["list_experiments", "inspect_experiment"],
    },
    {
        "name": "Design Experiment",
        "route": "/experiments/new",
        "purpose": "Author one experiment: variant, condition, timeline, sim params, gene target.",
        "data": "Variant catalog, conditions, timelines.",
        "assistant_tools": ["inspect_experiment", "create_experiment (confirmation-gated)"],
    },
    {
        "name": "Batch Builder",
        "route": "/experiments/batch",
        "purpose": "Author many experiments at once as a batch.",
        "data": "Variant/condition/timeline combinations grouped under a batch id.",
        "assistant_tools": ["list_experiments", "create_experiment (confirmation-gated)"],
    },
    {
        "name": "Results",
        "route": "/results",
        "purpose": "Browse completed simulation results and open one for detail.",
        "data": "Simulation jobs and summary metrics (division time, mass, growth rate, doubling time).",
        "assistant_tools": ["list_results", "inspect_result", "list_experiments", "compare_results"],
    },
    {
        "name": "Result detail & Molecule Explorer",
        "route": "/results/:jobId",
        "purpose": "Figures and per-molecule trajectories for one result; Molecule Explorer plots state variables.",
        "data": "Per-job phenotype figures and per-molecule timeseries (scoped to this job's lineages only).",
        "assistant_tools": ["inspect_result", "inspect_molecule_trajectories", "read_result_series", "compare_results"],
    },
    {
        "name": "ML",
        "route": "/ml",
        "purpose": "Machine-learning surface over simulation outputs.",
        "data": "Derived feature/training views over result data.",
        "assistant_tools": [],
    },
    {
        "name": "Genome Design",
        "route": "/design",
        "purpose": "Genome design surface.",
        "data": "Design artifacts and gene targets.",
        "assistant_tools": ["inspect_gene", "gene_catalog"],
    },
    {
        "name": "Assistant",
        "route": "/assistant",
        "purpose": "This chat. Ask questions, inspect facts via tools, review confirmation-gated actions.",
        "data": "Conversation history, page context, tool results, proposals.",
        "assistant_tools": ["all read-only tools"],
    },
]


def get_assistant_harness_status(session: Session | None = None) -> AssistantHarnessStatus:
    provider_configured = get_provider_layer_status(session).configured_provider_count > 0
    return AssistantHarnessStatus(
        state="read_only_tools_enabled",
        provider_required=True,
        provider_configured=provider_configured,
        tool_execution_enabled=True,
        tool_preview_enabled=True,
        execution_enabled_tools=[*READ_ONLY_TOOLS, *_SIDE_EFFECT_EXECUTORS],
        side_effect_execution_enabled=True,
        db_persistence_enabled=True,
        confirmation_required_for=CONFIRMATION_REQUIRED_ACTIONS,
        permission_policy=PERMISSION_POLICY,
        context_contract=CONTEXT_CONTRACT,
        visible_artifacts=VISIBLE_ARTIFACTS,
        tool_registry=get_tool_registry(),
        notes=[
            "This is the durable harness foundation, not a live LLM runtime.",
            "Provider setup can be saved from the Assistant page; stored keys are local to this installation and never returned by API.",
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
    # Accept a JSON-encoded object too, so normalized args (where this is stored as a JSON string)
    # round-trip through preview without spuriously failing on re-validation.
    if isinstance(value, str):
        if value.strip() == "":
            return {}
        try:
            parsed = json.loads(value)
        except (json.JSONDecodeError, ValueError):
            parsed = None
        if isinstance(parsed, dict):
            return parsed
        errors.append(f"Argument '{key}' must be an object.")
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
    variant_index = _int_arg(args, "variant_index", errors, required=False, minimum=0)
    condition = _string_arg(args, "condition", errors)
    timeline = _string_arg(args, "timeline", errors, required=False)
    sim_params = _object_arg(args, "sim_params", errors)
    gene_symbol = _string_arg(args, "gene_symbol", errors, required=False)
    gene_symbols = _string_list_arg(args, "gene_symbols", errors)
    include_wildtype = _bool_arg(args, "include_wildtype", errors)

    # Auto-resolve the knockout index from the gene so the model doesn't have to look it up first
    # (the common reason a valid-looking create_experiment was silently dropped as invalid).
    if variant_index is None and gene_symbol and variant_type == "gene_knockout":
        resolved_gene = _lookup_gene_by_symbol(session, gene_symbol)
        if resolved_gene and resolved_gene.ko_index and resolved_gene.ko_index > 0:
            variant_index = resolved_gene.ko_index
    if variant_index is None:
        errors.append("Missing 'variant_index' — provide it, or give a gene_symbol so it can be resolved.")

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
        "gene_symbol": gene_symbol,
        "gene_symbols": gene_symbols,
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


def _parse_str_list(value: Any) -> list[str]:
    """Best-effort: a JSON array string, a comma list, or already a list -> list[str]."""
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    text = str(value or "").strip()
    if not text:
        return []
    try:
        parsed = json.loads(text)
        if isinstance(parsed, list):
            return [str(v).strip() for v in parsed if str(v).strip()]
    except (json.JSONDecodeError, ValueError):
        pass
    return [token.strip() for token in text.split(",") if token.strip()]


def _preview_save_condition(session: Session, args: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    name = _string_arg(args, "name", errors)
    base_condition = _string_arg(args, "base_condition", errors, required=False)

    # Optionally clone an existing condition and override only what the user changed.
    base: Condition | None = None
    if base_condition:
        base = session.exec(select(Condition).where(Condition.name == base_condition)).first()
        if not base:
            errors.append(f"Base condition '{base_condition}' does not exist.")

    nutrients = _string_arg(args, "nutrients", errors, required=False) or (base.nutrients if base else "")
    if not nutrients:
        errors.append("Missing 'nutrients' — the media recipe id for this condition (or give a base_condition).")

    # doubling_time: number | numeric string; default from base, else 44.0.
    doubling_time: float | None = None
    raw_dt = args.get("doubling_time")
    if raw_dt is None or raw_dt == "":
        doubling_time = base.doubling_time if base and base.doubling_time else 44.0
    else:
        try:
            doubling_time = float(raw_dt)
        except (TypeError, ValueError):
            errors.append("Argument 'doubling_time' must be numeric (minutes).")
    if doubling_time is not None and doubling_time <= 0:
        errors.append("Argument 'doubling_time' must be positive (minutes).")

    active_tfs = _parse_str_list(args.get("active_tfs")) or (_parse_str_list(base.active_tfs) if base else [])
    inactive_tfs = _parse_str_list(args.get("inactive_tfs")) or (_parse_str_list(base.inactive_tfs) if base else [])
    geno = _object_arg(args, "genotype_perturbations", errors)
    if not geno and base and base.genotype_perturbations:
        try:
            parsed = json.loads(base.genotype_perturbations)
            if isinstance(parsed, dict):
                geno = parsed
        except (json.JSONDecodeError, ValueError):
            pass

    # Soft checks: the draft can still be created, but publishing later would fail on these.
    if nutrients and not session.exec(select(MediaRecipe).where(MediaRecipe.media_id == nutrients)).first():
        warnings.append(
            f"Media recipe '{nutrients}' is not published yet; you can save the draft, but publishing it will "
            "require that recipe to exist first."
        )
    if name and session.exec(select(Condition).where(Condition.name == name)).first():
        warnings.append(f"A published condition named '{name}' already exists; publishing this draft would be rejected.")

    normalized = {
        "name": name,
        "nutrients": nutrients,
        "doubling_time": doubling_time,
        "active_tfs": active_tfs,
        "inactive_tfs": inactive_tfs,
        "genotype_perturbations": geno,
        "base_condition": base_condition,
    }
    preview = {
        "action": "would_create_condition_draft",
        "summary": (
            f"Save '{name or 'unnamed'}' as a Conditions Builder draft on media '{nutrients or 'unknown'}' "
            f"(doubling time {doubling_time if doubling_time is not None else '?'} min)."
            + (f" Cloned from '{base_condition}'." if base_condition else "")
        ),
        "condition_name": name,
        "nutrients": nutrients,
        "doubling_time": doubling_time,
        "active_tfs": active_tfs,
        "inactive_tfs": inactive_tfs,
        "base_condition": base_condition,
        "side_effect_if_executed": "A new 'condition' draft would be saved in the Conditions Builder for review and publishing.",
    }
    return normalized, preview, warnings, errors


def _preview_save_timeline(session: Session, args: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    name = _string_arg(args, "name", errors)
    events = _string_arg(args, "events", errors)
    if name and session.exec(select(Timeline).where(Timeline.name == name)).first():
        warnings.append(f"A published timeline named '{name}' already exists; publishing this draft would be rejected.")
    if events:
        try:
            from app.services.timelines import validate_timeline_definition
            validate_timeline_definition(session, events)
        except HTTPException as exc:
            warnings.append(f"Timeline events may be invalid and will be re-checked on publish: {exc.detail}")
        except Exception:
            pass
    normalized = {"name": name, "events": events}
    preview = {
        "action": "would_create_timeline_draft",
        "summary": f"Save timeline '{name or 'unnamed'}' with schedule: {events or '(empty)'}.",
        "timeline_name": name,
        "events": events,
        "side_effect_if_executed": "A new 'timeline' draft would be saved in the Conditions Builder for review and publishing.",
    }
    return normalized, preview, warnings, errors


def _preview_save_recipe(session: Session, args: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    media_id = _string_arg(args, "media_id", errors)
    base_media = _string_arg(args, "base_media", errors)
    added_media = _string_arg(args, "added_media", errors, required=False)
    ingredients = _string_list_arg(args, "ingredients", errors)

    if media_id and session.exec(select(MediaRecipe).where(MediaRecipe.media_id == media_id)).first():
        warnings.append(f"A media recipe '{media_id}' already exists; publishing this draft would be rejected.")
    media_dir = getattr(settings, "condition_media_dir", None)
    if base_media and media_dir is not None and not (media_dir / f"{base_media}.tsv").exists():
        warnings.append(
            f"Base medium '{base_media}' is not a published growth-medium stock; you can save the draft, but "
            "publishing will require that stock to exist first."
        )
    normalized = {
        "media_id": media_id,
        "base_media": base_media,
        "added_media": added_media,
        "ingredients": ingredients,
    }
    preview = {
        "action": "would_create_media_recipe_draft",
        "summary": (
            f"Save media recipe '{media_id or 'unnamed'}' from base '{base_media or 'unknown'}'"
            + (f" + '{added_media}'" if added_media else "")
            + (f" with {len(ingredients)} extra ingredient(s)" if ingredients else "") + "."
        ),
        "media_id": media_id,
        "base_media": base_media,
        "added_media": added_media,
        "ingredients": ingredients,
        "side_effect_if_executed": "A new 'mediaRecipe' draft would be saved in the Conditions Builder for review and publishing.",
    }
    return normalized, preview, warnings, errors


def _preview_save_tf_condition(session: Session, args: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    tf = _string_arg(args, "tf", errors)
    active_tf = _string_arg(args, "active_tf", errors)
    active_nutrients = _string_arg(args, "active_nutrients", errors)
    inactive_nutrients = _string_arg(args, "inactive_nutrients", errors)
    tf_type = _string_arg(args, "tf_type", errors)
    name = _string_arg(args, "name", errors, required=False) or (f"{tf} rule" if tf else "")
    active_geno = _object_arg(args, "active_genotype_perturbations", errors)
    inactive_geno = _object_arg(args, "inactive_genotype_perturbations", errors)

    for media in (active_nutrients, inactive_nutrients):
        if media and not session.exec(select(MediaRecipe).where(MediaRecipe.media_id == media)).first():
            warnings.append(
                f"Media recipe '{media}' is not published yet; you can save the draft, but publishing will "
                "require that recipe to exist first."
            )
    normalized = {
        "name": name,
        "tf": tf,
        "active_tf": active_tf,
        "active_nutrients": active_nutrients,
        "inactive_nutrients": inactive_nutrients,
        "tf_type": tf_type,
        "active_genotype_perturbations": active_geno,
        "inactive_genotype_perturbations": inactive_geno,
    }
    preview = {
        "action": "would_create_tf_condition_draft",
        "summary": (
            f"Save TF rule '{name or tf}': {tf or '?'} active on '{active_nutrients or '?'}', inactive on "
            f"'{inactive_nutrients or '?'}' (type {tf_type or '?'})."
        ),
        "tf": tf,
        "active_tf": active_tf,
        "active_nutrients": active_nutrients,
        "inactive_nutrients": inactive_nutrients,
        "tf_type": tf_type,
        "side_effect_if_executed": "A new 'tfCondition' draft would be saved in the Conditions Builder for review and publishing.",
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


def _gene_summary(gene: Gene) -> dict[str, Any]:
    return {
        "symbol": gene.symbol,
        "ecoli_id": gene.ecoli_id,
        "category": gene.category,
        "ko_index": gene.ko_index,
        "mechanistic": gene.is_mechanistic,
        "monomer_id": gene.monomer_id or "",
        "monomer_name": gene.monomer_name or "",
        "rna_id": f"{gene.ecoli_id}_RNA" if gene.ecoli_id else "",
        "position": [gene.left_end_pos, gene.right_end_pos],
        "strand": gene.direction or "",
    }


def _lookup_gene_by_symbol(session: Session, symbol: str) -> Gene | None:
    cleaned = symbol.strip()
    if not cleaned:
        return None
    for gene in session.exec(select(Gene)).all():
        if gene.symbol and gene.symbol.lower() == cleaned.lower():
            return gene
    return None


def _preview_inspect_gene(session: Session, args: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    gene_symbol = _string_arg(args, "gene", errors)
    gene = _lookup_gene_by_symbol(session, gene_symbol) if gene_symbol else None
    if gene_symbol and not gene:
        errors.append(f"Gene '{gene_symbol}' was not found in the local Genes table.")

    normalized = {"gene": gene.symbol if gene else gene_symbol}
    preview = {
        "action": "would_inspect_gene",
        "summary": f"Read Genes Table metadata for {gene.symbol}." if gene else "Read Genes Table metadata.",
        "gene": _gene_summary(gene) if gene else {},
        "side_effect_if_executed": "None. This is a read-only Genes Table inspection tool.",
    }
    return normalized, preview, warnings, errors


def _clamp_limit(args: dict[str, Any], default: int, maximum: int) -> int:
    raw = args.get("limit")
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    return max(1, min(maximum, value))


def _preview_gene_catalog(session: Session, args: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], list[str], list[str]]:
    category = _string_arg(args, "category", required=False, errors=[]) or ""
    search = _string_arg(args, "search", required=False, errors=[]) or ""
    limit = _clamp_limit(args, default=15, maximum=50)
    normalized = {"category": category.strip(), "search": search.strip(), "limit": limit}
    preview = {
        "summary": "Summarize the Genes table (counts, categories, knockout-ready and mechanistic genes).",
        "filters": {"category": normalized["category"], "search": normalized["search"]},
    }
    return normalized, preview, [], []


def _preview_inspect_tf_network(session: Session, args: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], list[str], list[str]]:
    errors: list[str] = []
    gene_symbol = _string_arg(args, "gene", required=True, errors=errors)
    limit = _clamp_limit(args, default=20, maximum=100)
    gene = _lookup_gene_by_symbol(session, gene_symbol) if gene_symbol else None
    normalized = {"gene": (gene.symbol if gene else (gene_symbol or "").strip()), "limit": limit}
    if gene_symbol and not gene:
        errors.append(f"Gene '{gene_symbol}' is not in the local Genes table.")
    preview = {"summary": f"Read TF regulators and targets for {normalized['gene'] or 'a gene'}."}
    return normalized, preview, [], errors


def _preview_list_conditions(session: Session, args: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], list[str], list[str]]:
    search = _string_arg(args, "search", required=False, errors=[]) or ""
    limit = _clamp_limit(args, default=20, maximum=100)
    normalized = {"search": search.strip(), "limit": limit}
    preview = {"summary": "Summarize Conditions Builder conditions, media recipes, and timelines."}
    return normalized, preview, [], []


def _preview_list_experiments(session: Session, args: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], list[str], list[str]]:
    status = _string_arg(args, "status", required=False, errors=[]) or ""
    batch_id = _string_arg(args, "batch_id", required=False, errors=[]) or ""
    limit = _clamp_limit(args, default=15, maximum=50)
    normalized = {"status": status.strip(), "batch_id": batch_id.strip(), "limit": limit}
    preview = {"summary": "Summarize experiments by status and batch."}
    return normalized, preview, [], []


def _preview_inspect_experiment(session: Session, args: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], list[str], list[str]]:
    errors: list[str] = []
    experiment_id = _int_arg(args, "experiment_id", required=True, errors=errors)
    normalized = {"experiment_id": experiment_id}
    if experiment_id is not None and not session.get(Experiment, experiment_id):
        errors.append(f"Experiment {experiment_id} not found.")
    preview = {"summary": f"Read experiment {experiment_id} definition, jobs, and result metrics."}
    return normalized, preview, [], errors


def _preview_inspect_molecule_trajectories(session: Session, args: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], list[str], list[str]]:
    errors: list[str] = []
    job_id = _int_arg(args, "job_id", required=True, errors=errors)
    gene = _string_arg(args, "gene", required=False, errors=[]) or ""
    normalized = {"job_id": job_id, "gene": gene.strip()}
    if job_id is not None and not session.get(SimulationJob, job_id):
        errors.append(f"Simulation job {job_id} not found.")
    preview = {"summary": f"Report the per-job trajectory scope for job {job_id} (this job's lineages only)."}
    return normalized, preview, [], errors


def _int_list_arg(args: dict[str, Any], key: str) -> list[int]:
    value = args.get(key)
    if value is None:
        return []
    if isinstance(value, (int, str)):
        value = [value]
    out: list[int] = []
    for item in value if isinstance(value, list) else []:
        try:
            if isinstance(item, bool):
                continue
            out.append(int(item))
        except (TypeError, ValueError):
            continue
    return out


def _preview_list_results(session: Session, args: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], list[str], list[str]]:
    errors: list[str] = []
    status = _string_arg(args, "status", errors, required=False)
    limit = _int_arg(args, "limit", required=False, errors=errors, minimum=1)
    normalized = {"status": status, "limit": limit or 20}
    preview = {"summary": f"List {status or 'completed'} simulation results."}
    return normalized, preview, [], errors


def _preview_compare_results(session: Session, args: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], list[str], list[str]]:
    errors: list[str] = []
    job_ids = _int_list_arg(args, "job_ids")
    experiment_ids = _int_list_arg(args, "experiment_ids")
    metric = _string_arg(args, "metric", errors, required=False)
    if not job_ids and not experiment_ids:
        errors.append("Provide at least one of 'job_ids' or 'experiment_ids' to compare.")
    normalized = {"job_ids": job_ids, "experiment_ids": experiment_ids, "metric": metric}
    preview = {"summary": f"Compare metrics across {len(job_ids)} job(s) and {len(experiment_ids)} experiment(s)."}
    return normalized, preview, [], errors


def _preview_read_result_series(session: Session, args: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], list[str], list[str]]:
    errors: list[str] = []
    job_id = _int_arg(args, "job_id", required=True, errors=errors)
    series = _string_arg(args, "series", errors, required=False)
    seed = _int_arg(args, "seed", required=False, errors=errors, minimum=0)
    max_points = _int_arg(args, "max_points", required=False, errors=errors, minimum=2)
    if job_id is not None and not session.get(SimulationJob, job_id):
        errors.append(f"Simulation job {job_id} not found.")
    normalized = {"job_id": job_id, "series": series, "seed": seed, "max_points": max_points or 40}
    preview = {"summary": f"Read the '{series or '(list available)'}' time-series for job {job_id}."}
    return normalized, preview, [], errors


def _resolve_modeling_topic(raw: str) -> str | None:
    key = (raw or "").strip().lower()
    if not key:
        return None
    if key in MODELING_TOPICS:
        return key
    if key in _MODELING_TOPIC_ALIASES:
        return _MODELING_TOPIC_ALIASES[key]
    for alias, topic in _MODELING_TOPIC_ALIASES.items():
        if alias in key:
            return topic
    return None


def _metabolic_reactions_path() -> Path:
    return settings.reconstruction_path / "ecoli" / "flat" / "metabolic_reactions.tsv"


def _enzyme_ids_for_gene_symbol(session: Session, symbol: str) -> set[str]:
    gene = _lookup_gene_by_symbol(session, symbol)
    if not gene:
        return set()
    ids: set[str] = set()
    if gene.monomer_id:
        ids.add(gene.monomer_id)
    for complex_id in from_json(gene.complex_ids, []) or []:
        if isinstance(complex_id, str):
            ids.add(complex_id)
    return ids


def _execute_model_structure(session: Session, normalized_arguments: dict[str, Any]) -> dict[str, Any]:
    import csv

    query = str(normalized_arguments.get("query") or "").strip()
    limit = int(normalized_arguments.get("limit") or 12)
    path = _metabolic_reactions_path()
    if not path.exists():
        return {
            "available": False,
            "query": query,
            "note": (
                "The reconstruction files are not mounted in this environment, so live structural lookup is "
                "unavailable. Conceptually: the FBA reaction count (~9,612) is the reversible-split expansion of "
                "~6,770 base metabolic reactions. Use the Network page for regulation."
            ),
        }

    enzyme_ids = _enzyme_ids_for_gene_symbol(session, query) if query else set()
    q_lower = query.lower()

    reversible = one_way = 0
    matches: list[dict[str, Any]] = []
    try:
        with path.open("r", encoding="utf-8") as handle:
            for row in csv.reader(handle, delimiter="\t"):
                if len(row) < 3:
                    continue
                reaction_id = row[0].strip().strip('"')
                if not reaction_id or reaction_id == "id" or reaction_id.startswith("#"):
                    continue
                try:
                    stoich = json.loads(row[1])
                    catalysts = json.loads(row[3]) if len(row) > 3 else []
                except (json.JSONDecodeError, ValueError):
                    continue
                if not isinstance(stoich, dict):
                    continue
                direction = (row[2].strip().strip('"') if len(row) > 2 else "")
                is_reversible = direction == "BOTH"
                if is_reversible:
                    reversible += 1
                else:
                    one_way += 1

                if query and len(matches) < limit:
                    catalyst_list = [c for c in catalysts if isinstance(c, str)]
                    metabolite_ids = list(stoich.keys())
                    hit = (
                        q_lower in reaction_id.lower()
                        or any(eid in catalyst_list for eid in enzyme_ids)
                        or any(q_lower in m.lower() for m in metabolite_ids)
                    )
                    if hit:
                        matches.append({
                            "id": reaction_id,
                            "direction": direction,
                            "reversible": is_reversible,
                            "catalysts": catalyst_list[:8],
                            "reactants": [m for m, c in stoich.items() if isinstance(c, (int, float)) and c < 0][:12],
                            "products": [m for m, c in stoich.items() if isinstance(c, (int, float)) and c > 0][:12],
                        })
    except OSError as exc:
        return {"available": False, "query": query, "note": f"Could not read reconstruction: {exc}"}

    total = reversible + one_way
    return {
        "available": True,
        "query": query,
        "resolved_enzyme_ids": sorted(enzyme_ids),
        "match_count": len(matches),
        "reactions": matches,
        "network_totals": {
            "base_reactions": total,
            "reversible": reversible,
            "one_way": one_way,
            "fba_expanded_flux_estimate": reversible * 2 + one_way,
            "note": (
                "FBA splits each reversible reaction into forward+reverse non-negative fluxes; the live FBA flux "
                "count also adds transport/exchange/maintenance reactions, so it is slightly higher than this estimate."
            ),
        },
        "guardrail": "This is static structure (condition-independent). For values over time, run a simulation and inspect the result.",
    }


def _preview_model_structure(session: Session, args: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], list[str], list[str]]:
    errors: list[str] = []
    query = _string_arg(args, "query", required=True, errors=errors)
    kind = _string_arg(args, "kind", required=False, errors=[]) or ""
    limit = _clamp_limit(args, default=12, maximum=50)
    normalized = {"query": query, "kind": kind.strip(), "limit": limit}
    preview = {"summary": f"Look up model structure for '{query}'." if query else "Look up model structure."}
    return normalized, preview, [], errors


def _preview_explain_modeling(session: Session, args: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], list[str], list[str]]:
    topic = _string_arg(args, "topic", required=False, errors=[]) or ""
    resolved = _resolve_modeling_topic(topic)
    normalized = {"topic": resolved or ""}
    preview = {"summary": f"Explain modeling topic '{resolved}'." if resolved else "Explain the model (overview + topics)."}
    return normalized, preview, [], []


def _preview_platform_guide(session: Session, args: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], list[str], list[str]]:
    page = _string_arg(args, "page", required=False, errors=[]) or ""
    normalized = {"page": page.strip()}
    preview = {"summary": f"Describe {'the ' + page.strip() + ' page' if page.strip() else 'all platform pages'}."}
    return normalized, preview, [], []


_PREVIEW_DISPATCH = {
    "create_experiment": _preview_create_experiment,
    "run_simulation": _preview_run_simulation,
    "save_condition": _preview_save_condition,
    "save_timeline": _preview_save_timeline,
    "save_recipe": _preview_save_recipe,
    "save_tf_condition": _preview_save_tf_condition,
    "publish_environment_builder_artifact": _preview_publish_builder_artifact,
    "inspect_result": _preview_inspect_result,
    "inspect_gene": _preview_inspect_gene,
    "gene_catalog": _preview_gene_catalog,
    "inspect_tf_network": _preview_inspect_tf_network,
    "list_conditions": _preview_list_conditions,
    "list_experiments": _preview_list_experiments,
    "inspect_experiment": _preview_inspect_experiment,
    "inspect_molecule_trajectories": _preview_inspect_molecule_trajectories,
    "list_results": _preview_list_results,
    "compare_results": _preview_compare_results,
    "read_result_series": _preview_read_result_series,
    "platform_guide": _preview_platform_guide,
    "explain_modeling": _preview_explain_modeling,
    "model_structure": _preview_model_structure,
}


def preview_tool(
    session: Session,
    tool_name: str,
    request: AssistantToolPreviewRequest,
) -> AssistantToolPreviewOut:
    spec = get_tool_spec(tool_name)
    preview_fn = _PREVIEW_DISPATCH.get(tool_name)
    if preview_fn is None:
        raise HTTPException(status_code=404, detail=f"Unknown assistant tool '{tool_name}'.")
    normalized, preview, warnings, errors = preview_fn(session, request.arguments)

    return AssistantToolPreviewOut(
        tool_name=tool_name,
        valid=not errors,
        requires_confirmation=spec.requires_confirmation,
        side_effect=spec.side_effect,
        execution_enabled=tool_name in READ_ONLY_TOOLS or tool_name in _SIDE_EFFECT_EXECUTORS,
        normalized_arguments=normalized,
        preview=preview,
        warnings=warnings,
        errors=errors,
    )


def _gene_symbol_map(session: Session) -> dict[str, Gene]:
    genes = session.exec(select(Gene)).all()
    return {gene.symbol.lower(): gene for gene in genes if gene.symbol}


def _mentioned_genes(
    session: Session,
    *texts: str,
    selected_gene: str | None = None,
    limit: int = 8,
) -> list[Gene]:
    symbol_map = _gene_symbol_map(session)
    ordered: list[Gene] = []
    seen: set[str] = set()

    def add_symbol(symbol: str | None) -> None:
        key = (symbol or "").strip().lower()
        if not key or key in seen:
            return
        gene = symbol_map.get(key)
        if not gene:
            return
        seen.add(key)
        ordered.append(gene)

    add_symbol(selected_gene)
    for text in texts:
        for token in re.findall(r"\b[A-Za-z][A-Za-z0-9]{1,9}\b", text or ""):
            add_symbol(token)
            if len(ordered) >= limit:
                return ordered
    return ordered


def _genes_from_symbols(session: Session, symbols: list[str], *, limit: int = 8) -> list[Gene]:
    symbol_map = _gene_symbol_map(session)
    genes: list[Gene] = []
    seen: set[str] = set()
    for symbol in symbols:
        key = (symbol or "").strip().lower()
        if not key or key in seen:
            continue
        gene = symbol_map.get(key)
        if not gene:
            continue
        seen.add(key)
        genes.append(gene)
        if len(genes) >= limit:
            break
    return genes


def _split_proposal_targets(raw: str) -> list[str]:
    cleaned = raw.strip().strip("[]")
    if not cleaned:
        return []
    targets: list[str] = []
    for part in re.split(r"[,;\n]+|\band\b", cleaned):
        symbol = part.strip().strip("\"'` .")
        if symbol:
            targets.append(symbol)
    return targets


def _json_proposal_candidates(text: str) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    for match in re.finditer(r"```(?:json)?\s*(\{.*?\})\s*```", text or "", re.DOTALL | re.IGNORECASE):
        try:
            parsed = json.loads(match.group(1))
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            candidates.append(parsed)
    for match in re.finditer(r"Assistant proposals?\s*:\s*(\{.*?\})(?:\n|$)", text or "", re.DOTALL | re.IGNORECASE):
        try:
            parsed = json.loads(match.group(1))
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            candidates.append(parsed)
    return candidates


def _structured_proposal_directive(assistant_content: str) -> dict[str, Any]:
    """Parse explicit model proposal directives without treating prose as commands."""

    targets: list[str] = []
    action = ""
    condition = ""

    for line in (assistant_content or "").splitlines():
        target_match = re.match(r"\s*Proposal targets?\s*:\s*(.+?)\s*$", line, re.IGNORECASE)
        if target_match:
            targets.extend(_split_proposal_targets(target_match.group(1)))
        action_match = re.match(r"\s*Proposal action\s*:\s*(.+?)\s*$", line, re.IGNORECASE)
        if action_match:
            action = action_match.group(1).strip().lower()
        condition_match = re.match(r"\s*Proposal condition\s*:\s*(.+?)\s*$", line, re.IGNORECASE)
        if condition_match:
            condition = condition_match.group(1).strip()

    for candidate in _json_proposal_candidates(assistant_content):
        raw_targets = (
            candidate.get("proposal_targets")
            or candidate.get("target_genes")
            or candidate.get("genes")
            or candidate.get("targets")
        )
        if isinstance(raw_targets, str):
            targets.extend(_split_proposal_targets(raw_targets))
        elif isinstance(raw_targets, list):
            targets.extend(str(value) for value in raw_targets if isinstance(value, (str, int, float)))

        raw_action = candidate.get("proposal_action") or candidate.get("action") or candidate.get("tool")
        if isinstance(raw_action, str) and raw_action.strip():
            action = raw_action.strip().lower()
        raw_condition = candidate.get("condition")
        if isinstance(raw_condition, str) and raw_condition.strip():
            condition = raw_condition.strip()

        proposals = candidate.get("proposals")
        if isinstance(proposals, list):
            for proposal in proposals:
                if not isinstance(proposal, dict):
                    continue
                gene = proposal.get("gene_symbol") or proposal.get("gene") or proposal.get("target")
                if isinstance(gene, str):
                    targets.append(gene)
                proposal_action = proposal.get("tool") or proposal.get("action")
                if isinstance(proposal_action, str) and proposal_action.strip():
                    action = proposal_action.strip().lower()
                proposal_condition = proposal.get("condition")
                if isinstance(proposal_condition, str) and proposal_condition.strip():
                    condition = proposal_condition.strip()

    normalized_action = action.replace("-", "_").replace(" ", "_")
    if normalized_action in {"gene_knockout", "knockout", "ko", "draft_knockout", "simulate_knockout"}:
        normalized_action = "create_experiment"
    if normalized_action in {"inspect", "inspect_gene", "gene_inspection", "read_gene"}:
        normalized_action = "inspect_gene"
    if normalized_action and normalized_action not in {"create_experiment", "inspect_gene"}:
        normalized_action = ""

    deduped_targets: list[str] = []
    seen: set[str] = set()
    for target in targets:
        key = target.strip().lower()
        if not key or key in seen:
            continue
        seen.add(key)
        deduped_targets.append(target.strip())

    return {
        "explicit": bool(deduped_targets),
        "targets": deduped_targets,
        "action": normalized_action or "create_experiment",
        "condition": condition,
    }


def assistant_conversation_context_pack(
    session: Session,
    *,
    conversation_id: int,
    current_message_id: int | None = None,
    limit: int = 24,
    char_budget: int | None = None,
    per_message_cap: int = 1600,
) -> dict[str, Any]:
    """Recent turns under a token-ish budget, with a digest of anything older that was dropped.

    Keeps as many recent user/assistant turns as fit ``char_budget`` (≈ char/4 tokens) instead of a
    blind message count, so long chats stop silently losing context. Older turns that don't fit are
    summarized into ``earlier_context`` (count + how the conversation started) so references survive.
    """
    # Budget is token-denominated (chars ≈ tokens * 4). Exact per-call counting is provider-specific
    # and network-bound, so an estimate is used for the budgeting decision.
    if char_budget is None:
        char_budget = max(2000, int(settings.assistant_context_token_budget or 3500) * 4)

    records = session.exec(
        select(AssistantMessage)
        .where(AssistantMessage.conversation_id == conversation_id)
        .order_by(AssistantMessage.id.desc())
    ).all()

    # A model-written rolling summary (role="summary") compacts everything up to covered_up_to.
    summary_message = next((record for record in records if record.role == "summary"), None)
    covered_up_to = 0
    summary_text = ""
    if summary_message:
        summary_text = summary_message.content
        covered_up_to = int(from_json(summary_message.context_json, {}).get("covered_up_to_message_id") or 0)

    eligible = [
        record
        for record in records
        if record.id != current_message_id
        and record.role in {"user", "assistant"}
        and (record.id or 0) > covered_up_to
    ]

    recent: list[AssistantMessage] = []
    used = 0
    for record in eligible:  # newest first
        cost = min(len(record.content), per_message_cap)
        if recent and (len(recent) >= limit or used + cost > char_budget):
            break
        recent.append(record)
        used += cost
    omitted = eligible[len(recent):]
    recent.reverse()

    earlier_context = None
    if summary_text:
        note = f"Summary of the earlier conversation (compacted): {summary_text}"
        if omitted:
            note += f" Plus {len(omitted)} more recent message(s) trimmed for budget."
        earlier_context = {
            "summary": summary_text,
            "covered_message_id": covered_up_to,
            "omitted_message_count": len(omitted),
            "note": note,
        }
    elif omitted:
        first_user = next((record.content for record in reversed(eligible) if record.role == "user"), "")
        compact_first = " ".join(first_user.split())[:300]
        earlier_context = {
            "omitted_message_count": len(omitted),
            "note": (
                f"{len(omitted)} earlier message(s) are not shown verbatim to stay within the context budget. "
                + (f"The conversation began with: \"{compact_first}\". " if compact_first else "")
                + "Re-fetch any specific facts through tools rather than relying on omitted turns."
            ),
        }

    return {
        "message_count": len(recent),
        "messages": [
            {
                "role": record.role,
                "content": record.content[:per_message_cap],
                "status": record.status,
            }
            for record in recent
        ],
        "earlier_context": earlier_context,
        "estimated_tokens": used // 4,
        "usage": (
            "Recent conversation turns are provided so references like 'those genes' or 'the three suggestions' "
            "can be resolved without asking the user to repeat themselves."
        ),
    }


def get_conversation_summary(session: Session, conversation_id: int) -> AssistantMessage | None:
    return session.exec(
        select(AssistantMessage)
        .where(AssistantMessage.conversation_id == conversation_id)
        .where(AssistantMessage.role == "summary")
    ).first()


def upsert_conversation_summary(
    session: Session,
    conversation_id: int,
    summary_text: str,
    covered_up_to_message_id: int,
) -> AssistantMessage:
    record = get_conversation_summary(session, conversation_id)
    timestamp = now_iso()
    meta = to_json({"covered_up_to_message_id": int(covered_up_to_message_id)})
    if record:
        record.content = summary_text
        record.context_json = meta
        record.status = "compacted"
    else:
        record = AssistantMessage(
            conversation_id=conversation_id,
            role="summary",
            content=summary_text,
            context_json=meta,
            status="compacted",
            created_at=timestamp,
        )
    session.add(record)
    session.commit()
    session.refresh(record)
    return record


def clear_conversation_summary(session: Session, conversation_id: int) -> bool:
    record = get_conversation_summary(session, conversation_id)
    if not record:
        return False
    session.delete(record)
    session.commit()
    return True


def get_conversation_memory(
    session: Session,
    conversation_id: int,
    context: AssistantContext | None = None,
) -> dict[str, Any]:
    """User-facing memory snapshot for the memory panel: rolling summary + structured working memory."""
    summary = get_conversation_summary(session, conversation_id)
    working = assistant_working_memory_pack(
        session, conversation_id=conversation_id, context=context or AssistantContext()
    )
    return {
        "conversation_id": conversation_id,
        "summary": summary.content if summary else "",
        "covered_up_to_message_id": int(from_json(summary.context_json, {}).get("covered_up_to_message_id") or 0) if summary else 0,
        "remembered_genes": working.get("remembered_genes", []),
        "pending_confirmations": working.get("pending_confirmations", []),
        "recent_unresolved_questions": working.get("recent_unresolved_questions", []),
    }


def assistant_working_memory_pack(
    session: Session,
    *,
    conversation_id: int,
    context: AssistantContext,
    current_message_id: int | None = None,
    conversation_context: dict[str, Any] | None = None,
    limit: int = 12,
) -> dict[str, Any]:
    """Build structured session memory without turning platform facts into stale prose."""

    tool_records = session.exec(
        select(AssistantToolCall)
        .where(AssistantToolCall.conversation_id == conversation_id)
        .order_by(AssistantToolCall.id.desc())
    ).all()[:limit]
    confirmations = session.exec(
        select(AssistantConfirmation)
        .where(AssistantConfirmation.conversation_id == conversation_id)
        .order_by(AssistantConfirmation.id.desc())
    ).all()[:limit]
    user_records = session.exec(
        select(AssistantMessage)
        .where(AssistantMessage.conversation_id == conversation_id)
        .where(AssistantMessage.role == "user")
        .order_by(AssistantMessage.id.desc())
    ).all()[:limit]

    selected_objects = {
        "gene": context.selected_gene or "",
        "condition": context.selected_condition or "",
        "experiment_id": context.selected_experiment,
        "job_id": context.selected_job,
        "result_id": context.selected_result,
        "surface": context.assistant_surface,
        "route": context.route,
    }

    proposed_actions: list[dict[str, Any]] = []
    remembered_genes: list[str] = []
    seen_genes: set[str] = set()
    for record in reversed(tool_records):
        arguments = from_json(record.arguments_json, {})
        result = from_json(record.result_json, {})
        if not isinstance(arguments, dict) or not isinstance(result, dict):
            continue
        gene_symbol = str(arguments.get("gene_symbol") or arguments.get("gene") or "").strip()
        if gene_symbol and gene_symbol.lower() not in seen_genes:
            seen_genes.add(gene_symbol.lower())
            remembered_genes.append(gene_symbol)
        if record.status in {"proposed", "pending_confirmation"}:
            proposed_actions.append(
                {
                    "tool_name": record.tool_name,
                    "status": record.status,
                    "gene": gene_symbol,
                    "experiment_id": arguments.get("experiment_id"),
                    "job_id": arguments.get("job_id"),
                    "title": result.get("title", ""),
                    "source": result.get("source", ""),
                    "requires_confirmation": result.get("requires_confirmation", False),
                }
            )

    if context.selected_gene and context.selected_gene.lower() not in seen_genes:
        remembered_genes.insert(0, context.selected_gene)

    pending_confirmations = [
        {
            "id": confirmation.id,
            "action": confirmation.action,
            "status": confirmation.status,
        }
        for confirmation in confirmations
        if confirmation.status == "pending"
    ]
    recent_questions = [
        record.content.strip()[:500]
        for record in reversed(user_records)
        if record.id != current_message_id and "?" in record.content
    ][-4:]

    recent_chars = 0
    if conversation_context and isinstance(conversation_context.get("messages"), list):
        recent_chars = sum(
            len(message.get("content", ""))
            for message in conversation_context["messages"]
            if isinstance(message, dict) and isinstance(message.get("content"), str)
        )

    should_summarize = recent_chars > 12000 or len(proposed_actions) > 10 or len(recent_questions) > 3
    return {
        "selected_objects": selected_objects,
        "remembered_genes": remembered_genes[:10],
        "proposed_actions": proposed_actions[-10:],
        "pending_confirmations": pending_confirmations[:10],
        "recent_unresolved_questions": recent_questions,
        "summary_policy": {
            "source_of_truth": "Re-fetch deterministic platform facts through adapters; do not rely on summaries for genes, jobs, results, media, conditions, or molecule values.",
            "keep_verbatim": "Preserve recent turns for pronoun/reference resolution.",
            "summarize_when": [
                "semantic task boundary",
                "context budget pressure",
                "large tool-result accumulation",
                "user asks to continue later",
            ],
            "currently_recommends_summary": should_summarize,
            "estimated_recent_context_chars": recent_chars,
        },
    }


def assistant_gene_context_pack(
    session: Session,
    *,
    user_content: str,
    context: AssistantContext,
    conversation_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    conversation_texts = []
    if conversation_context:
        for message in conversation_context.get("messages", []):
            if isinstance(message, dict) and isinstance(message.get("content"), str):
                conversation_texts.append(message["content"])
    genes = _mentioned_genes(
        session,
        user_content,
        *conversation_texts,
        selected_gene=context.selected_gene,
        limit=10,
    )
    return {
        "matched_gene_count": len(genes),
        "genes": [
            {
                "symbol": gene.symbol,
                "ecoli_id": gene.ecoli_id,
                "category": gene.category,
                "ko_index": gene.ko_index,
                "mechanistic": gene.is_mechanistic,
                "monomer_id": gene.monomer_id or "",
                "monomer_name": gene.monomer_name or "",
                "position": [gene.left_end_pos, gene.right_end_pos],
                "strand": gene.direction or "",
            }
            for gene in genes
        ],
        "usage": (
            "These are validated genes from the local Genes table that match the user's message or page context. "
            "If you recommend knockout follow-ups, name exact gene symbols from this list so the platform can show confirmation-bound proposal cards."
        ),
    }


def _record_tool_call(
    session: Session,
    *,
    conversation_id: int | None,
    message_id: int | None = None,
    tool_name: str,
    status: str,
    arguments: dict[str, Any],
    result: dict[str, Any],
) -> AssistantToolCall:
    timestamp = now_iso()
    record = AssistantToolCall(
        conversation_id=conversation_id or 0,
        message_id=message_id,
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


def _record_assistant_proposal(
    session: Session,
    *,
    conversation: AssistantConversation,
    assistant_message: AssistantMessage,
    tool_name: str,
    arguments: dict[str, Any],
    title: str,
    description: str,
    proposal_kind: str,
    source: str,
) -> AssistantToolCall:
    spec = get_tool_spec(tool_name)
    return _record_tool_call(
        session,
        conversation_id=conversation.id,
        message_id=assistant_message.id,
        tool_name=tool_name,
        status="proposed",
        arguments=arguments,
        result={
            "title": title,
            "description": description,
            "proposal_kind": proposal_kind,
            "source": source,
            "requires_confirmation": spec.requires_confirmation,
            "side_effect": spec.side_effect,
            "execution_state": "not_executed",
        },
    )


def record_contextual_proposals(
    session: Session,
    *,
    conversation: AssistantConversation,
    assistant_message: AssistantMessage,
    context: AssistantContext,
    skip_keys: set[tuple[str, str]] | None = None,
) -> list[AssistantToolCall]:
    """Record non-executing proposal cards derived from validated page context.

    ``skip_keys`` holds ``(tool_name, arguments_json)`` pairs already proposed this turn (e.g. by the
    model's own tool calls) so the contextual layer does not create a duplicate card.
    """

    proposals: list[AssistantToolCall] = []
    seen = set(skip_keys or set())

    def add_proposal(**kwargs: Any) -> None:
        key = (kwargs["tool_name"], to_json(kwargs.get("arguments", {})))
        if key in seen:
            return
        seen.add(key)
        proposals.append(
            _record_assistant_proposal(
                session,
                conversation=conversation,
                assistant_message=assistant_message,
                source="contextual_assistant",
                **kwargs,
            )
        )

    if context.selected_job is not None:
        add_proposal(
            tool_name="inspect_result",
            arguments={"job_id": context.selected_job, "gene": context.selected_gene or ""},
            title="Inspect current result",
            description="Run a read-only inspection of the selected simulation job and summarize deterministic result links.",
            proposal_kind="read_only",
        )

    if context.selected_gene:
        gene = _lookup_gene_by_symbol(session, context.selected_gene)
        if gene:
            add_proposal(
                tool_name="inspect_gene",
                arguments={"gene": gene.symbol},
                title=f"Inspect {gene.symbol} gene facts",
                description="Read validated Genes Table metadata, model-state IDs, and page links for the selected gene.",
                proposal_kind="read_only",
            )
        if gene and gene.ko_index > 0:
            condition = context.selected_condition or "basal"
            add_proposal(
                tool_name="create_experiment",
                arguments={
                    "name": f"{gene.symbol} knockout follow-up",
                    "description": "Assistant-proposed draft. Review the experiment before queueing any simulation.",
                    "variant_type": "gene_knockout",
                    "variant_index": gene.ko_index,
                    "condition": condition,
                    "timeline": "",
                    "sim_params": {},
                    "gene_symbol": gene.symbol,
                    "gene_symbols": [],
                    "include_wildtype": True,
                },
                title="Draft follow-up knockout",
                description=f"Prepare a reviewed gene-knockout draft for {gene.symbol} under {condition}.",
                proposal_kind="side_effect_preview",
            )

    if context.selected_experiment is not None:
        add_proposal(
            tool_name="run_simulation",
            arguments={"experiment_id": context.selected_experiment, "seed": 0, "generations": 1},
            title="Preview one simulation run",
            description="Preview queueing one seed/generation run from the selected experiment. Queueing still requires confirmation.",
            proposal_kind="side_effect_preview",
        )

    return proposals


def record_agent_side_effect_proposals(
    session: Session,
    *,
    conversation: AssistantConversation,
    assistant_message: AssistantMessage,
    pending: list[Any],
) -> list[AssistantToolCall]:
    """Turn side-effecting tool calls the model requested into confirmation-gated cards.

    ``pending`` items expose ``tool_name``, ``normalized_arguments`` and ``preview`` attributes
    (the ``PendingSideEffect`` records produced by the agent loop). The model already proposed
    the action via a native tool call; here we materialize the reviewable card the user confirms.
    """

    proposals: list[AssistantToolCall] = []
    for item in pending:
        tool_name = getattr(item, "tool_name", "")
        arguments = getattr(item, "normalized_arguments", {}) or {}
        preview = getattr(item, "preview", {}) or {}
        try:
            spec = get_tool_spec(tool_name)
        except HTTPException:
            continue
        description = preview.get("summary") if isinstance(preview, dict) else None
        proposals.append(
            _record_assistant_proposal(
                session,
                conversation=conversation,
                assistant_message=assistant_message,
                tool_name=tool_name,
                arguments=arguments,
                title=spec.label,
                description=description or spec.description,
                proposal_kind="side_effect_preview",
                source="model_tool_call",
            )
        )
    return proposals


def record_model_gene_proposals(
    session: Session,
    *,
    conversation: AssistantConversation,
    assistant_message: AssistantMessage,
    context: AssistantContext,
    user_content: str,
    assistant_content: str,
    conversation_context: dict[str, Any] | None = None,
) -> list[AssistantToolCall]:
    """Record validated, non-executing gene proposals from explicit model intent."""

    text_intent = f"{user_content}\n{assistant_content}".lower()
    action_keywords = (
        "knockout",
        "knock out",
        "ko",
        "experiment",
        "simulate",
        "simulation",
        "card",
        "cards",
        "prepare",
        "draft",
        "schedule",
        "queue",
    )
    structured_directive = _structured_proposal_directive(assistant_content)
    has_action_intent = any(keyword in text_intent for keyword in action_keywords)
    if not structured_directive["explicit"] and not has_action_intent:
        return []

    conversation_texts: list[str] = []
    if conversation_context:
        for message in conversation_context.get("messages", []):
            if isinstance(message, dict) and isinstance(message.get("content"), str):
                conversation_texts.append(message["content"])

    proposals: list[AssistantToolCall] = []
    existing_keys: set[tuple[str, str]] = set()
    existing_records = session.exec(
        select(AssistantToolCall).where(AssistantToolCall.message_id == assistant_message.id)
    ).all()
    for record in existing_records:
        if record.tool_name not in {"create_experiment", "inspect_gene"}:
            continue
        arguments = from_json(record.arguments_json, {})
        if isinstance(arguments, dict):
            gene_symbol = str(arguments.get("gene_symbol") or arguments.get("gene") or "").strip()
            if gene_symbol:
                existing_keys.add((record.tool_name, gene_symbol))

    if structured_directive["explicit"]:
        genes = _genes_from_symbols(session, structured_directive["targets"], limit=6)
        source = "model_structured_proposal"
    else:
        genes = _mentioned_genes(
            session,
            user_content,
            assistant_content,
            *conversation_texts,
            selected_gene=context.selected_gene,
            limit=6,
        )
        source = "model_gene_mention"

    proposal_action = structured_directive["action"]
    condition = structured_directive["condition"] or context.selected_condition or "basal"

    for gene in genes:
        inspect_key = ("inspect_gene", gene.symbol)
        if inspect_key not in existing_keys:
            existing_keys.add(inspect_key)
            proposals.append(
                _record_assistant_proposal(
                    session,
                    conversation=conversation,
                    assistant_message=assistant_message,
                    tool_name="inspect_gene",
                    arguments={"gene": gene.symbol},
                    title=f"Inspect {gene.symbol} gene facts",
                    description="Read validated Genes Table metadata before deciding whether to create a follow-up experiment.",
                    proposal_kind="read_only",
                    source=source,
                )
            )
        if proposal_action == "inspect_gene":
            continue
        if gene.ko_index <= 0:
            continue
        key = ("create_experiment", gene.symbol)
        if key in existing_keys:
            continue
        existing_keys.add(key)
        proposals.append(
            _record_assistant_proposal(
                session,
                conversation=conversation,
                assistant_message=assistant_message,
                tool_name="create_experiment",
                arguments={
                    "name": f"{gene.symbol} knockout follow-up",
                    "description": "Model-suggested draft. Review the experiment before queueing any simulation.",
                    "variant_type": "gene_knockout",
                    "variant_index": gene.ko_index,
                    "condition": condition,
                    "timeline": "",
                    "sim_params": {},
                    "gene_symbol": gene.symbol,
                    "gene_symbols": [],
                    "include_wildtype": True,
                },
                title=f"Draft {gene.symbol} knockout",
                description=(
                    f"The assistant mentioned {gene.symbol}. Prepare a reviewed gene-knockout draft under {condition}; "
                    "creating and running it still require confirmation."
                ),
                proposal_kind="side_effect_preview",
                source=source,
            )
        )
    return proposals


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
    if _confirmation_expired(confirmation):
        errors.append(f"Confirmation {confirmation_id} has expired; please confirm the action again.")
    confirmed_payload = from_json(confirmation.payload_json, {})
    if confirmed_payload != normalized_arguments:
        errors.append("Confirmation payload does not match normalized tool arguments.")
    return confirmation, errors


def _confirmation_expired(confirmation: AssistantConfirmation) -> bool:
    expires_at = getattr(confirmation, "expires_at", "") or ""
    if not expires_at:
        return False
    try:
        return datetime.now(timezone.utc) > datetime.fromisoformat(expires_at)
    except ValueError:
        return False


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


def _execute_inspect_gene(
    session: Session,
    normalized_arguments: dict[str, Any],
) -> dict[str, Any]:
    gene_symbol = str(normalized_arguments.get("gene") or "")
    gene = _lookup_gene_by_symbol(session, gene_symbol)
    if not gene:
        raise HTTPException(status_code=404, detail=f"Gene '{gene_symbol}' not found.")
    links = [
        {"label": "Workspace gene detail", "path": f"/?gene={gene.symbol}"},
        {"label": "Genome map", "path": f"/genome?gene={gene.symbol}"},
        {"label": "Network context", "path": f"/network?gene={gene.symbol}"},
        {"label": "Design knockout draft", "path": f"/experiments/new?gene={gene.symbol}"},
    ]
    return {
        "gene": _gene_summary(gene),
        "summary": {
            "mechanistic": gene.is_mechanistic,
            "knockout_available": gene.ko_index > 0,
            "model_state_ids": {
                "mrna": f"{gene.ecoli_id}_RNA" if gene.ecoli_id else "",
                "protein": gene.monomer_id or "",
            },
        },
        "links": links,
    }


def _execute_gene_catalog(session: Session, normalized_arguments: dict[str, Any]) -> dict[str, Any]:
    category = (normalized_arguments.get("category") or "").strip().lower()
    search = (normalized_arguments.get("search") or "").strip().lower()
    limit = int(normalized_arguments.get("limit") or 15)
    genes = session.exec(select(Gene)).all()

    by_category: dict[str, int] = {}
    knockout_ready = 0
    mechanistic = 0
    with_protein = 0
    for gene in genes:
        key = gene.category or "other"
        by_category[key] = by_category.get(key, 0) + 1
        if gene.ko_index and gene.ko_index > 0:
            knockout_ready += 1
        if gene.is_mechanistic:
            mechanistic += 1
        if gene.monomer_id:
            with_protein += 1

    def matches(gene: Gene) -> bool:
        if category and (gene.category or "other").lower() != category:
            return False
        if search:
            haystack = " ".join(
                [gene.symbol or "", gene.ecoli_id or "", gene.monomer_name or "", gene.monomer_id or ""]
            ).lower()
            if search not in haystack:
                return False
        return True

    matched = [gene for gene in genes if matches(gene)]
    return {
        "totals": {
            "genes": len(genes),
            "knockout_ready": knockout_ready,
            "mechanistic": mechanistic,
            "with_protein": with_protein,
            "categories": len(by_category),
        },
        "category_breakdown": dict(sorted(by_category.items(), key=lambda item: -item[1])),
        "filters": {"category": category, "search": search},
        "matched_count": len(matched),
        "genes": [_gene_summary(gene) for gene in matched[:limit]],
        "note": "Counts are over the local Genes table. Knockout-ready genes have ko_index > 0.",
        "links": [{"label": "Gene catalog", "path": "/genes"}],
    }


def _execute_inspect_tf_network(session: Session, normalized_arguments: dict[str, Any]) -> dict[str, Any]:
    gene_symbol = str(normalized_arguments.get("gene") or "")
    gene = _lookup_gene_by_symbol(session, gene_symbol)
    if not gene:
        raise HTTPException(status_code=404, detail=f"Gene '{gene_symbol}' not found.")
    limit = int(normalized_arguments.get("limit") or 20)
    downstream = session.exec(select(TFEdge).where(TFEdge.tf_symbol == gene.symbol)).all()
    upstream = session.exec(select(TFEdge).where(TFEdge.target_symbol == gene.symbol)).all()
    return {
        "gene": gene.symbol,
        "is_transcription_factor": len(downstream) > 0,
        "summary": {"regulator_count": len(upstream), "target_count": len(downstream)},
        "regulators": [
            {"regulator": edge.tf_symbol, "log2fc": edge.log2fc_mean, "regulation": edge.regulation_direct or ""}
            for edge in upstream[:limit]
        ],
        "targets": [
            {"target": edge.target_symbol, "log2fc": edge.log2fc_mean, "regulation": edge.regulation_direct or ""}
            for edge in downstream[:limit]
        ],
        "links": [
            {"label": f"TF network for {gene.symbol}", "path": f"/network?gene={gene.symbol}"},
            {"label": f"Workspace context for {gene.symbol}", "path": f"/?gene={gene.symbol}"},
        ],
    }


def _read_tf_conditions() -> list[dict[str, str]]:
    """TF-condition rules live only in the flat reconstruction file (no DB model)."""
    import csv as _csv

    path = getattr(settings, "tf_condition_tsv", None)
    if not path or not path.exists():
        return []
    try:
        with open(path, encoding="utf-8") as handle:
            lines = [ln for ln in handle if ln.strip() and not ln.lstrip().startswith("#")]
        rows: list[dict[str, str]] = []
        for row in _csv.DictReader(lines, delimiter="\t"):
            rows.append({(k or "").strip().strip('"'): (v or "").strip() for k, v in row.items() if k})
        return rows
    except OSError:
        return []


def _execute_list_conditions(session: Session, normalized_arguments: dict[str, Any]) -> dict[str, Any]:
    search = (normalized_arguments.get("search") or "").strip().lower()
    limit = int(normalized_arguments.get("limit") or 20)
    conditions = session.exec(select(Condition)).all()
    media = session.exec(select(MediaRecipe)).all()
    timelines = session.exec(select(Timeline)).all()
    tf_rows = _read_tf_conditions()

    def matches(condition: Condition) -> bool:
        if not search:
            return True
        return search in (condition.name or "").lower() or search in (condition.nutrients or "").lower()

    def tf_matches(row: dict[str, str]) -> bool:
        if not search:
            return True
        return any(search in (row.get(k) or "").lower() for k in ("TF", "active nutrients", "inactive nutrients", "TF type"))

    matched = [condition for condition in conditions if matches(condition)]
    matched_tf = [row for row in tf_rows if tf_matches(row)]
    return {
        "totals": {
            "conditions": len(conditions),
            "media_recipes": len(media),
            "timelines": len(timelines),
            "tf_conditions": len(tf_rows),
        },
        "matched_count": len(matched),
        "conditions": [
            {
                "name": condition.name,
                "nutrients": condition.nutrients,
                "active_tfs": condition.active_tfs,
                "inactive_tfs": condition.inactive_tfs,
                "genotype_perturbations": condition.genotype_perturbations,
                "doubling_time": condition.doubling_time,
            }
            for condition in matched[:limit]
        ],
        # Full recipe compositions (base/added media + ingredients), not just names.
        "media_recipes": [
            {
                "media_id": recipe.media_id,
                "base_media": recipe.base_media,
                "added_media": recipe.added_media,
                "ingredients": recipe.ingredients,
            }
            for recipe in media[:limit]
        ],
        # Timelines with their actual event schedule (media shifts over time), not just names.
        "timelines": [
            {"name": timeline.name, "definition": timeline.definition}
            for timeline in timelines[:limit]
        ],
        # TF-condition rules: which TF is active/inactive under which nutrients, and TF type.
        "tf_conditions": [
            {
                "tf": row.get("TF", ""),
                "active_tf": row.get("active TF", ""),
                "active_nutrients": row.get("active nutrients", ""),
                "inactive_nutrients": row.get("inactive nutrients", ""),
                "tf_type": row.get("TF type", ""),
            }
            for row in matched_tf[:limit]
        ],
        "links": [{"label": "Conditions Builder", "path": "/environment-builder"}],
    }


def _execute_list_experiments(session: Session, normalized_arguments: dict[str, Any]) -> dict[str, Any]:
    status_filter = (normalized_arguments.get("status") or "").strip().lower()
    batch_id = (normalized_arguments.get("batch_id") or "").strip()
    limit = int(normalized_arguments.get("limit") or 15)
    experiments = session.exec(select(Experiment).order_by(Experiment.id.desc())).all()

    by_status: dict[str, int] = {}
    by_variant: dict[str, int] = {}
    batches: set[str] = set()
    for experiment in experiments:
        by_status[experiment.status or "draft"] = by_status.get(experiment.status or "draft", 0) + 1
        by_variant[experiment.variant_type or "unknown"] = by_variant.get(experiment.variant_type or "unknown", 0) + 1
        if experiment.batch_id:
            batches.add(experiment.batch_id)

    requested_status = _canonical_status(status_filter) if status_filter else ""

    def matches(experiment: Experiment) -> bool:
        if requested_status and _canonical_status(experiment.status or "draft") != requested_status:
            return False
        if batch_id and experiment.batch_id != batch_id:
            return False
        return True

    matched = [experiment for experiment in experiments if matches(experiment)]
    return {
        "totals": {"experiments": len(experiments), "batches": len(batches)},
        "by_status": by_status,
        "by_variant": by_variant,
        "matched_count": len(matched),
        "experiments": [
            {
                "id": experiment.id,
                "name": experiment.name,
                "variant_type": experiment.variant_type,
                "condition": experiment.condition,
                "gene_symbol": experiment.gene_symbol,
                "status": experiment.status,
                "batch_id": experiment.batch_id,
            }
            for experiment in matched[:limit]
        ],
        "links": [
            {"label": "Experiments", "path": "/experiments"},
            {"label": "Design experiment", "path": "/experiments/new"},
            {"label": "Batch builder", "path": "/experiments/batch"},
        ],
    }


def _execute_inspect_experiment(session: Session, normalized_arguments: dict[str, Any]) -> dict[str, Any]:
    experiment_id = normalized_arguments.get("experiment_id")
    experiment = session.get(Experiment, experiment_id)
    if not experiment:
        raise HTTPException(status_code=404, detail=f"Experiment {experiment_id} not found.")
    jobs = session.exec(
        select(SimulationJob).where(SimulationJob.experiment_id == experiment.id).order_by(SimulationJob.id)
    ).all()
    results = session.exec(
        select(SimulationResult).where(SimulationResult.experiment_id == experiment.id)
    ).all()
    return {
        "experiment": {
            "id": experiment.id,
            "name": experiment.name,
            "description": experiment.description,
            "variant_type": experiment.variant_type,
            "variant_index": experiment.variant_index,
            "condition": experiment.condition,
            "timeline": experiment.timeline,
            "gene_symbol": experiment.gene_symbol,
            "status": experiment.status,
            "batch_id": experiment.batch_id,
            "sim_params": from_json(experiment.sim_params, {}),
        },
        "jobs": [
            {"id": job.id, "status": job.status, "seed": job.seed, "generations": job.generations, "condition": job.condition}
            for job in jobs
        ],
        "result_summary": {
            "result_count": len(results),
            "divided": sum(1 for result in results if result.divided),
        },
        "links": [{"label": f"Experiment {experiment.id}", "path": f"/experiments?experiment={experiment.id}"}],
    }


def _execute_explain_modeling(session: Session, normalized_arguments: dict[str, Any]) -> dict[str, Any]:
    topic = (normalized_arguments.get("topic") or "").strip().lower()
    if topic and topic in MODELING_TOPICS:
        return {
            "topic": topic,
            "explanation": MODELING_TOPICS[topic],
            "available_topics": list(MODELING_TOPICS.keys()),
            "guardrail": MODELING_GUARDRAIL,
        }
    # No (or unknown) topic: return the overview plus the catalog of topics so the model can pick.
    return {
        "topic": "overview",
        "explanation": MODELING_TOPICS["overview"],
        "all_topics": MODELING_TOPICS,
        "available_topics": list(MODELING_TOPICS.keys()),
        "guardrail": MODELING_GUARDRAIL,
    }


def _execute_platform_guide(session: Session, normalized_arguments: dict[str, Any]) -> dict[str, Any]:
    page = (normalized_arguments.get("page") or "").strip().lower()
    if page:
        pages = [
            entry
            for entry in PLATFORM_PAGES
            if page in entry["name"].lower() or page in entry["route"].lower()
        ]
    else:
        pages = list(PLATFORM_PAGES)
    return {
        "pages": pages,
        "page_count": len(pages),
        "note": (
            "Authoritative platform page descriptions. The assistant cannot browse pages itself, but these are the "
            "real pages, their data, and the read-only tools that back them."
        ),
    }


def _execute_inspect_molecule_trajectories(session: Session, normalized_arguments: dict[str, Any]) -> dict[str, Any]:
    job_id = normalized_arguments.get("job_id")
    job = session.get(SimulationJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Simulation job {job_id} not found.")
    gene_symbol = str(normalized_arguments.get("gene") or "")
    results = session.exec(
        select(SimulationResult).where(SimulationResult.job_id == job.id)
    ).all()
    seeds = sorted({result.seed for result in results})
    generations = sorted({result.generation for result in results})

    molecule_ids: list[dict[str, Any]] = []
    gene = _lookup_gene_by_symbol(session, gene_symbol) if gene_symbol else None
    if gene:
        if gene.monomer_id:
            molecule_ids.append({"id": gene.monomer_id, "molecule_type": "protein", "role": "monomer"})
        for rna_id in from_json(gene.rna_ids, []) or []:
            if isinstance(rna_id, str):
                molecule_ids.append({"id": rna_id, "molecule_type": "mRNA_cistron", "role": "mrna"})

    return {
        "job": {"id": job.id, "status": job.status, "condition": job.condition, "seed": job.seed, "generations": job.generations},
        "trajectory_scope": {
            "result_rows_for_this_job": len(results),
            "seeds": seeds,
            "generation_indices": generations,
            "note": (
                "Each plotted trajectory is one cell lineage (seed x generation, including daughter cells) belonging "
                "to THIS job only. The Molecule Explorer is scoped to a single job; it does not aggregate other "
                "results. A high trajectory count comes from this job's own multigenerational lineage fan-out, not "
                "from other runs."
            ),
        },
        "focus_gene": gene.symbol if gene else "",
        "molecules": molecule_ids,
        "links": [
            {"label": f"Molecule explorer for job {job.id}", "path": f"/results/{job.id}?view=model-outputs"},
        ],
    }


def _aggregate_job_metrics(results: list[SimulationResult]) -> dict[str, Any]:
    def stats(values: list[float]) -> dict[str, float] | None:
        nums = [v for v in values if v is not None]
        if not nums:
            return None
        return {"mean": sum(nums) / len(nums), "min": min(nums), "max": max(nums), "n": len(nums)}

    return {
        "growth_rate": stats([r.growth_rate for r in results]),
        "division_time_sec": stats([r.division_time_sec for r in results]),
        "final_mass_fg": stats([r.final_mass_fg for r in results]),
        "doubling_time_min": stats([r.doubling_time_min for r in results]),
    }


_STATUS_BUCKETS = {
    "done": {"done", "completed", "complete", "finished", "success", "succeeded", "ok", "ready"},
    "running": {"running", "in_progress", "active", "started", "processing"},
    "pending": {"pending", "queued", "waiting", "scheduled", "not_started"},
    "failed": {"failed", "error", "errored", "failure", "cancelled", "canceled", "aborted"},
}


def _canonical_status(value: Any) -> str:
    """Map a status (DB value or model-supplied synonym like 'completed') to a canonical bucket."""
    token = str(value or "").strip().lower().replace(" ", "_").replace("-", "_")
    for canon, names in _STATUS_BUCKETS.items():
        if token in names:
            return canon
    return token


def _execute_list_results(session: Session, normalized_arguments: dict[str, Any]) -> dict[str, Any]:
    status_filter = (normalized_arguments.get("status") or "").strip().lower()
    requested = _canonical_status(status_filter) if status_filter else "done"
    limit = int(normalized_arguments.get("limit") or 20)
    jobs = session.exec(select(SimulationJob).order_by(SimulationJob.id.desc())).all()

    by_status: dict[str, int] = {}
    for job in jobs:
        by_status[job.status or "unknown"] = by_status.get(job.status or "unknown", 0) + 1

    # Default to completed results (what 'a result' usually means); allow an explicit override.
    # Match on the canonical bucket so 'completed'/'finished'/'success' all hit DB status 'done'.
    def matches(job: SimulationJob) -> bool:
        return _canonical_status(job.status) == requested

    matched = [job for job in jobs if matches(job)]
    rows: list[dict[str, Any]] = []
    for job in matched[:limit]:
        experiment = session.get(Experiment, job.experiment_id)
        results = session.exec(select(SimulationResult).where(SimulationResult.job_id == job.id)).all()
        rows.append({
            "job_id": job.id,
            "experiment_id": job.experiment_id,
            "experiment_name": experiment.name if experiment else "",
            "gene_symbol": (experiment.gene_symbol if experiment else "") or "",
            "variant_type": experiment.variant_type if experiment else job.variant_type,
            "condition": job.condition,
            "status": job.status,
            "result_rows": len(results),
            "metrics": _aggregate_job_metrics(results),
        })
    return {
        "totals": {"jobs": len(jobs), "by_status": by_status, "completed": by_status.get("done", 0)},
        "filter": {"status": status_filter or "done"},
        "matched_count": len(matched),
        "results": rows,
        "note": "Each row is one completed result; inspect_result or compare_results with its job_id for detail.",
        "links": [{"label": "Results", "path": "/results"}],
    }


def _execute_compare_results(session: Session, normalized_arguments: dict[str, Any]) -> dict[str, Any]:
    job_ids = list(normalized_arguments.get("job_ids") or [])
    experiment_ids = list(normalized_arguments.get("experiment_ids") or [])
    metric = (normalized_arguments.get("metric") or "growth_rate").strip() or "growth_rate"

    # Expand experiment_ids to their jobs, preserving order and de-duplicating.
    resolved: list[int] = []
    seen: set[int] = set()
    for jid in job_ids:
        if jid not in seen:
            seen.add(jid); resolved.append(jid)
    for eid in experiment_ids:
        jobs = session.exec(select(SimulationJob).where(SimulationJob.experiment_id == eid)).all()
        for job in jobs:
            if job.id not in seen:
                seen.add(job.id); resolved.append(job.id)

    comparison: list[dict[str, Any]] = []
    missing: list[int] = []
    for jid in resolved:
        job = session.get(SimulationJob, jid)
        if not job:
            missing.append(jid); continue
        experiment = session.get(Experiment, job.experiment_id)
        results = session.exec(select(SimulationResult).where(SimulationResult.job_id == jid)).all()
        comparison.append({
            "job_id": jid,
            "experiment_id": job.experiment_id,
            "experiment_name": experiment.name if experiment else "",
            "gene_symbol": (experiment.gene_symbol if experiment else "") or job.variant_type or "",
            "variant_type": experiment.variant_type if experiment else job.variant_type,
            "condition": job.condition,
            "status": job.status,
            "result_rows": len(results),
            "metrics": _aggregate_job_metrics(results),
        })

    # Rank by the requested metric's mean (only jobs that have it).
    def metric_mean(entry: dict[str, Any]) -> float | None:
        m = entry["metrics"].get(metric)
        return m["mean"] if isinstance(m, dict) else None

    ranked = sorted(
        [e for e in comparison if metric_mean(e) is not None],
        key=lambda e: metric_mean(e),
        reverse=True,
    )
    ranking = [{"job_id": e["job_id"], "label": e["experiment_name"] or f"job {e['job_id']}", f"{metric}_mean": metric_mean(e)} for e in ranked]

    return {
        "metric": metric,
        "compared_job_count": len(comparison),
        "missing_job_ids": missing,
        "comparison": comparison,
        "ranking": ranking,
        "note": "Metrics are aggregated across each job's seeds and generations. Ranking is by the requested metric's mean (higher first).",
        "links": [{"label": "Results", "path": "/results"}],
    }


def _execute_read_result_series(session: Session, normalized_arguments: dict[str, Any]) -> dict[str, Any]:
    job_id = normalized_arguments.get("job_id")
    job = session.get(SimulationJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Simulation job {job_id} not found.")
    requested = (normalized_arguments.get("series") or "").strip()
    seed = normalized_arguments.get("seed")
    max_points = int(normalized_arguments.get("max_points") or 40)

    # Reuse the Results router's real-or-mock timeseries builder so the agent reads exactly what the
    # Molecule Explorer plots; flag clearly whether the numbers are real simOut or synthetic.
    from app.services.results_timeseries import generate_mock_timeseries as _generate_mock_timeseries
    from app.services.results_timeseries import load_real_timeseries as _load_real_timeseries

    timeseries = _load_real_timeseries(job)
    data_source = "real_simOut"
    if not timeseries:
        data_source = "synthetic_demo"
        db_results = session.exec(select(SimulationResult).where(SimulationResult.job_id == job_id)).all()
        num_seeds = max(1, (max((r.seed for r in db_results), default=job.seed or 0)) + 1)
        timeseries = {}
        for s in range(num_seeds):
            for channel, sdata in _generate_mock_timeseries(s).items():
                timeseries.setdefault(channel, []).append(sdata)

    available = sorted(timeseries.keys())

    def find_channel(name: str) -> str | None:
        low = name.lower()
        if name in timeseries:
            return name
        for key in timeseries:
            if key.lower() == low:
                return key
        for key, series_list in timeseries.items():
            if low in key.lower() or any(low in (sd.label or "").lower() for sd in series_list):
                return key
        return None

    channel = find_channel(requested) if requested else None
    if not channel:
        return {
            "job_id": job_id,
            "data_source": data_source,
            "available_series": available,
            "note": (
                "Pass one of available_series as `series` to read its numeric values."
                + (" Data is synthetic demo data (no real simOut for this job) — caveat any numbers as illustrative." if data_source == "synthetic_demo" else "")
            ),
            "links": [{"label": f"Molecule explorer for job {job_id}", "path": f"/results/{job_id}?view=model-outputs"}],
        }

    series_list = timeseries[channel]
    chosen = series_list[0]
    if seed is not None and 0 <= int(seed) < len(series_list):
        chosen = series_list[int(seed)]
    points = [{"time": p.time, "value": p.value} for p in chosen.points]

    # Downsample evenly to at most max_points.
    if len(points) > max_points:
        step = (len(points) - 1) / (max_points - 1)
        idx = sorted({int(round(i * step)) for i in range(max_points)})
        points = [points[i] for i in idx if i < len(points)]

    values = [p["value"] for p in points]
    stats = None
    if values:
        stats = {
            "n_points": len(points),
            "t_start": points[0]["time"],
            "t_end": points[-1]["time"],
            "min": min(values),
            "max": max(values),
            "mean": sum(values) / len(values),
            "first": values[0],
            "last": values[-1],
        }
    return {
        "job_id": job_id,
        "data_source": data_source,
        "series": {
            "channel": channel,
            "label": chosen.label,
            "unit": chosen.unit,
            "seed_index": int(seed) if seed is not None else 0,
            "stats": stats,
            "points": points,
        },
        "available_series": available,
        "note": (
            "Synthetic demo data (no real simOut for this job) — numbers are illustrative, not measured."
            if data_source == "synthetic_demo" else "Real simOut values, downsampled for readability."
        ),
        "links": [{"label": f"Molecule explorer for job {job_id}", "path": f"/results/{job_id}?view=model-outputs"}],
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


def _persist_builder_draft(session: Session, *, section: str, name: str, payload: dict[str, Any]) -> BuilderSectionDraft:
    """Create a reviewable Conditions Builder draft (shared by the save_* tools). 409 on name clash."""
    if not name:
        raise HTTPException(status_code=422, detail=f"{section} draft requires a name.")
    existing = session.exec(
        select(BuilderSectionDraft)
        .where(BuilderSectionDraft.section == section)
        .where(BuilderSectionDraft.name == name)
    ).first()
    if existing:
        raise HTTPException(status_code=409, detail=f"A {section} draft named '{name}' already exists.")
    timestamp = now_iso()
    draft = BuilderSectionDraft(
        section=section,
        name=name,
        payload=json.dumps(payload, separators=(",", ":")),
        status="draft",
        created_at=timestamp,
        updated_at=timestamp,
    )
    session.add(draft)
    session.commit()
    session.refresh(draft)
    return draft


_CONDITION_BUILDER_LINK = {"label": "Open in Conditions Builder", "path": "/environment-builder"}


def _execute_save_condition(
    session: Session,
    normalized_arguments: dict[str, Any],
) -> dict[str, Any]:
    """Persist a 'condition' Conditions Builder draft (reviewable; not published)."""
    name = str(normalized_arguments.get("name") or "").strip()
    nutrients = str(normalized_arguments.get("nutrients") or "").strip()
    if not name or not nutrients:
        raise HTTPException(status_code=422, detail="Condition draft requires a name and nutrients.")

    doubling_time = normalized_arguments.get("doubling_time")
    active_tfs = normalized_arguments.get("active_tfs") or []
    inactive_tfs = normalized_arguments.get("inactive_tfs") or []
    geno = normalized_arguments.get("genotype_perturbations") or {}
    # The Builder publish step expects each draft cell as a string (it writes straight to TSV).
    payload = {
        "mode": "create",
        "source": "assistant",
        "draft": {
            "condition": name,
            "nutrients": nutrients,
            "genotype_perturbations": json.dumps(geno, separators=(",", ":")),
            "doubling_time": str(doubling_time if doubling_time is not None else 44.0),
            "active_tfs": json.dumps(active_tfs, separators=(",", ":")),
            "inactive_tfs": json.dumps(inactive_tfs, separators=(",", ":")),
        },
    }
    draft = _persist_builder_draft(session, section="condition", name=name, payload=payload)
    return {
        "action": "created_condition_draft",
        "draft": {
            "id": draft.id, "section": "condition", "name": draft.name, "status": draft.status,
            "nutrients": nutrients, "doubling_time": payload["draft"]["doubling_time"],
            "active_tfs": active_tfs, "inactive_tfs": inactive_tfs,
        },
        "links": [_CONDITION_BUILDER_LINK],
    }


def _execute_save_timeline(session: Session, normalized_arguments: dict[str, Any]) -> dict[str, Any]:
    name = str(normalized_arguments.get("name") or "").strip()
    events = str(normalized_arguments.get("events") or "").strip()
    if not name or not events:
        raise HTTPException(status_code=422, detail="Timeline draft requires a name and events.")
    payload = {"mode": "create", "source": "assistant", "name": name, "events": events}
    draft = _persist_builder_draft(session, section="timeline", name=name, payload=payload)
    return {
        "action": "created_timeline_draft",
        "draft": {"id": draft.id, "section": "timeline", "name": draft.name, "status": draft.status, "events": events},
        "links": [_CONDITION_BUILDER_LINK],
    }


def _execute_save_recipe(session: Session, normalized_arguments: dict[str, Any]) -> dict[str, Any]:
    media_id = str(normalized_arguments.get("media_id") or "").strip()
    base_media = str(normalized_arguments.get("base_media") or "").strip()
    if not media_id or not base_media:
        raise HTTPException(status_code=422, detail="Media-recipe draft requires media_id and base_media.")
    added_media = str(normalized_arguments.get("added_media") or "").strip()
    ingredients = normalized_arguments.get("ingredients") or []
    payload = {
        "mode": "create",
        "source": "assistant",
        "draft": {
            "media_id": media_id,
            "base_media": base_media,
            "base_media_volume": "1.0",
            "added_media": added_media,
            "added_media_volume": "0",
            "ingredients": json.dumps(ingredients, separators=(",", ":")),
            "ingredients_weight": "[]",
            "ingredients_counts": "[]",
            "ingredients_volume": "[]",
        },
    }
    draft = _persist_builder_draft(session, section="mediaRecipe", name=media_id, payload=payload)
    return {
        "action": "created_media_recipe_draft",
        "draft": {"id": draft.id, "section": "mediaRecipe", "name": draft.name, "status": draft.status,
                  "base_media": base_media, "added_media": added_media, "ingredients": ingredients},
        "links": [_CONDITION_BUILDER_LINK],
    }


def _execute_save_tf_condition(session: Session, normalized_arguments: dict[str, Any]) -> dict[str, Any]:
    name = str(normalized_arguments.get("name") or "").strip()
    tf = str(normalized_arguments.get("tf") or "").strip()
    if not name or not tf:
        raise HTTPException(status_code=422, detail="TF-condition draft requires a name and tf.")
    row = {
        "tf": tf,
        "active_tf": str(normalized_arguments.get("active_tf") or "").strip(),
        "active_nutrients": str(normalized_arguments.get("active_nutrients") or "").strip(),
        "active_genotype_perturbations": json.dumps(normalized_arguments.get("active_genotype_perturbations") or {}, separators=(",", ":")),
        "inactive_nutrients": str(normalized_arguments.get("inactive_nutrients") or "").strip(),
        "inactive_genotype_perturbations": json.dumps(normalized_arguments.get("inactive_genotype_perturbations") or {}, separators=(",", ":")),
        "tf_type": str(normalized_arguments.get("tf_type") or "").strip(),
    }
    # The tfCondition publish step expects payload.draft to be a LIST of rows.
    payload = {"mode": "create", "source": "assistant", "draft": [row]}
    draft = _persist_builder_draft(session, section="tfCondition", name=name, payload=payload)
    return {
        "action": "created_tf_condition_draft",
        "draft": {"id": draft.id, "section": "tfCondition", "name": draft.name, "status": draft.status, "tf": tf},
        "links": [_CONDITION_BUILDER_LINK],
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
    _resolve_proposed_tool_call(session, confirmation.tool_call_id, "executed")
    session.commit()
    session.refresh(confirmation)
    return confirmation


def _resolve_proposed_tool_call(session: Session, tool_call_id: int | None, status: str) -> None:
    """Move the originating 'proposed' card out of the awaiting-review list once it is acted on."""
    if tool_call_id is None:
        return
    record = session.get(AssistantToolCall, tool_call_id)
    if record and record.status in {"proposed", "pending_confirmation"}:
        record.status = status
        record.updated_at = now_iso()
        session.add(record)


def dismiss_tool_call(session: Session, tool_call_id: int, status: str = "rejected") -> AssistantToolCall | None:
    """Public, idempotent terminal-state setter for a proposed card (used by the UI on resolve)."""
    record = session.get(AssistantToolCall, tool_call_id)
    if not record:
        return None
    if record.status in {"proposed", "pending_confirmation"}:
        record.status = status if status in {"executed", "rejected", "cancelled", "superseded"} else "rejected"
        record.updated_at = now_iso()
        session.add(record)
        session.commit()
        session.refresh(record)
    return record


def supersede_open_proposals(session: Session, conversation_id: int | None) -> int:
    """Retire any still-open proposals in a conversation so a new turn's cards replace, not stack.

    Without this, every `status='proposed'` refetch (e.g. after navigating away and back) resurrects
    the entire accumulated pile of past proposals.
    """
    if conversation_id is None:
        return 0
    open_records = session.exec(
        select(AssistantToolCall)
        .where(AssistantToolCall.conversation_id == conversation_id)
        .where(AssistantToolCall.status == "proposed")
    ).all()
    for record in open_records:
        record.status = "superseded"
        record.updated_at = now_iso()
        session.add(record)
    if open_records:
        session.commit()
    return len(open_records)


# Side-effecting tools: execute only after an approved, matching confirmation. The keys also drive
# the execution-enabled membership checks (preview, status, execute dispatch).
_SIDE_EFFECT_EXECUTORS = {
    "create_experiment": _execute_create_experiment,
    "run_simulation": _execute_run_simulation,
    "save_condition": _execute_save_condition,
    "save_timeline": _execute_save_timeline,
    "save_recipe": _execute_save_recipe,
    "save_tf_condition": _execute_save_tf_condition,
}


_READ_ONLY_EXECUTORS = {
    "inspect_result": _execute_inspect_result,
    "inspect_gene": _execute_inspect_gene,
    "gene_catalog": _execute_gene_catalog,
    "inspect_tf_network": _execute_inspect_tf_network,
    "list_conditions": _execute_list_conditions,
    "list_experiments": _execute_list_experiments,
    "inspect_experiment": _execute_inspect_experiment,
    "inspect_molecule_trajectories": _execute_inspect_molecule_trajectories,
    "list_results": _execute_list_results,
    "compare_results": _execute_compare_results,
    "read_result_series": _execute_read_result_series,
    "platform_guide": _execute_platform_guide,
    "explain_modeling": _execute_explain_modeling,
    "model_structure": _execute_model_structure,
}


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

        if tool_name in _SIDE_EFFECT_EXECUTORS:
            result = _SIDE_EFFECT_EXECUTORS[tool_name](session, preview.normalized_arguments)
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

    executor = _READ_ONLY_EXECUTORS.get(tool_name)
    if executor is None:
        raise HTTPException(status_code=404, detail=f"No execution adapter registered for '{tool_name}'.")

    result = executor(session, preview.normalized_arguments)
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
        expires_at=getattr(record, "expires_at", "") or "",
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


def update_conversation(
    session: Session, conversation_id: int, data: AssistantConversationUpdate
) -> AssistantConversation:
    conversation = session.get(AssistantConversation, conversation_id)
    if not conversation:
        raise HTTPException(status_code=404, detail="Assistant conversation not found.")
    title = data.title.strip()
    if not title:
        raise HTTPException(status_code=422, detail="Conversation title cannot be empty.")
    conversation.title = title[:200]
    conversation.updated_at = now_iso()
    session.add(conversation)
    session.commit()
    session.refresh(conversation)
    return conversation


def delete_conversation(session: Session, conversation_id: int) -> None:
    conversation = session.get(AssistantConversation, conversation_id)
    if not conversation:
        raise HTTPException(status_code=404, detail="Assistant conversation not found.")
    for model in (AssistantProvenance, AssistantConfirmation, AssistantToolCall, AssistantMessage):
        records = session.exec(select(model).where(model.conversation_id == conversation_id)).all()
        for record in records:
            session.delete(record)
    session.delete(conversation)
    session.commit()


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
    import secrets as _secrets

    timestamp = now_iso()
    ttl = max(30, int(settings.assistant_confirmation_ttl_sec or 900))
    expires_at = (datetime.now(timezone.utc) + timedelta(seconds=ttl)).isoformat()
    confirmation = AssistantConfirmation(
        conversation_id=data.conversation_id,
        tool_call_id=data.tool_call_id,
        action=data.action,
        status="pending",
        payload_json=to_json(data.payload),
        nonce=_secrets.token_hex(8),
        expires_at=expires_at,
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
    if data.status in {"rejected", "cancelled"}:
        _resolve_proposed_tool_call(session, confirmation.tool_call_id, data.status)
    session.commit()
    session.refresh(confirmation)
    return confirmation
