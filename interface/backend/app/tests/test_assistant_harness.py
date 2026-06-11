from sqlalchemy.pool import StaticPool
from sqlmodel import SQLModel, Session, create_engine, select

from app.config import settings
from app.db.models import (
    AssistantConfirmation,
    AssistantProviderConfig,
    AssistantToolCall,
    Condition,
    Experiment,
    Gene,
    SimulationJob,
    SimulationResult,
    Variant,
)
from app.services.assistant_runtime import generate_assistant_runtime_reply
from app.services.assistant_harness import (
    AssistantContext,
    AssistantConversationCreate,
    AssistantMessageCreate,
    AssistantProviderConfigUpdate,
    AssistantToolPreviewRequest,
    AssistantToolExecutionRequest,
    ConfirmationCreate,
    ConfirmationResolve,
    assistant_conversation_context_pack,
    assistant_gene_context_pack,
    assistant_working_memory_pack,
    create_confirmation,
    create_conversation,
    execute_tool,
    get_assistant_harness_status,
    get_provider_layer_status,
    message_to_out,
    preview_tool,
    record_contextual_proposals,
    record_model_gene_proposals,
    record_provenance,
    resolve_confirmation,
    store_message,
    tool_call_to_out,
    upsert_provider_config,
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
    assert status.execution_enabled_tools == ["inspect_result", "inspect_gene", "create_experiment", "run_simulation"]
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

        assert len(proposals) == 4
        assert {proposal.tool_name for proposal in proposals} == {
            "inspect_result",
            "inspect_gene",
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
        gene_out = tool_call_to_out(next(proposal for proposal in proposals if proposal.tool_name == "inspect_gene"))
        assert gene_out.arguments["gene"] == "dnaA"
        assert gene_out.result["proposal_kind"] == "read_only"
    finally:
        session.close()
        engine.dispose()


def test_assistant_gene_context_pack_exposes_validated_gene_facts_only():
    engine, session = _build_session()
    try:
        session.add(
            Gene(
                id=1,
                ecoli_id="EG10001",
                symbol="dnaA",
                category="Replication",
                ko_index=42,
                is_mechanistic=True,
                monomer_id="PDNA-TF",
                monomer_name="chromosomal replication initiator protein DnaA",
                left_end_pos=388,
                right_end_pos=1799,
                direction="+",
            )
        )
        session.add(Gene(id=2, ecoli_id="EG99999", symbol="fakeA", ko_index=0))
        session.commit()

        context = AssistantContext(route="/assistant", selected_gene=None, assistant_surface="central")
        pack = assistant_gene_context_pack(
            session,
            user_content="Could we simulate a dnaA knockout and maybe some made_up_gene follow-up?",
            context=context,
        )

        assert pack["matched_gene_count"] == 1
        assert pack["genes"][0]["symbol"] == "dnaA"
        assert pack["genes"][0]["ko_index"] == 42
        assert pack["genes"][0]["mechanistic"] is True
        assert pack["genes"][0]["monomer_id"] == "PDNA-TF"
        assert "made_up_gene" not in {gene["symbol"] for gene in pack["genes"]}
    finally:
        session.close()
        engine.dispose()


def test_model_gene_proposals_validate_mentions_and_deduplicate_contextual_drafts():
    engine, session = _build_session()
    try:
        session.add(Variant(name="gene_knockout", docstring="Set selected gene expression to zero."))
        session.add(Condition(name="basal", nutrients="minimal glucose"))
        session.add(Gene(id=1, ecoli_id="EG10001", symbol="dnaA", ko_index=42))
        session.add(Gene(id=2, ecoli_id="EG10002", symbol="crp", ko_index=84))
        session.commit()

        context = AssistantContext(
            route="/results/2",
            selected_gene="dnaA",
            selected_experiment=None,
            selected_job=None,
            selected_condition="basal",
            assistant_surface="results",
        )
        conversation = create_conversation(
            session,
            AssistantConversationCreate(
                title="gene follow-ups",
                assistant_surface="results",
                context=context,
            ),
        )
        assistant_message = store_message(
            session,
            conversation,
            "assistant",
            "A dnaA knockout is already the current page context. A crp knockout is also worth reviewing.",
            context,
            status="completed",
        )

        contextual = record_contextual_proposals(
            session,
            conversation=conversation,
            assistant_message=assistant_message,
            context=context,
        )
        model_proposals = record_model_gene_proposals(
            session,
            conversation=conversation,
            assistant_message=assistant_message,
            context=context,
            user_content="Suggest knockout follow-up experiments.",
            assistant_content="Review crp knockout as a second hypothesis after dnaA.",
        )

        assert len([proposal for proposal in contextual if proposal.tool_name == "create_experiment"]) == 1
        assert len(model_proposals) == 2
        inspect_out = tool_call_to_out(next(proposal for proposal in model_proposals if proposal.tool_name == "inspect_gene"))
        assert inspect_out.arguments["gene"] == "crp"
        assert inspect_out.result["source"] == "model_gene_mention"
        create_out = tool_call_to_out(next(proposal for proposal in model_proposals if proposal.tool_name == "create_experiment"))
        assert create_out.arguments["gene_symbol"] == "crp"
        assert create_out.arguments["variant_index"] == 84
        assert create_out.result["source"] == "model_gene_mention"
        assert create_out.result["requires_confirmation"] is True
    finally:
        session.close()
        engine.dispose()


def test_model_gene_proposals_can_use_prior_assistant_suggestions():
    engine, session = _build_session()
    try:
        session.add(Variant(name="gene_knockout", docstring="Set selected gene expression to zero."))
        session.add(Condition(name="basal", nutrients="minimal glucose"))
        session.add(Gene(id=1, ecoli_id="EG10001", symbol="dnaA", ko_index=42))
        session.add(Gene(id=2, ecoli_id="EG10002", symbol="crp", ko_index=84))
        session.add(Gene(id=3, ecoli_id="EG10003", symbol="fis", ko_index=126))
        session.commit()

        context = AssistantContext(route="/assistant", selected_condition="basal", assistant_surface="central")
        conversation = create_conversation(
            session,
            AssistantConversationCreate(
                title="prior gene suggestions",
                assistant_surface="central",
                context=context,
            ),
        )
        prior_user = store_message(
            session,
            conversation,
            "user",
            "Suggest three genes to knockout.",
            context,
            status="stored",
        )
        prior_assistant = store_message(
            session,
            conversation,
            "assistant",
            "Three reasonable candidates are dnaA, crp, and fis. Start with read-only gene checks before making KO drafts.",
            context,
            status="completed",
        )
        current_user = store_message(
            session,
            conversation,
            "user",
            "Prepare cards for the three suggestions you made.",
            context,
            status="stored",
        )
        memory = assistant_conversation_context_pack(
            session,
            conversation_id=conversation.id or 0,
            current_message_id=current_user.id,
        )
        assert memory["message_count"] == 2
        assert "dnaA" in memory["messages"][1]["content"]

        assistant_message = store_message(
            session,
            conversation,
            "assistant",
            "I can prepare reviewable proposal cards for the previous gene suggestions.",
            context,
            status="completed",
        )

        proposals = record_model_gene_proposals(
            session,
            conversation=conversation,
            assistant_message=assistant_message,
            context=context,
            user_content=current_user.content,
            assistant_content=assistant_message.content,
            conversation_context=memory,
        )

        create_symbols = {
            tool_call_to_out(proposal).arguments["gene_symbol"]
            for proposal in proposals
            if proposal.tool_name == "create_experiment"
        }
        inspect_symbols = {
            tool_call_to_out(proposal).arguments["gene"]
            for proposal in proposals
            if proposal.tool_name == "inspect_gene"
        }
        assert create_symbols == {"dnaA", "crp", "fis"}
        assert inspect_symbols == {"dnaA", "crp", "fis"}
        assert all(tool_call_to_out(proposal).result["requires_confirmation"] is True for proposal in proposals if proposal.tool_name == "create_experiment")
        assert all(tool_call_to_out(proposal).result["side_effect"] is False for proposal in proposals if proposal.tool_name == "inspect_gene")
    finally:
        session.close()
        engine.dispose()


def test_model_gene_proposals_parse_explicit_proposal_targets_directive():
    engine, session = _build_session()
    try:
        session.add(Variant(name="gene_knockout", docstring="Set selected gene expression to zero."))
        session.add(Condition(name="basal", nutrients="minimal glucose"))
        session.add(Condition(name="acetate", nutrients="minimal acetate"))
        session.add(Gene(id=1, ecoli_id="EG10001", symbol="dnaA", ko_index=42))
        session.add(Gene(id=2, ecoli_id="EG10002", symbol="crp", ko_index=84))
        session.commit()

        context = AssistantContext(route="/assistant", selected_condition="basal", assistant_surface="central")
        conversation = create_conversation(
            session,
            AssistantConversationCreate(title="structured proposals", assistant_surface="central", context=context),
        )
        assistant_message = store_message(
            session,
            conversation,
            "assistant",
            "These are good candidates.\nProposal action: create_experiment\nProposal condition: acetate\nProposal targets: dnaA, crp, not_a_gene",
            context,
            status="completed",
        )

        proposals = record_model_gene_proposals(
            session,
            conversation=conversation,
            assistant_message=assistant_message,
            context=context,
            user_content="Prepare the proposal cards.",
            assistant_content=assistant_message.content,
        )

        create_calls = [tool_call_to_out(proposal) for proposal in proposals if proposal.tool_name == "create_experiment"]
        inspect_calls = [tool_call_to_out(proposal) for proposal in proposals if proposal.tool_name == "inspect_gene"]
        assert {call.arguments["gene_symbol"] for call in create_calls} == {"dnaA", "crp"}
        assert {call.arguments["gene"] for call in inspect_calls} == {"dnaA", "crp"}
        assert all(call.arguments["condition"] == "acetate" for call in create_calls)
        assert all(call.result["source"] == "model_structured_proposal" for call in create_calls + inspect_calls)
    finally:
        session.close()
        engine.dispose()


def test_model_gene_proposals_parse_json_inspect_only_directive_without_drafts():
    engine, session = _build_session()
    try:
        session.add(Variant(name="gene_knockout", docstring="Set selected gene expression to zero."))
        session.add(Condition(name="basal", nutrients="minimal glucose"))
        session.add(Gene(id=1, ecoli_id="EG10001", symbol="dnaA", ko_index=42))
        session.add(Gene(id=2, ecoli_id="EG10002", symbol="crp", ko_index=84))
        session.commit()

        context = AssistantContext(route="/assistant", selected_condition="basal", assistant_surface="central")
        conversation = create_conversation(
            session,
            AssistantConversationCreate(title="inspect-only proposals", assistant_surface="central", context=context),
        )
        assistant_message = store_message(
            session,
            conversation,
            "assistant",
            '```json\n{"action":"inspect_gene","proposal_targets":["dnaA","crp"]}\n```',
            context,
            status="completed",
        )

        proposals = record_model_gene_proposals(
            session,
            conversation=conversation,
            assistant_message=assistant_message,
            context=context,
            user_content="Show me what you can inspect.",
            assistant_content=assistant_message.content,
        )

        assert {proposal.tool_name for proposal in proposals} == {"inspect_gene"}
        assert {tool_call_to_out(proposal).arguments["gene"] for proposal in proposals} == {"dnaA", "crp"}
        assert all(tool_call_to_out(proposal).result["source"] == "model_structured_proposal" for proposal in proposals)
    finally:
        session.close()
        engine.dispose()


def test_assistant_working_memory_pack_tracks_selected_objects_and_proposals():
    engine, session = _build_session()
    try:
        context = AssistantContext(
            route="/results/2",
            selected_gene="dnaA",
            selected_job=2,
            selected_condition="basal",
            assistant_surface="results",
        )
        conversation = create_conversation(
            session,
            AssistantConversationCreate(title="memory test", assistant_surface="results", context=context),
        )
        user_message = store_message(
            session,
            conversation,
            "user",
            "Can you prepare cards for dnaA?",
            context,
            status="stored",
        )
        assistant_message = store_message(
            session,
            conversation,
            "assistant",
            "I can prepare reviewed cards.",
            context,
            status="completed",
        )
        session.add(
            AssistantToolCall(
                conversation_id=conversation.id or 0,
                message_id=assistant_message.id,
                tool_name="create_experiment",
                status="proposed",
                arguments_json='{"gene_symbol":"dnaA","condition":"basal"}',
                result_json='{"title":"Draft dnaA knockout","source":"test","requires_confirmation":true}',
                created_at="2026-01-01T00:00:00+00:00",
                updated_at="2026-01-01T00:00:00+00:00",
            )
        )
        session.add(
            AssistantConfirmation(
                conversation_id=conversation.id,
                action="create_experiment",
                status="pending",
                payload_json='{"gene_symbol":"dnaA"}',
                created_at="2026-01-01T00:00:00+00:00",
                resolved_at="",
            )
        )
        session.commit()

        conversation_context = assistant_conversation_context_pack(
            session,
            conversation_id=conversation.id or 0,
            current_message_id=user_message.id,
        )
        memory = assistant_working_memory_pack(
            session,
            conversation_id=conversation.id or 0,
            context=context,
            current_message_id=user_message.id,
            conversation_context=conversation_context,
        )

        assert memory["selected_objects"]["gene"] == "dnaA"
        assert memory["remembered_genes"] == ["dnaA"]
        assert memory["proposed_actions"][0]["tool_name"] == "create_experiment"
        assert memory["proposed_actions"][0]["requires_confirmation"] is True
        assert memory["pending_confirmations"][0]["action"] == "create_experiment"
        assert "Re-fetch deterministic platform facts" in memory["summary_policy"]["source_of_truth"]
    finally:
        session.close()
        engine.dispose()


def test_assistant_runtime_reports_no_provider_without_network():
    snapshot = {
        "assistant_provider": settings.assistant_provider,
        "assistant_model": settings.assistant_model,
        "openai_api_key": settings.openai_api_key,
        "anthropic_api_key": settings.anthropic_api_key,
        "openrouter_api_key": settings.openrouter_api_key,
        "lm_studio_base_url": settings.lm_studio_base_url,
        "vllm_base_url": settings.vllm_base_url,
        "ollama_base_url": settings.ollama_base_url,
    }
    try:
        settings.assistant_provider = ""
        settings.assistant_model = ""
        settings.openai_api_key = ""
        settings.anthropic_api_key = ""
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


def test_assistant_runtime_reports_selected_provider_not_configured():
    snapshot = {
        "assistant_provider": settings.assistant_provider,
        "assistant_model": settings.assistant_model,
        "openai_api_key": settings.openai_api_key,
    }
    try:
        settings.assistant_provider = "openai"
        settings.assistant_model = ""
        settings.openai_api_key = ""
        result = generate_assistant_runtime_reply(
            "Explain this result.",
            {"route": "/results/2", "selected_gene": "dnaA"},
        )
        assert result.status == "selected_provider_not_configured"
        assert result.provider_id == "openai"
        assert "selected but not configured" in result.content

        providers = get_provider_layer_status()
        assert providers.selected_provider_id == "openai"
        assert providers.active_runtime_provider_id == "openai"
        assert providers.runtime_ready is False
        assert "not configured" in providers.runtime_issue
    finally:
        _restore_runtime_settings(snapshot)


def test_anthropic_runtime_uses_messages_api_without_tools():
    snapshot = {
        "assistant_provider": settings.assistant_provider,
        "assistant_model": settings.assistant_model,
        "anthropic_api_key": settings.anthropic_api_key,
    }
    calls: list[dict[str, object]] = []

    def fake_transport(url, headers, payload, timeout):
        calls.append({"url": url, "headers": headers, "payload": payload, "timeout": timeout})
        return {"content": [{"type": "text", "text": "Claude response"}], "id": "msg-test"}

    try:
        settings.assistant_provider = "anthropic"
        settings.assistant_model = "claude-test"
        settings.anthropic_api_key = "anthropic-key"
        result = generate_assistant_runtime_reply(
            "Explain this result.",
            {"route": "/results/2", "selected_gene": "dnaA"},
            transport=fake_transport,
        )
        assert result.status == "completed"
        assert result.provider_id == "anthropic"
        assert result.model == "claude-test"
        assert result.content == "Claude response"
        assert len(calls) == 1
        call = calls[0]
        assert call["url"] == "https://api.anthropic.com/v1/messages"
        assert call["headers"]["x-api-key"] == "anthropic-key"
        assert call["headers"]["anthropic-version"] == "2023-06-01"
        payload = call["payload"]
        assert payload["model"] == "claude-test"
        assert "tools" not in payload
        assert payload["messages"][0]["role"] == "user"

        providers = get_provider_layer_status()
        assert providers.selected_provider_id == "anthropic"
        assert providers.runtime_ready is True
    finally:
        _restore_runtime_settings(snapshot)


def test_persisted_provider_config_overrides_environment_selection():
    engine, session = _build_session()
    snapshot = {
        "assistant_provider": settings.assistant_provider,
        "assistant_model": settings.assistant_model,
        "openai_api_key": settings.openai_api_key,
    }
    calls: list[dict[str, object]] = []

    def fake_transport(url, headers, payload, timeout):
        calls.append({"url": url, "headers": headers, "payload": payload, "timeout": timeout})
        return {"choices": [{"message": {"content": "Stored provider response"}}]}

    try:
        settings.assistant_provider = "openai"
        settings.assistant_model = "env-model"
        settings.openai_api_key = ""
        upsert_provider_config(
            session,
            "openai",
            AssistantProviderConfigUpdate(
                api_key="stored-key",
                model="stored-model",
                make_active=True,
            ),
        )

        providers = get_provider_layer_status(session)
        assert providers.selected_provider_id == "openai"
        assert providers.runtime_ready is True
        assert providers.active_runtime_model == "stored-model"
        assert session.exec(select(AssistantProviderConfig)).one().secret_value == "stored-key"

        result = generate_assistant_runtime_reply(
            "Use stored provider.",
            {"route": "/assistant"},
            session=session,
            transport=fake_transport,
        )
        assert result.status == "completed"
        assert result.model == "stored-model"
        assert calls[0]["headers"]["Authorization"] == "Bearer stored-key"
    finally:
        _restore_runtime_settings(snapshot)
        session.close()
        engine.dispose()


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
            {
                "route": "/results/2",
                "selected_gene": "dnaA",
                "conversation_context": {
                    "messages": [
                        {"role": "assistant", "content": "Earlier I suggested dnaA, crp, and fis."}
                    ]
                },
                "working_memory": {
                    "selected_objects": {"route": "/results/2", "gene": "dnaA", "surface": "results"},
                    "remembered_genes": ["dnaA", "crp", "fis"],
                    "proposed_actions": [
                        {
                            "tool_name": "create_experiment",
                            "status": "proposed",
                            "gene": "crp",
                            "title": "Draft crp knockout",
                            "requires_confirmation": True,
                        }
                    ],
                    "pending_confirmations": [],
                    "recent_unresolved_questions": ["What should I inspect next?"],
                    "summary_policy": {"currently_recommends_summary": False},
                },
            },
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
        assert "Recent conversation memory" in payload["messages"][0]["content"]
        assert "dnaA, crp, and fis" in payload["messages"][0]["content"]
        assert "Structured working memory" in payload["messages"][0]["content"]
        assert "Draft crp knockout" in payload["messages"][0]["content"]
        assert "Proposal targets:" in payload["messages"][0]["content"]
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


def test_read_only_inspect_gene_execution_returns_genes_table_facts():
    engine, session = _build_session()
    try:
        session.add(
            Gene(
                ecoli_id="EG10001",
                symbol="dnaA",
                category="Replication",
                ko_index=42,
                is_mechanistic=True,
                monomer_id="PDNA-TF",
                monomer_name="chromosomal replication initiator protein DnaA",
                left_end_pos=388,
                right_end_pos=1799,
                direction="+",
            )
        )
        session.commit()

        preview = preview_tool(
            session,
            "inspect_gene",
            AssistantToolPreviewRequest(arguments={"gene": "dnaa"}),
        )
        assert preview.valid is True
        assert preview.normalized_arguments["gene"] == "dnaA"
        assert preview.preview["gene"]["rna_id"] == "EG10001_RNA"

        executed = execute_tool(
            session,
            "inspect_gene",
            AssistantToolExecutionRequest(arguments={"gene": "dnaA"}),
        )
        assert executed.executed is True
        assert executed.requires_confirmation is False
        assert executed.result["gene"]["symbol"] == "dnaA"
        assert executed.result["summary"]["model_state_ids"]["protein"] == "PDNA-TF"
        assert executed.result["summary"]["knockout_available"] is True
        assert any(link["path"] == "/?gene=dnaA" for link in executed.result["links"])

        tool_calls = session.exec(select(AssistantToolCall)).all()
        assert len(tool_calls) == 1
        assert tool_calls[0].tool_name == "inspect_gene"
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
