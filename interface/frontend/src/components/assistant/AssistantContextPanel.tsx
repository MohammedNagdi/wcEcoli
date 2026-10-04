import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAssistant } from './AssistantProvider'
import { MessageMarkdown } from './AssistantMarkdown'
import { contextSummary } from './assistantPresentation'
import { AssistantNotice } from './AssistantUI'
import { ConfirmDialog } from '../common/ConfirmDialog'

export function AssistantContextPanel() {
  const { context, memory, memoryError, memoryLoading, refreshMemory, clearMemory, inspecting, inspectCurrentResult, resolvedNote } = useAssistant()
  const [clear, setClear] = useState(false)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [error, setError] = useState('')
  const hasMemory = Boolean(memory?.summary || memory?.remembered_genes.length)
  return <details className="assistant-context">
    <summary><span>Current page context</span><span className="assistant-context-summary">{context.selected_gene ?? (context.selected_job != null ? `Job #${context.selected_job}` : 'Page context')}</span></summary>
    <div className="assistant-context-body">
      <p>{contextSummary(context)}</p>
      <div className="assistant-context-links">
        {context.selected_gene && <Link to={`/explore?gene=${encodeURIComponent(context.selected_gene)}`}>Gene {context.selected_gene}</Link>}
        {context.selected_experiment != null && <Link to={`/experiments?experiment=${context.selected_experiment}`}>Experiment #{context.selected_experiment}</Link>}
        {context.selected_job != null && <button className="assistant-button" disabled={inspecting} onClick={() => void inspectCurrentResult()}>{inspecting ? 'Inspecting…' : `Inspect current result (Job #${context.selected_job})`}</button>}
        {context.selected_condition && <span>Condition: {context.selected_condition}</span>}
      </div>
      <details className="assistant-memory"><summary>Conversation memory{memoryError ? ' · unavailable' : memoryLoading ? ' · loading' : hasMemory ? '' : ' · empty'}</summary><div>
        {memory?.summary && <MessageMarkdown messageKey="conversation-memory" text={memory.summary} />}
        {memory?.remembered_genes.map(gene => <span className="assistant-chip" key={gene}>{gene}</span>)}
        {memoryLoading && <p role="status">Loading conversation memory…</p>}
        {memoryError && <AssistantNotice retry={() => void refreshMemory()}>{memoryError}</AssistantNotice>}
        {!memoryLoading && !memoryError && !hasMemory && <p>No summary has been saved for this conversation.</p>}
        {hasMemory && !memoryError && <button className="assistant-button" onClick={() => setClear(true)}>Clear memory</button>}
        {feedback && <span role="status">{feedback}</span>}
        {error && <AssistantNotice>{error}</AssistantNotice>}
      </div></details>
    </div>
    <ConfirmDialog open={clear} title="Clear conversation memory?" message="Forget the saved summary and remembered genes. Saved messages remain available." confirmLabel="Clear memory" busy={busy} onCancel={() => setClear(false)} onConfirm={async () => { setBusy(true); setError(''); try { await clearMemory(); setClear(false); setFeedback('Conversation memory cleared.') } catch { setError('Memory could not be cleared. Please try again.') } finally { setBusy(false) } }} />
    {resolvedNote && <span role="status" className="assistant-resolved-note">{resolvedNote}</span>}
  </details>
}
