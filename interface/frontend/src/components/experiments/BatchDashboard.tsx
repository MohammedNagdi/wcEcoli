import { useState, useEffect, useMemo, useRef } from 'react'
import { Link } from 'react-router-dom'
import { cancelBatch, deleteBatch, deleteExperiment, getBatches, getBatchDetail, resumeBatch, runBatch } from '../../api/client'
import { statusLabel, variantLabel } from '../../utils/labels'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { SearchInput } from '../common/SearchInput'
import { ExperimentDetailPanel } from './ExperimentDetailPanel'
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

export function BatchDashboard({
  initialExpandedId,
  onAssistantSnapshot,
}: {
  initialExpandedId?: string
  onAssistantSnapshot?: (snapshot: Record<string, unknown>) => void
}) {
  const [batches, setBatches] = useState<BatchSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [runningBatchId, setRunningBatchId] = useState<string | null>(null)
  const [cancellingBatchId, setCancellingBatchId] = useState<string | null>(null)
  const [resumingBatchId, setResumingBatchId] = useState<string | null>(null)
  const [runResult, setRunResult] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [expandedDetail, setExpandedDetail] = useState<BatchDetail | null>(null)
  const [deletingBatchId, setDeletingBatchId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<BatchSummary | null>(null)
  const [selectedExperiment, setSelectedExperiment] = useState<Experiment | null>(null)
  const [selectedExperimentDetailSnapshot, setSelectedExperimentDetailSnapshot] = useState<Record<string, unknown> | null>(null)
  const [deleteExperimentTarget, setDeleteExperimentTarget] = useState<Experiment | null>(null)
  const [deletingExperimentId, setDeletingExperimentId] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchBatches = async () => {
    try {
      const data = await getBatches()
      setBatches(data)
      // Also refresh expanded detail if open
      if (expandedId) {
        try {
          const detail = await getBatchDetail(expandedId)
          setExpandedDetail(detail)
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  useEffect(() => {
    setLoading(true)
    fetchBatches().finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!initialExpandedId) return
    setExpandedId(initialExpandedId)
    getBatchDetail(initialExpandedId).then(setExpandedDetail).catch(() => setExpandedDetail(null))
  }, [initialExpandedId])

  useEffect(() => {
    if (!runResult) return
    const timer = setTimeout(() => setRunResult(null), 5000)
    return () => clearTimeout(timer)
  }, [runResult])

  useEffect(() => {
    if (!selectedExperiment) setSelectedExperimentDetailSnapshot(null)
  }, [selectedExperiment])

  // Poll while any batch has active experiments
  useEffect(() => {
    const hasActive = batches.some((b) => b.queued > 0 || b.running > 0)
    if (hasActive && !pollRef.current) {
      pollRef.current = setInterval(fetchBatches, 5000)
    } else if (!hasActive && pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [batches])

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

  const handleToggleExpand = async (batchId: string) => {
    if (expandedId === batchId) {
      setExpandedId(null)
      setExpandedDetail(null)
      return
    }
    setExpandedId(batchId)
    try {
      const detail = await getBatchDetail(batchId)
      setExpandedDetail(detail)
    } catch {
      setExpandedDetail(null)
    }
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

  const handleExperimentUpdated = (updated: Experiment) => {
    setSelectedExperiment(updated)
    setExpandedDetail((current) => current
      ? {
        ...current,
        experiments: current.experiments.map((exp) => (exp.id === updated.id ? updated : exp)),
      }
      : current)
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
      if (selectedExperiment?.id === experiment.id) setSelectedExperiment(null)
      setExpandedDetail((current) => current
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

  const normalizedQuery = query.trim().toLowerCase()
  const visibleBatches = useMemo(() => (
    normalizedQuery
      ? batches.filter((batch) => batchSearchText(batch).includes(normalizedQuery))
      : batches
  ), [batches, normalizedQuery])

  const assistantSnapshot = useMemo(() => {
    const expandedBatch = expandedDetail ?? visibleBatches.find((batch) => batch.batch_id === expandedId) ?? null
    return {
      kind: 'batch_dashboard',
      query,
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
    batches.length,
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

      <section className="rounded-lg border border-gray-200 bg-white px-4 py-4">
        <div className="grid gap-3 sm:grid-cols-[minmax(220px,1fr),auto] sm:items-center">
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder="Search batch, gene, condition, protocol..."
          />
          <div className="flex items-center justify-between gap-3 text-xs text-gray-400 sm:justify-end">
            <span>
              Showing {visibleBatches.length} of {batches.length} batch{batches.length === 1 ? '' : 'es'}
            </span>
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="font-medium text-brand-600 hover:text-brand-700"
              >
                Clear
              </button>
            )}
          </div>
        </div>
      </section>

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
          onOpenExperiment={setSelectedExperiment}
          onDeleteExperiment={handleDeleteExperiment}
          onToggleExpand={handleToggleExpand}
          isRunning={runningBatchId === batch.batch_id}
          isCancelling={cancellingBatchId === batch.batch_id}
          isResuming={resumingBatchId === batch.batch_id}
          isDeleting={deletingBatchId === batch.batch_id}
          isExpanded={expandedId === batch.batch_id}
          detail={expandedId === batch.batch_id ? expandedDetail : null}
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
      {selectedExperiment && (
        <ExperimentDetailPanel
          experiment={selectedExperiment}
          onClose={() => setSelectedExperiment(null)}
          onUpdated={handleExperimentUpdated}
          onAssistantSnapshot={setSelectedExperimentDetailSnapshot}
        />
      )}
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
  detail: BatchDetail | null
}) {
  const { total, done, failed, running, queued, draft, cancelled } = batch
  const completedPct = total > 0 ? Math.round(((done + failed + cancelled) / total) * 100) : 0

  const isActive = running > 0 || queued > 0
  const allDone = draft === 0 && queued === 0 && running === 0
  const hasDraft = draft > 0
  const hasStopped = cancelled > 0
  const actionBusy = isRunning || isCancelling || isResuming || isDeleting
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
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className={`text-gray-400 text-xs transition-transform ${isExpanded ? 'rotate-90' : ''}`}>
                ▶
              </span>
              <h3 className="font-medium text-gray-900 truncate">{batch.name}</h3>
              {isActive && (
                <span className="flex items-center gap-1 text-xs text-blue-600 font-medium">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
                  Running
                </span>
              )}
              {allDone && done > 0 && (
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
                className="bg-green-500 transition-all duration-500"
                style={{ width: `${(done / total) * 100}%` }}
                title={`${done} done`}
              />
            )}
            {failed > 0 && (
              <div
                className="bg-red-400 transition-all duration-500"
                style={{ width: `${(failed / total) * 100}%` }}
                title={`${failed} failed`}
              />
            )}
            {cancelled > 0 && (
              <div
                className="bg-gray-300 transition-all duration-500"
                style={{ width: `${(cancelled / total) * 100}%` }}
                title={`${cancelled} stopped`}
              />
            )}
            {running > 0 && (
              <div
                className="bg-blue-400 animate-pulse transition-all duration-500"
                style={{ width: `${(running / total) * 100}%` }}
                title={`${running} running`}
              />
            )}
            {queued > 0 && (
              <div
                className="bg-yellow-300 transition-all duration-500"
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
                <span className="w-2 h-2 rounded-full bg-gray-300" /> {cancelled} stopped
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
            <span className="ml-auto tabular-nums">{completedPct}% complete</span>
          </div>
        </div>
      </div>

      {/* Expanded: experiment list */}
      {isExpanded && (
        <div className="border-t border-gray-200">
          {!detail ? (
            <div className="text-center py-4 text-gray-400 text-sm">
              <div className="inline-block w-4 h-4 border-2 border-brand-500 border-t-transparent rounded-full animate-spin mr-1.5" />
              Loading experiments...
            </div>
          ) : (
            <div className="max-h-[400px] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-100 sticky top-0">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium text-gray-500">Gene</th>
                    <th className="text-left px-4 py-2 font-medium text-gray-500 w-28">Condition</th>
                    <th className="text-left px-4 py-2 font-medium text-gray-500 w-24">Status</th>
                    <th className="text-left px-4 py-2 font-medium text-gray-500 w-36">Created</th>
                    <th className="w-28"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {detail.experiments.map((exp) => (
                    <tr
                      key={exp.id}
                      onClick={() => onOpenExperiment(exp)}
                      className="cursor-pointer hover:bg-gray-50"
                    >
                      <td className="px-4 py-2">
                        <span className="font-mono text-brand-700 text-xs">{exp.gene_symbol || exp.name}</span>
                      </td>
                      <td className="px-4 py-2 text-gray-600">{exp.condition}</td>
                      <td className="px-4 py-2">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${
                          STATUS_COLORS[exp.status] ?? 'bg-gray-100 text-gray-600'
                        }`}>
                          {['queued', 'running', 'running_parca', 'running_sim', 'ingesting'].includes(exp.status) && (
                            <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
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
