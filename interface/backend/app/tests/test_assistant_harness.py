from sqlalchemy.pool import StaticPool
from sqlmodel import SQLModel, Session, create_engine, select

from app.db.models import AssistantConfirmation
from app.services.assistant_harness import (
    AssistantContext,
    AssistantConversationCreate,
    AssistantMessageCreate,
    ConfirmationCreate,
    ConfirmationResolve,
    create_confirmation,
    create_conversation,
    get_assistant_harness_status,
    get_provider_layer_status,
    message_to_out,
    record_provenance,
    resolve_confirmation,
    store_message,
)


def _build_session():
    engine = create_engine(
        "sqlite://",
        echo=False,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine, Session(engine)


def test_assistant_status_exposes_provider_and_tool_contracts_without_execution():
    providers = get_provider_layer_status()
    assert providers.configured_provider_count >= 0
    for provider in providers.providers:
        payload = provider.model_dump()
        assert "secret_setting" not in payload
        assert "endpoint_setting" not in payload

    status = get_assistant_harness_status()
    assert status.tool_execution_enabled is False
    assert status.db_persistence_enabled is True
    assert "route" in status.context_contract
    tool_names = {tool.name for tool in status.tool_registry}
    assert {"create_experiment", "run_simulation", "inspect_result"} <= tool_names


def test_assistant_message_round_trip_records_blocked_response_and_provenance():
    engine, session = _build_session()
    try:
        context = AssistantContext(
            route="/results/2",
            selected_gene="dnaA",
            selected_experiment=2,
            selected_job=2,
            selected_result=None,
            assistant_surface="results",
        )
        conversation = create_conversation(
            session,
            AssistantConversationCreate(
                title="dnaA result inspection",
                assistant_surface="results",
                context=context,
            ),
        )
        user_input = AssistantMessageCreate(
            content="Which model outputs should I inspect first?",
            context=context,
        )
        user_message = store_message(session, conversation, "user", user_input.content, user_input.context)
        assistant_message = store_message(
            session,
            conversation,
            "assistant",
            "Assistant runtime is scaffolded but disabled.",
            context,
            status="blocked_not_enabled",
        )
        provenance = record_provenance(
            session,
            conversation_id=conversation.id,
            message_id=assistant_message.id,
            provider_id="",
            model="",
            request={"content_length": len(user_input.content), "context": context.model_dump()},
            response={"status": "blocked_not_enabled"},
        )

        assert message_to_out(user_message).role == "user"
        assert message_to_out(assistant_message).status == "blocked_not_enabled"
        assert provenance.prompt_hash
    finally:
        session.close()
        engine.dispose()


def test_confirmations_can_be_recorded_and_resolved_without_execution():
    engine, session = _build_session()
    try:
        confirmation = create_confirmation(
            session,
            ConfirmationCreate(
                action="run_simulation",
                payload={"experiment_id": 10, "seed": 0},
            ),
        )
        assert confirmation.status == "pending"

        resolved = resolve_confirmation(
            session,
            confirmation,
            ConfirmationResolve(status="rejected", note="Not ready to run."),
        )
        assert resolved.status == "rejected"
        assert resolved.note == "Not ready to run."

        records = session.exec(select(AssistantConfirmation)).all()
        assert len(records) == 1
    finally:
        session.close()
        engine.dispose()
