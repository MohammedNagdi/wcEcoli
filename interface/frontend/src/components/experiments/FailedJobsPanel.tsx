import { useState, useEffect, useMemo } from 'react'
import { getFailedJobs, retryJob, deleteJobPermanent } from '../../api/client'
import { ConfirmDialog } from '../common/ConfirmDialog'
import type { FailedJobSummary } from '../../types'

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
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium ${color}`}>
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
}: {
  onAssistantSnapshot?: (snapshot: Record<string, unknown>) => void
}) {
  const [jobs, setJobs] = useState<FailedJobSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [actionInProgress, setActionInProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<FailedJobSummary | null>(null)

  const fetchJobs = async () => {
    try {
      const data = await getFailedJobs()
      setJobs(data)
    } catch (e: any) {
      setError(e.message || 'Failed to load failed jobs')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchJobs() }, [])

  useEffect(() => {
    if (!error) return
    const timer = setTimeout(() => setError(null), 5000)
    return () => clearTimeout(timer)
  }, [error])

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
  }), [actionInProgress, deleteTarget, error, expandedId, jobs])

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

  if (jobs.length === 0) {
    return (
      <div className="text-center py-16 bg-white rounded-lg border border-gray-200">
        <svg className="w-10 h-10 mx-auto mb-3 text-green-200" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <p className="text-gray-500 font-medium mb-1">No failed jobs</p>
        <p className="text-sm text-gray-400">All simulation jobs are healthy.</p>
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

      <div className="text-xs text-gray-400 mb-2">
        {jobs.length} failed job{jobs.length !== 1 ? 's' : ''} — retry or delete to clean up
      </div>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-red-50/50 border-b border-gray-200">
            <tr>
              <th className="text-left px-4 py-2.5 font-medium text-gray-500">Job</th>
              <th className="text-left px-4 py-2.5 font-medium text-gray-500 w-28">Gene</th>
              <th className="text-left px-4 py-2.5 font-medium text-gray-500 w-24">Condition</th>
              <th className="text-left px-4 py-2.5 font-medium text-gray-500 w-24">Phase</th>
              <th className="text-left px-4 py-2.5 font-medium text-gray-500 w-32">Failed at</th>
              <th className="text-right px-4 py-2.5 font-medium text-gray-500 w-32">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {jobs.map((job) => {
              const isExpanded = expandedId === job.id
              const isActing = actionInProgress === job.id
              return (
                <tr key={job.id} className="group">
                  <td className="px-4 py-3">
                    <button
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
                      <div className="mt-2 px-3 py-2 bg-red-50 rounded border border-red-100 text-xs text-red-700 font-mono whitespace-pre-wrap max-h-40 overflow-y-auto">
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
                        {isActing ? '...' : 'Retry'}
                      </button>
                      <button
                        onClick={() => handleDelete(job.id)}
                        disabled={isActing}
                        className="text-xs px-2.5 py-1 rounded border border-red-200 bg-red-50 text-red-700
                                   hover:bg-red-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        title="Permanently delete job and results"
                      >
                        {isActing ? '...' : 'Delete'}
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
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
