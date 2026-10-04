import { useState, useEffect, useMemo, useRef } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { useRegisterAssistantContext } from '../assistant/AssistantProvider'
import { getExperiments, deleteExperiment, getExperiment } from '../../api/client'
import { variantLabel, statusLabel } from '../../utils/labels'
import { ExperimentDetailPanel } from './ExperimentDetailPanel'
import { BatchDashboard } from './BatchDashboard'
import { FailedJobsPanel } from './FailedJobsPanel'
import { useNavigationGuard } from '../common/NavigationGuard'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { makeAssistantContextKey } from '../../utils/assistantContext'
import '../../styles/experiments.css'
import { ExperimentControls, ExperimentStatus, DeleteMenu, EMPTY_FILTERS, isExperimentActive, statusGroup, RequestNotice } from './ExperimentControls'
import { useExperimentResource } from './useExperimentResource'
import type { Experiment } from '../../types'

type AssistantExperimentSummary = {
  id: number
  name: string
  variant_type: string
  variant_label: string
  variant_index: number
  condition: string
  timeline: string
  status: string
  gene_symbol: string
  batch_id: string
}

type AssistantSubviewSnapshot = Record<string, unknown> & {
  selected_experiment?: AssistantExperimentSummary | null
}

function summarizeExperiment(exp: Experiment): AssistantExperimentSummary {
  return {
    id: exp.id,
    name: exp.name,
    variant_type: exp.variant_type,
    variant_label: variantLabel(exp.variant_type),
    variant_index: exp.variant_index,
    condition: exp.condition,
    timeline: exp.timeline,
    status: exp.status,
    gene_symbol: exp.gene_symbol,
    batch_id: exp.batch_id,
  }
}

const EMPTY_EXPERIMENTS: Experiment[] = []

export function ExperimentListPage() {
  const location = useLocation()
  const assistantCapturedAt = useRef(new Date().toISOString()).current
  const [searchParams, setSearchParams] = useSearchParams()
  const resource = useExperimentResource('experiments', getExperiments, (data) => data.some((exp) => isExperimentActive(exp.status)))
  const experiments = resource.data ?? EMPTY_EXPERIMENTS
  const loading = resource.loading
  const setExperiments = (update: (previous: Experiment[]) => Experiment[]) => resource.setData((previous) => update(previous ?? []))
  const requestedView = searchParams.get('view')
  const view: 'all' | 'batches' | 'failed' = requestedView === 'failed' ? 'failed' : requestedView === 'batches' || (!requestedView && searchParams.has('batch')) ? 'batches' : 'all'
  const rawSelectedId = Number(searchParams.get('experiment'))
  const selectedId = Number.isSafeInteger(rawSelectedId) && rawSelectedId > 0 ? rawSelectedId : null
  const [selectedDetail, setSelectedDetail] = useState<Experiment | null>(null)
  const [selectionError, setSelectionError] = useState<string | null>(null)
  const [selectionRetry, setSelectionRetry] = useState(0)
  const [dirty, setDirty] = useState(false)
  const deletionNavigation = useRef(false)
  const blocker = useNavigationGuard(({ currentLocation, nextLocation }) => {
    if (deletionNavigation.current) { deletionNavigation.current = false; return false }
    if (!dirty) return false
    const current = new URLSearchParams(currentLocation.search), next = new URLSearchParams(nextLocation.search)
    return currentLocation.pathname !== nextLocation.pathname || current.get('experiment') !== next.get('experiment') || current.get('view') !== next.get('view')
  })
  const [filters, setFilters] = useState({ ...EMPTY_FILTERS })
  const [ascending, setAscending] = useState(false)
  const requestNavigation = (action: () => void) => {
    action()
  }
  const selectExperiment = (id: number | null) => {
    if (id === selectedId) return
    requestNavigation(() => setSearchParams((previous) => { const next = new URLSearchParams(previous); if (id) next.set('experiment', String(id)); else next.delete('experiment'); return next }, { replace: true }))
  }
  const setView = (nextView: 'all' | 'batches' | 'failed') => requestNavigation(() => setSearchParams((previous) => {
    const next = new URLSearchParams(previous)
    next.set('view', nextView)
    next.delete('experiment')
    return next
  }))
  useEffect(() => {
    let cancelled = false
    setSelectedDetail(null); setSelectionError(null); setDetailAssistantSnapshot(null)
    if (selectedId) getExperiment(selectedId).then((data) => { if (!cancelled) setSelectedDetail(data) }).catch((error: unknown) => { if (!cancelled) setSelectionError(error instanceof Error ? error.message : 'Experiment unavailable') })
    return () => { cancelled = true }
  }, [selectedId, selectionRetry])
  const [deleteTarget, setDeleteTarget] = useState<Experiment | null>(null)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [showCreatedMessage, setShowCreatedMessage] = useState(Boolean(searchParams.get('created')))
  const [batchAssistantSnapshot, setBatchAssistantSnapshot] = useState<AssistantSubviewSnapshot | null>(null)
  const [failedAssistantSnapshot, setFailedAssistantSnapshot] = useState<AssistantSubviewSnapshot | null>(null)
  const [detailAssistantSnapshot, setDetailAssistantSnapshot] = useState<AssistantSubviewSnapshot | null>(null)
  const [createdBatchMessage, setCreatedBatchMessage] = useState(() => {
    const batchName = searchParams.get('createdBatchName')
    if (!batchName) return ''
    const count = searchParams.get('createdBatchCount') || '0'
    return `Created batch "${batchName}" with ${count} experiment${count === '1' ? '' : 's'}.`
  })
  const justCreated = searchParams.get('created')
  const createdBatchName = searchParams.get('createdBatchName')
  const createdBatchCount = searchParams.get('createdBatchCount')
  const createdBatchId = searchParams.get('batch')
  useEffect(() => {
    if (justCreated) {
      setShowCreatedMessage(true)
      const timer = setTimeout(() => setShowCreatedMessage(false), 5000)
      return () => clearTimeout(timer)
    }
  }, [justCreated])

  useEffect(() => {
    if (createdBatchName) {
      setCreatedBatchMessage(`Created batch "${createdBatchName}" with ${createdBatchCount || '0'} experiment${createdBatchCount === '1' ? '' : 's'}.`)
      const timer = setTimeout(() => setCreatedBatchMessage(''), 5000)
      return () => clearTimeout(timer)
    }
  }, [createdBatchCount, createdBatchName])

  const handleDelete = (experiment: Experiment) => {
    setDeleteTarget(experiment)
    setDeleteError(null)
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    const id = deleteTarget.id
    setDeletingId(id)
    setDeleteError(null)
    try {
      await deleteExperiment(id)
      setExperiments((prev) => prev.filter((e) => e.id !== id))
      if (selectedId === id) { deletionNavigation.current = true; selectExperiment(null) }
      setDeleteTarget(null)
    } catch (e: unknown) {
      setDeleteError('Failed to delete: ' + (e instanceof Error ? e.message : 'unknown error'))
    } finally {
      setDeletingId(null)
    }
  }

  const handleUpdated = (updated: Experiment) => {
    setExperiments((prev) => prev.map((e) => (e.id === updated.id ? updated : e)))
    setSelectedDetail((current) => current?.id === updated.id ? updated : current)
  }

  // Hide batch-created experiments from the "All experiments" tab
  const standaloneExperiments = useMemo(() => experiments.filter((e) => !e.batch_id), [experiments])
  const batchCreatedExperiments = useMemo(() => experiments.filter((e) => e.batch_id), [experiments])
  const statusCounts = useMemo(() => experiments.reduce<Record<string, number>>((acc, experiment) => {
    acc[experiment.status] = (acc[experiment.status] || 0) + 1
    return acc
  }, {}), [experiments])
  const activeExperimentCount = useMemo(() => experiments.filter((experiment) =>
    isExperimentActive(experiment.status)
  ).length, [experiments])

  // Derive selected experiment from list — auto-updates when polling refreshes
  const selectedExperiment = selectedId != null
    ? (experiments.find((e) => e.id === selectedId) ?? (selectedDetail?.id === selectedId ? selectedDetail : null)) ?? null
    : null
  const selectedAssistantExperiment = useMemo(() => selectedExperiment ? summarizeExperiment(selectedExperiment) : null, [selectedExperiment])
  const visibleExperiments = useMemo(() => standaloneExperiments.filter((exp) =>
    [exp.name, exp.description, exp.gene_symbol, exp.condition, exp.variant_type, variantLabel(exp.variant_type), exp.timeline].join(' ').toLowerCase().includes(filters.query.trim().toLowerCase())
    && (!filters.status || statusGroup(exp.status) === filters.status)
    && (!filters.type || exp.variant_type === filters.type)
    && (!filters.condition || exp.condition === filters.condition)
  ).sort((a, b) => (ascending ? 1 : -1) * (a.created_at.localeCompare(b.created_at) || a.id - b.id)), [standaloneExperiments, filters, ascending])
  const experimentsPageState = useMemo(() => {
    const standaloneSample = standaloneExperiments.slice(0, 25).map(summarizeExperiment)
    return {
      kind: 'experiments_overview',
      surface: 'experiments',
      summary: `Experiments ${view} view with ${experiments.length} total experiment${experiments.length === 1 ? '' : 's'}, ${standaloneExperiments.length} standalone, ${batchCreatedExperiments.length} batch-created, and ${activeExperimentCount} active.`,
      dirty: Boolean(deleteTarget || deletingId || deleteError),
      captured_at: assistantCapturedAt,
      view,
      route: `${location.pathname}${location.search}`,
      route_params: {
        created: justCreated || '',
        created_batch_id: createdBatchId || '',
        created_batch_name: createdBatchName || '',
        created_batch_count: createdBatchCount || '',
      },
      notices: {
        show_created_message: showCreatedMessage,
        created_batch_message: createdBatchMessage,
        delete_error: deleteError,
      },
      totals: {
        experiments: experiments.length,
        standalone: standaloneExperiments.length,
        batch_created: batchCreatedExperiments.length,
        active: activeExperimentCount,
        by_status: statusCounts,
      },
      selected_experiment: selectedAssistantExperiment,
      filters,
      matching_experiments: visibleExperiments.length,
      loading,
      request_error: resource.error,
      standalone: view === 'all'
        ? {
          selected_id: selectedId,
          sample: standaloneSample,
          sample_truncated: standaloneExperiments.length > standaloneSample.length,
          delete_target: deleteTarget ? summarizeExperiment(deleteTarget) : null,
          deleting_id: deletingId,
        }
        : null,
      batch_dashboard: view === 'batches' ? batchAssistantSnapshot : null,
      failed_jobs: view === 'failed' ? failedAssistantSnapshot : null,
      experiment_detail: selectedExperiment ? detailAssistantSnapshot : null,
    }
  }, [
    activeExperimentCount,
    assistantCapturedAt,
    batchAssistantSnapshot,
    batchCreatedExperiments.length,
    createdBatchCount,
    createdBatchId,
    createdBatchMessage,
    createdBatchName,
    deleteError,
    deleteTarget,
    deletingId,
    detailAssistantSnapshot,
    experiments.length,
    failedAssistantSnapshot,
    justCreated,
    location.pathname,
    location.search,
    selectedAssistantExperiment,
    selectedExperiment,
    selectedId,
    showCreatedMessage,
    standaloneExperiments,
    statusCounts,
    view,
    filters,
    visibleExperiments.length,
    loading,
    resource.error,
  ])
  const batchSnapshotForKey = batchAssistantSnapshot as {
    total_batches?: number
    visible_batches?: number
    expanded_batch_id?: string | null
    expanded_batch?: { expanded_experiment_count?: number } | null
  } | null
  const failedSnapshotForKey = failedAssistantSnapshot as {
    failed_job_count?: number
    expanded_job_id?: number | null
  } | null
  useRegisterAssistantContext({
    contextKey: makeAssistantContextKey([
      'experiments_overview',
      view,
      location.pathname,
      location.search,
      selectedAssistantExperiment?.id,
      selectedAssistantExperiment?.condition,
      selectedAssistantExperiment?.variant_type,
      experiments.length,
      activeExperimentCount,
      deleteTarget?.id,
      deletingId,
      Boolean(deleteError),
      detailAssistantSnapshot?.kind as string | undefined,
      batchAssistantSnapshot?.kind as string | undefined,
      failedAssistantSnapshot?.kind as string | undefined,
      batchSnapshotForKey?.total_batches,
      batchSnapshotForKey?.visible_batches,
      batchSnapshotForKey?.expanded_batch_id,
      batchSnapshotForKey?.expanded_batch?.expanded_experiment_count,
      failedSnapshotForKey?.failed_job_count,
      failedSnapshotForKey?.expanded_job_id,
      batchAssistantSnapshot?.selected_experiment && typeof batchAssistantSnapshot.selected_experiment === 'object'
        ? (batchAssistantSnapshot.selected_experiment as { id?: number }).id
        : null,
    ]),
    context: {
      assistant_surface: 'experiments',
      route: `${location.pathname}${location.search}`,
      selected_experiment: selectedAssistantExperiment?.id ?? null,
      selected_condition: selectedAssistantExperiment?.condition || null,
      selected_variant_type: selectedAssistantExperiment?.variant_type || null,
      page_state: experimentsPageState,
    },
    suggestedPrompt: `Help me review the Experiments page. Explain the ${view} view, selected experiment or batch context, queue state, redundant controls, and the next safe action.`,
  })

  const formatDate = (iso: string) => {
    if (!iso) return '—'
    const d = new Date(iso)
    return d.toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })
  }

  return <div className="experiments-page">
    <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
      <div><h1 className="text-xl font-semibold text-gray-900">Experiments</h1><p className="mt-1 text-sm text-gray-500">Find saved configurations, monitor simulations, and review results.</p></div>
      <div className="flex flex-wrap items-center gap-2"><Link className="experiment-button" to="/guide">Guide</Link><Link className="experiment-button" to="/experiments/batch">New batch</Link><Link className="experiment-button experiment-button-primary" to="/experiments/new">New experiment</Link></div>
    </header>
    {showCreatedMessage && <p role="status" className="bg-green-50 border border-green-200 text-green-700 rounded-lg px-4 py-3 text-sm mb-4">Experiment saved successfully.</p>}
    {createdBatchMessage && <p role="status" className="bg-green-50 border border-green-200 text-green-700 rounded-lg px-4 py-3 text-sm mb-4">{createdBatchMessage}</p>}
    {deleteError && <p role="alert" className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm mb-4">{deleteError}</p>}
    <div role="tablist" aria-label="Experiment views" className="experiment-tabs">
      {(['all', 'batches', 'failed'] as const).map((value, index) => <button key={value} role="tab" id={`experiments-${value}`} aria-selected={view === value} aria-controls={`catalog-${value}`} tabIndex={view === value ? 0 : -1} onClick={() => setView(value)} onKeyDown={(event) => {
        if (['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 'all' : event.key === 'End' ? 'failed' : (['all', 'batches', 'failed'] as const)[(index + (event.key === 'ArrowRight' ? 1 : 2)) % 3]; setView(next); document.getElementById(`experiments-${next}`)?.focus() }
      }}>{value === 'all' ? 'Single experiments' : value === 'batches' ? 'Batches' : 'Failed jobs'}</button>)}
    </div>
    <div className="experiment-layout" data-inspecting={selectedId != null}>
      <div className="experiment-catalog min-w-0">
        <section className="experiment-view" id="catalog-all" role="tabpanel" aria-labelledby="experiments-all" hidden={view !== 'all'}>
          <ExperimentControls label="Find an experiment" filters={filters} onChange={setFilters} types={standaloneExperiments.map((exp) => exp.variant_type)} conditions={standaloneExperiments.map((exp) => exp.condition)} count={visibleExperiments.length} total={standaloneExperiments.length} />
          <RequestNotice error={resource.error} retry={() => void resource.refresh()} />
          {loading ? <p role="status" className="p-8 text-gray-500">Loading experiments…</p> : !resource.error && standaloneExperiments.length === 0 ? <div className="bg-white border border-gray-200 rounded-lg p-8 text-center"><p>No experiments yet</p><p className="text-sm text-gray-500 my-3">Save a configuration before running a simulation.</p><Link className="experiment-button experiment-button-primary" to="/experiments/new">Design your first experiment</Link></div> : visibleExperiments.length === 0 && standaloneExperiments.length > 0 ? <p className="p-8 text-gray-500">No matching experiments. Adjust search or clear filters.</p> : standaloneExperiments.length > 0 ? <div className="experiment-table-wrap">
            <table className="experiment-table"><thead><tr><th>Name</th><th>Type</th><th>Condition</th><th>Status</th><th aria-sort={ascending ? 'ascending' : 'descending'}><button onClick={() => setAscending((value) => !value)}>Created {ascending ? '↑' : '↓'}</button></th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>{visibleExperiments.map((exp) => <tr key={exp.id} data-selected={exp.id === selectedId} onClick={() => selectExperiment(exp.id)}>
                <td><button className="text-left font-medium text-gray-900" aria-label={`Inspect ${exp.name}`} onClick={(event) => { event.stopPropagation(); selectExperiment(exp.id) }}>{exp.name}</button>{exp.gene_symbol && <p className="mt-1 text-xs text-gray-500">Gene: <span className="font-mono text-bio-gene">{exp.gene_symbol}</span>{exp.variant_type === 'gene_knockout' ? ` · Knockout index ${exp.variant_index}` : ''}</p>}</td>
                <td className="text-gray-600">{variantLabel(exp.variant_type)}</td><td className="text-gray-600">{exp.condition}</td><td><ExperimentStatus status={exp.status} /></td><td className="text-gray-500 whitespace-nowrap">{formatDate(exp.created_at)}</td><td><DeleteMenu label={exp.name} onDelete={() => handleDelete(exp)} /></td>
              </tr>)}</tbody></table>
          </div> : null}
        </section>
        <section className="experiment-view" id="catalog-batches" role="tabpanel" aria-labelledby="experiments-batches" hidden={view !== 'batches'}><BatchDashboard onExpandedChange={(id) => setSearchParams((previous) => { const next = new URLSearchParams(previous); if (id) next.set('batch', id); else next.delete('batch'); return next }, { replace: true })} active={view === 'batches'} initialExpandedId={createdBatchId || undefined} selectedExperiment={view === 'batches' ? selectedExperiment : null} selectedExperimentDetailSnapshot={detailAssistantSnapshot} onOpenExperiment={(exp) => { setExperiments((previous) => previous.some((row) => row.id === exp.id) ? previous : [...previous, exp]); selectExperiment(exp.id) }} onDeletedExperiment={(id) => { setExperiments((previous) => previous.filter((exp) => exp.id !== id)); if (selectedId === id) { deletionNavigation.current = true; selectExperiment(null) } }} onAssistantSnapshot={setBatchAssistantSnapshot} /></section>
        <section className="experiment-view" id="catalog-failed" role="tabpanel" aria-labelledby="experiments-failed" hidden={view !== 'failed'}><FailedJobsPanel experiments={experiments} active={view === 'failed'} onOpenExperiment={selectExperiment} onAssistantSnapshot={setFailedAssistantSnapshot} /></section>
      </div>
      {selectedId != null && <div className="min-w-0"><button className="experiment-button experiment-narrow-back" onClick={() => selectExperiment(null)}>← Back to experiments</button>
        {selectedExperiment ? <ExperimentDetailPanel key={selectedExperiment.id} experiment={selectedExperiment} onClose={() => selectExperiment(null)} onUpdated={handleUpdated} onDirtyChange={setDirty} onAssistantSnapshot={setDetailAssistantSnapshot} /> : <div className="experiment-inspector p-5"><button className="experiment-button mb-4" onClick={() => selectExperiment(null)}>Close experiment details</button>{selectionError ? <RequestNotice error={`Experiment unavailable: ${selectionError}`} retry={() => setSelectionRetry((value) => value + 1)} /> : <p role="status">Loading experiment details…</p>}</div>}
      </div>}
    </div>
    <ConfirmDialog open={Boolean(deleteTarget)} title="Delete experiment" message={`Delete "${deleteTarget?.name || 'this experiment'}"? Jobs and results will be removed.`} confirmLabel="Delete experiment" destructive busy={deletingId === deleteTarget?.id} onConfirm={confirmDelete} onCancel={() => { if (deletingId == null) setDeleteTarget(null) }} />
    <ConfirmDialog open={blocker.state === 'blocked'} title="Discard unsaved edits?" message="Your changes to the experiment name and description have not been saved." confirmLabel="Discard edits" cancelLabel="Keep editing" onConfirm={() => { setDirty(false); if (blocker.state === 'blocked') blocker.proceed() }} onCancel={() => { if (blocker.state === 'blocked') blocker.reset() }} />
  </div>
}
