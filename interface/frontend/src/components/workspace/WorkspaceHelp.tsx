import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import {IS_EXPLORER} from '../../explorer/mode'
import {guideTopicHref,type GuideTopicId} from '../../explorer/guideLinks'

export const WORKSPACE_HELP = {
  mechanistic:
    'Mechanistic genes are connected to downstream processes represented in this model, such as metabolism, replication, or regulation. This classification describes model coverage, not experimental essentiality.',
  expression:
    'Expression-only genes have RNA and protein expression represented, without a mechanistic connection to downstream processes in this model. A knockout can change expression without producing a modeled growth effect.',
  knockout:
    'The knockout index identifies the gene-specific simulation variant. The experiment designer sets it when you choose a gene. An em dash means no index is available; the index is not an essentiality score.',
  state:
    'Model state IDs identify the RNA, protein, complexes, and pathway metabolites used by the simulation. Use these identifiers to connect a gene to model output and molecule analysis.',
}

/** Short hints follow the Origin UI tooltip pattern; pinned help also works on touch. */
export function WorkspaceHelp({ label, children, guideTopic }: { label: string; children: string; guideTopic?:GuideTopicId }) {
  const id = useId()
  const root = useRef<HTMLSpanElement>(null)
  const panel = useRef<HTMLSpanElement>(null)
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>()
  const [position, setPosition] = useState({ left: 16, top: 0 })
  const button = useRef<HTMLButtonElement>(null)
  const [hovered, setHovered] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const open = !dismissed && (hovered || pinned)

  useEffect(() => () => clearTimeout(leaveTimer.current), [])
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const rect = button.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(320, window.innerWidth - 32)
      const height = panel.current?.offsetHeight ?? 180
      setPosition({
        left: Math.max(16, Math.min(window.innerWidth - width - 16, rect.left - 12)),
        top:
          rect.bottom + height + 12 > window.innerHeight
            ? Math.max(8, rect.top - height - 8)
            : rect.bottom + 8,
      })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      if (
        !root.current?.contains(event.target as Node) &&
        !panel.current?.contains(event.target as Node)
      ) {
        setPinned(false)
        setHovered(false)
      }
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])

  return (
    <span
      ref={root}
      className="workspace-help"
      onMouseEnter={() => {
        clearTimeout(leaveTimer.current)
        setHovered(true)
        setDismissed(false)
      }}
      onMouseLeave={() => {
        leaveTimer.current = setTimeout(() => setHovered(false), 160)
      }}
      onBlur={(event) => {
        if (
          !event.currentTarget.contains(event.relatedTarget) &&
          !panel.current?.contains(event.relatedTarget)
        ) {
          setPinned(false)
          setHovered(false)
          setDismissed(false)
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'Tab' && !event.shiftKey && open && event.target === button.current) {
          event.preventDefault()
          panel.current?.querySelector<HTMLAnchorElement>('a')?.focus()
        }
        if (event.key === 'Escape') {
          event.stopPropagation()
          setPinned(false)
          setHovered(false)
          setDismissed(true)
          button.current?.focus()
        }
      }}
    >
      <button
        ref={button}
        type="button"
        className="workspace-help-button"
        aria-label={`Help: ${label}`}
        aria-expanded={open}
        aria-controls={id}
        onFocus={() => setDismissed(false)}
        onClick={() => {
          const next = !pinned
          setPinned(next)
          setHovered(false)
          setDismissed(!next)
        }}
      >
        <span aria-hidden="true">?</span>
      </button>
      {createPortal(
        <span
          ref={panel}
          id={id}
          style={{ left: position.left, top: position.top }}
          onMouseEnter={() => {
            clearTimeout(leaveTimer.current)
            setHovered(true)
          }}
          onMouseLeave={() => {
            leaveTimer.current = setTimeout(() => setHovered(false), 160)
          }}
          onBlur={(event) => {
            if (
              !event.currentTarget.contains(event.relatedTarget) &&
              !root.current?.contains(event.relatedTarget)
            ) {
              setPinned(false)
              setHovered(false)
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Tab') {
              button.current?.focus()
              if (event.shiftKey) event.preventDefault()
              else {
                setPinned(false)
                setHovered(false)
                setDismissed(true)
              }
            }
            if (event.key === 'Escape') {
              event.stopPropagation()
              setPinned(false)
              setHovered(false)
              setDismissed(true)
              button.current?.focus()
            }
          }}
          className="workspace-help-content"
          data-open={open}
          role="region"
          aria-label={`${label} help`}
          aria-hidden={!open}
          {...(!open ? { inert: '' } : {})}
        >
          <strong>{label}</strong>
          <span>{children}</span>
          <Link to={IS_EXPLORER&&guideTopic?guideTopicHref(guideTopic):'/guide'}>Read the guide →</Link>
        </span>,
        document.body,
      )}
    </span>
  )
}
