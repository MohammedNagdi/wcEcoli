import type { ReactNode } from 'react'
import { useAssistant } from './AssistantProvider'

/**
 * Drop-in replacement for the old `<Link to={assistantHref}>` entry points. Instead of navigating
 * to /assistant (losing the page), it opens the docked Assistant with that page's context+prompt,
 * so the page stays visible beside the chat. The hook lives inside this component, so pages just
 * swap the element — no per-page hooks, no rules-of-hooks concerns.
 */
export function AskAssistantButton({
  href,
  className,
  children,
  title,
}: {
  href: string
  className?: string
  children: ReactNode
  title?: string
}) {
  const { openAssistantWithHref } = useAssistant()
  return (
    <button
      type="button"
      data-testid="ask-assistant"
      title={title}
      className={className}
      onClick={() => openAssistantWithHref(href)}
    >
      {children}
    </button>
  )
}
