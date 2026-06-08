"""Platform planning/status endpoints for local distribution and assistant scaffolding."""

from pydantic import BaseModel
from fastapi import APIRouter

from app.config import settings


router = APIRouter(prefix="/api/platform", tags=["platform"])


class ArtifactBootstrapOut(BaseModel):
    enabled: bool
    source: str | None
    repository: str | None
    role: str


class DistributionStatusOut(BaseModel):
    mode: str
    runtime: str
    requires_hosted_backend: bool
    artifact_bootstrap: ArtifactBootstrapOut
    paths: dict[str, str]
    notes: list[str]


class ProviderStatusOut(BaseModel):
    provider_id: str
    label: str
    category: str
    configured: bool
    configuration_hint: str


class ProviderLayerStatusOut(BaseModel):
    mode: str
    configured_provider_count: int
    providers: list[ProviderStatusOut]
    notes: list[str]


class AssistantHarnessStatusOut(BaseModel):
    state: str
    provider_required: bool
    provider_configured: bool
    tool_execution_enabled: bool
    confirmation_required_for: list[str]
    context_contract: list[str]
    visible_artifacts: list[str]
    notes: list[str]


class PlatformStatusOut(BaseModel):
    distribution: DistributionStatusOut
    providers: ProviderLayerStatusOut
    assistant: AssistantHarnessStatusOut


def _configured(value: str | None) -> bool:
    return bool((value or "").strip())


def _provider_status() -> list[ProviderStatusOut]:
    return [
        ProviderStatusOut(
            provider_id="openai",
            label="OpenAI",
            category="hosted_byok",
            configured=_configured(settings.openai_api_key),
            configuration_hint="Set OPENAI_API_KEY in the local environment.",
        ),
        ProviderStatusOut(
            provider_id="anthropic",
            label="Anthropic",
            category="hosted_byok",
            configured=_configured(settings.anthropic_api_key),
            configuration_hint="Set ANTHROPIC_API_KEY in the local environment.",
        ),
        ProviderStatusOut(
            provider_id="openrouter",
            label="OpenRouter",
            category="hosted_byok",
            configured=_configured(settings.openrouter_api_key),
            configuration_hint="Set OPENROUTER_API_KEY in the local environment.",
        ),
        ProviderStatusOut(
            provider_id="ollama",
            label="Ollama",
            category="local_runtime",
            configured=_configured(settings.ollama_base_url),
            configuration_hint="Set OLLAMA_BASE_URL for a local Ollama endpoint.",
        ),
        ProviderStatusOut(
            provider_id="lm_studio",
            label="LM Studio",
            category="local_runtime",
            configured=_configured(settings.lm_studio_base_url),
            configuration_hint="Set LM_STUDIO_BASE_URL for a local LM Studio endpoint.",
        ),
        ProviderStatusOut(
            provider_id="vllm",
            label="vLLM",
            category="local_runtime",
            configured=_configured(settings.vllm_base_url),
            configuration_hint="Set VLLM_BASE_URL for a local vLLM/OpenAI-compatible endpoint.",
        ),
    ]


def _distribution_status() -> DistributionStatusOut:
    artifact_source = settings.artifact_bootstrap_source.strip() or None
    artifact_repo = settings.artifact_bootstrap_repo.strip() or None
    return DistributionStatusOut(
        mode="local_first",
        runtime="docker_local",
        requires_hosted_backend=False,
        artifact_bootstrap=ArtifactBootstrapOut(
            enabled=bool(artifact_source or artifact_repo),
            source=artifact_source,
            repository=artifact_repo,
            role="optional accelerator for prepared data, seed databases, or precomputed results",
        ),
        paths={
            "database": str(settings.database_path),
            "reconstruction": str(settings.reconstruction_path),
            "models": str(settings.models_path),
            "simulation_output": str(settings.sim_output_dir),
        },
        notes=[
            "The platform is expected to start from the local Docker runtime without a hosted backend.",
            "Optional artifacts should accelerate first use without replacing local ownership of app runtime.",
        ],
    )


def _provider_layer_status() -> ProviderLayerStatusOut:
    providers = _provider_status()
    configured_count = sum(1 for provider in providers if provider.configured)
    return ProviderLayerStatusOut(
        mode="bring_your_own_key_or_local_endpoint",
        configured_provider_count=configured_count,
        providers=providers,
        notes=[
            "Provider status reports configuration presence only; API keys are never returned.",
            "The scientific platform remains usable when no LLM provider is configured.",
        ],
    )


def _assistant_status(provider_configured: bool) -> AssistantHarnessStatusOut:
    return AssistantHarnessStatusOut(
        state="scaffolded_disabled",
        provider_required=True,
        provider_configured=provider_configured,
        tool_execution_enabled=False,
        confirmation_required_for=[
            "create_experiment",
            "run_simulation",
            "cancel_simulation",
            "delete_experiment",
            "publish_environment_builder_artifact",
        ],
        context_contract=[
            "route",
            "selected_gene",
            "selected_experiment",
            "selected_job",
            "selected_result",
            "assistant_surface",
        ],
        visible_artifacts=[
            "assistant_message",
            "tool_call_record",
            "experiment_proposal",
            "result_reference",
            "pending_confirmation",
        ],
        notes=[
            "This endpoint is a planning scaffold, not a live LLM harness.",
            "Future tool execution must remain typed, validated, and provider-agnostic.",
        ],
    )


@router.get("/status", response_model=PlatformStatusOut)
def get_platform_status() -> PlatformStatusOut:
    """Return local distribution, provider-layer, and assistant scaffold status."""
    providers = _provider_layer_status()
    return PlatformStatusOut(
        distribution=_distribution_status(),
        providers=providers,
        assistant=_assistant_status(providers.configured_provider_count > 0),
    )


@router.get("/distribution", response_model=DistributionStatusOut)
def get_distribution_status() -> DistributionStatusOut:
    """Return local-first runtime and optional artifact bootstrap status."""
    return _distribution_status()


@router.get("/llm-providers", response_model=ProviderLayerStatusOut)
def get_llm_provider_status() -> ProviderLayerStatusOut:
    """Return non-secret BYOK/local model provider configuration status."""
    return _provider_layer_status()


@router.get("/assistant", response_model=AssistantHarnessStatusOut)
def get_assistant_harness_status() -> AssistantHarnessStatusOut:
    """Return the assistant harness scaffold state."""
    providers = _provider_layer_status()
    return _assistant_status(providers.configured_provider_count > 0)
