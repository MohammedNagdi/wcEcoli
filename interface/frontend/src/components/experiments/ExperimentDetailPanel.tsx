import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { updateExperiment, runExperiment, getJobs, getExperiment, cancelJob } from '../../api/client'
import { variantLabel, statusLabel } from '../../utils/labels'
import type { Experiment, SimulationJob } from '../../types'

const STATUS_COLORS: Record<string, string> = {
  draft:   'bg-gray-100 text-gray-600',
  queued:  'bg-yellow-50 text-yellow-700',
  running: 'bg-blue-50 text-blue-700',
  done:    'bg-green-50 text-green-700',
  failed:  'bg-red-50 text-red-700',
}

const JOB_STATUS_COLORS: Record<string, string> = {
  pending:       'bg-yellow-50 text-yellow-700',
  running_parca: 'bg-blue-50 text-blue-700',
  running_sim:   'bg-blue-50 text-blue-700',
  ingesting:     'bg-purple-50 text-purple-700',
  done:          'bg-green-50 text-green-700',
  failed:        'bg-red-50 text-red-700',
}

interface Props {
  experiment: Experiment
  onClose: () => void
  onUpdated: (exp: Experiment) => void
}

export function ExperimentDetailPanel({ experiment, onClose, onUpdated }: Props) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(experiment.name)
  const [description, setDescription] = useState(experiment.description)
  const [saving, setSaving] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [jobs, setJobs] = useState<SimulationJob[]>([])
  const [showLogs, setShowLogs] = useState<number | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Sync internal state when experiment prop changes (e.g. from list polling)
  useEffect(() => {
    if (!editing) {
      setName(experiment.name)
      setDescription(experiment.description)
    }
  }, [experiment.id, experiment.name, experiment.description, editing])

  const simParams = (() => {
    try { return JSON.parse(experiment.sim_params || '{}') }
    catch { return {} }
  })()

  // Fetch jobs for this experiment and poll if any are active
  useEffect(() => {
    let cancelled = false
    const fetchJobs = async () => {
      try {
        const data = await getJobs({ experiment_id: experiment.id })
        if (!cancelled) setJobs(data)
      } catch { /* ignore */ }
    }
    fetchJobs()

    // Poll while experiment is queued or running
    const active = ['queued', 'running'].includes(experiment.status)
    if (active) {
      pollRef.current = setInterval(fetchJobs, 5000)
    }
    return () => {
      cancelled = true
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [experiment.id, experiment.status])

  const handleSave = async () => {
    setSaving(true)
    try {
      const updated = await updateExperiment(experiment.id, {
        name: name.trim(),
        description: description.trim(),
      })
      onUpdated(updated)
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  const handleRun = async () => {
    setSubmitting(true)
    try {
      await runExperiment(experiment.id)
      // Refresh experiment status from server
      const updated = await getExperiment(experiment.id)
      onUpdated(updated)
      // Fetch new jobs
      const data = await getJobs({ experiment_id: experiment.id })
      setJobs(data)
    } catch (err) {
      alert(`Failed to submit: ${err instanceof Error ? err.message : err}`)
    } finally {
      setSubmitting(false)
    }
  }

  const handleCancel = async (jobId: number) => {
    if (!window.confirm('Cancel this simulation job?')) return
    try {
      await cancelJob(jobId)
      const data = await getJobs({ experiment_id: experiment.id })
      setJobs(data)
    } catch { /* ignore */ }
  }

  const formatDate = (iso: string) => {
    if (!iso) return '—'
    return new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  }

  const isActive = (s: string) =>
    ['pending', 'running_parca', 'running_sim', 'ingesting'].includes(s)

  const canRun = experiment.status === 'draft' || experiment.status === 'failed' || experiment.status === 'done'

  return (
    <div className="border-l border-gray-200 bg-white w-[420px] flex-shrink-0 overflow-y-auto p-5">
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex-1 min-w-0">
          {editing ? (
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full text-lg font-semibold text-gray-900 border border-gray-200 rounded px-2 py-1
                         focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500"
            />
          ) : (
            <h2 className="text-lg font-semibold text-gray-900 truncate">{experiment.name}</h2>
          )}
          <span className={`inline-flex mt-1 px-2 py-0.5 rounded text-xs font-medium ${
            STATUS_COLORS[experiment.status] ?? 'bg-gray-100 text-gray-600'
          }`}>
            {statusLabel(experiment.status)}
          </span>
        </div>
        <button
          onClick={onClose}
          className="ml-2 text-gray-400 hover:text-gray-600 transition-colors"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Description */}
      <div className="mb-5">
        <label className="text-xs text-gray-400 block mb-1">Description</label>
        {editing ? (
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="w-full border border-gray-200 rounded px-2 py-1.5 text-sm resize-none
                       focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500"
          />
        ) : (
          <p className="text-sm text-gray-600">
            {experiment.description || <span className="italic text-gray-300">No description</span>}
          </p>
        )}
      </div>

      {/* Configuration grid */}
      <div className="bg-gray-50 rounded-lg p-4 mb-5">
        <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-3">Configuration</h3>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-gray-400">Experiment type</dt>
          <dd className="font-medium text-gray-700">{variantLabel(experiment.variant_type)}</dd>

          {experiment.variant_type !== 'wildtype' && (
            <>
              <dt className="text-gray-400">{experiment.gene_symbol ? 'KO index' : 'Parameter index'}</dt>
              <dd className="font-mono text-gray-700">{experiment.variant_index}</dd>
            </>
          )}

          {experiment.gene_symbol && (
            <>
              <dt className="text-gray-400">Gene</dt>
              <dd>
                <span className="font-mono font-medium text-bio-gene">{experiment.gene_symbol}</span>
              </dd>
            </>
          )}

          <dt className="text-gray-400">Condition</dt>
          <dd className="text-gray-700">{experiment.condition || 'basal'}</dd>

          {experiment.timeline && (
            <>
              <dt className="text-gray-400">Timeline</dt>
              <dd className="text-gray-700">{experiment.timeline}</dd>
            </>
          )}
        </dl>
      </div>

      {/* Simulation parameters */}
      {Object.keys(simParams).length > 0 && (
        <div className="bg-gray-50 rounded-lg p-4 mb-5">
          <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-3">Simulation parameters</h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            {simParams.seeds != null && (
              <>
                <dt className="text-gray-400">Seeds</dt>
                <dd className="font-mono text-gray-700">{simParams.seeds}</dd>
              </>
            )}
            {simParams.generations != null && (
              <>
                <dt className="text-gray-400">Generations</dt>
                <dd className="font-mono text-gray-700">{simParams.generations}</dd>
              </>
            )}
            {simParams.length_sec != null && (
              <>
                <dt className="text-gray-400">Duration</dt>
                <dd className="font-mono text-gray-700">
                  {simParams.length_sec}s ({(simParams.length_sec / 3600).toFixed(1)} hr)
                </dd>
              </>
            )}
            {Object.entries(simParams)
              .filter(([k]) => !['seeds', 'length_sec', 'generations'].includes(k))
              .map(([k, v]) => (
                <span key={k} className="contents">
                  <dt className="text-gray-400">{k.replace(/_/g, ' ')}</dt>
                  <dd className="font-mono text-gray-700">{String(v)}</dd>
                </span>
              ))
            }
          </dl>
        </div>
      )}

      {/* Simulation Jobs */}
      {jobs.length > 0 && (
        <div className="mb-5">
          <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-3">Simulation jobs</h3>
          <div className="space-y-2">
            {jobs.map((job) => (
              <div key={job.id} className="border border-gray-200 rounded-lg p-3">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono text-gray-400">#{job.id}</span>
                    <span className={`inline-flex px-1.5 py-0.5 rounded text-xs font-medium ${
                      JOB_STATUS_COLORS[job.status] ?? 'bg-gray-100 text-gray-600'
                    }`}>
                      {job.status.replace(/_/g, ' ')}
                    </span>
                    {isActive(job.status) && (
                      <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    {job.status === 'done' && (
                      <Link
                        to={`/results/${job.id}`}
                        className="text-xs text-brand-600 hover:text-brand-700 px-1 font-medium"
                      >
                        Results
                      </Link>
                    )}
                    {job.log_tail && (
                      <button
                        onClick={() => setShowLogs(showLogs === job.id ? null : job.id)}
                        className="text-xs text-gray-400 hover:text-gray-600 px-1"
                        title="Toggle logs"
                      >
                        {showLogs === job.id ? 'Hide logs' : 'Logs'}
                      </button>
                    )}
                    {isActive(job.status) && (
                      <button
                        onClick={() => handleCancel(job.id)}
                        className="text-xs text-red-400 hover:text-red-600 px-1"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                </div>
                <p className="text-xs text-gray-500">{job.phase}</p>
                <div className="flex gap-3 mt-1 text-xs text-gray-400">
                  <span>seed {job.seed}</span>
                  <span>{job.generations} gen</span>
                  {job.started_at && <span>started {formatDate(job.started_at)}</span>}
                </div>
                {job.error_message && (
                  <p className="mt-1 text-xs text-red-600 bg-red-50 rounded px-2 py-1">{job.error_message}</p>
                )}
                {showLogs === job.id && job.log_tail && (
                  <pre className="mt-2 text-xs bg-gray-900 text-gray-300 rounded p-2 overflow-x-auto max-h-48 overflow-y-auto font-mono">
                    {job.log_tail}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Timestamps */}
      <div className="text-xs text-gray-400 space-y-1 mb-5">
        <p>Created: {formatDate(experiment.created_at)}</p>
        {experiment.updated_at && experiment.updated_at !== experiment.created_at && (
          <p>Updated: {formatDate(experiment.updated_at)}</p>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        {editing ? (
          <>
            <button
              onClick={handleSave}
              disabled={saving || !name.trim()}
              className="px-3 py-1.5 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700
                         rounded-lg transition-colors disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button
              onClick={() => { setEditing(false); setName(experiment.name); setDescription(experiment.description) }}
              className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            {canRun && (
              <button
                onClick={handleRun}
                disabled={submitting}
                className="px-3 py-1.5 text-sm font-medium text-white bg-green-600 hover:bg-green-700
                           rounded-lg transition-colors disabled:opacity-50 flex items-center gap-1.5"
              >
                {submitting ? (
                  <>
                    <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Submitting...
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    Run simulation
                  </>
                )}
              </button>
            )}
            <button
              onClick={() => setEditing(true)}
              className="px-3 py-1.5 text-sm text-brand-600 hover:bg-brand-50 rounded-lg transition-colors"
            >
              Edit
            </button>
            <Link
              to={`/experiments/new?variant=${experiment.variant_type}${experiment.gene_symbol ? `&gene=${experiment.gene_symbol}` : ''}`}
              className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
            >
              Duplicate
            </Link>
          </>
        )}
      </div>
    </div>
  )
}
