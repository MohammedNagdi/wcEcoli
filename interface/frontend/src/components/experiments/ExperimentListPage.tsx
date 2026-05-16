import { useState, useEffect, useRef } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { getExperiments, deleteExperiment } from '../../api/client'
import { variantLabel, statusLabel } from '../../utils/labels'
import { ExperimentDetailPanel } from './ExperimentDetailPanel'
import type { Experiment } from '../../types'

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

export function ExperimentListPage() {
  const [experiments, setExperiments] = useState<Experiment[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [searchParams] = useSearchParams()
  const justCreated = searchParams.get('created')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchAll = async () => {
    try {
      const data = await getExperiments()
      setExperiments(data)
    } catch { /* ignore */ }
  }

  useEffect(() => {
    setLoading(true)
    fetchAll().finally(() => setLoading(false))
  }, [])

  // Poll while any experiment is active
  useEffect(() => {
    const hasActive = experiments.some((e) =>
      ['queued', 'running', 'running_parca', 'running_sim', 'ingesting'].includes(e.status)
    )
    if (hasActive && !pollRef.current) {
      pollRef.current = setInterval(fetchAll, 5000)
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
  }, [experiments])

  const handleDelete = async (id: number) => {
    if (!window.confirm('Delete this experiment? This cannot be undone.')) return
    await deleteExperiment(id)
    setExperiments((prev) => prev.filter((e) => e.id !== id))
    if (selectedId === id) setSelectedId(null)
  }

  const handleUpdated = (updated: Experiment) => {
    setExperiments((prev) => prev.map((e) => (e.id === updated.id ? updated : e)))
  }

  // Derive selected experiment from list — auto-updates when polling refreshes
  const selectedExperiment = selectedId != null
    ? experiments.find((e) => e.id === selectedId) ?? null
    : null

  const formatDate = (iso: string) => {
    if (!iso) return '—'
    const d = new Date(iso)
    return d.toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })
  }

  return (
    <div className="flex gap-6 h-[calc(100vh-65px)]">
    <div className="flex-1 min-w-0 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Experiments</h1>
          <p className="text-sm text-gray-400">
            Saved simulation configurations
          </p>
        </div>
        <Link
          to="/experiments/new"
          className="px-4 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700
                     rounded-lg transition-colors"
        >
          + New experiment
        </Link>
      </div>

      {justCreated && (
        <div className="bg-green-50 border border-green-200 text-green-700 rounded-lg px-4 py-3 text-sm mb-4">
          Experiment saved successfully.
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-gray-400">
          <div className="inline-block w-5 h-5 border-2 border-brand-500 border-t-transparent rounded-full animate-spin mr-2" />
          Loading experiments...
        </div>
      ) : experiments.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-lg border border-gray-200">
          <svg className="w-10 h-10 mx-auto mb-3 text-gray-200" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
          </svg>
          <p className="text-gray-500 font-medium mb-1">No experiments yet</p>
          <p className="text-sm text-gray-400 mb-4">
            Configure a simulation variant, pick a growth condition, and save.
          </p>
          <Link
            to="/experiments/new"
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg transition-colors"
          >
            + Design your first experiment
          </Link>
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium text-gray-500">Name</th>
                <th className="text-left px-4 py-2.5 font-medium text-gray-500 w-36">Type</th>
                <th className="text-left px-4 py-2.5 font-medium text-gray-500 w-28">Condition</th>
                <th className="text-left px-4 py-2.5 font-medium text-gray-500 w-20">Status</th>
                <th className="text-left px-4 py-2.5 font-medium text-gray-500 w-36">Created</th>
                <th className="w-16"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {experiments.map((exp) => (
                <tr
                  key={exp.id}
                  onClick={() => setSelectedId(exp.id === selectedId ? null : exp.id)}
                  className={`cursor-pointer transition-colors ${
                    exp.id === selectedId ? 'bg-brand-50' : 'hover:bg-gray-50'
                  }`}
                >
                  <td className="px-4 py-3">
                    <p className="font-medium text-gray-900">{exp.name}</p>
                    {exp.gene_symbol && (
                      <p className="text-xs text-gray-400 mt-0.5">
                        Gene: <span className="font-mono text-bio-gene">{exp.gene_symbol}</span>
                        {' '}(KO #{exp.variant_index})
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-600">
                    {variantLabel(exp.variant_type)}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{exp.condition}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium ${
                      STATUS_COLORS[exp.status] ?? 'bg-gray-100 text-gray-600'
                    }`}>
                      {['queued', 'running', 'running_parca', 'running_sim', 'ingesting'].includes(exp.status) && (
                        <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
                      )}
                      {statusLabel(exp.status)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-400">
                    {formatDate(exp.created_at)}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDelete(exp.id) }}
                      className="text-gray-300 hover:text-red-500 transition-colors"
                      title="Delete"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>

    {/* Detail panel */}
    {selectedExperiment && (
      <ExperimentDetailPanel
        experiment={selectedExperiment}
        onClose={() => setSelectedId(null)}
        onUpdated={handleUpdated}
      />
    )}
    </div>
  )
}
