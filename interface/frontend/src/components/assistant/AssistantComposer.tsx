import { useLayoutEffect, useRef } from 'react'
import { useAssistant } from './AssistantProvider'
import { ModelPill } from './AssistantModelPicker'
import { AssistantIcon, AssistantNotice } from './AssistantUI'

export function AssistantComposer() {
  const a = useAssistant()
  const region = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => { const el = region.current; if (!el) return; const observer = new ResizeObserver(() => el.closest<HTMLElement>('.assistant-chat')?.style.setProperty('--assistant-composer-height', `${el.offsetHeight}px`)); observer.observe(el); return () => observer.disconnect() }, [])
  const inputRef = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.style.height = '0px'
    input.style.height = `${Math.min(160, Math.max(48, input.scrollHeight))}px`
    input.style.overflowY = input.scrollHeight > 160 ? 'auto' : 'hidden'
  }, [a.input])
  const disabled = a.runtimeChanging || !a.input.trim() || !a.selectionAvailable || a.messageLoading || Boolean(a.messageError) || Boolean(a.interruptedTurn && !a.interruptedTurn.reconciled)
  return <div className="assistant-composer-region" ref={region}>
    {a.error && <AssistantNotice>{a.error}</AssistantNotice>}
    <form className="assistant-composer" onSubmit={e => { e.preventDefault(); void a.sendMessage() }}>
      <label htmlFor="assistant-chat-input" className="sr-only">Assistant message</label>
      <textarea ref={inputRef} id="assistant-chat-input" data-testid="assistant-input" rows={1} value={a.input} placeholder="Ask about a gene, experiment, or result…" onChange={e => a.setInput(e.target.value)} onKeyDown={e => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing && (!e.shiftKey || e.ctrlKey || e.metaKey)) { e.preventDefault(); void a.sendMessage() }
      }} />
      <div className="assistant-composer-controls">
        <ModelPill options={a.providerModelOptions} providerId={a.selectedProviderId} model={a.selectedModel} available={a.selectionAvailable} disabled={a.sending || a.runtimeChanging} onSelect={(provider, model) => void a.selectConversationRuntime(provider, model)} />
        {a.sending ? <button type="button" data-testid="assistant-stop" className="assistant-button" onClick={a.stopStreaming}><span aria-hidden="true">■</span> Stop response</button> : <button data-testid="assistant-send" className="assistant-button assistant-button--primary" disabled={disabled}><AssistantIcon name="arrow" size={16} /> Send</button>}
      </div>
    </form>
    <div className="assistant-composer-help">Enter to send · Shift+Enter for a new line</div>
  </div>
}
