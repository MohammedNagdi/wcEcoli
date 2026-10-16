import { useId, useRef, useState } from 'react'
import { ExperimentActionPopup } from './ExperimentPresentation'
import { variantLabel, statusLabel } from '../../utils/labels'
import { WorkspaceHelp } from '../workspace/WorkspaceHelp'

export const ACTIVE_STATUSES = ['pending', 'claimed', 'queued', 'running', 'waiting_parca', 'running_parca', 'running_sim', 'ingesting', 'cancelling', 'recovering']
export const isExperimentActive = (status: string) => ACTIVE_STATUSES.includes(status)
export const statusGroup = (status: string) => ['running_parca', 'running_sim', 'ingesting', 'claimed', 'waiting_parca', 'cancelling', 'recovering'].includes(status) ? 'running' : status === 'pending' ? 'queued' : status
export type CatalogFilters = { query: string; status: string; type: string; condition: string }
export const EMPTY_FILTERS: CatalogFilters = { query: '', status: '', type: '', condition: '' }

export function ExperimentStatus({ status }: { status: string }) {
  const group = statusGroup(status)
  const color = group === 'done' ? 'bg-green-50 text-green-700' : group === 'failed' ? 'bg-red-50 text-red-700' : group === 'queued' ? 'bg-yellow-50 text-yellow-700' : group === 'running' ? 'bg-blue-50 text-blue-700' : 'bg-gray-100 text-gray-600'
  return <span data-status={group} className={`experiment-status inline-flex whitespace-nowrap items-center gap-1.5 rounded px-2 py-1 text-xs font-medium ${color}`}><span aria-hidden="true">{group === 'done' ? '✓' : group === 'failed' ? '!' : '●'}</span>{statusLabel(status)}</span>
}

export function ExperimentControls({ label, filters, onChange, types, conditions, count, total, statusLabel: statusTitle = 'Status', failed = false, polished = true }: {
  label: string; filters: CatalogFilters; onChange: (filters: CatalogFilters) => void; types: string[]; conditions: string[]; count: number; total: number; statusLabel?: string; failed?: boolean; polished?: boolean
}) {
  const id = useId()
  const field = (key: keyof CatalogFilters, value: string) => onChange({ ...filters, [key]: value })
  const hasFilters = Object.values(filters).some(Boolean)
  const statusCaption = <><label htmlFor={`${id}-status`}>{statusTitle}</label> <WorkspaceHelp label="Experiment status">Queued jobs are waiting to run. Running includes preparation, simulation, result ingestion, stopping, and recovery. A batch can contain several states.</WorkspaceHelp></>
  return <section className="experiment-toolbar" aria-label={`${label} controls`}>
    <label className="block text-sm font-medium text-gray-700" htmlFor={`${id}-search`}>{label}</label>
    <div className={polished ? "experiment-search-row" : "flex gap-2"}>
      <input id={`${id}-search`} type="search" value={filters.query} onChange={(event) => field('query', event.target.value)} placeholder="Name, gene, condition, type, or protocol" className="experiment-input flex-1 min-w-0" />
      {hasFilters && <button className="experiment-button" onClick={() => onChange({ ...EMPTY_FILTERS })}>Clear filters</button>}
    </div>
    <div className={polished ? "experiment-filter-grid" : "flex flex-wrap items-end gap-3"}>
      {!failed && <div className="experiment-filter">{polished ? <div className="experiment-filter-caption">{statusCaption}</div> : statusCaption}<select id={`${id}-status`} aria-label={statusTitle} value={filters.status} onChange={(event) => field('status', event.target.value)} className="experiment-input"><option value="">All statuses</option>{['draft', 'queued', 'running', 'done', 'failed', 'cancelled'].map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}</select></div>}
      <label className="experiment-filter">Experiment type<select aria-label="Experiment type" value={filters.type} onChange={(event) => field('type', event.target.value)} className="experiment-input"><option value="">All types</option>{[...new Set(types)].sort().map((type) => <option key={type} value={type}>{variantLabel(type)}</option>)}</select></label>
      <label className="experiment-filter">Condition<select aria-label="Condition" value={filters.condition} onChange={(event) => field('condition', event.target.value)} className="experiment-input"><option value="">All conditions</option>{[...new Set(conditions)].filter(Boolean).sort().map((condition) => <option key={condition} value={condition}>{condition}</option>)}</select></label>
      <p className="text-sm text-gray-500 pb-2" role="status">Showing {count} of {total}</p>
    </div>
  </section>
}

export function RequestNotice({ error, retry }: { error: string | null; retry: () => void }) {
  return error ? <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 flex flex-wrap items-center gap-3"><span>{error}</span><button onClick={retry} className="experiment-button">Retry</button></div> : null
}

export function DeleteMenu({ label, onDelete }: { label: string; onDelete: () => void }) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  return <div ref={anchor} className="experiment-menu" onClick={event => event.stopPropagation()}>
    <button type="button" aria-label={`More actions for ${label}`} aria-expanded={open}
      className="experiment-button min-w-10" onClick={() => setOpen(value => !value)}>•••</button>
    {open && <ExperimentActionPopup anchor={anchor} label={`Actions for ${label}`} onClose={() => setOpen(false)}>
      <button type="button" className="text-red-700" onClick={() => { setOpen(false); onDelete() }}>Delete</button>
    </ExperimentActionPopup>}
  </div>
}
