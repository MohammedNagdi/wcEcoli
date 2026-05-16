import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { getJobs, getExperiments, getExperimentResults } from '../../api/client'
import { variantLabel, statusLabel } from '../../utils/labels'
import { HelpTip } from '../common/HelpTip'
import type { SimulationJob, Experiment, ExperimentAggregation } from '../../types'

const JOB_STATUS_COLORS: Record<string, string> = {
  pending:       'bg-yellow-50 text-yellow-700',
  running_parca: 'bg-blue-50 text-blue-700',
  running_sim:   'bg-blue-50 text-blue-700',
  ingesting:     'bg-purple-50 text-purple-700',
  done:          'bg-green-50 text-green-700',
  failed:        'bg-red-50 text-red-700',
}

type ViewMode = 'experiments' | 'jobs'

function formatMetric(val: number | null | undefined, unit: string, decimals = 1): string {
  if (val == null) return '—'
  return val.toFixed(decimals) + ' ' + unit
}

function MetricWithCI({ label, metric, unit, decimals = 1, transform }: {
  label: string
  metric: { mean: number | null; std: number | null; ci_lower: number | null; ci_upper: number | null; n: number }
  unit: string
  decimals?: number
  transform?: (v: number) => number
}) {
  const t = transform ?? ((v: number) => v)
  if (metric.mean == null) return <span className="text-gray-300">{'—'}</span>
  const meanStr = t(metric.mean).toFixed(decimals)
  if (metric.n < 2 || metric.std == null) {
    return <span className="font-mono">{meanStr} {unit}</span>
  }
  const ciL = metric.ci_lower != null ? t(metric.ci_lower).toFixed(decimals) : '?'
  const ciH = metric.ci_upper != null ? t(metric.ci_upper).toFixed(decimals) : '?'
  return (
    <span className="font-mono" title={'95% CI: [' + ciL + ', ' + ciH + '], n=' + metric.n}>
      {meanStr} <span className="text-gray-400">{'±'} {t(metric.std).toFixed(decimals)}</span>
      <span className="text-gray-300 text-[10px] ml-1">{unit}</span>
    </span>
  )
}

// -- Experiment card for aggregated view --

function ExperimentCard({ exp, jobs }: { exp: Experiment; jobs: SimulationJob[] }) {
  const [agg, setAgg] = useState<ExperimentAggregation | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState(false)

  const doneJobs = jobs.filter((j) => j.status === 'done')
  const failedJobs = jobs.filter((j) => j.status === 'failed')
  const activeJobs = jobs.filter((j) => ['pending', 'running_parca', 'running_sim', 'ingesting'].includes(j.status))
  const totalSeeds = jobs.length
  const hasMultipleSeeds = totalSeeds > 1

  useEffect(() => {
    if (doneJobs.length === 0) return
    setLoading(true)
    getExperimentResults(exp.id)
      .then(setAgg)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [exp.id, doneJobs.length])

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="font-medium text-gray-900 truncate">{exp.name}</h3>
            <span className="text-xs text-gray-400 font-mono">#{exp.id}</span>
            {exp.condition !== 'basal' && (
              <span className="text-xs px-1.5 py-0.5 bg-amber-50 text-amber-700 rounded font-medium">
                {exp.condition}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 text-xs text-gray-400">
            <span>{variantLabel(exp.variant_type)}</span>
            {exp.gene_symbol && (
              <span>Gene: <span className="font-mono text-bio-gene">{exp.gene_symbol}</span></span>
            )}
            <span>{totalSeeds} seed{totalSeeds !== 1 ? 's' : ''}</span>
            {activeJobs.length > 0 && (
              <span className="text-blue-600 flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
                {activeJobs.length} running
              </span>
            )}
            {failedJobs.length > 0 && (
              <span className="text-red-500">{failedJobs.length} failed</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {!hasMultipleSeeds && doneJobs.length === 1 && (
            <Link
              to={'/results/' + doneJobs[0].id}
              className="text-xs font-medium text-brand-600 hover:text-brand-700 px-3 py-1.5 rounded-lg hover:bg-brand-50 transition-colors"
            >
              View results
            </Link>
          )}
          {hasMultipleSeeds && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="text-xs text-gray-400 hover:text-gray-600 px-2 py-1 rounded transition-colors"
            >
              {expanded ? 'Collapse' : 'Expand seeds'}
              <span className="ml-1">{expanded ? '▲' : '▼'}</span>
            </button>
          )}
        </div>
      </div>

      {/* Aggregated stats (multi-seed) */}
      {hasMultipleSeeds && agg && !loading && (
        <div className="px-5 pb-3 border-t border-gray-100 pt-3">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <div>
              <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-0.5">Division rate</p>
              <p className="text-sm font-semibold text-gray-800">{agg.division_rate}</p>
            </div>
            <div>
              <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-0.5">Division time</p>
              <p className="text-sm">
                <MetricWithCI label="div" metric={agg.division_time} unit="min" transform={(v) => v / 60} />
              </p>
            </div>
            <div>
              <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-0.5">Final mass</p>
              <p className="text-sm">
                <MetricWithCI label="mass" metric={agg.final_mass} unit="fg" />
              </p>
            </div>
            <div>
              <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-0.5">Growth rate</p>
              <p className="text-sm">
                <MetricWithCI label="gr" metric={agg.growth_rate} unit={'×10⁻³/s'} decimals={2} transform={(v) => v * 1000} />
              </p>
            </div>
            <div>
              <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-0.5">Doubling time</p>
              <p className="text-sm">
                <MetricWithCI label="dt" metric={agg.doubling_time} unit="min" />
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Single-seed summary */}
      {!hasMultipleSeeds && agg && agg.seeds.length === 1 && doneJobs.length > 0 && (
        <div className="px-5 pb-3 border-t border-gray-100 pt-3">
          <div className="grid grid-cols-4 gap-3 text-xs">
            <div>
              <span className="text-gray-400">Division: </span>
              <span className="font-mono">{agg.seeds[0].division_time_sec != null ? (agg.seeds[0].division_time_sec / 60).toFixed(1) + ' min' : '—'}</span>
            </div>
            <div>
              <span className="text-gray-400">Mass: </span>
              <span className="font-mono">{agg.seeds[0].final_mass_fg != null ? agg.seeds[0].final_mass_fg.toFixed(1) + ' fg' : '—'}</span>
            </div>
            <div>
              <span className="text-gray-400">Growth: </span>
              <span className="font-mono">{agg.seeds[0].growth_rate != null ? (agg.seeds[0].growth_rate * 1000).toFixed(2) : '—'}</span>
            </div>
            <div>
              <span className="text-gray-400">Doubling: </span>
              <span className="font-mono">{agg.seeds[0].doubling_time_min != null ? agg.seeds[0].doubling_time_min.toFixed(1) + ' min' : '—'}</span>
            </div>
          </div>
        </div>
      )}

      {loading && (
        <div className="px-5 pb-3 border-t border-gray-100 pt-3 text-center">
          <div className="inline-block w-4 h-4 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {/* Expanded: per-seed table */}
      {expanded && hasMultipleSeeds && (
        <div className="border-t border-gray-200">
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
              {jobs.sort((a, b) => a.seed - b.seed).map((job) => {
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
                    <td className="px-4 py-2 text-right font-mono text-gray-600">
                      {seed?.division_time_sec != null ? (seed.division_time_sec / 60).toFixed(1) + ' min' : '—'}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-gray-600">
                      {seed?.final_mass_fg != null ? seed.final_mass_fg.toFixed(1) + ' fg' : '—'}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-gray-600">
                      {seed?.growth_rate != null ? (seed.growth_rate * 1000).toFixed(3) : '—'}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-gray-600">
                      {seed?.doubling_time_min != null ? seed.doubling_time_min.toFixed(1) + ' min' : '—'}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {job.status === 'done' && (
                        <Link
                          to={'/results/' + job.id}
                          className="text-[10px] font-medium text-brand-600 hover:text-brand-700 px-2 py-1 rounded hover:bg-brand-50 transition-colors"
                        >
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

// -- Main page --

export function ResultsBrowserPage() {
  const [jobs, setJobs] = useState<SimulationJob[]>([])
  const [experiments, setExperiments] = useState<Map<number, Experiment>>(new Map())
  const [loading, setLoading] = useState(true)
  const [viewMode, setViewMode] = useState<ViewMode>('experiments')

  useEffect(() => {
    setLoading(true)
    Promise.all([getJobs(), getExperiments()])
      .then(([jobData, expData]) => {
        setJobs(jobData)
        const expMap = new Map<number, Experiment>()
        expData.forEach((e) => expMap.set(e.id, e))
        setExperiments(expMap)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const isActive = (s: string) =>
    ['pending', 'running_parca', 'running_sim', 'ingesting'].includes(s)

  const doneCount = jobs.filter((j) => j.status === 'done').length
  const activeCount = jobs.filter((j) => isActive(j.status)).length
  const failedCount = jobs.filter((j) => j.status === 'failed').length

  // Group jobs by experiment
  const experimentGroups = new Map<number, SimulationJob[]>()
  for (const job of jobs) {
    const list = experimentGroups.get(job.experiment_id) ?? []
    list.push(job)
    experimentGroups.set(job.experiment_id, list)
  }

  // Sort experiment groups by most recent job creation
  const sortedExpIds = [...experimentGroups.keys()].sort((a, b) => {
    const aJobs = experimentGroups.get(a) ?? []
    const bJobs = experimentGroups.get(b) ?? []
    const aMax = Math.max(...aJobs.map((j) => j.id))
    const bMax = Math.max(...bJobs.map((j) => j.id))
    return bMax - aMax
  })

  const formatDate = (iso: string) => {
    if (!iso) return '—'
    return new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  }

  const formatDuration = (start: string, end: string) => {
    if (!start || !end) return '—'
    const ms = new Date(end).getTime() - new Date(start).getTime()
    if (ms < 0) return '—'
    const totalSec = Math.floor(ms / 1000)
    const h = Math.floor(totalSec / 3600)
    const m = Math.floor((totalSec % 3600) / 60)
    const s = totalSec % 60
    if (h > 0) return h + 'h ' + m + 'm'
    if (m > 0) return m + 'm ' + s + 's'
    return s + 's'
  }

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Simulation results</h1>
          <p className="text-sm text-gray-400">
            {viewMode === 'experiments'
              ? 'Experiments grouped with aggregated statistics across seeds'
              : 'All individual simulation jobs'
            }
          </p>
        </div>
        <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-0.5">
          <button
            onClick={() => setViewMode('experiments')}
            className={'px-3 py-1.5 text-xs font-medium rounded-md transition-colors ' + (
              viewMode === 'experiments'
                ? 'bg-white text-gray-800 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            )}
          >
            By experiment
          </button>
          <button
            onClick={() => setViewMode('jobs')}
            className={'px-3 py-1.5 text-xs font-medium rounded-md transition-colors ' + (
              viewMode === 'jobs'
                ? 'bg-white text-gray-800 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            )}
          >
            All jobs
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <div className="bg-white rounded-lg border border-gray-200 px-4 py-3">
          <p className="text-xs text-gray-400 mb-0.5">Experiments</p>
          <p className="text-2xl font-semibold text-gray-700">{experimentGroups.size}</p>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 px-4 py-3">
          <p className="text-xs text-gray-400 mb-0.5">Completed jobs</p>
          <p className="text-2xl font-semibold text-green-600">{doneCount}</p>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 px-4 py-3">
          <p className="text-xs text-gray-400 mb-0.5">Active</p>
          <p className="text-2xl font-semibold text-blue-600">{activeCount}</p>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 px-4 py-3">
          <p className="text-xs text-gray-400 mb-0.5">Failed</p>
          <p className="text-2xl font-semibold text-red-600">{failedCount}</p>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-400">
          <div className="inline-block w-5 h-5 border-2 border-brand-500 border-t-transparent rounded-full animate-spin mr-2" />
          Loading results...
        </div>
      ) : jobs.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-lg border border-gray-200">
          <svg className="w-10 h-10 mx-auto mb-3 text-gray-200" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
          </svg>
          <p className="text-gray-500 font-medium mb-1">No simulation jobs yet</p>
          <p className="text-sm text-gray-400 mb-4">
            Run a simulation from the Experiments page to see results here.
          </p>
          <Link
            to="/experiments"
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg transition-colors"
          >
            Go to Experiments
          </Link>
        </div>
      ) : viewMode === 'experiments' ? (
        <div className="space-y-4">
          {sortedExpIds.map((expId) => {
            const exp = experiments.get(expId)
            const expJobs = experimentGroups.get(expId) ?? []
            if (!exp) return null
            return <ExperimentCard key={expId} exp={exp} jobs={expJobs} />
          })}
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
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
              {jobs.map((job) => {
                const exp = experiments.get(job.experiment_id)
                return (
                  <tr key={job.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 font-mono text-gray-400">#{job.id}</td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-900">{exp?.name ?? 'Experiment #' + job.experiment_id}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        {exp?.gene_symbol && (
                          <span className="text-xs text-gray-400">
                            Gene: <span className="font-mono text-bio-gene">{exp.gene_symbol}</span>
                          </span>
                        )}
                        {job.condition && job.condition !== 'basal' && (
                          <span className="text-xs px-1.5 py-0.5 bg-amber-50 text-amber-700 rounded font-medium">
                            {job.condition}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-600">
                      {variantLabel(job.variant_type)}
                    </td>
                    <td className="px-4 py-3 font-mono text-gray-600">{job.seed}</td>
                    <td className="px-4 py-3 font-mono text-gray-600">{job.generations}</td>
                    <td className="px-4 py-3">
                      <span className={'inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium ' + (
                        JOB_STATUS_COLORS[job.status] ?? 'bg-gray-100 text-gray-600'
                      )}>
                        {isActive(job.status) && (
                          <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
                        )}
                        {statusLabel(job.status)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-400">
                      {formatDate(job.started_at)}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-400 font-mono">
                      {formatDuration(job.started_at, job.finished_at)}
                    </td>
                    <td className="px-4 py-3">
                      {job.status === 'done' && (
                        <Link
                          to={'/results/' + job.id}
                          className="text-xs font-medium text-brand-600 hover:text-brand-700 px-2 py-1 rounded hover:bg-brand-50 transition-colors"
                        >
                          View results
                        </Link>
                      )}
                      {job.status === 'failed' && job.error_message && (
                        <span className="text-xs text-red-400" title={job.error_message}>
                          Error
                        </span>
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
