"""Provider runtime adapter for assistant chat responses.

This module intentionally does not expose tools to model providers. It only
turns a user message plus page context into a regular assistant message.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Literal

from pydantic import BaseModel, Field
from sqlmodel import Session, select

from app.config import settings
from app.db.models import AssistantProviderConfig


RuntimeStatus = Literal[
    "no_provider_configured",
    "selected_provider_not_configured",
    "provider_not_supported",
    "provider_call_failed",
    "completed",
]


Transport = Callable[[str, dict[str, str], dict[str, Any], int], dict[str, Any]]


@dataclass(frozen=True)
class RuntimeProviderSpec:
    provider_id: str
    kind: Literal["openai_compatible", "anthropic", "ollama"]
    secret_setting: str | None = None
    endpoint_setting: str | None = None
    default_base_url: str = ""
    default_model: str = ""
    auth_header: str = "Authorization"
    auth_prefix: str = "Bearer "
    extra_headers: dict[str, str] | None = None


RUNTIME_PROVIDER_SPECS = {
    "openai": RuntimeProviderSpec(
        provider_id="openai",
        kind="openai_compatible",
        secret_setting="openai_api_key",
        default_base_url="https://api.openai.com/v1",
        default_model="gpt-4.1-mini",
    ),
    "anthropic": RuntimeProviderSpec(
        provider_id="anthropic",
        kind="anthropic",
        secret_setting="anthropic_api_key",
        default_base_url="https://api.anthropic.com/v1",
        default_model="claude-sonnet-4-5",
    ),
    "openrouter": RuntimeProviderSpec(
        provider_id="openrouter",
        kind="openai_compatible",
        secret_setting="openrouter_api_key",
        default_base_url="https://openrouter.ai/api/v1",
        default_model="openai/gpt-4.1-mini",
        extra_headers={"HTTP-Referer": "http://localhost", "X-Title": "wcEcoli"},
    ),
    "lm_studio": RuntimeProviderSpec(
        provider_id="lm_studio",
        kind="openai_compatible",
        endpoint_setting="lm_studio_base_url",
        default_model="local-model",
    ),
    "vllm": RuntimeProviderSpec(
        provider_id="vllm",
        kind="openai_compatible",
        endpoint_setting="vllm_base_url",
        default_model="local-model",
    ),
    "ollama": RuntimeProviderSpec(
        provider_id="ollama",
        kind="ollama",
        endpoint_setting="ollama_base_url",
        default_model="llama3.1",
    ),
}


@dataclass(frozen=True)
class ResolvedRuntimeProvider:
    spec: RuntimeProviderSpec
    secret_value: str = ""
    endpoint_url: str = ""
    model: str = ""
    source: Literal["local_config", "environment"] = "environment"

    @property
    def provider_id(self) -> str:
        return self.spec.provider_id


class AssistantRuntimeResult(BaseModel):
    status: RuntimeStatus
    provider_id: str = ""
    model: str = ""
    content: str = ""
    request: dict[str, Any] = Field(default_factory=dict)
    response: dict[str, Any] = Field(default_factory=dict)
    error: str = ""


def _configured(value: str | None) -> bool:
    return bool((value or "").strip())


def _provider_configured(spec: RuntimeProviderSpec) -> bool:
    secret = getattr(settings, spec.secret_setting, "") if spec.secret_setting else ""
    endpoint = getattr(settings, spec.endpoint_setting, "") if spec.endpoint_setting else ""
    return _configured(secret) or _configured(endpoint)


def _active_provider_config(session: Session | None) -> AssistantProviderConfig | None:
    if session is None:
        return None
    return session.exec(
        select(AssistantProviderConfig)
        .where(AssistantProviderConfig.is_active == True)  # noqa: E712
        .order_by(AssistantProviderConfig.updated_at.desc())
    ).first()


def _config_secret(config: AssistantProviderConfig) -> str:
    from app.services.assistant_secrets import reveal

    return reveal(config.secret_value or "", bool(getattr(config, "secret_encrypted", False))).strip()


def _select_provider(
    session: Session | None = None,
    provider_id: str = "",
    model: str = "",
) -> ResolvedRuntimeProvider | None:
    if provider_id:
        spec = RUNTIME_PROVIDER_SPECS.get(provider_id)
        if not spec:
            return None
        config = session.exec(
            select(AssistantProviderConfig).where(AssistantProviderConfig.provider_id == provider_id)
        ).first() if session is not None else None
        return ResolvedRuntimeProvider(
            spec=spec,
            secret_value=_config_secret(config) if config else "",
            endpoint_url=config.endpoint_url.strip() if config else "",
            model=model.strip() or (config.model.strip() if config else ""),
            source="local_config" if config else "environment",
        )

    active_config = _active_provider_config(session)
    if active_config:
        spec = RUNTIME_PROVIDER_SPECS.get(active_config.provider_id)
        if spec:
            return ResolvedRuntimeProvider(
                spec=spec,
                secret_value=_config_secret(active_config),
                endpoint_url=active_config.endpoint_url.strip(),
                model=active_config.model.strip(),
                source="local_config",
            )

    requested_provider = (settings.assistant_provider or "").strip()
    if requested_provider:
        spec = RUNTIME_PROVIDER_SPECS.get(requested_provider)
        return ResolvedRuntimeProvider(spec=spec) if spec else None

    if session is not None:
        local_configs = session.exec(select(AssistantProviderConfig)).all()
        local_by_provider = {config.provider_id: config for config in local_configs}
        for provider_id in ("openai", "anthropic", "ollama", "openrouter", "lm_studio", "vllm"):
            config = local_by_provider.get(provider_id)
            spec = RUNTIME_PROVIDER_SPECS.get(provider_id)
            if config and spec and _resolved_provider_configured(
                ResolvedRuntimeProvider(
                    spec=spec,
                    secret_value=_config_secret(config),
                    endpoint_url=config.endpoint_url.strip(),
                    model=config.model.strip(),
                    source="local_config",
                )
            ):
                return ResolvedRuntimeProvider(
                    spec=spec,
                    secret_value=_config_secret(config),
                    endpoint_url=config.endpoint_url.strip(),
                    model=config.model.strip(),
                    source="local_config",
                )

    for provider_id in ("openai", "anthropic", "openrouter", "lm_studio", "vllm", "ollama"):
        spec = RUNTIME_PROVIDER_SPECS[provider_id]
        if _provider_configured(spec):
            return ResolvedRuntimeProvider(spec=spec)
    return None


def _resolved_provider_configured(provider: ResolvedRuntimeProvider) -> bool:
    spec = provider.spec
    if spec.secret_setting and not provider.secret_value:
        secret = getattr(settings, spec.secret_setting, "") if provider.source == "environment" else ""
        return _configured(secret)
    if spec.endpoint_setting and not provider.endpoint_url and not spec.secret_setting:
        endpoint = getattr(settings, spec.endpoint_setting, "") if provider.source == "environment" else ""
        return _configured(endpoint)
    return _configured(provider.secret_value) or _configured(provider.endpoint_url) or bool(spec.default_base_url and not spec.endpoint_setting)


def _provider_base_url(provider: ResolvedRuntimeProvider) -> str:
    spec = provider.spec
    if provider.endpoint_url:
        endpoint = provider.endpoint_url
    else:
        endpoint = getattr(settings, spec.endpoint_setting, "") if spec.endpoint_setting else ""
    return (endpoint or spec.default_base_url).rstrip("/")


def _provider_model(provider: ResolvedRuntimeProvider) -> str:
    return (provider.model or settings.assistant_model or provider.spec.default_model).strip()


def _provider_secret(provider: ResolvedRuntimeProvider) -> str:
    spec = provider.spec
    if provider.secret_value:
        return provider.secret_value
    return getattr(settings, spec.secret_setting, "") if spec.secret_setting else ""


def _default_transport(url: str, headers: dict[str, str], payload: dict[str, Any], timeout: int) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read().decode("utf-8")
    return json.loads(raw or "{}")


def _context_summary(context: dict[str, Any]) -> str:
    parts: list[str] = []
    for key in ("route", "selected_gene", "selected_experiment", "selected_job", "selected_result", "assistant_surface"):
        value = context.get(key)
        if value not in (None, ""):
            parts.append(f"{key}={value}")
    return ", ".join(parts) or "no page context"


def _platform_facts_summary(context: dict[str, Any]) -> str:
    facts = context.get("platform_facts")
    if not isinstance(facts, dict):
        return ""
    gene_pack = facts.get("gene_context")
    if not isinstance(gene_pack, dict):
        return ""
    genes = gene_pack.get("genes")
    if not isinstance(genes, list) or not genes:
        return ""
    lines = ["Validated local Genes table matches:"]
    for gene in genes[:10]:
        if not isinstance(gene, dict):
            continue
        symbol = gene.get("symbol") or ""
        category = gene.get("category") or ""
        ko_index = gene.get("ko_index")
        mechanistic = "mechanistic" if gene.get("mechanistic") else "expression-only"
        monomer = gene.get("monomer_id") or ""
        lines.append(f"- {symbol}: category={category}, ko_index={ko_index}, {mechanistic}, protein={monomer or 'none'}")
    usage = gene_pack.get("usage")
    if isinstance(usage, str) and usage:
        lines.append(usage)
    return "\n".join(lines)


def _conversation_memory_summary(context: dict[str, Any]) -> str:
    memory = context.get("conversation_context")
    if not isinstance(memory, dict):
        return ""
    messages = memory.get("messages")
    if not isinstance(messages, list) or not messages:
        return ""
    lines = [
        "Recent conversation memory:",
        "Use this to resolve references like 'those genes' or 'the three suggestions'.",
    ]
    for message in messages[-8:]:
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        content = message.get("content")
        if role not in {"user", "assistant"} or not isinstance(content, str) or not content.strip():
            continue
        compact = " ".join(content.strip().split())
        if len(compact) > 700:
            compact = f"{compact[:697]}..."
        lines.append(f"- {role}: {compact}")
    return "\n".join(lines) if len(lines) > 2 else ""


def _working_memory_summary(context: dict[str, Any]) -> str:
    memory = context.get("working_memory")
    if not isinstance(memory, dict):
        return ""
    lines = [
        "Structured working memory:",
        "Treat this as session state only. Deterministic platform facts must be re-fetched by adapters when needed.",
    ]
    selected = memory.get("selected_objects")
    if isinstance(selected, dict):
        compact_selected = {
            key: value
            for key, value in selected.items()
            if value not in (None, "")
        }
        if compact_selected:
            lines.append(f"- current selection: {json.dumps(compact_selected, sort_keys=True)}")
    remembered_genes = memory.get("remembered_genes")
    if isinstance(remembered_genes, list) and remembered_genes:
        lines.append(f"- remembered genes: {', '.join(str(gene) for gene in remembered_genes[:10])}")
    proposed_actions = memory.get("proposed_actions")
    if isinstance(proposed_actions, list) and proposed_actions:
        lines.append("- proposed actions already shown:")
        for action in proposed_actions[-6:]:
            if not isinstance(action, dict):
                continue
            title = action.get("title") or action.get("tool_name") or "proposal"
            gene = action.get("gene") or ""
            status = action.get("status") or ""
            requires_confirmation = action.get("requires_confirmation")
            lines.append(
                f"  - {title}"
                f"{f' for {gene}' if gene else ''}"
                f"{f' ({status})' if status else ''}"
                f"{' requires confirmation' if requires_confirmation else ''}"
            )
    pending_confirmations = memory.get("pending_confirmations")
    if isinstance(pending_confirmations, list) and pending_confirmations:
        lines.append(
            "- pending confirmations: "
            + ", ".join(
                f"{item.get('action')} #{item.get('id')}"
                for item in pending_confirmations
                if isinstance(item, dict)
            )
        )
    questions = memory.get("recent_unresolved_questions")
    if isinstance(questions, list) and questions:
        lines.append("- recent user questions:")
        for question in questions[-4:]:
            if isinstance(question, str) and question.strip():
                lines.append(f"  - {question.strip()}")
    policy = memory.get("summary_policy")
    if isinstance(policy, dict) and policy.get("currently_recommends_summary"):
        lines.append("- context note: this session is approaching a semantic/context boundary; answer tersely and prefer updating structured memory.")
    return "\n".join(lines) if len(lines) > 2 else ""


def _system_prompt(context: dict[str, Any]) -> str:
    platform_facts = _platform_facts_summary(context)
    conversation_memory = _conversation_memory_summary(context)
    working_memory = _working_memory_summary(context)
    platform_block = f"\n\n{platform_facts}" if platform_facts else ""
    memory_block = f"\n\n{conversation_memory}" if conversation_memory else ""
    working_memory_block = f"\n\n{working_memory}" if working_memory else ""
    return (
        "You are the wcEcoli platform assistant. Explain model, experiment, and result context clearly. "
        "Do not claim that you executed tools, queued simulations, edited files, or changed data. "
        "When an action is needed, describe the proposed action in plain language so the platform can show a separate confirmation. "
        "If you recommend a knockout experiment, name the exact gene symbol and say that the platform should show a reviewable proposal card. "
        "When the user asks to prepare cards for previous gene suggestions, use recent conversation memory and repeat the exact gene symbols. "
        "For proposed gene cards, include explicit proposal data, not only prose. "
        "Use final plain-text lines like 'Proposal action: create_experiment', 'Proposal condition: basal', and 'Proposal targets: dnaA, crp, fis', "
        "or a small JSON block such as {\"action\":\"create_experiment\",\"proposal_targets\":[\"dnaA\",\"crp\"]}. "
        "The platform validates symbols before showing cards. "
        f"Current page context: {_context_summary(context)}."
        f"{platform_block}"
        f"{memory_block}"
        f"{working_memory_block}"
    )


def generate_assistant_runtime_reply(
    user_content: str,
    context: dict[str, Any],
    *,
    session: Session | None = None,
    transport: Transport | None = None,
) -> AssistantRuntimeResult:
    """Generate a provider-backed assistant message without tool access."""
    active_config = _active_provider_config(session)
    requested_provider = active_config.provider_id if active_config else (settings.assistant_provider or "").strip()
    if requested_provider and requested_provider not in RUNTIME_PROVIDER_SPECS:
        return AssistantRuntimeResult(
            status="provider_not_supported",
            provider_id=requested_provider,
            model=(active_config.model if active_config else settings.assistant_model or "").strip(),
            content=(
                f"Assistant provider '{requested_provider}' is selected, but this build does not have a runtime adapter for it yet. "
                "Choose OpenAI, Anthropic, Ollama, OpenRouter, LM Studio, or vLLM for provider-backed chat."
            ),
            request={"context": context, "content_length": len(user_content)},
            response={"reason": "selected provider has no runtime adapter"},
        )

    provider = _select_provider(session)
    if not provider:
        return AssistantRuntimeResult(
            status="no_provider_configured",
            content=(
                "Assistant chat is not connected to a provider yet. The message and context were stored, "
                "and no model call or tool execution was attempted."
            ),
            request={"context": context, "content_length": len(user_content)},
            response={"reason": "no configured assistant provider"},
        )

    if not _resolved_provider_configured(provider):
        return AssistantRuntimeResult(
            status="selected_provider_not_configured",
            provider_id=provider.provider_id,
            model=_provider_model(provider),
            content=(
                f"Assistant provider '{provider.provider_id}' is selected but not configured. "
                "Set the provider key or local endpoint in Assistant provider setup before using provider-backed chat."
            ),
            request={"context": context, "content_length": len(user_content)},
            response={"reason": "selected provider is not configured"},
        )

    spec = provider.spec
    model = _provider_model(provider)
    timeout = max(1, int(settings.assistant_request_timeout_sec or 30))
    if spec.kind == "ollama":
        timeout = max(timeout, 120)
    active_transport = transport or _default_transport

    try:
        if spec.kind == "openai_compatible":
            base_url = _provider_base_url(provider)
            url = f"{base_url}/chat/completions"
            headers = {"Content-Type": "application/json"}
            api_key = _provider_secret(provider)
            if api_key:
                headers[spec.auth_header] = f"{spec.auth_prefix}{api_key}"
            if spec.extra_headers:
                headers.update(spec.extra_headers)
            payload = {
                "model": model,
                "messages": [
                    {"role": "system", "content": _system_prompt(context)},
                    {"role": "user", "content": user_content},
                ],
                "temperature": 0.2,
            }
            response = active_transport(url, headers, payload, timeout)
            content = (
                response.get("choices", [{}])[0]
                .get("message", {})
                .get("content", "")
            )
        elif spec.kind == "anthropic":
            base_url = _provider_base_url(provider)
            url = f"{base_url}/messages"
            headers = {
                "Content-Type": "application/json",
                "x-api-key": _provider_secret(provider),
                "anthropic-version": "2023-06-01",
            }
            payload = {
                "model": model,
                "max_tokens": 1200,
                "system": _system_prompt(context),
                "messages": [{"role": "user", "content": user_content}],
                "temperature": 0.2,
            }
            response = active_transport(url, headers, payload, timeout)
            content_blocks = response.get("content", [])
            content = "\n".join(
                block.get("text", "")
                for block in content_blocks
                if isinstance(block, dict) and block.get("type") == "text"
            ).strip()
        elif spec.kind == "ollama":
            base_url = _provider_base_url(provider)
            url = f"{base_url}/api/chat"
            headers = {"Content-Type": "application/json"}
            payload = {
                "model": model,
                "messages": [
                    {"role": "system", "content": _system_prompt(context)},
                    {"role": "user", "content": user_content},
                ],
                "stream": False,
            }
            response = active_transport(url, headers, payload, timeout)
            content = response.get("message", {}).get("content", "")
        else:
            return AssistantRuntimeResult(
                status="provider_not_supported",
                provider_id=spec.provider_id,
                model=model,
                content=f"Provider '{spec.provider_id}' is configured but has no runtime adapter yet.",
                request={"context": context, "content_length": len(user_content)},
                response={"reason": "unsupported provider runtime"},
            )
    except (urllib.error.URLError, TimeoutError, OSError, KeyError, IndexError, TypeError, ValueError) as exc:
        failure_hint = "Assistant provider call failed. No tools or side effects were attempted."
        if spec.kind == "ollama":
            failure_hint = (
                "Ollama call failed. Check that the endpoint is reachable from Docker, the selected model is pulled, "
                "and the local model has enough time to answer. No tools or side effects were attempted."
            )
        return AssistantRuntimeResult(
            status="provider_call_failed",
            provider_id=provider.provider_id,
            model=model,
            content=failure_hint,
            request={"context": context, "content_length": len(user_content)},
            response={"error_type": type(exc).__name__},
            error=str(exc),
        )

    return AssistantRuntimeResult(
        status="completed",
        provider_id=provider.provider_id,
        model=model,
        content=content or "The provider returned an empty response.",
        request={"provider_id": provider.provider_id, "model": model, "context": context, "content_length": len(user_content)},
        response={"status": "completed", "raw_keys": sorted(response.keys())},
    )
