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

from app.config import settings


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
    kind: Literal["openai_compatible", "ollama"]
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


def _select_provider() -> RuntimeProviderSpec | None:
    requested_provider = (settings.assistant_provider or "").strip()
    if requested_provider:
        return RUNTIME_PROVIDER_SPECS.get(requested_provider)

    for provider_id in ("openai", "openrouter", "lm_studio", "vllm", "ollama"):
        spec = RUNTIME_PROVIDER_SPECS[provider_id]
        if _provider_configured(spec):
            return spec
    return None


def _provider_base_url(spec: RuntimeProviderSpec) -> str:
    endpoint = getattr(settings, spec.endpoint_setting, "") if spec.endpoint_setting else ""
    return (endpoint or spec.default_base_url).rstrip("/")


def _provider_model(spec: RuntimeProviderSpec) -> str:
    return (settings.assistant_model or spec.default_model).strip()


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


def _system_prompt(context: dict[str, Any]) -> str:
    return (
        "You are the wcEcoli platform assistant. Explain model, experiment, and result context clearly. "
        "Do not claim that you executed tools, queued simulations, edited files, or changed data. "
        "When an action is needed, describe the proposed action in plain language so the platform can show a separate confirmation. "
        f"Current page context: {_context_summary(context)}."
    )


def generate_assistant_runtime_reply(
    user_content: str,
    context: dict[str, Any],
    *,
    transport: Transport | None = None,
) -> AssistantRuntimeResult:
    """Generate a provider-backed assistant message without tool access."""
    requested_provider = (settings.assistant_provider or "").strip()
    if requested_provider and requested_provider not in RUNTIME_PROVIDER_SPECS:
        return AssistantRuntimeResult(
            status="provider_not_supported",
            provider_id=requested_provider,
            model=(settings.assistant_model or "").strip(),
            content=(
                f"Assistant provider '{requested_provider}' is selected, but this build does not have a runtime adapter for it yet. "
                "Choose OpenAI, OpenRouter, LM Studio, vLLM, or Ollama for provider-backed chat."
            ),
            request={"context": context, "content_length": len(user_content)},
            response={"reason": "selected provider has no runtime adapter"},
        )

    spec = _select_provider()
    if not spec:
        return AssistantRuntimeResult(
            status="no_provider_configured",
            content=(
                "Assistant chat is not connected to a provider yet. The message and context were stored, "
                "and no model call or tool execution was attempted."
            ),
            request={"context": context, "content_length": len(user_content)},
            response={"reason": "no configured assistant provider"},
        )

    if not _provider_configured(spec):
        return AssistantRuntimeResult(
            status="selected_provider_not_configured",
            provider_id=spec.provider_id,
            model=_provider_model(spec),
            content=(
                f"Assistant provider '{spec.provider_id}' is selected but not configured. "
                "Set the provider key or endpoint before using provider-backed chat."
            ),
            request={"context": context, "content_length": len(user_content)},
            response={"reason": "selected provider is not configured"},
        )

    model = _provider_model(spec)
    timeout = max(1, int(settings.assistant_request_timeout_sec or 30))
    active_transport = transport or _default_transport

    try:
        if spec.kind == "openai_compatible":
            base_url = _provider_base_url(spec)
            url = f"{base_url}/chat/completions"
            headers = {"Content-Type": "application/json"}
            api_key = getattr(settings, spec.secret_setting, "") if spec.secret_setting else ""
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
        elif spec.kind == "ollama":
            base_url = _provider_base_url(spec)
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
        return AssistantRuntimeResult(
            status="provider_call_failed",
            provider_id=spec.provider_id,
            model=model,
            content="Assistant provider call failed. No tools or side effects were attempted.",
            request={"context": context, "content_length": len(user_content)},
            response={"error_type": type(exc).__name__},
            error=str(exc),
        )

    return AssistantRuntimeResult(
        status="completed",
        provider_id=spec.provider_id,
        model=model,
        content=content or "The provider returned an empty response.",
        request={"provider_id": spec.provider_id, "model": model, "context": context, "content_length": len(user_content)},
        response={"status": "completed", "raw_keys": sorted(response.keys())},
    )
