import { useState, useEffect, useRef } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { AskAssistantButton } from '../assistant/AskAssistantButton'
import { getJobs, getExperiments, getExperimentResults, compareExperiments, deleteExperiment } from '../../api/client'
import { variantLabel, statusLabel } from '../../utils/labels'
import { assistantHref as buildAssistantHref } from '../../utils/assistantLinks'
import { SearchInput } from '../common/SearchInput'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { BatchDashboard } from '../experiments/BatchDashboard'
import type { SimulationJob, Experiment, ExperimentAggregation, ComparisonDelta } from '../../types'

const JOB_STATUS_COLORS: Record<string, string> = {
  pending:       'bg-yellow-50 text-yellow-700',
  running_parca: 'bg-blue-50 text-blue-700',
  running_sim:   'bg-blue-50 text-blue-700',
  ingesting:     'bg-purple-50 text-purple-700',
  done:          'bg-green-50 text-green-700',
  failed:        'bg-red-50 text-red-700',
}

type ViewMode = 'experiments' | 'jobs' | 'batches'
type DatePreset = 'any' | 'today' | '7d' | '30d' | 'custom'

const NO_TIMELINE = '__no_timeline__'

function validView(value: string | null): ViewMode {
  if (value === 'jobs' || value === 'batches') return value
  return 'experiments'
}

function timelineLabel(value: string | null | undefined): string {
  const timeline = (value || '').trim()
  return timeline || 'No time-varying protocol'
}

function timelineValue(value: string | null | undefined): string {
  const timeline = (value || '').trim()
  return timeline || NO_TIMELINE
}

function protocolLabel(exp: Experiment): string {
  return timelineLabel(exp.timeline)
}

function batchLabel(exp: Experiment): string {
  return exp.description?.trim() || exp.name?.trim() || 'Batch'
}

function viewLabel(viewMode: ViewMode): string {
  if (viewMode === 'jobs') return 'Job diagnostics'
  if (viewMode === 'batches') return 'Batches'
  return 'Experiment outcomes'
}

function viewDescription(viewMode: ViewMode): string {
  if (viewMode === 'jobs') return 'Individual job status, timing, errors, and result links.'
  if (viewMode === 'batches') return 'Batch experiment groups and run controls.'
  return 'Biological outcomes grouped by experiment, condition, timeline, and seed set.'
}

function resultIdentity(exp: Experiment): string {
  if (!exp.batch_id) return exp.name
  if (exp.gene_symbol) return exp.gene_symbol
  if (exp.variant_type === 'wildtype') return 'Wildtype'
  return `${variantLabel(exp.variant_type)} #${exp.variant_index}`
}

function experimentSearchText(exp: Experiment, jobs: SimulationJob[] = []): string {
  return [
    exp.name,
    resultIdentity(exp),
    batchLabel(exp),
    exp.description,
    exp.gene_symbol,
    exp.variant_type,
    variantLabel(exp.variant_type),
    String(exp.variant_index ?? ''),
    exp.condition,
    protocolLabel(exp),
    exp.variant_type === 'wildtype' ? 'control baseline wt' : '',
    ...jobs.map((job) => job.status),
    ...jobs.map((job) => statusLabel(job.status)),
  ].filter(Boolean).join(' ').toLowerCase()
}

function toDateInputValue(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function matchesDatePreset(date: Date | null, preset: DatePreset, customDate: string): boolean {
  if (preset === 'any') return true
  if (!date) return false

  const start = new Date()
  start.setHours(0, 0, 0, 0)

  if (preset === 'today') return date >= start
  if (preset === '7d') {
    start.setDate(start.getDate() - 6)
    return date >= start
  }
  if (preset === '30d') {
    start.setDate(start.getDate() - 29)
    return date >= start
  }
  if (preset === 'custom') {
    if (!customDate) return true
    return toDateInputValue(date) === customDate
  }
  return true
}

function latestJobDate(jobs: SimulationJob[], exp?: Experiment): Date | null {
  let latest: Date | null = null
  for (const job of jobs) {
    const candidate = parseDate(job.started_at) ?? parseDate(job.created_at)
    if (candidate && (!latest || candidate > latest)) latest = candidate
  }
  return latest ?? parseDate(exp?.created_at)
}

function MetricWithCI({ metric, unit, decimals = 1, transform }: {
  metric: { mean: number | null; std: number | null; ci_lower: number | null; ci_upper: number | null; n: number }
  unit: string
  decimals?: number
  transform?: (v: number) => number
}) {
  const t = transform ?? ((v: number) => v)
  if (metric.mean == null) return <span className="text-gray-300">{'-'}</span>
  const meanStr = t(metric.mean).toFixed(decimals)
  if (metric.n < 2 || metric.std == null) {
    return <span className="font-mono">{meanStr} {unit}</span>
  }
  const ciL = metric.ci_lower != null ? t(metric.ci_lower).toFixed(decimals) : '?'
  const ciH = metric.ci_upper != null ? t(metric.ci_upper).toFixed(decimals) : '?'
  return (
    <span className="font-mono" title={'95% CI: [' + ciL + ', ' + ciH + '], n=' + metric.n}>
      {meanStr} <span className="text-gray-400">{'+/-'} {t(metric.std).toFixed(decimals)}</span>
      <span className="text-gray-300 text-[10px] ml-1">{unit}</span>
    </span>
  )
}

function DeltaIndicator({ pct, label }: { pct: number | null; label: string }) {
  if (pct == null) return null
  const isNeutral = Math.abs(pct) < 2
  const isPositive = pct > 0
  const color = isNeutral ? 'text-gray-500' : isPositive ? 'text-amber-600' : 'text-blue-600'
  const arrow = isNeutral ? '~' : isPositive ? 'up' : 'down'
  return (
    <span className={`text-xs font-medium ${color}`} title={`${label}: ${pct > 0 ? '+' : ''}${pct.toFixed(1)}% vs wildtype`}>
      {arrow}{Math.abs(pct).toFixed(1)}%
    </span>
  )
}

function ExperimentCard({
  exp,
  jobs,
  showExperimentId,
  onDelete,
}: {
  exp: Experiment
  jobs: SimulationJob[]
  showExperimentId: boolean
  onDelete: (experiment: Experiment) => void
}) {
  const [agg, setAgg] = useState<ExperimentAggregation | null>(null)
  const [wtDelta, setWtDelta] = useState<ComparisonDelta | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const doneJobs = jobs.filter((j) => j.status === 'done')
  const failedJobs = jobs.filter((j) => j.status === 'failed')
  const activeJobs = jobs.filter((j) => ['pending', 'running_parca', 'running_sim', 'ingesting'].includes(j.status))
  const totalSeeds = jobs.length
  const hasMultipleSeeds = totalSeeds > 1
  const identity = resultIdentity(exp)
  const timeline = protocolLabel(exp)
  const batchName = batchLabel(exp)
  const latestJob = [...jobs].sort((a, b) => b.id - a.id)[0]
  const statusSummary = [
    doneJobs.length > 0 ? `${doneJobs.length} done` : '',
    activeJobs.length > 0 ? `${activeJobs.length} active` : '',
    failedJobs.length > 0 ? `${failedJobs.length} failed` : '',
  ].filter(Boolean).join(' / ') || 'No jobs'

  useEffect(() => {
    if (doneJobs.length === 0) return
    setLoading(true)
    getExperimentResults(exp.id)
      .then(setAgg)
      .catch(() => {})
      .finally(() => setLoading(false))

    if (exp.variant_type === 'gene_knockout') {
      compareExperiments([exp.id], true)
        .then((resp) => {
          if (resp.deltas.length > 0) setWtDelta(resp.deltas[0])
        })
        .catch(() => {})
    }
  }, [exp.id, doneJobs.length, exp.variant_type])

  useEffect(() => {
    if (!menuOpen) return
    const handlePointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [menuOpen])

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      <div className="px-5 py-4 flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="font-medium text-gray-900 truncate">{identity}</h3>
            {showExperimentId && (
              <span className="text-xs text-gray-400 font-mono">experiment #{exp.id}</span>
            )}
            <span className="text-xs px-1.5 py-0.5 bg-blue-50 text-blue-700 rounded font-medium">{exp.condition || 'No condition'}</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-400">
            <span>{variantLabel(exp.variant_type)}</span>
            <span>Variant index <span className="font-mono text-gray-500">{exp.variant_index}</span></span>
            {exp.batch_id && (
              <span className="truncate" title={`Internal batch ID: ${exp.batch_id}`}>
                Batch <span className="text-gray-500">{batchName}</span>
              </span>
            )}
            {exp.gene_symbol && (
              <span>Gene: <span className="font-mono text-bio-gene">{exp.gene_symbol}</span></span>
            )}
            <span>{totalSeeds} seed{totalSeeds !== 1 ? 's' : ''}</span>
            <span>{statusSummary}</span>
            {latestJob && (
              <span>Latest job <span className="font-mono text-gray-500">#{latestJob.id}</span></span>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-400">
            <span className="font-medium text-gray-500">Protocol</span>
            <span className="max-w-full truncate rounded bg-gray-50 px-2 py-1 font-mono text-[11px] text-gray-600" title={timeline}>
              {timeline}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {!hasMultipleSeeds && doneJobs.length === 1 && (
            <Link
              to={'/results/' + doneJobs[0].id}
              className="text-xs font-medium text-brand-600 hover:text-brand-700 px-3 py-1.5 rounded-lg hover:bg-brand-50 transition-colors"
            >
              Open result
            </Link>
          )}
          {hasMultipleSeeds && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="text-xs text-gray-400 hover:text-gray-600 px-2 py-1 rounded transition-colors"
            >
              {expanded ? 'Hide seeds' : 'Show seeds'}
              <span className="ml-1">{expanded ? '^' : 'v'}</span>
            </button>
          )}
          <div ref={menuRef} className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((current) => !current)}
              className="px-2 py-1 text-sm font-medium text-gray-400 hover:text-gray-700 rounded hover:bg-gray-100 transition-colors"
              title="More actions"
              aria-label="More experiment actions"
              aria-expanded={menuOpen}
            >
              ...
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-full z-20 mt-1 w-40 rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false)
                    onDelete(exp)
                  }}
                  className="w-full px-3 py-2 text-left text-xs font-medium text-red-600 hover:bg-red-50"
                >
                  Delete experiment
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {hasMultipleSeeds && agg && !loading && (
        <div className="px-5 pb-3 border-t border-gray-100 pt-3">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <div>
              <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-0.5">Division rate</p>
              <p className="text-sm font-semibold text-gray-800">{agg.division_rate}</p>
            </div>
            <div>
              <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-0.5">Division time</p>
              <p className="text-sm"><MetricWithCI metric={agg.division_time} unit="min" transform={(v) => v / 60} /></p>
            </div>
            <div>
              <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-0.5">Final mass</p>
              <p className="text-sm"><MetricWithCI metric={agg.final_mass} unit="fg" /></p>
            </div>
            <div>
              <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-0.5">Growth rate</p>
              <p className="text-sm"><MetricWithCI metric={agg.growth_rate} unit={'x10^-3/s'} decimals={2} transform={(v) => v * 1000} /></p>
            </div>
            <div>
              <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-0.5">Doubling time</p>
              <p className="text-sm"><MetricWithCI metric={agg.doubling_time} unit="min" /></p>
            </div>
          </div>
        </div>
      )}

      {!hasMultipleSeeds && agg && agg.seeds.length === 1 && doneJobs.length > 0 && (
        <div className="px-5 pb-3 border-t border-gray-100 pt-3">
          <div className="grid grid-cols-4 gap-3 text-xs">
            <div>
              <span className="text-gray-400">Division: </span>
              <span className="font-mono">{agg.seeds[0].division_time_sec != null ? (agg.seeds[0].division_time_sec / 60).toFixed(1) + ' min' : '-'}</span>
            </div>
            <div>
              <span className="text-gray-400">Mass: </span>
              <span className="font-mono">{agg.seeds[0].final_mass_fg != null ? agg.seeds[0].final_mass_fg.toFixed(1) + ' fg' : '-'}</span>
            </div>
            <div>
              <span className="text-gray-400">Growth: </span>
              <span className="font-mono">{agg.seeds[0].growth_rate != null ? (agg.seeds[0].growth_rate * 1000).toFixed(2) : '-'}</span>
            </div>
            <div>
              <span className="text-gray-400">Doubling: </span>
              <span className="font-mono">{agg.seeds[0].doubling_time_min != null ? agg.seeds[0].doubling_time_min.toFixed(1) + ' min' : '-'}</span>
            </div>
          </div>
        </div>
      )}

      {wtDelta && agg && (
        <div className="px-5 pb-2 pt-2 border-t border-gray-100 flex items-center gap-4 text-xs">
          <span className="text-gray-400 font-medium">vs wildtype:</span>
          <DeltaIndicator pct={wtDelta.division_time_pct} label="Division time" />
          <DeltaIndicator pct={wtDelta.final_mass_pct} label="Final mass" />
          <DeltaIndicator pct={wtDelta.growth_rate_pct} label="Growth rate" />
          <DeltaIndicator pct={wtDelta.doubling_time_pct} label="Doubling time" />
        </div>
      )}

      {loading && (
        <div className="px-5 pb-3 border-t border-gray-100 pt-3 text-center">
          <div className="inline-block w-4 h-4 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {expanded && hasMultipleSeeds && (
        <div className="border-t border-gray-200 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left px-4 py-2 font-medium text-gray-500 w-16">Seed</th>
                <th className="text-left px-4 py-2 font-medium text-gray-500 w-24">Status</th>
                <th className="text-right px-4 py-2 font-medium text-gray-500">Division time</th>
                <th className="text-right px-4 py-2 font-medium text-gray-500">Final mass</th>
                <th className="text-right px-4 py-2 font-medium text-gray-500">Growth rate</th>
                <th className="text-right px-4 py-2 font-medium text-gray-500">Doubling</th>
                <th className="w-24"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {[...jobs].sort((a, b) => a.seed - b.seed).map((job) => {
                const seed = agg?.seeds.find((s) => s.job_id === job.id)
                return (
                  <tr key={job.id} className="hover:bg-gray-50">
                    <td className="px-4 py-2 font-mono">{job.seed}</td>
                    <td className="px-4 py-2">
                      <span className={'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ' + (
                        JOB_STATUS_COLORS[job.status] ?? 'bg-gray-100 text-gray-600'
                      )}>
                        {statusLabel(job.status)}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-gray-600">{seed?.division_time_sec != null ? (seed.division_time_sec / 60).toFixed(1) + ' min' : '-'}</td>
                    <td className="px-4 py-2 text-right font-mono text-gray-600">{seed?.final_mass_fg != null ? seed.final_mass_fg.toFixed(1) + ' fg' : '-'}</td>
                    <td className="px-4 py-2 text-right font-mono text-gray-600">{seed?.growth_rate != null ? (seed.growth_rate * 1000).toFixed(3) : '-'}</td>
                    <td className="px-4 py-2 text-right font-mono text-gray-600">{seed?.doubling_time_min != null ? seed.doubling_time_min.toFixed(1) + ' min' : '-'}</td>
                    <td className="px-4 py-2 text-right">
                      {job.status === 'done' && (
                        <Link to={'/results/' + job.id} className="text-[10px] font-medium text-brand-600 hover:text-brand-700 px-2 py-1 rounded hover:bg-brand-50 transition-colors">
                          View
                        </Link>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export function ResultsBrowserPage() {
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const [jobs, setJobs] = useState<SimulationJob[]>([])
  const [experiments, setExperiments] = useState<Map<number, Experiment>>(new Map())
  const [loading, setLoading] = useState(true)
  const [viewMode, setViewMode] = useState<ViewMode>(() => validView(searchParams.get('view')))
  const [query, setQuery] = useState('')
  const [seedFilter, setSeedFilter] = useState('all')
  const [timelineFilter, setTimelineFilter] = useState('all')
  const [typeFilter, setTypeFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [datePreset, setDatePreset] = useState<DatePreset>('any')
  const [customDate, setCustomDate] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<Experiment | null>(null)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    Promise.all([getJobs(), getExperiments()])
      .then(([jobData, expData]) => {
        setJobs(jobData)
        const expMap = new Map<number, Experiment>()
        expData.forEach((exp) => expMap.set(exp.id, exp))
        setExperiments(expMap)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    setViewMode(validView(searchParams.get('view')))
  }, [searchParams])

  const isActive = (status: string) =>
    ['pending', 'running_parca', 'running_sim', 'ingesting'].includes(status)

  const setView = (nextView: ViewMode) => {
    setViewMode(nextView)
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      if (nextView === 'experiments') next.delete('view')
      else next.set('view', nextView)
      return next
    })
  }

  const handleDatePresetChange = (value: DatePreset) => {
    setDatePreset(value)
    if (value === 'custom' && !customDate) setCustomDate(toDateInputValue(new Date()))
  }

  const clearFilters = () => {
    setQuery('')
    setSeedFilter('all')
    setTimelineFilter('all')
    setTypeFilter('all')
    setStatusFilter('all')
    setDatePreset('any')
    setCustomDate('')
  }

  const handleDelete = (experiment: Experiment) => {
    setDeleteTarget(experiment)
    setDeleteError(null)
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    const experiment = deleteTarget
    setDeletingId(experiment.id)
    setDeleteError(null)
    try {
      await deleteExperiment(experiment.id)
      setExperiments((current) => {
        const next = new Map(current)
        next.delete(experiment.id)
        return next
      })
      setJobs((current) => current.filter((job) => job.experiment_id !== experiment.id))
      setDeleteTarget(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error'
      setDeleteError(`Failed to delete: ${message}`)
    } finally {
      setDeletingId(null)
    }
  }

  const doneCount = jobs.filter((job) => job.status === 'done').length
  const activeCount = jobs.filter((job) => isActive(job.status)).length
  const failedCount = jobs.filter((job) => job.status === 'failed').length
  const normalizedQuery = query.trim().toLowerCase()

  const experimentGroups = new Map<number, SimulationJob[]>()
  for (const job of jobs) {
    const list = experimentGroups.get(job.experiment_id) ?? []
    list.push(job)
    experimentGroups.set(job.experiment_id, list)
  }

  const sortedExpIds = [...experimentGroups.keys()].sort((a, b) => {
    const aJobs = experimentGroups.get(a) ?? []
    const bJobs = experimentGroups.get(b) ?? []
    const aMax = Math.max(...aJobs.map((job) => job.id))
    const bMax = Math.max(...bJobs.map((job) => job.id))
    return bMax - aMax
  })

  const seedOptions = [...new Set(jobs.map((job) => job.seed))].sort((a, b) => a - b)
  const timelineOptions = [...new Set([
    ...[...experiments.values()].map((exp) => timelineValue(exp.timeline)),
    ...jobs.map((job) => timelineValue(job.timeline)),
  ])].sort((a, b) => timelineLabel(a === NO_TIMELINE ? '' : a).localeCompare(timelineLabel(b === NO_TIMELINE ? '' : b)))
  const typeOptions = [...new Set([
    ...[...experiments.values()].map((exp) => exp.variant_type),
    ...jobs.map((job) => job.variant_type),
  ])].sort((a, b) => variantLabel(a).localeCompare(variantLabel(b)))
  const statusOptions = [...new Set(jobs.map((job) => job.status))]
    .sort((a, b) => statusLabel(a).localeCompare(statusLabel(b)))

  const experimentMatchesFilters = (exp: Experiment, expJobs: SimulationJob[]) => {
    if (normalizedQuery && !experimentSearchText(exp, expJobs).includes(normalizedQuery)) return false
    if (seedFilter !== 'all' && !expJobs.some((job) => String(job.seed) === seedFilter)) return false
    if (timelineFilter !== 'all' && timelineValue(exp.timeline) !== timelineFilter) return false
    if (typeFilter !== 'all' && exp.variant_type !== typeFilter) return false
    if (statusFilter !== 'all' && !expJobs.some((job) => job.status === statusFilter)) return false
    return matchesDatePreset(latestJobDate(expJobs, exp), datePreset, customDate)
  }

  const jobMatchesFilters = (job: SimulationJob) => {
    const exp = experiments.get(job.experiment_id)
    const jobSearchText = [
      exp ? experimentSearchText(exp, [job]) : '',
      exp ? batchLabel(exp) : '',
      job.variant_type,
      variantLabel(job.variant_type),
      String(job.variant_index ?? ''),
      job.condition,
      job.timeline,
      job.status,
      statusLabel(job.status),
      job.phase,
      job.error_message,
      String(job.id),
      String(job.experiment_id),
      String(job.seed),
    ].filter(Boolean).join(' ').toLowerCase()
    if (normalizedQuery && !jobSearchText.includes(normalizedQuery)) return false
    if (seedFilter !== 'all' && String(job.seed) !== seedFilter) return false
    if (timelineFilter !== 'all' && timelineValue(job.timeline || exp?.timeline) !== timelineFilter) return false
    if (typeFilter !== 'all' && (exp?.variant_type || job.variant_type) !== typeFilter) return false
    if (statusFilter !== 'all' && job.status !== statusFilter) return false
    return matchesDatePreset(parseDate(job.started_at) ?? parseDate(job.created_at), datePreset, customDate)
  }

  const filteredExpIds = sortedExpIds.filter((expId) => {
    const exp = experiments.get(expId)
    if (!exp) return false
    return experimentMatchesFilters(exp, experimentGroups.get(expId) ?? [])
  })
  const filteredJobs = jobs.filter(jobMatchesFilters)
  const filtersActive = Boolean(
    normalizedQuery
    || seedFilter !== 'all'
    || timelineFilter !== 'all'
    || typeFilter !== 'all'
    || statusFilter !== 'all'
    || datePreset !== 'any'
  )
  const filteredIdentityCounts = new Map<string, number>()
  for (const expId of filteredExpIds) {
    const exp = experiments.get(expId)
    if (!exp) continue
    const identity = resultIdentity(exp)
    filteredIdentityCounts.set(identity, (filteredIdentityCounts.get(identity) ?? 0) + 1)
  }

  const formatDate = (iso: string) => {
    if (!iso) return '-'
    return new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  }

  const formatDuration = (start: string, end: string) => {
    if (!start || !end) return '-'
    const ms = new Date(end).getTime() - new Date(start).getTime()
    if (ms < 0) return '-'
    const totalSec = Math.floor(ms / 1000)
    const h = Math.floor(totalSec / 3600)
    const m = Math.floor((totalSec % 3600) / 60)
    const s = totalSec % 60
    if (h > 0) return h + 'h ' + m + 'm'
    if (m > 0) return m + 'm ' + s + 's'
    return s + 's'
  }

  const assistantHref = buildAssistantHref({
    surface: 'results',
    route: `${location.pathname}${location.search}`,
    variantType: typeFilter !== 'all' ? typeFilter : null,
    prompt: `Help me triage the Results browser. Explain the ${viewMode} view, current filters, redundant controls, failed/running jobs, and which result should be opened first for biological interpretation.`,
  })

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex flex-col gap-4 mb-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Results</p>
          <h1 className="text-xl font-semibold text-gray-900">{viewLabel(viewMode)}</h1>
          <p className="mt-1 text-sm text-gray-500">{viewDescription(viewMode)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <AskAssistantButton
            href={assistantHref}
            className="px-3 py-1.5 text-sm font-medium text-brand-700 bg-brand-50 hover:bg-brand-100 border border-brand-200 rounded-lg transition-colors"
          >
            Ask Assistant
          </AskAssistantButton>
          <Link
            to="/results/compare"
            className="px-3 py-1.5 text-sm font-medium text-brand-700 bg-brand-50 hover:bg-brand-100 border border-brand-200 rounded-lg transition-colors"
          >
            Compare experiments
          </Link>
          <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-0.5">
            <button
              onClick={() => setView('experiments')}
              className={'px-3 py-1.5 text-xs font-medium rounded-md transition-colors ' + (
                viewMode === 'experiments' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              )}
            >
              Experiment outcomes
            </button>
            <button
              onClick={() => setView('batches')}
              className={'px-3 py-1.5 text-xs font-medium rounded-md transition-colors ' + (
                viewMode === 'batches' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              )}
            >
              Batches
            </button>
            <button
              type="button"
              onClick={() => setView('jobs')}
              className={'px-3 py-1.5 text-xs font-medium rounded-md transition-colors ' + (
                viewMode === 'jobs' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              )}
            >
              Job diagnostics
            </button>
          </div>
        </div>
      </div>

      <div className="mb-5 flex flex-wrap gap-2">
        <div className="rounded-full border border-gray-200 bg-white px-3 py-1.5">
          <span className="text-xs text-gray-400">Experiments</span>
          <span className="ml-2 text-sm font-semibold text-gray-700">{experimentGroups.size}</span>
        </div>
        <div className="rounded-full border border-green-100 bg-green-50 px-3 py-1.5">
          <span className="text-xs text-green-700">Completed jobs</span>
          <span className="ml-2 text-sm font-semibold text-green-700">{doneCount}</span>
        </div>
        <div className="rounded-full border border-blue-100 bg-blue-50 px-3 py-1.5">
          <span className="text-xs text-blue-700">Active</span>
          <span className="ml-2 text-sm font-semibold text-blue-700">{activeCount}</span>
        </div>
        <div className="rounded-full border border-red-100 bg-red-50 px-3 py-1.5">
          <span className="text-xs text-red-700">Failed</span>
          <span className="ml-2 text-sm font-semibold text-red-700">{failedCount}</span>
        </div>
      </div>

      {deleteError && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm mb-4">
          {deleteError}
        </div>
      )}

      {viewMode !== 'batches' && jobs.length > 0 && (
        <section className="mb-6 rounded-lg border border-gray-200 bg-white px-4 py-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-gray-900">
                {viewMode === 'jobs' ? 'Find diagnostic jobs' : 'Find experiment outcomes'}
              </h2>
              <p className="text-xs text-gray-400">
                {viewMode === 'jobs'
                  ? 'Filter raw execution records by status, seed, protocol, type, or run date.'
                  : 'Filter by target gene, batch name, experiment type, condition, protocol, status, or run date.'}
              </p>
            </div>
          </div>
          <div className="grid gap-3 lg:grid-cols-[minmax(220px,1fr),120px,170px,170px,150px,150px,150px]">
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder={viewMode === 'jobs' ? 'Search job ID, target, protocol...' : 'Search gene, batch, condition...'}
            />
            <select value={seedFilter} onChange={(event) => setSeedFilter(event.target.value)} className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30" aria-label="Filter by seed">
              <option value="all">All seeds</option>
              {seedOptions.map((seed) => <option key={seed} value={String(seed)}>Seed {seed}</option>)}
            </select>
            <select value={timelineFilter} onChange={(event) => setTimelineFilter(event.target.value)} className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30" aria-label="Filter by timeline">
              <option value="all">All protocols</option>
              {timelineOptions.map((timeline) => (
                <option key={timeline} value={timeline}>{timeline === NO_TIMELINE ? 'No time-varying protocol' : timeline}</option>
              ))}
            </select>
            <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30" aria-label="Filter by experiment type">
              <option value="all">All types</option>
              {typeOptions.map((type) => <option key={type} value={type}>{variantLabel(type)}</option>)}
            </select>
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30" aria-label="Filter by job status">
              <option value="all">All statuses</option>
              {statusOptions.map((status) => <option key={status} value={status}>{statusLabel(status)}</option>)}
            </select>
            <select value={datePreset} onChange={(event) => handleDatePresetChange(event.target.value as DatePreset)} className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30" aria-label="Filter by date">
              <option value="any">Any date</option>
              <option value="today">Today</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="custom">Custom</option>
            </select>
            {datePreset === 'custom' ? (
              <input type="date" value={customDate} onChange={(event) => setCustomDate(event.target.value)} className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30" aria-label="Custom result date" />
            ) : (
              <div className="hidden lg:block" />
            )}
          </div>
          <div className="mt-3 flex items-center justify-between gap-3 text-xs text-gray-400">
            <span>
              {viewMode === 'experiments'
                ? `Showing ${filteredExpIds.length} of ${sortedExpIds.length} experiment${sortedExpIds.length === 1 ? '' : 's'}`
                : `Showing ${filteredJobs.length} of ${jobs.length} job${jobs.length === 1 ? '' : 's'}`
              }
            </span>
            {filtersActive && (
              <button type="button" onClick={clearFilters} className="font-medium text-brand-600 hover:text-brand-700">
                Clear filters
              </button>
            )}
          </div>
        </section>
      )}

      {loading ? (
        <div className="text-center py-12 text-gray-400">
          <div className="inline-block w-5 h-5 border-2 border-brand-500 border-t-transparent rounded-full animate-spin mr-2" />
          Loading results...
        </div>
      ) : viewMode === 'batches' ? (
        <BatchDashboard />
      ) : jobs.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-lg border border-gray-200">
          <p className="text-gray-500 font-medium mb-1">No simulation jobs yet</p>
          <p className="text-sm text-gray-400 mb-4">Run a simulation from the Experiments page to see results here.</p>
          <Link to="/experiments" className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg transition-colors">
            Go to Experiments
          </Link>
        </div>
      ) : viewMode === 'experiments' ? (
        <>
          {filteredExpIds.length === 0 ? (
            <div className="text-center py-16 bg-white rounded-lg border border-gray-200">
              <p className="text-gray-500 font-medium mb-1">No matching experiments</p>
              <p className="text-sm text-gray-400 mb-4">Adjust target, seed, protocol, type, status, or date filters.</p>
              {filtersActive && (
                <button type="button" onClick={clearFilters} className="inline-flex items-center px-4 py-2 text-sm font-medium text-brand-700 bg-brand-50 hover:bg-brand-100 border border-brand-200 rounded-lg transition-colors">
                  Clear filters
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {filteredExpIds.map((expId) => {
                const exp = experiments.get(expId)
                const expJobs = experimentGroups.get(expId) ?? []
                if (!exp) return null
                return (
                  <ExperimentCard
                    key={expId}
                    exp={exp}
                    jobs={expJobs}
                    showExperimentId={(filteredIdentityCounts.get(resultIdentity(exp)) ?? 0) > 1}
                    onDelete={handleDelete}
                  />
                )
              })}
            </div>
          )}
        </>
      ) : (
        <>
          {filteredJobs.length === 0 ? (
            <div className="text-center py-16 bg-white rounded-lg border border-gray-200">
              <p className="text-gray-500 font-medium mb-1">No matching jobs</p>
              <p className="text-sm text-gray-400 mb-4">Adjust job search, seed, protocol, type, status, or date filters.</p>
              {filtersActive && (
                <button type="button" onClick={clearFilters} className="inline-flex items-center px-4 py-2 text-sm font-medium text-brand-700 bg-brand-50 hover:bg-brand-100 border border-brand-200 rounded-lg transition-colors">
                  Clear filters
                </button>
              )}
            </div>
          ) : (
            <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
              <div className="border-b border-gray-100 px-4 py-3">
                <h2 className="text-sm font-semibold text-gray-900">Job diagnostics</h2>
                <p className="text-xs text-gray-400">Raw execution records for checking provenance, failures, and runtime state.</p>
              </div>
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-4 py-2.5 font-medium text-gray-500 w-16">Job</th>
                    <th className="text-left px-4 py-2.5 font-medium text-gray-500">Experiment</th>
                    <th className="text-left px-4 py-2.5 font-medium text-gray-500 w-28">Type</th>
                    <th className="text-left px-4 py-2.5 font-medium text-gray-500 w-20">Seed</th>
                    <th className="text-left px-4 py-2.5 font-medium text-gray-500 w-16">Gen</th>
                    <th className="text-left px-4 py-2.5 font-medium text-gray-500 w-28">Status</th>
                    <th className="text-left px-4 py-2.5 font-medium text-gray-500 w-36">Started</th>
                    <th className="text-left px-4 py-2.5 font-medium text-gray-500 w-24">Duration</th>
                    <th className="w-20"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filteredJobs.map((job) => {
                    const exp = experiments.get(job.experiment_id)
                    const identity = exp ? resultIdentity(exp) : 'Experiment #' + job.experiment_id
                    const timeline = timelineLabel(job.timeline || exp?.timeline)
                    return (
                      <tr key={job.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-4 py-3 font-mono text-gray-400">#{job.id}</td>
                        <td className="px-4 py-3">
                          <p className="font-medium text-gray-900">{identity}</p>
                          <div className="flex items-center gap-2 mt-0.5">
                            {exp?.gene_symbol && (
                              <span className="text-xs text-gray-400">Gene: <span className="font-mono text-bio-gene">{exp.gene_symbol}</span></span>
                            )}
                            <span className="text-xs px-1.5 py-0.5 bg-blue-50 text-blue-700 rounded font-medium truncate max-w-[14rem]" title={timeline}>
                              {timeline}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-600">{variantLabel(job.variant_type)}</td>
                        <td className="px-4 py-3 font-mono text-gray-600">{job.seed}</td>
                        <td className="px-4 py-3 font-mono text-gray-600">{job.generations}</td>
                        <td className="px-4 py-3">
                          <span className={'inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium ' + (
                            JOB_STATUS_COLORS[job.status] ?? 'bg-gray-100 text-gray-600'
                          )}>
                            {isActive(job.status) && <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />}
                            {statusLabel(job.status)}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-400">{formatDate(job.started_at)}</td>
                        <td className="px-4 py-3 text-xs text-gray-400 font-mono">{formatDuration(job.started_at, job.finished_at)}</td>
                        <td className="px-4 py-3">
                          {job.status === 'done' && (
                            <Link to={'/results/' + job.id} className="text-xs font-medium text-brand-600 hover:text-brand-700 px-2 py-1 rounded hover:bg-brand-50 transition-colors">
                              Open result
                            </Link>
                          )}
                          {job.status === 'failed' && job.error_message && (
                            <span className="text-xs text-red-400" title={job.error_message}>Error</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Delete experiment"
        message={`Delete "${deleteTarget?.name || 'this experiment'}"? Jobs and results will be removed.`}
        confirmLabel="Delete experiment"
        destructive
        busy={deletingId === deleteTarget?.id}
        onConfirm={confirmDelete}
        onCancel={() => {
          if (deletingId == null) setDeleteTarget(null)
        }}
      />
    </div>
  )
}
