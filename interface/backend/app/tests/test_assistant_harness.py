from sqlalchemy.pool import StaticPool
from sqlmodel import SQLModel, Session, create_engine, select

from app.db.models import AssistantConfirmation, Condition, Experiment
from app.services.assistant_harness import (
    AssistantContext,
    AssistantConversationCreate,
    AssistantMessageCreate,
    AssistantToolPreviewRequest,
    ConfirmationCreate,
    ConfirmationResolve,
    create_confirmation,
    create_conversation,
    get_assistant_harness_status,
    get_provider_layer_status,
    message_to_out,
    preview_tool,
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
    assert status.tool_preview_enabled is True
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


def test_tool_preview_validates_arguments_without_execution():
    engine, session = _build_session()
    try:
        session.add(Condition(name="basal", nutrients="minimal"))
        session.add(Experiment(name="dnaA knockout", variant_type="gene_knockout", variant_index=0, condition="basal"))
        session.commit()

        create_preview = preview_tool(
            session,
            "create_experiment",
            AssistantToolPreviewRequest(
                arguments={
                    "variant_type": "gene_knockout",
                    "variant_index": 0,
                    "condition": "basal",
                    "sim_params": {"generations": 1},
                }
            ),
        )
        assert create_preview.valid is True
        assert create_preview.requires_confirmation is True
        assert create_preview.execution_enabled is False
        assert create_preview.normalized_arguments["condition"] == "basal"

        run_preview = preview_tool(
            session,
            "run_simulation",
            AssistantToolPreviewRequest(arguments={"experiment_id": 1, "seed": 0, "generations": 1}),
        )
        assert run_preview.valid is True
        assert run_preview.preview["action"] == "would_queue_simulation_job"
    finally:
        session.close()
        engine.dispose()


def test_tool_preview_reports_structured_errors_for_bad_references():
    engine, session = _build_session()
    try:
        preview = preview_tool(
            session,
            "create_experiment",
            AssistantToolPreviewRequest(
                arguments={
                    "variant_type": "gene_knockout",
                    "variant_index": "not-an-index",
                    "condition": "missing_condition",
                }
            ),
        )
        assert preview.valid is False
        assert "Argument 'variant_index' must be an integer." in preview.errors
        assert "Condition 'missing_condition' does not exist." in preview.errors
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
