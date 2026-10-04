import type { ReactNode } from 'react'
import { useTheme } from '../theme/ThemeProvider'



export function StatusPill({ children, tone = 'neutral' }: { children: string; tone?: 'neutral' | 'ready' | 'blocked' | 'planned' }) {
  const { resolvedTheme } = useTheme()
  const darkMode = resolvedTheme === 'dark'
  const classes = darkMode
    ? {
      neutral: 'border-slate-700 bg-slate-800 text-slate-300',
      ready: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
      blocked: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
      planned: 'border-violet-400/30 bg-violet-400/10 text-violet-200',
    }
    : {
      neutral: 'border-gray-200 bg-gray-50 text-gray-600',
      ready: 'border-emerald-200 bg-emerald-50 text-emerald-700',
      blocked: 'border-amber-200 bg-amber-50 text-amber-800',
      planned: 'border-brand-200 bg-brand-50 text-brand-700',
    }
  return (
    <span className={`inline-flex items-center rounded-md border px-2.5 py-1 text-xs font-medium ${classes[tone]}`}>
      {children}
    </span>
  )
}

export function InfoTooltip({ label, text }: { label: string; text: string }) {
  return <details className="assistant-help"><summary aria-label={label}>i</summary><p>{text}</p></details>
}

export function Card({
  title,
  children,
}: {
  title: string
  issue?: string
  children: ReactNode
}) {
  return (
    <section className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
      <div className="mb-3 flex items-start justify-between gap-3">
        <h2 className="text-base font-semibold text-gray-900">{title}</h2>
      </div>
      {children}
    </section>
  )
}
