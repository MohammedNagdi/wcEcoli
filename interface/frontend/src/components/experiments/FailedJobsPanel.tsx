import { useState, useEffect, useMemo } from 'react'
import { ExperimentControls, EMPTY_FILTERS, DeleteMenu, RequestNotice } from './ExperimentControls'
import { useExperimentResource } from './useExperimentResource'
import { getFailedJobs, retryJob, deleteJobPermanent } from '../../api/client'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { variantLabel } from '../../utils/labels'
import { ExperimentScrollRegion } from './ExperimentPresentation'
import type { Experiment, FailedJobSummary } from '../../types'

function formatDate(iso: string): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })
  } catch { return iso }
}

function ErrorPhaseTag({ phase }: { phase: string }) {
  const phaseColors: Record<string, string> = {
    'Failed':     'bg-red-100 text-red-700',
    'Cancelled':  'bg-gray-100 text-gray-600',
  }
  const color = phaseColors[phase] || 'bg-red-50 text-red-600'
  return (
    <span className={`experiment-failure-phase inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium ${color}`}>
      {phase}
    </span>
  )
}

function truncate(value: string, max = 500): string {
  if (value.length <= max) return value
  return `${value.slice(0, max - 3)}...`
}

export function FailedJobsPanel({
  onAssistantSnapshot,
  active = true,
  experiments = [],
  onOpenExperiment,
}: {
  experiments?: Experiment[]
  active?: boolean
  onOpenExperiment: (id: number) => void
  onAssistantSnapshot?: (snapshot: Record<string, unknown>) => void
}) {
  const resource = useExperimentResource('failed-jobs', getFailedJobs, () => true, active)
  const jobs = useMemo(() => resource.data ?? [], [resource.data])
  const loading = resource.loading
  const [filters, setFilters] = useState({ ...EMPTY_FILTERS })
  const [ascending, setAscending] = useState(false)
  const visibleJobs = useMemo(() => jobs.filter((job) =>
    [job.id, job.experiment_id, job.experiment_name, job.gene_symbol, job.variant_type, variantLabel(job.variant_type), job.condition, job.phase, experiments.find((exp) => exp.id === job.experiment_id)?.timeline].join(' ').toLowerCase().includes(filters.query.trim().toLowerCase())
    && (!filters.type || job.variant_type === filters.type)
    && (!filters.condition || job.condition === filters.condition)
  ).sort((a, b) => (ascending ? 1 : -1) * (a.finished_at.localeCompare(b.finished_at) || a.id - b.id)), [jobs, filters, ascending, experiments])
  const [actionInProgress, setActionInProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<FailedJobSummary | null>(null)

  const fetchJobs = () => resource.refresh(true)

  const handleRetry = async (jobId: number) => {
    setActionInProgress(jobId)
    setError(null)
    try {
      await retryJob(jobId)
      await fetchJobs()
    } catch (e: any) {
      setError(e.message || 'Retry failed')
    } finally {
      setActionInProgress(null)
    }
  }

  const handleDelete = async (jobId: number) => {
    const job = jobs.find((item) => item.id === jobId)
    if (job) setDeleteTarget(job)
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    const jobId = deleteTarget.id
    setActionInProgress(jobId)
    setError(null)
    try {
      await deleteJobPermanent(jobId)
      setDeleteTarget(null)
      await fetchJobs()
    } catch (e: any) {
      setError(e.message || 'Delete failed')
    } finally {
      setActionInProgress(null)
    }
  }

  const assistantSnapshot = useMemo(() => ({
    kind: 'failed_jobs',
    failed_job_count: jobs.length,
    expanded_job_id: expandedId,
    delete_target: deleteTarget
      ? {
        id: deleteTarget.id,
        experiment_id: deleteTarget.experiment_id,
        experiment_name: deleteTarget.experiment_name,
        gene_symbol: deleteTarget.gene_symbol,
        condition: deleteTarget.condition,
        phase: deleteTarget.phase,
      }
      : null,
    action_in_progress_job_id: actionInProgress,
    filters,
    matching_jobs: visibleJobs.length,
    request_error: resource.error,
    error,
    jobs_sample: jobs.slice(0, 25).map((job) => ({
      id: job.id,
      experiment_id: job.experiment_id,
      experiment_name: job.experiment_name,
      gene_symbol: job.gene_symbol,
      variant_type: job.variant_type,
      variant_index: job.variant_index,
      condition: job.condition,
      seed: job.seed,
      phase: job.phase,
      finished_at: job.finished_at,
      error_message: truncate(job.error_message || ''),
      error_truncated: Boolean(job.error_message && job.error_message.length > 500),
    })),
    sample_truncated: jobs.length > 25,
  }), [actionInProgress, deleteTarget, error, expandedId, jobs, filters, visibleJobs.length, resource.error])

  useEffect(() => {
    onAssistantSnapshot?.(assistantSnapshot)
  }, [assistantSnapshot, onAssistantSnapshot])

  if (loading) {
    return (
      <div className="text-center py-12 text-gray-400">
        <div className="inline-block w-5 h-5 border-2 border-red-400 border-t-transparent rounded-full animate-spin mr-2" />
        Loading failed jobs...
      </div>
    )
  }

  if (resource.error && jobs.length === 0) return <RequestNotice error={resource.error} retry={() => void fetchJobs()} />

  if (jobs.length === 0) {
    return (
      <div className="text-center py-16 bg-white rounded-lg border border-gray-200">
        <svg className="w-10 h-10 mx-auto mb-3 text-green-200" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <p className="text-gray-500 font-medium mb-1">No failed jobs</p>
        <p className="text-sm text-gray-400">There are no failed jobs in this catalog.</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-2 text-sm">
          {error}
        </div>
      )}

      <RequestNotice error={resource.error} retry={() => void fetchJobs()} />
      <ExperimentControls label="Find a failed job" filters={filters} onChange={setFilters} failed types={visibleJobs.map((job) => job.variant_type)} conditions={visibleJobs.map((job) => job.condition)} count={visibleJobs.length} total={jobs.length} />
      {visibleJobs.length === 0 && <p className="text-sm text-gray-500 p-5">No matching failed jobs. Adjust search or clear filters.</p>}
      <ExperimentScrollRegion label="Failed jobs table">
        <table className="experiment-table">
          <thead className="bg-red-50/50 border-b border-gray-200">
            <tr>
              <th className="text-left px-4 py-2.5 font-medium text-gray-500">Job</th>
              <th className="text-left px-4 py-2.5 font-medium text-gray-500 w-28">Gene</th>
              <th className="text-left px-4 py-2.5 font-medium text-gray-500 w-24">Condition</th>
              <th className="text-left px-4 py-2.5 font-medium text-gray-500 w-24">Phase</th>
              <th aria-sort={ascending ? 'ascending' : 'descending'} className="text-left px-4 py-2.5 font-medium text-gray-500 w-32"><button onClick={() => setAscending((value) => !value)}>Failed at {ascending ? '↑' : '↓'}</button></th>
              <th className="text-right px-4 py-2.5 font-medium text-gray-500 w-32">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {visibleJobs.map((job) => {
              const isExpanded = expandedId === job.id
              const isActing = actionInProgress != null
              return (
                <tr key={job.id} className="group">
                  <td className="px-4 py-3">
                    <button
                      aria-expanded={isExpanded}
                      onClick={() => setExpandedId(isExpanded ? null : job.id)}
                      className="text-left"
                    >
                      <p className="font-medium text-gray-900">
                        #{job.id}
                        <span className="text-gray-400 font-normal ml-2">{job.experiment_name}</span>
                      </p>
                      <p className="text-[11px] text-gray-400 mt-0.5">
                        seed {job.seed} · {job.variant_type}[{job.variant_index}]
                      </p>
                    </button>
                    {isExpanded && job.error_message && (
                      <div role="region" aria-label={`Error for job ${job.id}`} tabIndex={0} className="mt-2 px-3 py-2 bg-red-50 rounded border border-red-100 text-xs text-red-700 font-mono whitespace-pre-wrap max-h-40 overflow-y-auto">
                        {job.error_message}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {job.gene_symbol ? (
                      <span className="font-mono text-bio-gene text-xs">{job.gene_symbol}</span>
                    ) : (
                      <span className="text-gray-300">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-600 text-xs">{job.condition}</td>
                  <td className="px-4 py-3">
                    <ErrorPhaseTag phase={job.phase} />
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-400">
                    {formatDate(job.finished_at)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => handleRetry(job.id)}
                        disabled={isActing}
                        className="text-xs px-2.5 py-1 rounded border border-blue-200 bg-blue-50 text-blue-700
                                   hover:bg-blue-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        title="Reset to pending and re-run"
                      >
                        {actionInProgress === job.id ? 'Working…' : 'Retry'}
                      </button>
                      <button className="experiment-button" onClick={() => onOpenExperiment(job.experiment_id)}>Open experiment</button>
                      <DeleteMenu label={`job ${job.id}`} onDelete={() => { if (!isActing) void handleDelete(job.id) }} />
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </ExperimentScrollRegion>
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Delete failed job"
        message={`Delete failed job #${deleteTarget?.id || ''}? Results will be removed.`}
        confirmLabel="Delete job"
        destructive
        busy={actionInProgress === deleteTarget?.id}
        onConfirm={confirmDelete}
        onCancel={() => {
          if (actionInProgress == null) setDeleteTarget(null)
        }}
      />
    </div>
  )
}
