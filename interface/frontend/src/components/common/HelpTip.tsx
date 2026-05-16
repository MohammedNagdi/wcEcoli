import { useState, useRef, useEffect, type ReactNode } from 'react'

/**
 * Inline contextual-help tooltip. Shows a small "?" icon that reveals
 * an explanation on hover/click.  Designed for biology/comp-sci audience.
 */
export function HelpTip({
  text,
  position = 'top',
  className = '',
}: {
  text: string
  position?: 'top' | 'bottom' | 'left' | 'right'
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const positionClasses: Record<string, string> = {
    top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
    bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
    left: 'right-full top-1/2 -translate-y-1/2 mr-2',
    right: 'left-full top-1/2 -translate-y-1/2 ml-2',
  }

  return (
    <span ref={ref} className={`relative inline-flex items-center ${className}`}>
      <button
        onClick={() => setOpen(!open)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        className="inline-flex items-center justify-center w-4 h-4 rounded-full
                   bg-gray-200 hover:bg-gray-300 text-gray-500 hover:text-gray-700
                   text-[10px] font-bold leading-none transition-colors cursor-help
                   focus:outline-none focus:ring-2 focus:ring-brand-500/30"
        aria-label="More info"
      >
        ?
      </button>
      {open && (
        <span
          className={`absolute z-50 w-64 px-3 py-2.5 rounded-lg shadow-lg border border-gray-200
                      bg-white text-xs text-gray-600 leading-relaxed ${positionClasses[position]}`}
        >
          {text}
        </span>
      )}
    </span>
  )
}

/**
 * A larger contextual note block for section-level explanations.
 */
export function HelpNote({
  children,
  variant = 'info',
}: {
  children: ReactNode
  variant?: 'info' | 'warning' | 'model-depth'
}) {
  const styles: Record<string, string> = {
    info: 'bg-blue-50 border-blue-200 text-blue-700',
    warning: 'bg-amber-50 border-amber-200 text-amber-700',
    'model-depth': 'bg-indigo-50 border-indigo-200 text-indigo-700',
  }

  const icons: Record<string, string> = {
    info: 'i',
    warning: '!',
    'model-depth': '~',
  }

  return (
    <div className={`rounded-lg border px-3 py-2.5 text-xs leading-relaxed flex gap-2 ${styles[variant]}`}>
      <span className="shrink-0 w-4 h-4 rounded-full bg-current/10 flex items-center justify-center text-[10px] font-bold mt-0.5">
        {icons[variant]}
      </span>
      <div>{children}</div>
    </div>
  )
}
