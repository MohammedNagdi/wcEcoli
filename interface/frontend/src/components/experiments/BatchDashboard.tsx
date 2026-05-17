import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { getBatches, getBatchDetail, runBatch } from '../../api/client'
import { statusLabel } from '../../utils/labels'
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
}

export function BatchDashboard() {
  const [batches, setBatches] = useState<BatchSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [runningBatchId, setRunningBatchId] = useState<string | null>(null)
  const [runResult, setRunResult] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [expandedDetail, setExpandedDetail] = useState<BatchDetail | null>(null)
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
          Create a batch of gene knockout experiments to get started.
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

      {batches.map((batch) => (
        <BatchCard
          key={batch.batch_id}
          batch={batch}
          onRun={handleRun}
          onToggleExpand={handleToggleExpand}
          isRunning={runningBatchId === batch.batch_id}
          isExpanded={expandedId === batch.batch_id}
          detail={expandedId === batch.batch_id ? expandedDetail : null}
        />
      ))}
    </div>
  )
}


function BatchCard({
  batch,
  onRun,
  onToggleExpand,
  isRunning,
  isExpanded,
  detail,
}: {
  batch: BatchSummary
  onRun: (id: string) => void
  onToggleExpand: (id: string) => void
  isRunning: boolean
  isExpanded: boolean
  detail: BatchDetail | null
}) {
  const { total, done, failed, running, queued, draft } = batch
  const completedPct = total > 0 ? Math.round(((done + failed) / total) * 100) : 0

  const isActive = running > 0 || queued > 0
  const allDone = draft === 0 && queued === 0 && running === 0
  const hasDraft = draft > 0

  const formatDate = (iso: string) => {
    if (!iso) return '—'
    const d = new Date(iso)
    return d.toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })
  }

  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      {/* Header — clickable to expand */}
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
            </div>
            <p className="text-xs text-gray-400 mt-0.5 ml-5">
              {formatDate(batch.created_at)} · {total} experiment{total !== 1 ? 's' : ''}
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
                disabled={isRunning}
                className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  isRunning
                    ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
                    : 'bg-brand-600 hover:bg-brand-700 text-white'
                }`}
              >
                {isRunning ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Submitting…
                  </span>
                ) : (
                  `Run all (${draft} draft)`
                )}
              </button>
            )}
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
              Loading experiments…
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
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {detail.experiments.map((exp) => (
                    <tr key={exp.id} className="hover:bg-gray-50">
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
