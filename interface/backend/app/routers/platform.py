"""Platform planning/status endpoints for local distribution and assistant scaffolding."""

from pydantic import BaseModel
from fastapi import APIRouter

from app.config import settings
from app.services.assistant_harness import (
    AssistantHarnessStatus,
    ProviderLayerStatus,
    get_assistant_harness_status,
    get_provider_layer_status,
)


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


class PlatformStatusOut(BaseModel):
    distribution: DistributionStatusOut
    providers: ProviderLayerStatus
    assistant: AssistantHarnessStatus


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


@router.get("/status", response_model=PlatformStatusOut)
def get_platform_status() -> PlatformStatusOut:
    """Return local distribution, provider-layer, and assistant scaffold status."""
    return PlatformStatusOut(
        distribution=_distribution_status(),
        providers=get_provider_layer_status(),
        assistant=get_assistant_harness_status(),
    )


@router.get("/distribution", response_model=DistributionStatusOut)
def get_distribution_status() -> DistributionStatusOut:
    """Return local-first runtime and optional artifact bootstrap status."""
    return _distribution_status()


@router.get("/llm-providers", response_model=ProviderLayerStatus)
def get_llm_provider_status() -> ProviderLayerStatus:
    """Return non-secret BYOK/local model provider configuration status."""
    return get_provider_layer_status()


@router.get("/assistant", response_model=AssistantHarnessStatus)
def get_platform_assistant_harness_status() -> AssistantHarnessStatus:
    """Return the assistant harness scaffold state."""
    return get_assistant_harness_status()
