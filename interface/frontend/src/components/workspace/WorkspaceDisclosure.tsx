import { useId, type ReactNode } from 'react'

/** Independently controlled sections, adapted from the inspected LN accordion pattern. */
export function WorkspaceDisclosure({
  title,
  summary,
  open,
  onToggle,
  help,
  children,
}: {
  title: string
  summary: string
  open: boolean
  onToggle: () => void
  help?: ReactNode
  children: ReactNode
}) {
  const id = useId()
  return (
    <section className="workspace-disclosure" data-open={open}>
      <div className="workspace-disclosure-heading">
        <h3>
          <button
            type="button"
            id={`${id}-button`}
            aria-expanded={open}
            aria-controls={id}
            onClick={onToggle}
          >
            <span>
              {title}
              <small>{summary}</small>
            </span>
            <svg
              aria-hidden="true"
              className="workspace-chevron"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path d="m5 7 5 5 5-5" />
            </svg>
          </button>
        </h3>
        {help}
      </div>
      <div
        className="workspace-disclosure-grid"
        aria-hidden={!open}
        {...(!open ? { inert: '' } : {})}
      >
        <div className="workspace-disclosure-clip">
          <div
            id={id}
            role="region"
            aria-labelledby={`${id}-button`}
            className="workspace-disclosure-body"
          >
            {children}
          </div>
        </div>
      </div>
    </section>
  )
}
