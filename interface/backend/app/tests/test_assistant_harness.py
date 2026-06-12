from sqlalchemy.pool import StaticPool
from sqlmodel import SQLModel, Session, create_engine, select

from app.config import settings
from app.db.models import (
    AssistantConfirmation,
    AssistantProvenance,
    AssistantProviderConfig,
    AssistantToolCall,
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
    assert set(status.execution_enabled_tools) >= {
        "inspect_result", "inspect_gene", "gene_catalog", "inspect_tf_network",
        "list_conditions", "list_experiments", "inspect_experiment",
        "inspect_molecule_trajectories", "create_experiment", "run_simulation",
    }
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
        # Secret is encrypted at rest, not stored in cleartext, but decrypts back to the original.
        stored = session.exec(select(AssistantProviderConfig)).one()
        assert stored.secret_value != "stored-key"
        assert stored.secret_encrypted is True
        from app.services.assistant_secrets import decrypt_secret
        assert decrypt_secret(stored.secret_value) == "stored-key"

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


def test_agent_loop_executes_read_only_tool_and_feeds_result_back():
    """Native tool-use loop: model calls inspect_gene, loop runs it, model answers from the result."""
    from app.services.assistant_agent import generate_assistant_agent_reply

    engine, session = _build_session()
    snapshot = {
        "assistant_provider": settings.assistant_provider,
        "assistant_model": settings.assistant_model,
        "openai_api_key": settings.openai_api_key,
    }
    calls: list[dict[str, object]] = []

    def fake_transport(url, headers, payload, timeout):
        calls.append({"payload": payload})
        if len(calls) == 1:
            return {
                "choices": [{
                    "finish_reason": "tool_calls",
                    "message": {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [{
                            "id": "call_1",
                            "type": "function",
                            "function": {"name": "inspect_gene", "arguments": '{"gene": "alaA"}'},
                        }],
                    },
                }]
            }
        return {"choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": "alaA is mechanistic."}}]}

    try:
        settings.assistant_provider = ""
        settings.assistant_model = ""
        settings.openai_api_key = ""
        session.add(Gene(id=1, ecoli_id="EG10001", symbol="alaA", ko_index=7, is_mechanistic=True))
        session.commit()
        upsert_provider_config(
            session,
            "openai",
            AssistantProviderConfigUpdate(api_key="k", model="m", make_active=True),
        )

        result = generate_assistant_agent_reply(
            "What is alaA?",
            {"route": "/", "selected_gene": "alaA"},
            session=session,
            history=[],
            conversation_id=None,
            transport=fake_transport,
        )

        assert result.status == "completed"
        assert result.content == "alaA is mechanistic."
        # The loop made two calls: tool request, then the answer turn.
        assert len(calls) == 2
        # First request advertised native tools.
        assert any(t["function"]["name"] == "inspect_gene" for t in calls[0]["payload"]["tools"])
        # The read-only tool actually executed and its real result was threaded back.
        assert [item["tool_name"] for item in result.executed_tools] == ["inspect_gene"]
        assert result.pending_side_effects == []
        tool_msg = calls[1]["payload"]["messages"][-1]
        assert tool_msg["role"] == "tool"
        assert "EG10001" in tool_msg["content"]
    finally:
        _restore_runtime_settings(snapshot)
        session.close()
        engine.dispose()


def test_gene_catalog_adapter_counts_and_filters():
    engine, session = _build_session()
    try:
        session.add(Gene(id=1, ecoli_id="EG10001", symbol="dnaA", category="replication", ko_index=42, is_mechanistic=True, monomer_id="DNAA-MONOMER"))
        session.add(Gene(id=2, ecoli_id="EG10002", symbol="crp", category="regulation", ko_index=84, monomer_id="CRP-MONOMER"))
        session.add(Gene(id=3, ecoli_id="EG10003", symbol="fakeA", category="regulation", ko_index=0))
        session.commit()

        result = execute_tool(
            session,
            "gene_catalog",
            AssistantToolExecutionRequest(arguments={"category": "regulation"}),
        )
        assert result.executed is True
        assert result.result["totals"]["genes"] == 3
        assert result.result["totals"]["knockout_ready"] == 2
        assert result.result["totals"]["mechanistic"] == 1
        assert result.result["matched_count"] == 2
        assert {g["symbol"] for g in result.result["genes"]} == {"crp", "fakeA"}
    finally:
        session.close()
        engine.dispose()


def test_inspect_tf_network_adapter_returns_regulators_and_targets():
    engine, session = _build_session()
    try:
        session.add(Gene(id=1, ecoli_id="EG10001", symbol="crp", ko_index=84))
        session.add(TFEdge(tf_symbol="crp", target_symbol="lacZ", log2fc_mean=1.5, regulation_direct="+"))
        session.add(TFEdge(tf_symbol="fis", target_symbol="crp", log2fc_mean=-0.8, regulation_direct="-"))
        session.commit()

        result = execute_tool(
            session,
            "inspect_tf_network",
            AssistantToolExecutionRequest(arguments={"gene": "crp"}),
        )
        assert result.executed is True
        assert result.result["is_transcription_factor"] is True
        assert [t["target"] for t in result.result["targets"]] == ["lacZ"]
        assert [r["regulator"] for r in result.result["regulators"]] == ["fis"]
    finally:
        session.close()
        engine.dispose()


def test_agent_recovers_text_embedded_tool_call_from_weak_model():
    """Models that emit a tool call as a fenced JSON block (not structured tool_calls) still execute,
    and the raw JSON never leaks into the displayed answer."""
    from app.services.assistant_agent import generate_assistant_agent_reply

    engine, session = _build_session()
    snapshot = {
        "assistant_provider": settings.assistant_provider,
        "assistant_model": settings.assistant_model,
        "openai_api_key": settings.openai_api_key,
    }
    calls: list[dict[str, object]] = []

    def fake_transport(url, headers, payload, timeout):
        calls.append({"payload": payload})
        if len(calls) == 1:
            # Weak model: tool call appears in content, NOT in tool_calls.
            return {"choices": [{"finish_reason": "stop", "message": {
                "role": "assistant",
                "content": "Let me check the genes table.\n```json\n{\"name\": \"gene_catalog\", \"arguments\": {}}\n```",
            }}]}
        return {"choices": [{"finish_reason": "stop", "message": {
            "role": "assistant", "content": "The platform supports 2 genes."}}]}

    try:
        settings.assistant_provider = ""
        settings.assistant_model = ""
        settings.openai_api_key = ""
        session.add(Gene(id=1, ecoli_id="EG10001", symbol="dnaA", ko_index=42))
        session.add(Gene(id=2, ecoli_id="EG10002", symbol="crp", ko_index=84))
        session.commit()
        upsert_provider_config(session, "openai", AssistantProviderConfigUpdate(api_key="k", model="m", make_active=True))

        result = generate_assistant_agent_reply(
            "How many genes are supported?",
            {"route": "/"},
            session=session,
            history=[],
            conversation_id=None,
            transport=fake_transport,
        )

        assert result.status == "completed"
        # The text-embedded call was recovered and executed.
        assert [item["tool_name"] for item in result.executed_tools] == ["gene_catalog"]
        # Raw JSON tool call must not leak into the answer.
        assert '"name"' not in result.content
        assert "gene_catalog" not in result.content
        assert result.content == "The platform supports 2 genes."
        # The recovered call was threaded back as a real tool result.
        tool_msg = calls[1]["payload"]["messages"][-1]
        assert tool_msg["role"] == "tool"
        assert '"genes": 2' in tool_msg["content"] or '"genes":2' in tool_msg["content"]
    finally:
        _restore_runtime_settings(snapshot)
        session.close()
        engine.dispose()


def test_streaming_agent_emits_deltas_and_runs_tool():
    """SSE path: assemble a streamed tool call, run it, then stream the answer tokens."""
    from app.services.assistant_stream import stream_assistant_agent_events

    engine, session = _build_session()
    snapshot = {
        "assistant_provider": settings.assistant_provider,
        "assistant_model": settings.assistant_model,
        "openai_api_key": settings.openai_api_key,
    }
    calls: list[int] = []

    def fake_stream_transport(url, headers, payload, timeout):
        calls.append(1)
        if len(calls) == 1:
            return iter([
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"gene_catalog","arguments":""}}]}}]}',
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}',
                'data: {"choices":[{"finish_reason":"tool_calls","delta":{}}]}',
                'data: [DONE]',
            ])
        return iter([
            'data: {"choices":[{"delta":{"content":"The platform "}}]}',
            'data: {"choices":[{"delta":{"content":"supports 2 genes."}}]}',
            'data: {"choices":[{"finish_reason":"stop","delta":{}}]}',
            'data: [DONE]',
        ])

    try:
        settings.assistant_provider = ""
        settings.assistant_model = ""
        settings.openai_api_key = ""
        session.add(Gene(id=1, ecoli_id="EG10001", symbol="dnaA", ko_index=42))
        session.add(Gene(id=2, ecoli_id="EG10002", symbol="crp", ko_index=84))
        session.commit()
        upsert_provider_config(session, "openai", AssistantProviderConfigUpdate(api_key="k", model="m", make_active=True))

        events = list(stream_assistant_agent_events(
            "How many genes are supported?",
            {"route": "/"},
            session=session,
            history=[],
            conversation_id=None,
            stream_transport=fake_stream_transport,
        ))

        deltas = "".join(e["text"] for e in events if e.get("type") == "delta")
        statuses = [e["tool"] for e in events if e.get("type") == "status"]
        result = next(e["result"] for e in events if e.get("type") == "result")

        assert deltas == "The platform supports 2 genes."
        assert statuses == ["gene_catalog"]
        assert result["status"] == "completed"
        assert result["content"] == "The platform supports 2 genes."
        assert [item["tool_name"] for item in result["executed_tools"]] == ["gene_catalog"]
    finally:
        _restore_runtime_settings(snapshot)
        session.close()
        engine.dispose()


def test_compaction_summarizes_old_turns_and_pack_surfaces_it():
    """Model-based compaction folds old turns into a rolling summary; the pack then surfaces it
    and excludes the covered messages from the verbatim window."""
    from app.services.assistant_agent import compact_conversation
    from app.services.assistant_harness import AssistantConversationCreate, get_conversation_summary

    engine, session = _build_session()
    snapshot = {
        "assistant_provider": settings.assistant_provider,
        "assistant_keep_recent_turns": settings.assistant_keep_recent_turns,
        "assistant_compact_threshold": settings.assistant_compact_threshold,
    }
    try:
        settings.assistant_provider = ""
        settings.assistant_keep_recent_turns = 4
        settings.assistant_compact_threshold = 3
        upsert_provider_config(session, "openai", AssistantProviderConfigUpdate(api_key="k", model="m", make_active=True))

        conversation = create_conversation(session, AssistantConversationCreate(title="c"))
        ctx = AssistantContext()
        for i in range(12):
            store_message(session, conversation, "user", f"user turn {i} about dnaA", ctx)
            store_message(session, conversation, "assistant", f"assistant reply {i}", ctx)

        def fake_transport(url, headers, payload, timeout):
            # It used a cheap summary model and was given the old transcript.
            assert payload["model"] == "gpt-4.1-mini"
            return {"choices": [{"message": {"content": "User is studying dnaA across several turns."}}]}

        result = compact_conversation(session, conversation.id or 0, transport=fake_transport)
        assert result["compacted"] is True
        assert result["summarized"] > 0

        summary = get_conversation_summary(session, conversation.id or 0)
        assert summary is not None
        assert "dnaA" in summary.content

        pack = assistant_conversation_context_pack(session, conversation_id=conversation.id or 0)
        assert pack["earlier_context"]["summary"] == "User is studying dnaA across several turns."
        # Covered (old) messages are no longer in the verbatim window.
        assert pack["message_count"] <= settings.assistant_keep_recent_turns + 1
    finally:
        for key, value in snapshot.items():
            setattr(settings, key, value)
        session.close()
        engine.dispose()


def test_context_pack_budgets_long_history_and_digests_the_rest():
    engine, session = _build_session()
    try:
        from app.services.assistant_harness import AssistantConversationCreate

        conversation = create_conversation(session, AssistantConversationCreate(title="long"))
        ctx = AssistantContext()
        store_message(session, conversation, "user", "First question about dnaA growth.", ctx)
        # Many long turns that blow past the char budget.
        for i in range(20):
            store_message(session, conversation, "assistant", ("X" * 1500) + f" turn {i}", ctx)
        current = store_message(session, conversation, "user", "And now?", ctx)

        pack = assistant_conversation_context_pack(
            session, conversation_id=conversation.id or 0, current_message_id=current.id, char_budget=6000,
        )
        assert pack["message_count"] < 21  # budget trimmed the history
        assert pack["earlier_context"] is not None
        assert pack["earlier_context"]["omitted_message_count"] > 0
        assert "dnaA" in pack["earlier_context"]["note"]  # the opening turn is preserved in the digest
    finally:
        session.close()
        engine.dispose()


def test_resolving_a_proposal_clears_it_from_the_awaiting_list():
    """Approving (execute) or rejecting a side-effect proposal must move its card out of 'proposed'."""
    from app.services.assistant_harness import _record_tool_call

    engine, session = _build_session()
    try:
        session.add(Condition(name="basal", nutrients="minimal"))
        session.add(Variant(name="gene_knockout", docstring="", filename="gene_knockout.py"))
        session.add(Gene(id=1, ecoli_id="EG10001", symbol="alaA", ko_index=7))
        session.commit()

        args = {
            "name": "alaA knockout", "description": "", "variant_type": "gene_knockout",
            "variant_index": 7, "condition": "basal", "timeline": "", "sim_params": {},
            "gene_symbol": "alaA", "gene_symbols": [], "include_wildtype": False,
        }
        normalized = preview_tool(session, "create_experiment", AssistantToolPreviewRequest(arguments=args)).normalized_arguments

        # Approve + execute path.
        proposal = _record_tool_call(session, conversation_id=None, tool_name="create_experiment",
                                     status="proposed", arguments=normalized, result={"title": "draft"})
        confirmation = create_confirmation(session, ConfirmationCreate(
            action="create_experiment", payload=normalized, tool_call_id=proposal.id))
        resolve_confirmation(session, confirmation, ConfirmationResolve(status="approved"))
        outcome = execute_tool(session, "create_experiment", AssistantToolExecutionRequest(
            arguments=args, confirmation_id=confirmation.id))
        assert outcome.executed is True
        assert session.get(AssistantToolCall, proposal.id).status == "executed"

        # Reject path.
        proposal2 = _record_tool_call(session, conversation_id=None, tool_name="create_experiment",
                                      status="proposed", arguments=normalized, result={"title": "draft"})
        confirmation2 = create_confirmation(session, ConfirmationCreate(
            action="create_experiment", payload=normalized, tool_call_id=proposal2.id))
        resolve_confirmation(session, confirmation2, ConfirmationResolve(status="rejected"))
        assert session.get(AssistantToolCall, proposal2.id).status == "rejected"
    finally:
        session.close()
        engine.dispose()


def test_create_experiment_auto_resolves_variant_index_from_gene():
    """The model often omits variant_index; for a gene_knockout it is filled from the gene's ko_index
    so the proposal is valid (and surfaced) instead of being dropped."""
    engine, session = _build_session()
    try:
        session.add(Condition(name="glc_20mM", nutrients="minimal + glucose"))
        session.add(Variant(name="gene_knockout", docstring="", filename="gene_knockout.py"))
        session.add(Gene(id=1, ecoli_id="EG11001", symbol="thiS", ko_index=931))
        session.commit()

        preview = preview_tool(session, "create_experiment", AssistantToolPreviewRequest(arguments={
            "variant_type": "gene_knockout", "condition": "glc_20mM", "gene_symbol": "thiS",
            "include_wildtype": False,  # variant_index intentionally omitted
        }))
        assert preview.valid is True
        assert preview.normalized_arguments["variant_index"] == 931
    finally:
        session.close()
        engine.dispose()


def test_reconcile_claim_contradicts_false_success():
    from app.services.assistant_agent import _reconcile_claim

    # Claims success but produced no card and had an invalid attempt -> correction appended.
    out = _reconcile_claim("I have prepared this experiment for review.", pending=[], issues=["create_experiment: Missing 'variant_index'"])
    assert "no action card was actually created" in out.lower()
    assert "variant_index" in out
    # A real pending action is left untouched.
    from app.services.assistant_agent import PendingSideEffect
    kept = _reconcile_claim("I've prepared it.", pending=[PendingSideEffect(tool_name="create_experiment")], issues=[])
    assert kept == "I've prepared it."
    # A plain answer with no claim is untouched.
    assert _reconcile_claim("There are 4749 genes.", pending=[], issues=[]) == "There are 4749 genes."


def test_permission_tiers_are_assigned_and_policy_exposed():
    from app.services.assistant_harness import PERMISSION_POLICY, get_tool_registry

    tiers = {spec.name: spec.permission_tier for spec in get_tool_registry()}
    assert tiers["inspect_gene"] == "read_only"
    assert tiers["create_experiment"] == "draft"
    assert tiers["run_simulation"] == "queue"
    assert tiers["publish_environment_builder_artifact"] == "publish_destructive"
    assert PERMISSION_POLICY["read_only"]["requires_confirmation"] is False
    assert PERMISSION_POLICY["queue"]["requires_confirmation"] is True
    assert get_assistant_harness_status().permission_policy == PERMISSION_POLICY


def test_secret_at_rest_round_trips_and_tamper_is_detected():
    from app.services.assistant_secrets import decrypt_secret, encrypt_secret

    token = encrypt_secret("sk-test-123")
    assert token.startswith("enc:v1:")
    assert "sk-test-123" not in token
    assert decrypt_secret(token) == "sk-test-123"
    assert decrypt_secret("") == ""
    assert decrypt_secret("legacy-plaintext") == "legacy-plaintext"  # tolerates pre-encryption values
    import pytest as _pytest
    with _pytest.raises(ValueError):
        decrypt_secret(token[:-4] + "AAAA")  # corrupted tag


def test_expired_confirmation_blocks_execution():
    engine, session = _build_session()
    try:
        session.add(Condition(name="basal", nutrients="minimal"))
        session.add(Variant(name="gene_knockout", docstring="", filename="gene_knockout.py"))
        session.add(Gene(id=1, ecoli_id="EG10001", symbol="alaA", ko_index=7))
        session.commit()

        args = {"variant_type": "gene_knockout", "variant_index": 7, "condition": "basal", "gene_symbol": "alaA", "sim_params": {}}
        normalized = preview_tool(session, "create_experiment", AssistantToolPreviewRequest(arguments=args)).normalized_arguments
        confirmation = create_confirmation(session, ConfirmationCreate(action="create_experiment", payload=normalized))
        resolve_confirmation(session, confirmation, ConfirmationResolve(status="approved"))
        # Force expiry into the past.
        confirmation.expires_at = "2000-01-01T00:00:00+00:00"
        session.add(confirmation)
        session.commit()

        outcome = execute_tool(session, "create_experiment",
                               AssistantToolExecutionRequest(arguments=args, confirmation_id=confirmation.id))
        assert outcome.executed is False
        assert any("expired" in err.lower() for err in outcome.errors)
        assert session.exec(select(Experiment)).all() == []
    finally:
        session.close()
        engine.dispose()


def test_create_experiment_normalized_args_re_preview_as_valid():
    """A proposal stores normalized args (sim_params as a JSON string); re-previewing them — which the
    confirm flow does — must stay valid instead of failing 'sim_params must be an object'."""
    engine, session = _build_session()
    try:
        session.add(Condition(name="glc_20mM", nutrients="minimal + glucose"))
        session.add(Variant(name="gene_knockout", docstring="", filename="gene_knockout.py"))
        session.add(Gene(id=1, ecoli_id="EG10001", symbol="yaaA", ko_index=3))
        session.commit()

        args = {
            "variant_type": "gene_knockout", "variant_index": 3, "condition": "glc_20mM",
            "gene_symbol": "yaaA", "sim_params": {"generations": 1},
        }
        first = preview_tool(session, "create_experiment", AssistantToolPreviewRequest(arguments=args))
        assert first.valid is True
        assert isinstance(first.normalized_arguments["sim_params"], str)  # stored as JSON string

        # Re-preview the *normalized* args (what the proposal card / confirm flow replays).
        second = preview_tool(session, "create_experiment",
                              AssistantToolPreviewRequest(arguments=first.normalized_arguments))
        assert second.valid is True
        assert second.errors == []
    finally:
        session.close()
        engine.dispose()


def test_supersede_open_proposals_retires_prior_cards():
    from app.services.assistant_harness import _record_tool_call, supersede_open_proposals

    engine, session = _build_session()
    try:
        a = _record_tool_call(session, conversation_id=7, tool_name="create_experiment",
                              status="proposed", arguments={}, result={})
        b = _record_tool_call(session, conversation_id=7, tool_name="inspect_gene",
                              status="proposed", arguments={}, result={})
        other = _record_tool_call(session, conversation_id=99, tool_name="inspect_gene",
                                  status="proposed", arguments={}, result={})
        retired = supersede_open_proposals(session, 7)
        assert retired == 2
        assert session.get(AssistantToolCall, a.id).status == "superseded"
        assert session.get(AssistantToolCall, b.id).status == "superseded"
        assert session.get(AssistantToolCall, other.id).status == "proposed"  # other conversation untouched
    finally:
        session.close()
        engine.dispose()


def test_invalid_side_effect_is_not_surfaced_as_a_card():
    """A create_experiment with a bogus variant_type must not become a confirmation card."""
    from app.services.assistant_agent import _run_tool_call, NormalizedToolCall, PendingSideEffect

    engine, session = _build_session()
    try:
        session.add(Condition(name="basal", nutrients="minimal"))
        session.add(Variant(name="gene_knockout", docstring="", filename="gene_knockout.py"))
        session.add(Gene(id=1, ecoli_id="EG10001", symbol="alaA", ko_index=7))
        session.commit()

        pending: list[PendingSideEffect] = []
        executed: list = []
        call = NormalizedToolCall(id="c1", name="create_experiment", input={
            "variant_type": "mutation", "variant_index": 1, "condition": "basal", "gene_symbol": "alaA",
        })
        result = _run_tool_call(
            session, call=call, context=AssistantContext(), conversation_id=None, pending=pending, executed=executed,
        )
        assert pending == []  # invalid → no card
        assert "invalid_arguments" in result["content"]
        assert session.exec(select(Experiment)).all() == []
    finally:
        session.close()
        engine.dispose()


def test_stream_fence_filter_suppresses_code_blocks():
    from app.services.assistant_stream import _FenceFilter

    f = _FenceFilter()
    # Feed in awkward chunks that split the fence markers and the JSON.
    shown = ""
    for chunk in ["Here is the plan. ", "```js", "on\n{\"name\": \"x\"}", "\n``", "` Done."]:
        shown += f.feed(chunk)
    shown += f.flush()
    assert "name" not in shown
    assert "Here is the plan." in shown
    assert "Done." in shown


def test_model_structure_adapter_reads_reconstruction():
    import tempfile
    from pathlib import Path as _Path

    engine, session = _build_session()
    snapshot = {"reconstruction_path": settings.reconstruction_path}
    tmp = tempfile.mkdtemp()
    try:
        session.add(Gene(id=1, ecoli_id="EG10001", symbol="pfkA", ko_index=1, monomer_id="PFKA-MONOMER"))
        session.commit()

        flat = _Path(tmp) / "ecoli" / "flat"
        flat.mkdir(parents=True)
        (flat / "metabolic_reactions.tsv").write_text(
            "# comment line\n"
            '"id"\t"stoichiometry"\t"direction"\t"catalyzed_by"\n'
            '"PFK-RXN"\t{"ATP[c]": -1, "FRUCTOSE-6P[c]": -1, "ADP[c]": 1, "FRUCTOSE-16-DIPHOSPHATE[c]": 1}\t"L2R"\t["PFKA-MONOMER"]\n'
            '"TPI-RXN"\t{"DIHYDROXYACETONE-PHOSPHATE[c]": -1, "GAP[c]": 1}\t"BOTH"\t["TPI-MONOMER"]\n',
            encoding="utf-8",
        )
        settings.reconstruction_path = _Path(tmp)

        # By enzyme (gene symbol -> monomer -> catalysed reactions)
        by_gene = execute_tool(session, "model_structure", AssistantToolExecutionRequest(arguments={"query": "pfkA"}))
        assert by_gene.executed is True
        assert by_gene.result["available"] is True
        assert [r["id"] for r in by_gene.result["reactions"]] == ["PFK-RXN"]
        assert by_gene.result["reactions"][0]["reversible"] is False
        totals = by_gene.result["network_totals"]
        assert totals["base_reactions"] == 2
        assert totals["reversible"] == 1 and totals["one_way"] == 1
        assert totals["fba_expanded_flux_estimate"] == 1 * 2 + 1  # reversible*2 + one_way

        # By metabolite
        by_met = execute_tool(session, "model_structure", AssistantToolExecutionRequest(arguments={"query": "GAP"}))
        assert "TPI-RXN" in [r["id"] for r in by_met.result["reactions"]]
    finally:
        settings.reconstruction_path = snapshot["reconstruction_path"]
        session.close()
        engine.dispose()


def test_explain_modeling_adapter_topics_and_guardrail():
    engine, session = _build_session()
    try:
        # FBA topic: returns term roles + the no-equation guardrail.
        fba = execute_tool(session, "explain_modeling", AssistantToolExecutionRequest(arguments={"topic": "what is FBA"}))
        assert fba.executed is True
        assert fba.result["topic"] == "fba"
        terms = {t["term"] for t in fba.result["explanation"]["terms"]}
        assert {"flux vector", "stoichiometric matrix", "reversible split"} <= terms
        assert "do NOT" in fba.result["guardrail"]

        # Mechanistic processes resolve via alias; describe terms, not equations.
        proc = execute_tool(session, "explain_modeling", AssistantToolExecutionRequest(arguments={"topic": "mechanistic equations"}))
        assert proc.result["topic"] == "processes"
        processes = {e["process"] for e in proc.result["explanation"]["examples"]}
        assert {"transcription", "translation", "metabolism"} <= processes

        # No topic -> overview + full catalog so the model can pick.
        overview = execute_tool(session, "explain_modeling", AssistantToolExecutionRequest(arguments={}))
        assert overview.result["topic"] == "overview"
        assert "output_series" in overview.result["all_topics"]
    finally:
        session.close()
        engine.dispose()


def test_platform_guide_adapter_describes_pages():
    engine, session = _build_session()
    try:
        full = execute_tool(session, "platform_guide", AssistantToolExecutionRequest(arguments={}))
        assert full.executed is True
        assert full.result["page_count"] >= 10
        one = execute_tool(session, "platform_guide", AssistantToolExecutionRequest(arguments={"page": "network"}))
        assert one.executed is True
        assert [p["name"] for p in one.result["pages"]] == ["Network"]
        assert one.result["pages"][0]["route"] == "/network"
    finally:
        session.close()
        engine.dispose()


def test_agent_loop_surfaces_side_effect_tool_without_executing():
    """create_experiment is never auto-run: it is surfaced as a pending confirmation card."""
    from app.services.assistant_agent import generate_assistant_agent_reply

    engine, session = _build_session()
    snapshot = {
        "assistant_provider": settings.assistant_provider,
        "assistant_model": settings.assistant_model,
        "openai_api_key": settings.openai_api_key,
    }
    calls: list[dict[str, object]] = []

    def fake_transport(url, headers, payload, timeout):
        calls.append({"payload": payload})
        if len(calls) == 1:
            return {
                "choices": [{
                    "finish_reason": "tool_calls",
                    "message": {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [{
                            "id": "call_1",
                            "type": "function",
                            "function": {
                                "name": "create_experiment",
                                "arguments": '{"variant_type": "gene_knockout", "variant_index": 7, "condition": "basal", "gene_symbol": "alaA"}',
                            },
                        }],
                    },
                }]
            }
        return {"choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": "Prepared a draft for your review."}}]}

    try:
        settings.assistant_provider = ""
        settings.assistant_model = ""
        settings.openai_api_key = ""
        session.add(Condition(name="basal", nutrients="minimal"))
        session.add(Variant(name="gene_knockout", docstring="", filename="gene_knockout.py"))
        session.add(Gene(id=1, ecoli_id="EG10001", symbol="alaA", ko_index=7))
        session.commit()
        upsert_provider_config(
            session,
            "openai",
            AssistantProviderConfigUpdate(api_key="k", model="m", make_active=True),
        )

        result = generate_assistant_agent_reply(
            "Knock out alaA.",
            {"route": "/", "selected_gene": "alaA"},
            session=session,
            history=[],
            conversation_id=None,
            transport=fake_transport,
        )

        assert result.status == "completed"
        # No side effect executed; experiment table is untouched.
        assert session.exec(select(Experiment)).all() == []
        assert result.executed_tools == []
        assert [p.tool_name for p in result.pending_side_effects] == ["create_experiment"]
        # The model was told the action is pending, not done.
        tool_msg = calls[1]["payload"]["messages"][-1]
        assert tool_msg["role"] == "tool"
        assert "pending_user_confirmation" in tool_msg["content"]
    finally:
        _restore_runtime_settings(snapshot)
        session.close()
        engine.dispose()


# --------------------------------------------------------------------------- #
# Exhaustive per-adapter coverage: execute + audit, reject invalid, confirmation
# --------------------------------------------------------------------------- #


def _seed_adapter_fixture(session):
    session.add(Condition(name="basal", nutrients="minimal"))
    session.add(Condition(name="glc_20mM", nutrients="minimal + glucose"))
    session.add(MediaRecipe(media_id="minimal", base_media="MIX0"))
    session.add(Timeline(name="000000_basal", definition="[]"))
    session.add(Variant(name="gene_knockout", docstring="", filename="gene_knockout.py"))
    session.add(Gene(id=1, ecoli_id="EG10001", symbol="dnaA", category="replication",
                     ko_index=42, is_mechanistic=True, monomer_id="DNAA-MONOMER"))
    session.add(TFEdge(tf_symbol="dnaA", target_symbol="lacZ", log2fc_mean=1.0, regulation_direct="+"))
    session.add(Experiment(id=7, name="dnaA KO", variant_type="gene_knockout", variant_index=42,
                           condition="basal", status="done", gene_symbol="dnaA", sim_params="{}"))
    session.add(SimulationJob(id=12, experiment_id=7, status="done", condition="basal", seed=0, generations=2, sim_dir="out/run"))
    session.add(SimulationResult(job_id=12, experiment_id=7, seed=0, generation=0, divided=True, growth_rate=0.010))
    session.add(SimulationResult(job_id=12, experiment_id=7, seed=0, generation=1, divided=True, growth_rate=0.011))
    session.commit()


READ_ONLY_ADAPTER_CASES = [
    ("inspect_gene", {"gene": "dnaA"}, "gene"),
    ("gene_catalog", {}, "totals"),
    ("inspect_tf_network", {"gene": "dnaA"}, "targets"),
    ("list_conditions", {}, "conditions"),
    ("list_experiments", {}, "experiments"),
    ("inspect_experiment", {"experiment_id": 7}, "experiment"),
    ("inspect_result", {"job_id": 12}, "summary"),
    ("inspect_molecule_trajectories", {"job_id": 12}, "trajectory_scope"),
    ("platform_guide", {}, "pages"),
    ("explain_modeling", {"topic": "fba"}, "explanation"),
]


def test_every_read_only_adapter_executes_and_is_audited():
    engine, session = _build_session()
    try:
        _seed_adapter_fixture(session)
        for tool, args, expect_key in READ_ONLY_ADAPTER_CASES:
            out = execute_tool(session, tool, AssistantToolExecutionRequest(arguments=args))
            assert out.executed is True, tool
            assert out.requires_confirmation is False, tool
            assert out.status == "executed", (tool, out.status)
            assert expect_key in out.result, (tool, expect_key)
            # Audited: a tool-call row AND a provenance row were written.
            assert out.tool_call_id is not None and out.provenance_id is not None, tool
        tool_calls = session.exec(select(AssistantToolCall)).all()
        provenance = session.exec(select(AssistantProvenance)).all()
        assert len(tool_calls) >= len(READ_ONLY_ADAPTER_CASES)
        assert len(provenance) >= len(READ_ONLY_ADAPTER_CASES)
    finally:
        session.close()
        engine.dispose()


def test_read_only_adapters_reject_invalid_arguments():
    engine, session = _build_session()
    try:
        _seed_adapter_fixture(session)
        cases = [
            ("inspect_gene", {"gene": "NOTAGENE"}),          # unknown gene
            ("inspect_tf_network", {"gene": "NOTAGENE"}),
            ("inspect_experiment", {"experiment_id": 999}),  # missing row
            ("inspect_result", {"job_id": 999}),
            ("inspect_molecule_trajectories", {"job_id": 999}),
            ("inspect_experiment", {}),                      # missing required arg
            ("inspect_result", {}),
            ("inspect_gene", {}),
        ]
        for tool, args in cases:
            out = execute_tool(session, tool, AssistantToolExecutionRequest(arguments=args))
            assert out.executed is False, (tool, args)
            assert out.status == "validation_failed", (tool, args, out.status)
            assert out.errors, (tool, args)
    finally:
        session.close()
        engine.dispose()


def test_side_effect_adapters_require_confirmation_and_make_no_changes():
    engine, session = _build_session()
    try:
        _seed_adapter_fixture(session)
        # create_experiment with valid args but NO confirmation -> gated, nothing created.
        create = execute_tool(session, "create_experiment", AssistantToolExecutionRequest(arguments={
            "variant_type": "gene_knockout", "condition": "basal", "gene_symbol": "dnaA", "include_wildtype": False,
        }))
        assert create.executed is False
        assert create.status == "confirmation_required"
        assert create.requires_confirmation is True
        assert create.tool_call_id is not None  # still audited
        assert session.exec(select(Experiment).where(Experiment.id != 7)).all() == []

        # run_simulation with valid experiment but NO confirmation -> gated, no job queued.
        run = execute_tool(session, "run_simulation", AssistantToolExecutionRequest(arguments={
            "experiment_id": 7, "seed": 0, "generations": 1,
        }))
        assert run.executed is False
        assert run.status == "confirmation_required"
        jobs = session.exec(select(SimulationJob).where(SimulationJob.id != 12)).all()
        assert jobs == []
    finally:
        session.close()
        engine.dispose()


def test_execute_unknown_tool_is_a_clean_404():
    from fastapi import HTTPException

    engine, session = _build_session()
    try:
        raised = False
        try:
            execute_tool(session, "does_not_exist", AssistantToolExecutionRequest(arguments={}))
        except HTTPException as exc:
            raised = True
            assert exc.status_code == 404
        assert raised
    finally:
        session.close()
        engine.dispose()


def test_agent_degrades_gracefully_on_provider_failure():
    import urllib.error
    from app.services.assistant_agent import generate_assistant_agent_reply

    engine, session = _build_session()
    snapshot = {
        "assistant_provider": settings.assistant_provider,
        "assistant_model": settings.assistant_model,
        "openai_api_key": settings.openai_api_key,
    }
    try:
        settings.assistant_provider = ""
        settings.assistant_model = ""
        settings.openai_api_key = ""
        upsert_provider_config(session, "openai", AssistantProviderConfigUpdate(api_key="k", model="m", make_active=True))

        def boom(url, headers, payload, timeout):
            raise urllib.error.URLError("connection refused")

        result = generate_assistant_agent_reply(
            "hello", {"route": "/"}, session=session, history=[], conversation_id=None, transport=boom,
        )
        assert result.status == "provider_call_failed"  # no exception bubbled up
        assert "failed" in result.content.lower()
        assert result.pending_side_effects == [] and result.executed_tools == []
    finally:
        _restore_runtime_settings(snapshot)
        session.close()
        engine.dispose()


def test_streaming_degrades_gracefully_on_provider_failure():
    import urllib.error
    from app.services.assistant_stream import stream_assistant_agent_events

    engine, session = _build_session()
    snapshot = {
        "assistant_provider": settings.assistant_provider,
        "assistant_model": settings.assistant_model,
        "openai_api_key": settings.openai_api_key,
    }
    try:
        settings.assistant_provider = ""
        settings.assistant_model = ""
        settings.openai_api_key = ""
        upsert_provider_config(session, "openai", AssistantProviderConfigUpdate(api_key="k", model="m", make_active=True))

        def boom(url, headers, payload, timeout):
            raise urllib.error.URLError("connection refused")
            yield  # pragma: no cover (makes this a generator)

        events = list(stream_assistant_agent_events(
            "hello", {"route": "/"}, session=session, history=[], conversation_id=None, stream_transport=boom,
        ))
        result = next(e["result"] for e in events if e.get("type") == "result")
        assert result["status"] == "provider_call_failed"
    finally:
        _restore_runtime_settings(snapshot)
        session.close()
        engine.dispose()
