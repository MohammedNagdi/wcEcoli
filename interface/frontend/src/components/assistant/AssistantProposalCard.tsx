import { Link } from 'react-router-dom'
import { previewAssistantTool, createAssistantConfirmation, resolveAssistantConfirmation, executeAssistantTool, getAssistantConfirmations, getAssistantToolCalls } from '../../api/client'
import type { AssistantToolCall, AssistantContext, AssistantToolPreview, AssistantToolExecution, AssistantConfirmation } from '../../types'


import { confirmButtonLabel, proposalText, proposalKind, proposalSourceLabel, proposalFactRows } from './assistantPresentation'
import { StatusPill } from './AssistantPrimitives'
import { useAssistant } from './AssistantProvider'
import { ToolReviewPanel } from './AssistantEvidence'

export function AssistantProposalCard({
  proposal,
  context,
  conversationId,
  busy,
  darkMode,
  onRunReadOnly,
  onResolved,
}: {
  proposal: AssistantToolCall
  context: AssistantContext
  conversationId: number | null
  busy: boolean
  darkMode: boolean
  onRunReadOnly: (proposal: AssistantToolCall) => void
  onResolved: (proposalId: number, outcome: 'executed' | 'rejected') => void
}) {
  const a = useAssistant()
  const review = a.proposalReviews[proposal.id]
  const preview = review?.preview ?? null
  const execution = review?.execution ?? null
  const confirmation = review?.confirmation ?? null
  const cardBusy = review?.busy ?? null
  const error = review?.error ?? null
  const uncertain = review?.uncertain ?? false
  const patch = (value: Partial<import('./AssistantProvider').ProposalReviewState>) => a.setProposalReview(proposal.id, value)
  const setPreview = (value: AssistantToolPreview) => patch({ preview: value })
  const setExecution = (value: AssistantToolExecution) => patch({ execution: value })
  const setConfirmation = (value: AssistantConfirmation) => patch({ confirmation: value })
  const setCardBusy = (value: string | null) => patch({ busy: value })
  const setError = (value: string | null) => patch({ error: value })
  function acquire(kind: string) { if (a.proposalLocks.current.has(proposal.id) || busy) return false; a.proposalLocks.current.add(proposal.id); setCardBusy(kind); return true }
  function release() { a.proposalLocks.current.delete(proposal.id); setCardBusy(null) }
  const title = proposalText(proposal, 'title', proposal.tool_name.replace(/_/g, ' '))
  const description = proposalText(proposal, 'description', 'Review this proposed assistant action.')
  const gene = typeof proposal.arguments.gene_symbol === 'string'
    ? proposal.arguments.gene_symbol
    : typeof proposal.arguments.gene === 'string'
      ? proposal.arguments.gene
      : ''
  const experimentId = typeof proposal.arguments.experiment_id === 'number' ? proposal.arguments.experiment_id : null
  const isReadOnly = (proposal.tool_name === 'inspect_result' || proposal.tool_name === 'inspect_gene') && !proposal.result.side_effect
  const isCreateExperiment = proposal.tool_name === 'create_experiment'
  const isRunSimulation = proposal.tool_name === 'run_simulation'
  const isSideEffect = Boolean(proposal.result.side_effect)
  const canConfirm = isSideEffect && preview?.valid && preview.execution_enabled && !execution && !uncertain && confirmation?.status !== 'rejected'
  const facts = proposalFactRows(proposal)

  async function previewProposal() {
    if (uncertain || execution?.executed || confirmation?.status === 'used' || confirmation?.status === 'rejected' || !acquire('preview')) return
    const snapshot = JSON.parse(JSON.stringify(context)) as AssistantContext
    patch({ context: snapshot, conversationId, messageId: proposal.message_id, execution: null, confirmation: null })
    setError(null)
    try {
      const nextPreview = await previewAssistantTool(proposal.tool_name, { arguments: proposal.arguments, context: snapshot })
      setPreview(nextPreview)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      release()
    }
  }

  async function rejectProposal() {
    if (!preview?.valid || !isSideEffect) {
      onResolved(proposal.id, 'rejected')
      return
    }
    if (uncertain || !acquire('reject')) return
    setError(null)
    try {
      const pending = await createAssistantConfirmation({
        action: proposal.tool_name,
        payload: preview.normalized_arguments,
        conversation_id: conversationId,
        tool_call_id: proposal.id,
      })
      const rejected = await resolveAssistantConfirmation(pending.id, {
        status: 'rejected',
        note: 'Rejected from assistant proposal card.',
      })
      setConfirmation(rejected)
      onResolved(proposal.id, 'rejected')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      release()
    }
  }

  async function confirmAndExecuteProposal() {
    if (!preview?.valid || !isSideEffect || cardBusy) return
    if (!canConfirm || !acquire('execute')) return
    let executionRequested = false
    setError(null)
    try {
      const pending = await createAssistantConfirmation({
        action: proposal.tool_name,
        payload: preview.normalized_arguments,
        conversation_id: conversationId,
        tool_call_id: proposal.id,
      })
      const approved = await resolveAssistantConfirmation(pending.id, {
        status: 'approved',
        note: 'Approved from assistant proposal card.',
      })
      setConfirmation(approved)
      executionRequested = true
      patch({ uncertain: true })
      const result = await executeAssistantTool(proposal.tool_name, {
        arguments: preview.normalized_arguments,
        context: review.context!,
        conversation_id: conversationId,
        confirmation_id: approved.id,
      })
      patch({ uncertain: false })
      setExecution(result)
      if (result.executed) {
        onResolved(proposal.id, 'executed')
      }
    } catch (err) {
      patch({ uncertain: executionRequested })
      setError(executionRequested ? 'Execution outcome is uncertain. Check the saved records before taking another action.' : err instanceof Error ? err.message : String(err))
    } finally {
      release()
    }
  }

  async function reconcile() {
    if (!acquire('reconcile')) return
    try {
      const [confirmations, calls] = await Promise.all([getAssistantConfirmations({ conversation_id: conversationId ?? undefined }), getAssistantToolCalls({ conversation_id: conversationId ?? undefined })])
      const record = confirmations.find(c => c.id === confirmation?.id)
      if (record?.status === 'used') {
        const usedId = record.note.match(/Used by assistant tool call (\d+)/)?.[1]
        const call = calls.find(c => c.id === Number(usedId) && c.status === 'executed')
        if (call && preview) { setExecution({ tool_name: call.tool_name, executed: true, status: call.status, requires_confirmation: true, confirmation_id: record.id, tool_call_id: call.id, provenance_id: null, normalized_arguments: call.arguments, result: call.result, warnings: [], errors: [] }); patch({ uncertain: false, error: null }); onResolved(proposal.id, 'executed') }
        else setError('Approval was used. Open Activity to inspect the recorded outcome. This action cannot be retried.')
      } else setError('Saved records do not yet establish the execution outcome. Retry remains disabled; check Activity or refresh records again.')
    } catch (err) { setError(`Records could not be checked: ${err instanceof Error ? err.message : String(err)}`) }
    finally { release() }
  }

  const secondaryActionClasses = darkMode
    ? 'border-slate-600 bg-slate-900 text-slate-200 hover:bg-slate-800'
    : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'

  return (
    <div
      data-testid="proposal-card"
      data-tool={proposal.tool_name}
      className={`rounded-lg border p-3 ${
        darkMode
          ? 'border-slate-700 bg-[#0b0f16] shadow-none'
          : 'border-gray-100 bg-gray-50 shadow-sm'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className={`break-words text-sm font-semibold ${darkMode ? 'text-slate-100' : 'text-gray-900'}`}>{title}</div>
          <div className={`mt-1 break-words text-xs leading-5 ${darkMode ? 'text-slate-400' : 'text-gray-500'}`}>{description}</div>
        </div>
        <StatusPill tone={proposalKind(proposal)}>
          {proposal.result.side_effect ? 'needs confirmation' : 'read-only'}
        </StatusPill>
      </div>
      {facts.length > 0 && !preview && (
        <dl className={`mt-3 grid gap-2 rounded-md border p-3 text-xs sm:grid-cols-2 ${
          darkMode ? 'border-slate-700 bg-slate-900/60' : 'border-gray-100 bg-white'
        }`}>
          {facts.map((fact) => (
            <div key={`${proposal.id}-${fact.label}`} className="min-w-0">
              <dt className={`font-semibold uppercase tracking-wide ${darkMode ? 'text-slate-400' : 'text-gray-500'}`}>{fact.label}</dt>
              <dd className={`mt-1 truncate ${darkMode ? 'text-slate-200' : 'text-gray-800'} ${fact.mono ? 'font-mono' : ''}`}>{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <StatusPill tone="neutral">{proposalSourceLabel(proposal)}</StatusPill>
        {isReadOnly && (
          <button
            type="button"
            onClick={() => onRunReadOnly(proposal)}
            disabled={busy}
            className="rounded-md border border-brand-200 bg-brand-50 px-3 py-1.5 text-xs font-medium text-brand-700 hover:bg-brand-100 disabled:opacity-50"
          >
            {busy ? 'Inspecting...' : 'Run read-only inspection'}
          </button>
        )}
        {isSideEffect && (
          <button
            type="button"
            data-testid="proposal-preview"
            onClick={previewProposal}
            disabled={busy || uncertain || Boolean(execution?.executed) || confirmation?.status === 'rejected' || Boolean(cardBusy)}
            className={`rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-50 ${secondaryActionClasses}`}
          >
            {cardBusy === 'preview' ? 'Previewing...' : preview ? 'Refresh preview' : isCreateExperiment ? 'Preview draft' : 'Preview'}
          </button>
        )}
        {isCreateExperiment && (
          <Link
            to={`/experiments/new${gene ? `?gene=${encodeURIComponent(gene)}` : ''}`}
            className={`rounded-md border px-3 py-1.5 text-xs font-medium ${secondaryActionClasses}`}
          >
            Open Experiment Designer
          </Link>
        )}
        {isRunSimulation && experimentId != null && (
          <Link
            to={`/experiments?experiment=${experimentId}`}
            className={`rounded-md border px-3 py-1.5 text-xs font-medium ${secondaryActionClasses}`}
          >
            Review experiment
          </Link>
        )}
      </div>
      {preview && (
        <div className={`mt-3 rounded-md border p-3 ${
          darkMode ? 'border-slate-700 bg-slate-900/60' : 'border-gray-100 bg-white'
        }`}>
          <ToolReviewPanel title="Proposal preview" preview={preview} execution={execution} embedded darkMode={darkMode} />
        </div>
      )}
      {isSideEffect && preview && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="proposal-confirm"
            onClick={confirmAndExecuteProposal}
            disabled={busy || !canConfirm || Boolean(cardBusy)}
            className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          >
            {cardBusy === 'execute' ? 'Executing...' : confirmButtonLabel(proposal.tool_name)}
          </button>
          <button
            type="button"
            data-testid="proposal-reject"
            onClick={rejectProposal}
            disabled={busy || uncertain || Boolean(cardBusy) || confirmation?.status === 'rejected' || Boolean(execution?.executed)}
            className={`rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-50 ${secondaryActionClasses}`}
          >
            {cardBusy === 'reject' ? 'Rejecting...' : 'Reject'}
          </button>
          {confirmation && (
            <StatusPill tone={confirmation.status === 'approved' || confirmation.status === 'used' ? 'ready' : confirmation.status === 'rejected' ? 'blocked' : 'planned'}>
              {confirmation.status}
            </StatusPill>
          )}
        </div>
      )}
      {preview && <p className="mt-2 text-xs text-gray-500">Review uses the page context captured when you previewed this action.</p>}
      {preview && <details className="mt-2 text-xs text-gray-500"><summary className="cursor-pointer">Captured page context</summary><pre className="mt-2 max-h-60 overflow-auto font-mono">{JSON.stringify(review.context, null, 2)}</pre></details>}
      {uncertain && <button className="assistant-button mt-3" disabled={Boolean(cardBusy)} onClick={() => void reconcile()}>Check execution records</button>}
      {error && (
        <div role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">{error}</div>
      )}
    </div>
  )
}
