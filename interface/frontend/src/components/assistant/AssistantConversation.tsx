import { useLayoutEffect, useState } from 'react'
import { useAssistant } from './AssistantProvider'
import { AssistantComposer } from './AssistantComposer'
import { AssistantContextPanel } from './AssistantContextPanel'
import { GroundedToolResults, ToolReviewPanel } from './AssistantEvidence'
import { AssistantProposalCard } from './AssistantProposalCard'
import { MessageMarkdown } from './AssistantMarkdown'
import { messageStatusLabel, starterPrompts } from './assistantPresentation'
import { AssistantNotice } from './AssistantUI'
import type { AssistantToolCall } from '../../types'

function CopyAnswer({ text }: { text: string }) {
  const [label, setLabel] = useState('Copy answer')
  return <button className="assistant-copy" onClick={async () => { try { await navigator.clipboard.writeText(text); setLabel('Copied') } catch { setLabel('Copy unavailable') } }} aria-label={label}>{label}</button>
}

function ActivityDetails({ segments }: { segments: string[] }) {
  if (!segments.length) return null
  return <details className="assistant-turn-activity" data-testid="thinking-block"><summary>Activity details · {segments.length} {segments.length === 1 ? 'update' : 'updates'}</summary><div>{segments.map((text, index) => <p key={index}>{text}</p>)}</div></details>
}

function ProposalGroup({ proposals }: { proposals: AssistantToolCall[] }) {
  const a = useAssistant()
  const [count, setCount] = useState(3)
  if (!proposals.length) return null
  return <section className="assistant-proposals" data-testid="chat-proposals" aria-label="Actions awaiting your review">
    <div className="assistant-proposals-heading"><h3>Actions awaiting your review</h3><span>{proposals.length}</span></div>
    {proposals.slice(0, count).map(proposal => <AssistantProposalCard key={proposal.id} proposal={proposal} context={a.context} conversationId={a.activeConversation?.id ?? null} busy={a.inspecting || a.sending} darkMode={false} onRunReadOnly={a.runReadOnlyProposal} onResolved={a.handleProposalResolved} />)}
    {count < proposals.length && <button className="assistant-button" onClick={() => setCount(current => current + 3)}>Show more actions ({proposals.length - count})</button>}
  </section>
}

export function AssistantConversation({ openSettings }: { openSettings: () => void }) {
  const a = useAssistant()
  const [showJump, setShowJump] = useState(false)
  const key = String(a.activeConversation?.id ?? 'new')
  useLayoutEffect(() => {
    const el = a.scrollRef.current
    if (!el || a.messageLoading) return
    const position = a.scrollPositions.current[key]
    el.scrollTop = position ?? el.scrollHeight
    a.followLatestRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    setShowJump(!a.followLatestRef.current)
    return () => { a.scrollPositions.current[key] = el.scrollTop }
  }, [key, a.messageLoading])
  const messageIds = new Set(a.messages.map(m => m.id))
  const unattached = a.proposals.filter(p => p.message_id == null || !messageIds.has(p.message_id))
  function onScroll() {
    const el = a.scrollRef.current
    if (!el || a.messageLoading) return
    a.followLatestRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    a.scrollPositions.current[key] = el.scrollTop
    setShowJump(!a.followLatestRef.current)
  }
  return <div className="assistant-chat">
    <div className="assistant-conversation-heading"><span className="assistant-eyebrow">Scientific workbench</span><h2>{a.activeConversation?.title ?? 'New chat'}</h2></div>
    <AssistantContextPanel />
    {a.statusError ? <AssistantNotice retry={() => void a.refreshAssistantStatus()}>Assistant status unavailable: {a.statusError}</AssistantNotice> : a.statusLoading ? <AssistantNotice tone="neutral">Checking assistant availability…</AssistantNotice> : !a.selectionAvailable ? <AssistantNotice tone="neutral"><span>{a.providerConfigured || a.providerModelOptions.length ? 'This conversation’s model is unavailable. Choose a configured model.' : 'Configure a provider to start chatting.'} <button className="assistant-text-button" onClick={openSettings}>Open settings</button></span></AssistantNotice> : null}
    <div className="assistant-messages" data-testid="assistant-scroll-region" ref={a.scrollRef} onScroll={onScroll}>
      {a.messageLoading && <p className="assistant-muted" role="status">Loading messages…</p>}
      {a.messageError && <AssistantNotice retry={() => void a.reloadMessages()}>{a.messageError}</AssistantNotice>}
      {(a.inspectPreview || a.inspectExecution) && <ToolReviewPanel title="Read-only result inspection" preview={a.inspectPreview} execution={a.inspectExecution} />}
      {!a.messageLoading && !a.messageError && !a.messages.length && !a.sending && !a.interruptedTurn && <div className="assistant-empty">
        <div className="assistant-empty-mark" aria-hidden="true">✦</div>
        <h3>What would you like to understand?</h3><p>Explore a gene, interpret a result, or prepare an experiment.</p>
        <div>{starterPrompts(a.context).map(prompt => <button className="assistant-starter" key={prompt} onClick={() => { a.setInput(prompt); a.scrollRef.current?.closest('.assistant-chat')?.querySelector<HTMLTextAreaElement>('textarea')?.focus() }}>{prompt}<span aria-hidden="true">↗</span></button>)}</div>
      </div>}
      {!a.messageLoading && a.messages.map(message => <article className={`assistant-message assistant-message--${message.role === 'user' ? 'user' : 'answer'}`} key={message.id}>
        <div className="assistant-message-meta"><span>{message.role === 'user' ? 'You' : 'Assistant'}</span>{!['stored', 'completed'].includes(message.status) && <span>{messageStatusLabel(message.status)}</span>}</div>
        {message.role !== 'user' && <ActivityDetails segments={a.messageThinking[message.id] ?? []} />}
        <div data-testid={message.role === 'user' ? 'message-user' : 'message-assistant'} className="assistant-message-content">{message.role === 'user' ? message.content : <MessageMarkdown messageKey={`${key}-${message.id}`} text={message.content || (message.status === 'failed' ? 'Message could not be sent.' : '')} />}</div>
        {message.role !== 'user' && <>
          {a.messageToolResults[message.id]?.length > 0 && <GroundedToolResults entries={a.messageToolResults[message.id]} />}
          {Object.entries(a.proposalReviews).filter(([id, review]) => review.conversationId === a.activeConversation?.id && review.messageId === message.id && review.execution?.executed && !a.proposals.some(p => p.id === Number(id))).map(([id, review]) => <ToolReviewPanel key={id} title="Action outcome" preview={null} execution={review.execution} />)}
          <CopyAnswer text={message.content} />
          <ProposalGroup proposals={a.proposals.filter(p => p.message_id === message.id)} />
        </>}
      </article>)}
      {!a.messageLoading && <ProposalGroup proposals={unattached} />}
      {a.sending && <div className="assistant-live-turn">
        <ActivityDetails segments={a.thinkingSegments} />
        {a.streamingTool && <div className="assistant-tool-chip" role="status">Tool activity: {a.streamingTool.replace(/_/g, ' ')}</div>}
        {a.streamingText ? <div className="assistant-message assistant-message--answer"><div className="assistant-message-meta">Assistant · responding</div><div className="assistant-message-content"><MessageMarkdown messageKey={`${key}-live`} mode="streaming" text={a.streamingText} /></div></div> : <p className="assistant-muted" role="status">{a.turnState === 'tool' ? 'Working with platform data…' : 'Waiting for a response…'}</p>}
      </div>}
      {a.interruptedTurn && <div className="assistant-interrupted">
        <strong>{a.interruptedTurn.status === 'stopped' ? 'Stopped' : 'Interrupted'}</strong>
        {a.interruptedTurn.text && <div className="assistant-message-content"><MessageMarkdown messageKey={`${key}-partial`} mode="partial" text={a.interruptedTurn.text} /></div>}
        <p>{a.interruptedTurn.status === 'stopped' ? 'Response display stopped. This does not cancel simulation jobs.' : 'The response ended before completion. Your message will not be resent automatically.'}</p>
        <button className="assistant-button" disabled={a.messageLoading || a.sending} onClick={() => void a.reloadMessages()}>Reload stored messages</button>
      </div>}
      {a.compactionNotice && !a.sending && <p className="assistant-compaction" data-testid="assistant-compaction-notice">Summarized earlier turns to stay focused</p>}
      <div ref={a.bottomRef} />
    </div>
    {showJump && <button className="assistant-jump" data-testid="assistant-scroll-down" onClick={() => { const el = a.scrollRef.current; if (el) { a.followLatestRef.current = true; el.scrollTop = el.scrollHeight; setShowJump(false) } }}>↓ Jump to latest</button>}
    {a.resolvedNote && <div role="status" className="assistant-notice assistant-notice--neutral">{a.resolvedNote}</div>}
    <AssistantComposer />
  </div>
}
