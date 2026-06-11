"""Assistant harness endpoints.

These endpoints expose provider status, typed tool metadata, durable context
storage, confirmations, and provenance. They do not call an LLM or execute
tools yet.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlmodel import Session, select

from app.db.models import (
    AssistantConfirmation,
    AssistantConversation,
    AssistantMessage,
    AssistantProvenance,
    AssistantToolCall,
)
from app.main import get_session
from app.services.assistant_harness import (
    AssistantConversationCreate,
    AssistantConversationOut,
    AssistantExchangeOut,
    AssistantHarnessStatus,
    AssistantMessageCreate,
    AssistantMessageOut,
    AssistantToolExecutionOut,
    AssistantToolExecutionRequest,
    AssistantToolCallOut,
    AssistantToolPreviewOut,
    AssistantToolPreviewRequest,
    AssistantToolSpec,
    AssistantProviderConfigOut,
    AssistantProviderConfigUpdate,
    ConfirmationCreate,
    ConfirmationOut,
    ConfirmationResolve,
    OllamaModelListOut,
    ProviderLayerStatus,
    ProvenanceOut,
    assistant_gene_context_pack,
    confirmation_to_out,
    conversation_to_out,
    create_confirmation,
    create_conversation,
    delete_conversation,
    delete_provider_config,
    execute_tool,
    get_assistant_harness_status,
    get_ollama_models,
    get_provider_layer_status,
    get_tool_registry,
    message_to_out,
    preview_tool,
    provider_configs_to_out,
    provenance_to_out,
    record_contextual_proposals,
    record_model_gene_proposals,
    record_provenance,
    resolve_confirmation,
    store_message,
    tool_call_to_out,
    upsert_provider_config,
)
from app.services.assistant_runtime import generate_assistant_runtime_reply


router = APIRouter(prefix="/api/assistant", tags=["assistant"])


@router.get("/status", response_model=AssistantHarnessStatus)
def get_status(session: Session = Depends(get_session)) -> AssistantHarnessStatus:
    return get_assistant_harness_status(session)


@router.get("/providers", response_model=ProviderLayerStatus)
def get_providers(session: Session = Depends(get_session)) -> ProviderLayerStatus:
    return get_provider_layer_status(session)


@router.get("/provider-configs", response_model=list[AssistantProviderConfigOut])
def list_provider_configs(session: Session = Depends(get_session)) -> list[AssistantProviderConfigOut]:
    return provider_configs_to_out(session)


@router.put("/provider-configs/{provider_id}", response_model=AssistantProviderConfigOut)
def update_provider_config(
    provider_id: str,
    data: AssistantProviderConfigUpdate,
    session: Session = Depends(get_session),
) -> AssistantProviderConfigOut:
    upsert_provider_config(session, provider_id, data)
    return next(config for config in provider_configs_to_out(session) if config.provider_id == provider_id)


@router.delete("/provider-configs/{provider_id}", response_model=list[AssistantProviderConfigOut])
def clear_provider_config(
    provider_id: str,
    session: Session = Depends(get_session),
) -> list[AssistantProviderConfigOut]:
    delete_provider_config(session, provider_id)
    return provider_configs_to_out(session)


@router.get("/provider-configs/ollama/models", response_model=OllamaModelListOut)
def list_ollama_models(
    endpoint_url: str = Query(""),
    session: Session = Depends(get_session),
) -> OllamaModelListOut:
    return get_ollama_models(session, endpoint_url)


@router.get("/tools", response_model=list[AssistantToolSpec])
def get_tools() -> list[AssistantToolSpec]:
    return get_tool_registry()


@router.post("/tools/{tool_name}/preview", response_model=AssistantToolPreviewOut)
def preview_assistant_tool(
    tool_name: str,
    data: AssistantToolPreviewRequest,
    session: Session = Depends(get_session),
) -> AssistantToolPreviewOut:
    return preview_tool(session, tool_name, data)


@router.post("/tools/{tool_name}/execute", response_model=AssistantToolExecutionOut)
def execute_assistant_tool(
    tool_name: str,
    data: AssistantToolExecutionRequest,
    session: Session = Depends(get_session),
) -> AssistantToolExecutionOut:
    if data.conversation_id is not None and not session.get(AssistantConversation, data.conversation_id):
        raise HTTPException(status_code=404, detail="Assistant conversation not found.")
    return execute_tool(session, tool_name, data)


@router.get("/conversations", response_model=list[AssistantConversationOut])
def list_conversations(session: Session = Depends(get_session)) -> list[AssistantConversationOut]:
    records = session.exec(
        select(AssistantConversation).order_by(AssistantConversation.updated_at.desc())
    ).all()
    return [conversation_to_out(record) for record in records]


@router.post("/conversations", response_model=AssistantConversationOut)
def create_assistant_conversation(
    data: AssistantConversationCreate,
    session: Session = Depends(get_session),
) -> AssistantConversationOut:
    return conversation_to_out(create_conversation(session, data))


@router.get("/conversations/{conversation_id}", response_model=AssistantConversationOut)
def get_conversation(
    conversation_id: int,
    session: Session = Depends(get_session),
) -> AssistantConversationOut:
    conversation = session.get(AssistantConversation, conversation_id)
    if not conversation:
        raise HTTPException(status_code=404, detail="Assistant conversation not found.")
    return conversation_to_out(conversation)


@router.delete("/conversations/{conversation_id}", response_model=dict[str, bool])
def delete_assistant_conversation(
    conversation_id: int,
    session: Session = Depends(get_session),
) -> dict[str, bool]:
    delete_conversation(session, conversation_id)
    return {"deleted": True}


@router.get("/conversations/{conversation_id}/messages", response_model=list[AssistantMessageOut])
def list_messages(
    conversation_id: int,
    session: Session = Depends(get_session),
) -> list[AssistantMessageOut]:
    conversation = session.get(AssistantConversation, conversation_id)
    if not conversation:
        raise HTTPException(status_code=404, detail="Assistant conversation not found.")
    records = session.exec(
        select(AssistantMessage)
        .where(AssistantMessage.conversation_id == conversation_id)
        .order_by(AssistantMessage.id)
    ).all()
    return [message_to_out(record) for record in records]


@router.post("/conversations/{conversation_id}/messages", response_model=AssistantExchangeOut)
def create_message(
    conversation_id: int,
    data: AssistantMessageCreate,
    session: Session = Depends(get_session),
) -> AssistantExchangeOut:
    conversation = session.get(AssistantConversation, conversation_id)
    if not conversation:
        raise HTTPException(status_code=404, detail="Assistant conversation not found.")
    if not data.content.strip():
        raise HTTPException(status_code=422, detail="Message content must not be empty.")

    persisted_conversation_id = conversation.id or conversation_id
    user_message = store_message(session, conversation, "user", data.content, data.context)
    runtime_context = data.context.model_dump()
    runtime_context["platform_facts"] = {
        "gene_context": assistant_gene_context_pack(
            session,
            user_content=data.content,
            context=data.context,
        )
    }
    runtime_result = generate_assistant_runtime_reply(data.content, runtime_context, session=session)
    conversation = session.get(AssistantConversation, persisted_conversation_id)
    if not conversation:
        raise HTTPException(
            status_code=409,
            detail="Assistant conversation was deleted before the provider response was stored.",
        )
    assistant_status = (
        "completed"
        if runtime_result.status == "completed"
        else runtime_result.status
    )
    assistant_message = store_message(
        session,
        conversation,
        "assistant",
        runtime_result.content,
        data.context,
        status=assistant_status,
    )
    provenance = record_provenance(
        session,
        conversation_id=persisted_conversation_id,
        message_id=assistant_message.id,
        provider_id=runtime_result.provider_id,
        model=runtime_result.model,
        request={
            "content_length": len(data.content),
            "context": data.context.model_dump(),
            "platform_facts": runtime_context.get("platform_facts", {}),
            "tool_execution_enabled": False,
            "tool_access": "none",
            "runtime_request": runtime_result.request,
        },
        response={
            "status": runtime_result.status,
            "runtime_response": runtime_result.response,
            "error": runtime_result.error,
        },
    )
    proposals = record_contextual_proposals(
        session,
        conversation=conversation,
        assistant_message=assistant_message,
        context=data.context,
    )
    proposals.extend(
        record_model_gene_proposals(
            session,
            conversation=conversation,
            assistant_message=assistant_message,
            context=data.context,
            user_content=data.content,
            assistant_content=runtime_result.content,
        )
    )
    return AssistantExchangeOut(
        conversation=conversation_to_out(conversation),
        user_message=message_to_out(user_message),
        assistant_message=message_to_out(assistant_message),
        provenance_id=provenance.id or 0,
        tool_calls=[record.id or 0 for record in proposals],
        proposals=[tool_call_to_out(record) for record in proposals],
    )


@router.post("/confirmations", response_model=ConfirmationOut)
def create_assistant_confirmation(
    data: ConfirmationCreate,
    session: Session = Depends(get_session),
) -> ConfirmationOut:
    if data.conversation_id is not None and not session.get(AssistantConversation, data.conversation_id):
        raise HTTPException(status_code=404, detail="Assistant conversation not found.")
    return confirmation_to_out(create_confirmation(session, data))


@router.get("/confirmations", response_model=list[ConfirmationOut])
def list_confirmations(
    status: str | None = Query(None),
    conversation_id: int | None = Query(None),
    session: Session = Depends(get_session),
) -> list[ConfirmationOut]:
    stmt = select(AssistantConfirmation)
    if status:
        stmt = stmt.where(AssistantConfirmation.status == status)
    if conversation_id is not None:
        stmt = stmt.where(AssistantConfirmation.conversation_id == conversation_id)
    records = session.exec(stmt.order_by(AssistantConfirmation.id.desc())).all()
    return [confirmation_to_out(record) for record in records]


@router.get("/tool-calls", response_model=list[AssistantToolCallOut])
def list_tool_calls(
    conversation_id: int | None = Query(None),
    status: str | None = Query(None),
    session: Session = Depends(get_session),
) -> list[AssistantToolCallOut]:
    stmt = select(AssistantToolCall)
    if conversation_id is not None:
        stmt = stmt.where(AssistantToolCall.conversation_id == conversation_id)
    if status:
        stmt = stmt.where(AssistantToolCall.status == status)
    records = session.exec(stmt.order_by(AssistantToolCall.id.desc())).all()
    return [tool_call_to_out(record) for record in records]


@router.post("/confirmations/{confirmation_id}/resolve", response_model=ConfirmationOut)
def resolve_assistant_confirmation(
    confirmation_id: int,
    data: ConfirmationResolve,
    session: Session = Depends(get_session),
) -> ConfirmationOut:
    confirmation = session.get(AssistantConfirmation, confirmation_id)
    if not confirmation:
        raise HTTPException(status_code=404, detail="Assistant confirmation not found.")
    return confirmation_to_out(resolve_confirmation(session, confirmation, data))


@router.get("/provenance", response_model=list[ProvenanceOut])
def list_provenance(
    conversation_id: int | None = Query(None),
    session: Session = Depends(get_session),
) -> list[ProvenanceOut]:
    stmt = select(AssistantProvenance)
    if conversation_id is not None:
        stmt = stmt.where(AssistantProvenance.conversation_id == conversation_id)
    records = session.exec(stmt.order_by(AssistantProvenance.id.desc())).all()
    return [provenance_to_out(record) for record in records]
