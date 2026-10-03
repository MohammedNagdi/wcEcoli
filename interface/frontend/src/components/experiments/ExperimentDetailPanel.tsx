import { useState, useEffect, useMemo, useRef } from 'react'
import { Link } from 'react-router-dom'
import { updateExperiment, runExperiment, getJobs, getExperiment, cancelJob } from '../../api/client'
import { variantLabel } from '../../utils/labels'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { WorkspaceHelp } from '../workspace/WorkspaceHelp'
import { ExperimentStatus, isExperimentActive, RequestNotice } from './ExperimentControls'
import { useExperimentResource } from './useExperimentResource'
import type { Experiment, SimulationJob } from '../../types'

const EMPTY_JOBS: SimulationJob[] = []
interface Props {
  experiment: Experiment
  onClose: () => void
  onUpdated: (exp: Experiment) => void
  onDirtyChange?: (dirty: boolean) => void
  onAssistantSnapshot?: (snapshot: Record<string, unknown>) => void
}

export function ExperimentDetailPanel({ experiment, onClose, onUpdated, onDirtyChange, onAssistantSnapshot }: Props) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(experiment.name)
  const [description, setDescription] = useState(experiment.description)
  const [saving, setSaving] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [showLogs, setShowLogs] = useState<number | null>(null)
  const [tab, setTab] = useState<'overview' | 'jobs'>('overview')
  const [actionError, setActionError] = useState<string | null>(null)
  const [cancelTarget, setCancelTarget] = useState<SimulationJob | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const live = useRef(true)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  const dirty = editing && (name.trim() !== experiment.name || description.trim() !== experiment.description)
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false) }, [dirty, onDirtyChange])
  useEffect(() => {
    if (!dirty) return
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', unload)
    return () => window.removeEventListener('beforeunload', unload)
  }, [dirty])
  useEffect(() => { if (!editing) { setName(experiment.name); setDescription(experiment.description) } }, [experiment.name, experiment.description, editing])
  const jobResource = useExperimentResource(`jobs:${experiment.id}`, () => getJobs({ experiment_id: experiment.id }), (data) => isExperimentActive(experiment.status) || data.some((job) => isExperimentActive(job.status)))
  const jobs = jobResource.data ?? EMPTY_JOBS
  const isActive = isExperimentActive
  const canRun = ['draft', 'failed', 'done'].includes(experiment.status)
  const parsedParams = useMemo(() => {
    try { const data = JSON.parse(experiment.sim_params || '{}'); return data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : null } catch { return null }
  }, [experiment.sim_params])
  const params = parsedParams ?? {}
  const seedSpec = params.seed_values ?? params.seeds ?? (params.seed != null ? [params.seed] : null)
  const seedText = Array.isArray(seedSpec) ? `${seedSpec.length} (values: ${seedSpec.join(', ')})` : String(seedSpec ?? 'Not specified')
  const formatDate = (iso: string) => iso ? new Date(iso).toLocaleString() : '—'
  const fail = (error: unknown) => { if (live.current) setActionError(error instanceof Error ? error.message : 'Action failed') }
  const handleSave = async () => {
    if (saving || !name.trim()) return
    setSaving(true); setActionError(null)
    try { const updated = await updateExperiment(experiment.id, { name: name.trim(), description: description.trim() }); if (live.current) { onUpdated(updated); setEditing(false) } }
    catch (error) { fail(error) }
    finally { if (live.current) setSaving(false) }
  }
  const handleRun = async () => {
    if (submitting) return
    setSubmitting(true); setActionError(null)
    try { await runExperiment(experiment.id); const updated = await getExperiment(experiment.id); if (live.current) { onUpdated(updated); setTab('jobs'); await jobResource.refresh(true) } }
    catch (error) { fail(error) }
    finally { if (live.current) setSubmitting(false) }
  }
  const handleCancel = async () => {
    if (!cancelTarget || cancelling) return
    setCancelling(true); setActionError(null)
    try { await cancelJob(cancelTarget.id); if (live.current) { setCancelTarget(null); await jobResource.refresh(true) } }
    catch (error) { fail(error) }
    finally { if (live.current) setCancelling(false) }
  }
  const assistantSnapshot = useMemo(() => {
    const jobStatusCounts = jobs.reduce<Record<string, number>>((acc, job) => {
      acc[job.status] = (acc[job.status] || 0) + 1
      return acc
    }, {})
    return {
      kind: 'experiment_detail',
      experiment: {
        id: experiment.id,
        name: experiment.name,
        variant_type: experiment.variant_type,
        variant_label: variantLabel(experiment.variant_type),
        variant_index: experiment.variant_index,
        condition: experiment.condition,
        timeline: experiment.timeline,
        status: experiment.status,
        gene_symbol: experiment.gene_symbol,
        batch_id: experiment.batch_id,
      },
      editing,
      unsaved_edits: editing
        ? {
          name_changed: name.trim() !== experiment.name,
          description_changed: description.trim() !== experiment.description,
          draft_name: name.trim(),
          draft_description: description.trim(),
        }
        : null,
      saving,
      submitting,
      can_run: canRun,
      tab,
      loading_jobs: jobResource.loading,
      jobs_error: jobResource.error,
      action_error: actionError,
      visible_logs_job_id: showLogs,
      jobs: {
        total: jobs.length,
        active: jobs.filter((job) => isActive(job.status)).length,
        by_status: jobStatusCounts,
        sample: jobs.slice(0, 10).map((job) => ({
          id: job.id,
          status: job.status,
          phase: job.phase,
          seed: job.seed,
          generations: job.generations,
          condition: job.condition,
          timeline: job.timeline,
          has_log_tail: Boolean(job.log_tail),
          has_error: Boolean(job.error_message),
        })),
      },
    }
  }, [
    canRun,
    description,
    editing,
    experiment,
    jobs,
    name,
    saving,
    showLogs,
    submitting,
    tab,
    jobResource.loading,
    jobResource.error,
    actionError,
  ])

  useEffect(() => {
    onAssistantSnapshot?.(assistantSnapshot)
  }, [assistantSnapshot, onAssistantSnapshot])

  return <aside className="experiment-inspector" aria-label="Experiment details">
    <header className="experiment-inspector-header">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0"><h2 className="text-lg font-semibold text-gray-900 break-words">{experiment.name}</h2><div className="mt-2"><ExperimentStatus status={experiment.status} /></div></div>
        <button onClick={onClose} className="experiment-button" aria-label="Close experiment details">×</button>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {editing ? <><button className="experiment-button experiment-button-primary" disabled={saving || !name.trim()} onClick={handleSave}>{saving ? 'Saving…' : 'Save'}</button><button className="experiment-button" disabled={saving} onClick={() => { setEditing(false); setName(experiment.name); setDescription(experiment.description); setActionError(null) }}>Discard edits</button></> : <>
          {canRun && <button className="experiment-button experiment-button-primary" disabled={submitting} onClick={handleRun}>{submitting ? 'Submitting…' : 'Run simulation'}</button>}
          <button className="experiment-button" disabled={submitting} onClick={() => { setTab('overview'); setEditing(true) }}>Edit</button>
          <Link className="experiment-button" to={`/experiments/new?duplicate=${experiment.id}`}>Duplicate</Link>
        </>}
      </div>
      <div role="tablist" aria-label="Experiment detail sections" className="experiment-tabs mt-3 mb-0">
        {(['overview', 'jobs'] as const).map((value) => <button key={value} id={`detail-${value}`} role="tab" aria-selected={tab === value} aria-controls={`panel-${value}`} tabIndex={tab === value ? 0 : -1} onKeyDown={(event) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = value === 'overview' ? 'jobs' : 'overview'; setTab(next); document.getElementById(`detail-${next}`)?.focus() } }} onClick={() => setTab(value)}>{value === 'overview' ? 'Overview' : `Simulation jobs (${jobs.length})`}</button>)}
      </div>
    </header>
    <div className="experiment-inspector-body space-y-4">
      {actionError && <div role="alert" className="p-3 rounded-lg border border-red-200 bg-red-50 text-sm text-red-700">{actionError}</div>}
      <section id="panel-overview" role="tabpanel" aria-labelledby="detail-overview" hidden={tab !== 'overview'} className="space-y-5">
        {editing ? <div className="space-y-3"><label className="block text-sm">Experiment name<input className="experiment-input mt-1" value={name} onChange={(event) => setName(event.target.value)} required /></label><label className="block text-sm">Description<textarea className="experiment-input mt-1" value={description} onChange={(event) => setDescription(event.target.value)} rows={4} /></label></div> : <p className="text-sm text-gray-600">{experiment.description || 'No description provided.'}</p>}
        <h3 className="font-medium text-gray-900">Configuration</h3>
        <dl className="experiment-facts">
          <div><dt>Experiment type</dt><dd>{variantLabel(experiment.variant_type)}</dd></div>
          <div><dt>{experiment.variant_type === 'gene_knockout' ? 'Knockout index' : 'Parameter index'}</dt><dd className="font-mono">{experiment.variant_index}</dd></div>
          {experiment.gene_symbol && <div><dt>Gene targets</dt><dd className="font-mono text-bio-gene">{experiment.gene_symbol}</dd></div>}
          <div><dt>Condition</dt><dd>{experiment.condition || 'basal'}</dd></div>
          <div><dt>Seeds <WorkspaceHelp label="Seeds and generations">Seeds are independent random replicates. Generations specify sequential cell divisions. The time limit applies to each simulated cell, rather than a promised job runtime.</WorkspaceHelp></dt><dd className="font-mono">{seedText}</dd></div>
          <div><dt>Generations</dt><dd className="font-mono">{String(params.generations ?? 'Not specified')}</dd></div>
          <div><dt>Maximum cell time</dt><dd>{typeof params.length_sec === 'number' ? `${params.length_sec.toLocaleString()} s (${(params.length_sec / 3600).toFixed(1)} hr)` : 'Not specified'}</dd></div>
          <div><dt>Created</dt><dd>{formatDate(experiment.created_at)}</dd></div>
          {experiment.updated_at && <div><dt>Updated</dt><dd>{formatDate(experiment.updated_at)}</dd></div>}
        </dl>
        <details className="experiment-disclosure"><summary>Media protocol</summary><div className="mt-3 text-sm whitespace-pre-wrap">{experiment.timeline || 'No explicit protocol stored.'}</div></details>
        <details className="experiment-disclosure"><summary>Technical details</summary><div className="mt-3 space-y-3 text-sm"><p>Experiment #{experiment.id}{experiment.batch_id && ` · Batch ${experiment.batch_id}`}</p><p>Variant: <span className="font-mono">{experiment.variant_type}[{experiment.variant_index}]</span></p>{parsedParams === null && <p role="alert" className="text-red-700">Stored simulation parameters are not a valid JSON object.</p>}<pre className="font-mono text-xs whitespace-pre-wrap">{parsedParams ? JSON.stringify(parsedParams, null, 2) : experiment.sim_params}</pre></div></details>
      </section>
      <section id="panel-jobs" role="tabpanel" aria-labelledby="detail-jobs" hidden={tab !== 'jobs'} className="space-y-3">
        <RequestNotice error={jobResource.error} retry={() => void jobResource.refresh()} />
        {jobResource.loading ? <p role="status">Loading simulation jobs…</p> : !jobResource.error && jobs.length === 0 ? <p className="text-sm text-gray-500">No simulation jobs yet. Run this configuration when it is ready.</p> : null}
        {jobs.map((job) => <article key={job.id} className="border border-gray-200 rounded-lg p-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-medium">Job #{job.id}</h3><ExperimentStatus status={job.status} /></div>
          <p className="text-sm text-gray-600">{job.phase || 'No phase reported.'}</p>
          <p className="text-xs text-gray-500">Seed {job.seed} · {job.generations} generations</p>
          {job.started_at && <p className="text-xs text-gray-500">Started {formatDate(job.started_at)}</p>}
          {job.finished_at && <p className="text-xs text-gray-500">Finished {formatDate(job.finished_at)}</p>}
          {job.error_message && <p className="text-sm text-red-700 bg-red-50 rounded p-2 whitespace-pre-wrap">{job.error_message}</p>}
          <div className="flex flex-wrap gap-2">
            {job.status === 'done' && <Link className="experiment-button" to={`/results/${job.id}`}>Results</Link>}
            {job.log_tail && <button className="experiment-button" aria-expanded={showLogs === job.id} onClick={() => setShowLogs(showLogs === job.id ? null : job.id)}>{showLogs === job.id ? 'Hide logs' : 'Logs'}</button>}
            {isActive(job.status) && <button className="experiment-button" disabled={cancelling || job.status === 'cancelling'} onClick={() => setCancelTarget(job)}>{job.status === 'cancelling' ? 'Stopping…' : 'Cancel'}</button>}
          </div>
          {showLogs === job.id && <pre className="font-mono text-xs bg-gray-950 text-gray-100 p-3 rounded max-h-64 overflow-auto whitespace-pre-wrap" tabIndex={0} aria-label={`Logs for job ${job.id}`}>{job.log_tail}</pre>}
        </article>)}
      </section>
    </div>
    <ConfirmDialog open={!!cancelTarget} title="Cancel simulation job" message={`Stop job #${cancelTarget?.id}? This requests cancellation of the running or queued simulation.`} confirmLabel="Cancel job" cancelLabel="Keep running" busy={cancelling} onConfirm={handleCancel} onCancel={() => setCancelTarget(null)} />
  </aside>
}
