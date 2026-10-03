import { useState, useEffect, useMemo, useRef } from 'react'
import { Link } from 'react-router-dom'
import { cancelBatch, deleteBatch, deleteExperiment, getBatches, getBatchDetail, resumeBatch, runBatch } from '../../api/client'
import { statusLabel, variantLabel } from '../../utils/labels'
import { ConfirmDialog } from '../common/ConfirmDialog'
import '../../styles/experiments.css'
import { ExperimentDetailPanel } from './ExperimentDetailPanel'
import { ExperimentControls, EMPTY_FILTERS, RequestNotice } from './ExperimentControls'
import { useExperimentResource } from './useExperimentResource'
import type { BatchSummary, BatchDetail, Experiment } from '../../types'

const STATUS_COLORS: Record<string, string> = {
  draft:        'bg-gray-100 text-gray-600',
  queued:       'bg-yellow-50 text-yellow-700',
  running:      'bg-blue-50 text-blue-700',
  running_parca: 'bg-blue-50 text-blue-700',
  running_sim:  'bg-blue-50 text-blue-700',
  ingesting:    'bg-blue-50 text-blue-700',
  done:         'bg-green-50 text-green-700',
  failed:       'bg-red-50 text-red-700',
  cancelled:    'bg-gray-100 text-gray-600',
}

function batchSearchText(batch: BatchSummary): string {
  return [
    batch.name,
    ...batch.targets,
    ...batch.variant_types,
    ...batch.variant_types.map(variantLabel),
    ...batch.conditions,
    ...batch.timelines,
  ].filter(Boolean).join(' ').toLowerCase()
}

function summarizeExperiment(exp: Experiment) {
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

export function BatchDashboard({ initialExpandedId, active = true, selectedExperiment: externalSelection = null, selectedExperimentDetailSnapshot: externalSnapshot = null, onOpenExperiment: externalOpen, onDeletedExperiment: externalDelete, onExpandedChange, onAssistantSnapshot }: {
  initialExpandedId?: string
  active?: boolean
  selectedExperiment?: Experiment | null
  selectedExperimentDetailSnapshot?: Record<string, unknown> | null
  onOpenExperiment?: (experiment: Experiment) => void
  onDeletedExperiment?: (id: number) => void
  onExpandedChange?: (id: string | null) => void
  onAssistantSnapshot?: (snapshot: Record<string, unknown>) => void
}) {
  const [internalSelection, setInternalSelection] = useState<Experiment | null>(null)
  const [internalSnapshot, setInternalSnapshot] = useState<Record<string, unknown> | null>(null)
  const selectedExperiment = externalOpen ? externalSelection : internalSelection
  const selectedExperimentDetailSnapshot = externalOpen ? externalSnapshot : internalSnapshot
  const onOpenExperiment = externalOpen ?? setInternalSelection
  const onDeletedExperiment = externalDelete ?? ((id: number) => { if (internalSelection?.id === id) setInternalSelection(null) })
  const resource = useExperimentResource('batches', getBatches, (data) => data.some((batch) => batch.queued > 0 || batch.running > 0), active)
  const batches = useMemo(() => resource.data ?? [], [resource.data])
  const loading = resource.loading
  const [runningBatchId, setRunningBatchId] = useState<string | null>(null)
  const [cancellingBatchId, setCancellingBatchId] = useState<string | null>(null)
  const [resumingBatchId, setResumingBatchId] = useState<string | null>(null)
  const [runResult, setRunResult] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(initialExpandedId ?? null)
  const detailResource = useExperimentResource(`batch:${expandedId}`, () => expandedId ? getBatchDetail(expandedId) : Promise.resolve(null), (data) => !!data && (data.queued > 0 || data.running > 0), active)
  const expandedDetail = detailResource.data
  const setExpandedDetail = detailResource.setData
  const [deletingBatchId, setDeletingBatchId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<BatchSummary | null>(null)
  const [deleteExperimentTarget, setDeleteExperimentTarget] = useState<Experiment | null>(null)
  const [deletingExperimentId, setDeletingExperimentId] = useState<number | null>(null)
  const [filters, setFilters] = useState({ ...EMPTY_FILTERS })
  const query = filters.query
  const fetchBatches = async () => { await resource.refresh(true); if (expandedId) await detailResource.refresh(true) }
  useEffect(() => { setExpandedId(initialExpandedId ?? null) }, [initialExpandedId])
  const handleRun = async (batchId: string) => {
    setRunningBatchId(batchId)
    setRunResult(null)
    try {
      const resp = await runBatch(batchId)
      setRunResult(resp.message)
      await fetchBatches()
    } catch (e: any) {
      setRunResult(`Error: ${e.message}`)
    } finally {
      setRunningBatchId(null)
    }
  }

  const handleCancel = async (batchId: string) => {
    setCancellingBatchId(batchId)
    setRunResult(null)
    try {
      const resp = await cancelBatch(batchId)
      setRunResult(resp.message)
      await fetchBatches()
    } catch (e: any) {
      setRunResult(`Error: ${e.message}`)
    } finally {
      setCancellingBatchId(null)
    }
  }

  const handleResume = async (batchId: string) => {
    setResumingBatchId(batchId)
    setRunResult(null)
    try {
      const resp = await resumeBatch(batchId)
      setRunResult(resp.message)
      await fetchBatches()
    } catch (e: any) {
      setRunResult(`Error: ${e.message}`)
    } finally {
      setResumingBatchId(null)
    }
  }

  const handleToggleExpand = (batchId: string) => {
    const next = expandedId === batchId ? null : batchId
    setExpandedId(next)
    onExpandedChange?.(next)
  }

  const handleDelete = async (batch: BatchSummary) => {
    setDeleteTarget(batch)
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    const batch = deleteTarget
    setDeletingBatchId(batch.batch_id)
    setRunResult(null)
    try {
      await deleteBatch(batch.batch_id)
      if (expandedId === batch.batch_id) {
        setExpandedId(null)
        setExpandedDetail(null)
      }
      if (selectedExperiment?.batch_id === batch.batch_id) onDeletedExperiment(selectedExperiment.id)
      onExpandedChange?.(null)
      setRunResult(`Deleted batch "${batch.name}".`)
      setDeleteTarget(null)
      await fetchBatches()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error'
      setRunResult(message.includes('409')
        ? 'Error: Cannot delete a batch with queued or running jobs. Let it finish or cancel active jobs first.'
        : `Error: ${message}`)
    } finally {
      setDeletingBatchId(null)
    }
  }

  const handleDeleteExperiment = (experiment: Experiment) => {
    setDeleteExperimentTarget(experiment)
    setRunResult(null)
  }

  const confirmDeleteExperiment = async () => {
    if (!deleteExperimentTarget) return
    const experiment = deleteExperimentTarget
    setDeletingExperimentId(experiment.id)
    setRunResult(null)
    try {
      await deleteExperiment(experiment.id)
      onDeletedExperiment(experiment.id)
      setExpandedDetail((current) => current?.batch_id === experiment.batch_id
        ? {
          ...current,
          total: Math.max(0, current.total - 1),
          experiments: current.experiments.filter((exp) => exp.id !== experiment.id),
        }
        : current)
      setDeleteExperimentTarget(null)
      setRunResult(`Deleted experiment "${experiment.name}".`)
      await fetchBatches()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error'
      setRunResult(`Error: ${message}`)
    } finally {
      setDeletingExperimentId(null)
    }
  }

  const visibleBatches = useMemo(() => batches.filter((batch) =>
    batchSearchText(batch).includes(query.trim().toLowerCase())
    && (!filters.type || batch.variant_types.includes(filters.type))
    && (!filters.condition || batch.conditions.includes(filters.condition))
    && (!filters.status || batch[filters.status as 'draft' | 'queued' | 'running' | 'done' | 'failed' | 'cancelled'] > 0)
  ).sort((a, b) => b.created_at.localeCompare(a.created_at) || a.batch_id.localeCompare(b.batch_id)), [batches, query, filters])

  const assistantSnapshot = useMemo(() => {
    const expandedBatch = expandedDetail ?? visibleBatches.find((batch) => batch.batch_id === expandedId) ?? null
    return {
      kind: 'batch_dashboard',
      query,
      filters,
      request_error: resource.error,
      total_batches: batches.length,
      visible_batches: visibleBatches.length,
      expanded_batch_id: expandedId,
      expanded_batch: expandedBatch
        ? {
          batch_id: expandedBatch.batch_id,
          name: expandedBatch.name,
          total: expandedBatch.total,
          targets: expandedBatch.targets,
          variant_types: expandedBatch.variant_types,
          conditions: expandedBatch.conditions,
          timelines: expandedBatch.timelines,
          status_counts: {
            draft: expandedBatch.draft,
            queued: expandedBatch.queued,
            running: expandedBatch.running,
            done: expandedBatch.done,
            failed: expandedBatch.failed,
            cancelled: expandedBatch.cancelled,
          },
          expanded_experiment_count: 'experiments' in expandedBatch && Array.isArray(expandedBatch.experiments)
            ? expandedBatch.experiments.length
            : 0,
        }
        : null,
      selected_experiment: selectedExperiment ? summarizeExperiment(selectedExperiment) : null,
      selected_experiment_detail: selectedExperimentDetailSnapshot,
      busy: {
        running_batch_id: runningBatchId,
        cancelling_batch_id: cancellingBatchId,
        resuming_batch_id: resumingBatchId,
        deleting_batch_id: deletingBatchId,
        deleting_experiment_id: deletingExperimentId,
      },
      latest_action_result: runResult,
      delete_target: deleteTarget
        ? {
          batch_id: deleteTarget.batch_id,
          name: deleteTarget.name,
          total: deleteTarget.total,
          draft: deleteTarget.draft,
          queued: deleteTarget.queued,
          running: deleteTarget.running,
        }
        : null,
      delete_experiment_target: deleteExperimentTarget ? summarizeExperiment(deleteExperimentTarget) : null,
      visible_batch_sample: visibleBatches.slice(0, 20).map((batch) => ({
        batch_id: batch.batch_id,
        name: batch.name,
        total: batch.total,
        targets: batch.targets.slice(0, 8),
        variant_types: batch.variant_types,
        conditions: batch.conditions,
        timelines: batch.timelines,
        status_counts: {
          draft: batch.draft,
          queued: batch.queued,
          running: batch.running,
          done: batch.done,
          failed: batch.failed,
          cancelled: batch.cancelled,
        },
      })),
      sample_truncated: visibleBatches.length > 20,
    }
  }, [
    batches,
    filters,
    resource.error,
    cancellingBatchId,
    deleteExperimentTarget,
    deleteTarget,
    deletingBatchId,
    deletingExperimentId,
    expandedDetail,
    expandedId,
    query,
    resumingBatchId,
    runResult,
    runningBatchId,
    selectedExperiment,
    selectedExperimentDetailSnapshot,
    visibleBatches,
  ])

  useEffect(() => {
    onAssistantSnapshot?.(assistantSnapshot)
  }, [assistantSnapshot, onAssistantSnapshot])

  if (loading) {
    return (
      <div className="text-center py-12 text-gray-400">
        <div className="inline-block w-5 h-5 border-2 border-brand-500 border-t-transparent rounded-full animate-spin mr-2" />
        Loading batches...
      </div>
    )
  }

  if (resource.error && batches.length === 0) return <RequestNotice error={resource.error} retry={() => void resource.refresh()} />

  if (batches.length === 0) {
    return (
      <div className="text-center py-16 bg-white rounded-lg border border-gray-200">
        <p className="text-gray-500 font-medium mb-1">No batches yet</p>
        <p className="text-sm text-gray-400 mb-4">
          Create a batch of typed experiments to get started.
        </p>
        <Link
          to="/experiments/batch"
          className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg transition-colors"
        >
          + Create your first batch
        </Link>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {runResult && (
        <div className={`rounded-lg px-4 py-3 text-sm ${
          runResult.startsWith('Error')
            ? 'bg-red-50 border border-red-200 text-red-700'
            : 'bg-green-50 border border-green-200 text-green-700'
        }`}>
          {runResult}
        </div>
      )}

      <RequestNotice error={resource.error} retry={() => void resource.refresh()} />
      <ExperimentControls label="Find a batch" filters={filters} onChange={setFilters} statusLabel="Contains status" types={batches.flatMap((batch) => batch.variant_types)} conditions={batches.flatMap((batch) => batch.conditions)} count={visibleBatches.length} total={batches.length} />
      {expandedId && <RequestNotice error={detailResource.error} retry={() => void detailResource.refresh()} />}
      {visibleBatches.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-lg border border-gray-200">
          <p className="text-gray-500 font-medium mb-1">No matching batches</p>
          <p className="text-sm text-gray-400">Adjust batch, gene, condition, protocol, or type search.</p>
        </div>
      ) : visibleBatches.map((batch) => (
        <BatchCard
          key={batch.batch_id}
          batch={batch}
          onRun={handleRun}
          onCancel={handleCancel}
          onResume={handleResume}
          onDelete={handleDelete}
          onOpenExperiment={onOpenExperiment}
          onDeleteExperiment={handleDeleteExperiment}
          onToggleExpand={handleToggleExpand}
          isRunning={runningBatchId === batch.batch_id}
          isCancelling={cancellingBatchId === batch.batch_id}
          isResuming={resumingBatchId === batch.batch_id}
          isDeleting={deletingBatchId === batch.batch_id}
          isExpanded={expandedId === batch.batch_id}
          detail={expandedId === batch.batch_id ? expandedDetail : null}
          detailError={expandedId === batch.batch_id ? detailResource.error : null}
          selectedId={selectedExperiment?.id ?? null}
        />
      ))}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Delete batch"
        message={`Delete "${deleteTarget?.name || 'this batch'}"? Experiments, jobs, and results will be removed.`}
        confirmLabel="Delete batch"
        destructive
        busy={deletingBatchId === deleteTarget?.batch_id}
        onConfirm={confirmDelete}
        onCancel={() => {
          if (deletingBatchId == null) setDeleteTarget(null)
        }}
      />
      <ConfirmDialog
        open={Boolean(deleteExperimentTarget)}
        title="Delete experiment"
        message={`Delete "${deleteExperimentTarget?.name || 'this experiment'}"? Jobs and results will be removed.`}
        confirmLabel="Delete experiment"
        destructive
        busy={deletingExperimentId === deleteExperimentTarget?.id}
        onConfirm={confirmDeleteExperiment}
        onCancel={() => {
          if (deletingExperimentId == null) setDeleteExperimentTarget(null)
        }}
      />
      {!externalOpen && internalSelection && <ExperimentDetailPanel key={internalSelection.id} experiment={internalSelection} onClose={() => setInternalSelection(null)} onUpdated={(updated) => { setInternalSelection(updated); void fetchBatches() }} onAssistantSnapshot={setInternalSnapshot} />}
    </div>
  )
}


function BatchCard({
  batch,
  onRun,
  onCancel,
  onResume,
  onDelete,
  onOpenExperiment,
  onDeleteExperiment,
  onToggleExpand,
  isRunning,
  isCancelling,
  isResuming,
  isDeleting,
  isExpanded,
  detail,
  detailError,
  selectedId,
}: {
  batch: BatchSummary
  onRun: (id: string) => void
  onCancel: (id: string) => void
  onResume: (id: string) => void
  onDelete: (batch: BatchSummary) => void
  onOpenExperiment: (experiment: Experiment) => void
  onDeleteExperiment: (experiment: Experiment) => void
  onToggleExpand: (id: string) => void
  isRunning: boolean
  isCancelling: boolean
  isResuming: boolean
  isDeleting: boolean
  isExpanded: boolean
  detailError: string | null
  selectedId: number | null
  detail: BatchDetail | null
}) {
  const { total, done, failed, running, queued, draft, cancelled } = batch


  const isActive = running > 0 || queued > 0
  const allDone = draft === 0 && queued === 0 && running === 0
  const hasDraft = draft > 0
  const hasStopped = cancelled > 0
  const actionBusy = isRunning || isCancelling || isResuming || isDeleting
  const [ascending, setAscending] = useState(false)
  const [batchMenuOpen, setBatchMenuOpen] = useState(false)
  const [openExperimentMenuId, setOpenExperimentMenuId] = useState<number | null>(null)
  const targetSummary = batch.targets.length > 0 ? batch.targets.slice(0, 4).join(', ') : 'No target gene'
  const typeSummary = batch.variant_types.map(variantLabel).join(', ')
  const conditionSummary = batch.conditions.length > 0 ? batch.conditions.join(', ') : 'No condition'

  useEffect(() => {
    if (openExperimentMenuId == null && !batchMenuOpen) return
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement
      if (!target.closest('[data-batch-card-menu]')) setBatchMenuOpen(false)
      if (!target.closest('[data-batch-experiment-menu]')) setOpenExperimentMenuId(null)
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [batchMenuOpen, openExperimentMenuId])

  const formatDate = (iso: string) => {
    if (!iso) return '-'
    const d = new Date(iso)
    return d.toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })
  }

  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      {/* Header: clickable to expand */}
      <div
        className="p-4 cursor-pointer hover:bg-gray-50 transition-colors"
        onClick={() => onToggleExpand(batch.batch_id)}
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className={`text-gray-400 text-xs transition-transform ${isExpanded ? 'rotate-90' : ''}`}>
                ▶
              </span>
              <h3 className="font-medium text-gray-900"><button aria-expanded={isExpanded} className="text-left" onClick={(event) => { event.stopPropagation(); onToggleExpand(batch.batch_id) }}>{batch.name}</button></h3>
              {isActive && (
                <span className="flex items-center gap-1 text-xs text-blue-600 font-medium">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-500 " />
                  Running
                </span>
              )}
              {allDone && done === total && total > 0 && (
                <span className="text-xs text-green-600 font-medium">Complete</span>
              )}
              {hasStopped && !isActive && (
                <span className="text-xs text-gray-600 font-medium">Stopped</span>
              )}
            </div>
            <p className="text-xs text-gray-400 mt-0.5 ml-5">
              {formatDate(batch.created_at)} · {total} experiment{total !== 1 ? 's' : ''}
            </p>
            <p className="mt-1 ml-5 truncate text-xs text-gray-500" title={`${targetSummary} | ${typeSummary} | ${conditionSummary}`}>
              {targetSummary}{batch.targets.length > 4 ? ` +${batch.targets.length - 4}` : ''} · {typeSummary} · {conditionSummary}
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
            {done > 0 && (
              <Link
                to={`/results/compare?batch=${batch.batch_id}`}
                className="px-3 py-1.5 rounded-lg text-sm font-medium text-brand-700 bg-brand-50
                           hover:bg-brand-100 border border-brand-200 transition-colors"
              >
                Compare
              </Link>
            )}
            {hasDraft && (
              <button
                onClick={() => onRun(batch.batch_id)}
                disabled={actionBusy}
                className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  actionBusy
                    ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
                    : 'bg-brand-600 hover:bg-brand-700 text-white'
                }`}
              >
                {isRunning ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Submitting...
                  </span>
                ) : (
                  `Run all (${draft} draft)`
                )}
              </button>
            )}
            {isActive && (
              <button
                onClick={() => onCancel(batch.batch_id)}
                disabled={actionBusy}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                  actionBusy
                    ? 'border-gray-200 bg-gray-100 text-gray-400 cursor-not-allowed'
                    : 'border-amber-200 bg-white text-amber-700 hover:bg-amber-50'
                }`}
              >
                {isCancelling ? 'Stopping...' : 'Stop queue'}
              </button>
            )}
            {hasStopped && (
              <button
                onClick={() => onResume(batch.batch_id)}
                disabled={actionBusy}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                  actionBusy
                    ? 'border-gray-200 bg-gray-100 text-gray-400 cursor-not-allowed'
                    : 'border-green-200 bg-white text-green-700 hover:bg-green-50'
                }`}
              >
                {isResuming ? 'Resuming...' : `Resume (${cancelled})`}
              </button>
            )}
            <div className="relative" data-batch-card-menu>
              <button
                type="button"
                onClick={() => setBatchMenuOpen((current) => !current)}
                disabled={actionBusy}
                className={`px-2.5 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                  actionBusy
                    ? 'border-gray-200 bg-gray-100 text-gray-400 cursor-not-allowed'
                    : 'border-gray-200 bg-white text-gray-500 hover:bg-gray-50 hover:text-gray-700'
                }`}
                title="More batch actions"
                aria-label="More batch actions"
                aria-expanded={batchMenuOpen}
              >
                ...
              </button>
              {batchMenuOpen && (
                <div className="absolute right-0 top-full z-20 mt-1 w-36 rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
                  <button
                    type="button"
                    onClick={() => {
                      setBatchMenuOpen(false)
                      onDelete(batch)
                    }}
                    className="w-full px-3 py-2 text-left text-xs font-medium text-red-600 hover:bg-red-50"
                  >
                    Delete batch
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Progress bar */}
        <div className="mt-3 ml-5">
          <div className="flex h-2 rounded-full bg-gray-100 overflow-hidden">
            {done > 0 && (
              <div
                className="bg-green-500 "
                style={{ width: `${(done / total) * 100}%` }}
                title={`${done} done`}
              />
            )}
            {failed > 0 && (
              <div
                className="bg-red-400 "
                style={{ width: `${(failed / total) * 100}%` }}
                title={`${failed} failed`}
              />
            )}
            {cancelled > 0 && (
              <div
                className="bg-gray-300 "
                style={{ width: `${(cancelled / total) * 100}%` }}
                title={`${cancelled} cancelled`}
              />
            )}
            {running > 0 && (
              <div
                className="bg-blue-400  "
                style={{ width: `${(running / total) * 100}%` }}
                title={`${running} running`}
              />
            )}
            {queued > 0 && (
              <div
                className="bg-yellow-300 "
                style={{ width: `${(queued / total) * 100}%` }}
                title={`${queued} queued`}
              />
            )}
          </div>

          {/* Status chips */}
          <div className="flex flex-wrap gap-3 mt-2 text-xs text-gray-500">
            {done > 0 && (
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-green-500" /> {done} done
              </span>
            )}
            {failed > 0 && (
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-red-400" /> {failed} failed
              </span>
            )}
            {cancelled > 0 && (
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-gray-300" /> {cancelled} cancelled
              </span>
            )}
            {running > 0 && (
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-blue-400" /> {running} running
              </span>
            )}
            {queued > 0 && (
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-yellow-400" /> {queued} queued
              </span>
            )}
            {draft > 0 && (
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-gray-300" /> {draft} draft
              </span>
            )}
            <span className="ml-auto tabular-nums">Finished {done + failed + cancelled} of {total}</span>
          </div>
        </div>
      </div>

      {/* Expanded: experiment list */}
      {isExpanded && (
        <div className="border-t border-gray-200">
          {detailError && !detail ? <p role="alert" className="p-4 text-sm text-red-700">Batch details unavailable. Use Retry above.</p> : !detail ? (
            <div className="text-center py-4 text-gray-400 text-sm">
              <div className="inline-block w-4 h-4 border-2 border-brand-500 border-t-transparent rounded-full animate-spin mr-1.5" />
              Loading experiments...
            </div>
          ) : (
            <div className="max-h-[400px] overflow-y-auto">
              <table className="experiment-table">
                <thead className="bg-gray-50 border-b border-gray-100 sticky top-0">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium text-gray-500">Gene</th>
                    <th className="text-left px-4 py-2 font-medium text-gray-500 w-28">Condition</th>
                    <th className="text-left px-4 py-2 font-medium text-gray-500 w-24">Status</th>
                    <th aria-sort={ascending ? 'ascending' : 'descending'} className="text-left px-4 py-2 font-medium text-gray-500 w-36"><button onClick={() => setAscending((value) => !value)}>Created {ascending ? '↑' : '↓'}</button></th>
                    <th className="w-28"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {[...detail.experiments].sort((a, b) => (ascending ? 1 : -1) * (a.created_at.localeCompare(b.created_at) || a.id - b.id)).map((exp) => (
                    <tr
                      key={exp.id}
                      onClick={() => onOpenExperiment(exp)}
                      data-selected={exp.id === selectedId}
                      className="cursor-pointer hover:bg-gray-50"
                    >
                      <td className="px-4 py-2">
                        <button className="text-left font-medium text-gray-900" onClick={(event) => { event.stopPropagation(); onOpenExperiment(exp) }}>{exp.name}</button>{exp.gene_symbol && <p className="font-mono text-bio-gene text-xs mt-1">{exp.gene_symbol}</p>}
                      </td>
                      <td className="px-4 py-2 text-gray-600">{exp.condition}</td>
                      <td className="px-4 py-2">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${
                          STATUS_COLORS[exp.status] ?? 'bg-gray-100 text-gray-600'
                        }`}>
                          {['queued', 'running', 'running_parca', 'running_sim', 'ingesting'].includes(exp.status) && (
                            <span className="w-1.5 h-1.5 rounded-full bg-current " />
                          )}
                          {statusLabel(exp.status)}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-xs text-gray-400">
                        {formatDate(exp.created_at)}
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex justify-end gap-2" onClick={(event) => event.stopPropagation()}>
                          <button
                            type="button"
                            onClick={() => onOpenExperiment(exp)}
                            className="text-xs font-medium text-brand-600 hover:text-brand-700"
                          >
                            Open
                          </button>
                          <div className="relative" data-batch-experiment-menu>
                            <button
                              type="button"
                              onClick={() => setOpenExperimentMenuId((current) => (current === exp.id ? null : exp.id))}
                              className="px-2 py-0.5 text-sm font-medium text-gray-400 hover:text-gray-700 rounded hover:bg-gray-100 transition-colors"
                              title="More actions"
                              aria-label="More experiment actions"
                              aria-expanded={openExperimentMenuId === exp.id}
                            >
                              ...
                            </button>
                            {openExperimentMenuId === exp.id && (
                              <div className="absolute right-0 top-full z-20 mt-1 w-40 rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setOpenExperimentMenuId(null)
                                    onDeleteExperiment(exp)
                                  }}
                                  className="w-full px-3 py-2 text-left text-xs font-medium text-red-600 hover:bg-red-50"
                                >
                                  Delete experiment
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
