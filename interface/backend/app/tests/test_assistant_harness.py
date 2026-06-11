from sqlalchemy.pool import StaticPool
from sqlmodel import SQLModel, Session, create_engine, select

from app.config import settings
from app.db.models import AssistantConfirmation, AssistantToolCall, Condition, Experiment, Gene, SimulationJob, SimulationResult, Variant
from app.services.assistant_runtime import generate_assistant_runtime_reply
from app.services.assistant_harness import (
    AssistantContext,
    AssistantConversationCreate,
    AssistantMessageCreate,
    AssistantToolPreviewRequest,
    AssistantToolExecutionRequest,
    ConfirmationCreate,
    ConfirmationResolve,
    create_confirmation,
    create_conversation,
    execute_tool,
    get_assistant_harness_status,
    get_provider_layer_status,
    message_to_out,
    preview_tool,
    record_contextual_proposals,
    record_provenance,
    resolve_confirmation,
    store_message,
    tool_call_to_out,
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


def _restore_runtime_settings(snapshot: dict[str, object]) -> None:
    for key, value in snapshot.items():
        setattr(settings, key, value)


def test_assistant_status_exposes_provider_and_tool_contracts_without_execution():
    providers = get_provider_layer_status()
    assert providers.configured_provider_count >= 0
    for provider in providers.providers:
        payload = provider.model_dump()
        assert "secret_setting" not in payload
        assert "endpoint_setting" not in payload

    status = get_assistant_harness_status()
    assert status.tool_execution_enabled is True
    assert status.tool_preview_enabled is True
    assert status.side_effect_execution_enabled is True
    assert status.execution_enabled_tools == ["inspect_result", "create_experiment", "run_simulation"]
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


def test_contextual_proposals_record_non_executing_tool_calls():
    engine, session = _build_session()
    try:
        session.add(Variant(name="gene_knockout", docstring="Set selected gene expression to zero."))
        session.add(Condition(name="basal", nutrients="minimal glucose"))
        session.add(Gene(id=1, ecoli_id="EG10001", symbol="dnaA", ko_index=42))
        session.commit()

        context = AssistantContext(
            route="/results/2",
            selected_gene="dnaA",
            selected_experiment=7,
            selected_job=2,
            selected_condition="basal",
            assistant_surface="results",
        )
        conversation = create_conversation(
            session,
            AssistantConversationCreate(
                title="dnaA follow-up",
                assistant_surface="results",
                context=context,
            ),
        )
        assistant_message = store_message(
            session,
            conversation,
            "assistant",
            "Inspect the result and consider a reviewed follow-up.",
            context,
            status="completed",
        )

        proposals = record_contextual_proposals(
            session,
            conversation=conversation,
            assistant_message=assistant_message,
            context=context,
        )

        assert len(proposals) == 3
        assert {proposal.tool_name for proposal in proposals} == {
            "inspect_result",
            "create_experiment",
            "run_simulation",
        }
        assert all(proposal.status == "proposed" for proposal in proposals)
        assert all(proposal.message_id == assistant_message.id for proposal in proposals)
        create_proposal = next(proposal for proposal in proposals if proposal.tool_name == "create_experiment")
        create_out = tool_call_to_out(create_proposal)
        assert create_out.arguments["gene_symbol"] == "dnaA"
        assert create_out.result["requires_confirmation"] is True
        inspect_out = tool_call_to_out(next(proposal for proposal in proposals if proposal.tool_name == "inspect_result"))
        assert inspect_out.result["proposal_kind"] == "read_only"
        assert inspect_out.result["side_effect"] is False
    finally:
        session.close()
        engine.dispose()


def test_assistant_runtime_reports_no_provider_without_network():
    snapshot = {
        "assistant_provider": settings.assistant_provider,
        "assistant_model": settings.assistant_model,
        "openai_api_key": settings.openai_api_key,
        "openrouter_api_key": settings.openrouter_api_key,
        "lm_studio_base_url": settings.lm_studio_base_url,
        "vllm_base_url": settings.vllm_base_url,
        "ollama_base_url": settings.ollama_base_url,
    }
    try:
        settings.assistant_provider = ""
        settings.assistant_model = ""
        settings.openai_api_key = ""
        settings.openrouter_api_key = ""
        settings.lm_studio_base_url = ""
        settings.vllm_base_url = ""
        settings.ollama_base_url = ""
        result = generate_assistant_runtime_reply(
            "Explain this result.",
            {"route": "/results/2", "selected_gene": "dnaA"},
        )
        assert result.status == "no_provider_configured"
        assert "no model call" in result.content
    finally:
        _restore_runtime_settings(snapshot)


def test_openai_compatible_runtime_uses_configured_provider_without_tools():
    snapshot = {
        "assistant_provider": settings.assistant_provider,
        "assistant_model": settings.assistant_model,
        "openai_api_key": settings.openai_api_key,
    }
    calls: list[dict[str, object]] = []

    def fake_transport(url, headers, payload, timeout):
        calls.append({"url": url, "headers": headers, "payload": payload, "timeout": timeout})
        return {"choices": [{"message": {"content": "Provider response"}}], "id": "test-response"}

    try:
        settings.assistant_provider = "openai"
        settings.assistant_model = "test-model"
        settings.openai_api_key = "test-key"
        result = generate_assistant_runtime_reply(
            "What should I inspect next?",
            {"route": "/results/2", "selected_gene": "dnaA"},
            transport=fake_transport,
        )
        assert result.status == "completed"
        assert result.provider_id == "openai"
        assert result.model == "test-model"
        assert result.content == "Provider response"
        assert len(calls) == 1
        call = calls[0]
        assert call["url"] == "https://api.openai.com/v1/chat/completions"
        assert call["headers"]["Authorization"] == "Bearer test-key"
        payload = call["payload"]
        assert payload["model"] == "test-model"
        assert "tools" not in payload
        assert payload["messages"][0]["role"] == "system"
        assert payload["messages"][1]["role"] == "user"
    finally:
        _restore_runtime_settings(snapshot)


def test_tool_preview_validates_arguments_without_execution():
    engine, session = _build_session()
    try:
        session.add(Condition(name="basal", nutrients="minimal"))
        session.add(Variant(name="gene_knockout", docstring="", filename="gene_knockout.py"))
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
        assert create_preview.execution_enabled is True
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


def test_create_experiment_execution_requires_approved_matching_confirmation_and_creates_draft_once():
    engine, session = _build_session()
    try:
        session.add(Condition(name="basal", nutrients="minimal"))
        session.add(Variant(name="gene_knockout", docstring="", filename="gene_knockout.py"))
        session.add(Gene(ecoli_id="EG10001", symbol="dnaA", ko_index=42))
        session.commit()

        arguments = {
            "name": "dnaA knockout",
            "description": "Assistant-created draft",
            "variant_type": "gene_knockout",
            "variant_index": 0,
            "condition": "basal",
            "timeline": "",
            "sim_params": {"seeds": 1, "generations": 1, "length_sec": 10800},
            "gene_symbol": "dnaA",
            "gene_symbols": [],
            "include_wildtype": False,
        }
        preview = preview_tool(session, "create_experiment", AssistantToolPreviewRequest(arguments=arguments))
        assert preview.valid is True
        assert preview.normalized_arguments["variant_index"] == 0
        assert preview.normalized_arguments["sim_params"] == '{"generations":1,"length_sec":10800,"seeds":1}'

        missing_confirmation = execute_tool(
            session,
            "create_experiment",
            AssistantToolExecutionRequest(arguments=arguments),
        )
        assert missing_confirmation.executed is False
        assert missing_confirmation.status == "confirmation_required"

        confirmation = create_confirmation(
            session,
            ConfirmationCreate(
                action="create_experiment",
                payload=preview.normalized_arguments,
            ),
        )
        resolve_confirmation(session, confirmation, ConfirmationResolve(status="approved", note="Approved for test."))
        executed = execute_tool(
            session,
            "create_experiment",
            AssistantToolExecutionRequest(arguments=arguments, confirmation_id=confirmation.id),
        )
        assert executed.executed is True
        assert executed.status == "executed"
        assert executed.result["experiment"]["id"] == 1
        assert executed.result["experiment"]["variant_index"] == 42
        assert executed.result["experiment"]["gene_symbol"] == "dnaA"

        used_confirmation = session.get(AssistantConfirmation, confirmation.id)
        assert used_confirmation.status == "used"

        replay = execute_tool(
            session,
            "create_experiment",
            AssistantToolExecutionRequest(arguments=arguments, confirmation_id=confirmation.id),
        )
        assert replay.executed is False
        assert replay.status == "confirmation_required"

        experiments = session.exec(select(Experiment)).all()
        assert len(experiments) == 1
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


def test_read_only_inspect_result_execution_records_tool_call_and_provenance():
    engine, session = _build_session()
    try:
        experiment = Experiment(
            name="dnaA knockout",
            variant_type="gene_knockout",
            variant_index=0,
            condition="basal",
            gene_symbol="dnaA",
            status="done",
        )
        session.add(experiment)
        session.flush()
        job = SimulationJob(
            experiment_id=experiment.id,
            status="done",
            condition="basal",
            seed=0,
            generations=1,
            variant_type="gene_knockout",
            variant_index=0,
        )
        session.add(job)
        session.flush()
        session.add(
            SimulationResult(
                job_id=job.id,
                experiment_id=experiment.id,
                seed=0,
                generation=0,
                final_mass_fg=1000.0,
                growth_rate=0.1,
                divided=True,
            )
        )
        session.commit()

        executed = execute_tool(
            session,
            "inspect_result",
            AssistantToolExecutionRequest(arguments={"job_id": job.id, "gene": "dnaA"}),
        )
        assert executed.executed is True
        assert executed.status == "executed"
        assert executed.result["summary"]["result_count"] == 1
        assert executed.tool_call_id is not None
        assert executed.provenance_id is not None

        tool_calls = session.exec(select(AssistantToolCall)).all()
        assert len(tool_calls) == 1
        assert tool_calls[0].status == "executed"
        tool_call_out = tool_call_to_out(tool_calls[0])
        assert tool_call_out.tool_name == "inspect_result"
        assert tool_call_out.arguments["job_id"] == job.id
        assert tool_call_out.result["summary"]["result_count"] == 1
    finally:
        session.close()
        engine.dispose()


def test_run_simulation_execution_requires_approved_matching_confirmation_and_queues_job_once():
    engine, session = _build_session()
    try:
        experiment = Experiment(name="dnaA knockout", variant_type="gene_knockout", variant_index=0, condition="basal")
        session.add(experiment)
        session.commit()

        request = AssistantToolExecutionRequest(arguments={"experiment_id": 1, "seed": 0, "generations": 1})
        missing_confirmation = execute_tool(session, "run_simulation", request)
        assert missing_confirmation.executed is False
        assert missing_confirmation.status == "confirmation_required"

        confirmation = create_confirmation(
            session,
            ConfirmationCreate(
                action="run_simulation",
                payload={"experiment_id": 1, "seed": 0, "generations": 1},
            ),
        )
        resolve_confirmation(session, confirmation, ConfirmationResolve(status="approved", note="Approved for test."))
        approved_request = AssistantToolExecutionRequest(
            arguments={"experiment_id": 1, "seed": 0, "generations": 1},
            confirmation_id=confirmation.id,
        )
        executed = execute_tool(session, "run_simulation", approved_request)
        assert executed.executed is True
        assert executed.status == "executed"
        assert executed.result["job_ids"] == [1]
        assert executed.result["experiment"]["status"] == "queued"

        used_confirmation = session.get(AssistantConfirmation, confirmation.id)
        assert used_confirmation.status == "used"

        replay = execute_tool(session, "run_simulation", approved_request)
        assert replay.executed is False
        assert replay.status == "confirmation_required"
        assert "not approved" in replay.errors[0]

        jobs = session.exec(select(SimulationJob)).all()
        assert len(jobs) == 1
    finally:
        session.close()
        engine.dispose()
