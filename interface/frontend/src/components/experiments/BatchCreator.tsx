import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { getGenes, getConditions, getTimelines, createBatchExperiments } from '../../api/client'
import type { Gene, Condition, Timeline, BatchRequest } from '../../types'
import { useUrlWorkspaceState } from '../../hooks/useUrlWorkspaceState'

const SCREEN_PRESETS = [
  { value: '', label: 'Manual selection' },
  { value: 'all_mechanistic', label: 'All mechanistic genes' },
  { value: 'gene_knockout_category:Amino acid biosynthesis', label: 'Category: Amino acid biosynthesis' },
  { value: 'gene_knockout_category:Transcription', label: 'Category: Transcription' },
  { value: 'gene_knockout_category:Translation', label: 'Category: Translation' },
  { value: 'gene_knockout_category:Cell division', label: 'Category: Cell division' },
  { value: 'gene_knockout_category:DNA replication', label: 'Category: DNA replication' },
  { value: 'gene_knockout_category:Metabolism', label: 'Category: Metabolism' },
]

export function BatchCreator() {
  const navigate = useNavigate()
  const {
    selectedGene,
    selectedCategory,
    selectedCondition,
    setSelectedCategory,
    setSelectedCondition,
  } = useUrlWorkspaceState()

  // Data state
  const [genes, setGenes] = useState<Gene[]>([])
  const [conditions, setConditions] = useState<Condition[]>([])
  const [timelines, setTimelines] = useState<Timeline[]>([])
  const [loading, setLoading] = useState(true)

  // Selection state
  const [selectedGenes, setSelectedGenes] = useState<Set<string>>(new Set())
  const [screenPreset, setScreenPreset] = useState('')

  // Filters
  const [search, setSearch] = useState(selectedGene ?? '')
  const [categoryFilter, setCategoryFilter] = useState(selectedCategory ?? '')

  // Shared config
  const [condition, setCondition] = useState(selectedCondition || 'basal')
  const [timeline, setTimeline] = useState('')
  const [seeds, setSeeds] = useState(4)
  const [generations, setGenerations] = useState(1)
  const [lengthSec, setLengthSec] = useState(10800)
  const [description, setDescription] = useState('')
  const [includeWildtype, setIncludeWildtype] = useState(true)

  // Submit state
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<{ created: number; skipped: number; batch_id: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([
      getGenes({ mechanistic: true, page_size: 5000 }),
      getConditions(),
      getTimelines(),
    ]).then(([geneRes, conds, tls]) => {
      setGenes(geneRes.genes)
      setConditions(conds)
      setTimelines(tls)
    }).catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!selectedGene || genes.length === 0) return
    const selected = genes.find((gene) => gene.symbol === selectedGene)
    if (!selected) return

    setSearch(selected.symbol)
    setSelectedGenes((prev) => {
      if (prev.has(selected.symbol)) return prev
      const next = new Set(prev)
      next.add(selected.symbol)
      return next
    })
  }, [genes, selectedGene])

  useEffect(() => {
    const nextCategory = selectedCategory ?? ''
    if (nextCategory !== categoryFilter) {
      setCategoryFilter(nextCategory)
    }
  }, [categoryFilter, selectedCategory])

  useEffect(() => {
    if (selectedCondition && selectedCondition !== condition) {
      setCondition(selectedCondition)
    }
  }, [condition, selectedCondition])

  // Derive categories
  const categories = useMemo(() => {
    const cats = new Set(genes.map((g) => g.category))
    return Array.from(cats).sort()
  }, [genes])

  // Filtered gene list
  const filteredGenes = useMemo(() => {
    let list = genes
    if (categoryFilter) {
      list = list.filter((g) => g.category === categoryFilter)
    }
    if (search) {
      const term = search.toLowerCase()
      list = list.filter((g) => g.symbol.toLowerCase().includes(term))
    }
    return list
  }, [genes, categoryFilter, search])

  // Toggle gene selection
  function toggleGene(symbol: string) {
    setSelectedGenes((prev) => {
      const next = new Set(prev)
      if (next.has(symbol)) next.delete(symbol)
      else next.add(symbol)
      return next
    })
  }

  function selectAll() {
    setSelectedGenes(new Set(filteredGenes.map((g) => g.symbol)))
  }

  function selectNone() {
    setSelectedGenes(new Set())
  }

  function toggleFiltered() {
    const allSelected = filteredGenes.every((g) => selectedGenes.has(g.symbol))
    if (allSelected) {
      // Deselect filtered
      setSelectedGenes((prev) => {
        const next = new Set(prev)
        filteredGenes.forEach((g) => next.delete(g.symbol))
        return next
      })
    } else {
      // Select all filtered
      setSelectedGenes((prev) => {
        const next = new Set(prev)
        filteredGenes.forEach((g) => next.add(g.symbol))
        return next
      })
    }
  }

  // Submit batch
  async function handleSubmit() {
    setSubmitting(true)
    setError(null)
    setResult(null)

    const simParams = JSON.stringify({ seeds, generations, length_sec: lengthSec })

    const request: BatchRequest = {
      condition,
      timeline,
      sim_params: simParams,
      description,
      include_wildtype: includeWildtype,
    }

    if (screenPreset) {
      request.screen = screenPreset
    } else {
      request.experiments = Array.from(selectedGenes).map((symbol) => ({
        variant_type: 'gene_knockout',
        gene_symbol: symbol,
      }))
    }

    try {
      const resp = await createBatchExperiments(request)
      setResult({ created: resp.created, skipped: resp.skipped, batch_id: resp.batch_id })
    } catch (e: any) {
      setError(e.message || 'Batch creation failed')
    } finally {
      setSubmitting(false)
    }
  }

  const usingPreset = screenPreset !== ''
  const canSubmit = usingPreset || selectedGenes.size > 0

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
      </div>
    )
  }

  if (result) {
    return (
      <div className="max-w-2xl mx-auto space-y-4">
        <div className="bg-green-50 border border-green-200 rounded-lg p-6 text-center">
          <div className="text-green-800 text-lg font-semibold mb-2">
            Batch created successfully
          </div>
          <p className="text-green-700">
            {result.created} experiment{result.created !== 1 ? 's' : ''} created
            {result.skipped > 0 && ` (${result.skipped} skipped as duplicates)`}
          </p>
          <p className="text-xs text-green-600 mt-1 font-mono">
            Batch ID: {result.batch_id}
          </p>
        </div>
        <div className="flex gap-3 justify-center">
          <button
            onClick={() => {
              const nextParams = new URLSearchParams({
                created: 'batch',
                condition,
              })
              navigate(`/experiments?${nextParams.toString()}`)
            }}
            className="px-4 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg"
          >
            View experiments
          </button>
          <button
            onClick={() => { setResult(null); setSelectedGenes(new Set()); setScreenPreset(''); setTimeline('') }}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg"
          >
            Create another batch
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Batch experiment creation</h1>
        <p className="text-sm text-gray-400 mt-1">
          Select genes for knockout screening and configure shared simulation parameters.
        </p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Gene selector */}
        <div className="lg:col-span-2 space-y-4">
          {/* Preset or manual */}
          <div className="flex items-center gap-3">
            <label className="text-sm font-medium text-gray-700">Mode:</label>
            <select
              value={screenPreset}
              onChange={(e) => setScreenPreset(e.target.value)}
              className="border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              {SCREEN_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </div>

          {usingPreset ? (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-700">
              <span className="font-medium">Screen preset active:</span>{' '}
              {SCREEN_PRESETS.find((p) => p.value === screenPreset)?.label}.
              All matching genes will be included automatically. The manual gene table below is disabled.
            </div>
          ) : (
            <>
              {/* Filters */}
              <div className="flex flex-wrap items-center gap-3">
                <input
                  type="text"
                  placeholder="Search gene…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="border border-gray-300 rounded-md px-3 py-1.5 text-sm w-44 focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
                <select
                  value={categoryFilter}
                  onChange={(e) => {
                    setCategoryFilter(e.target.value)
                    setSelectedCategory(e.target.value || null)
                  }}
                  className="border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                >
                  <option value="">All categories</option>
                  {categories.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
                <button
                  onClick={toggleFiltered}
                  className="text-xs text-brand-600 hover:text-brand-800 font-medium"
                >
                  {filteredGenes.every((g) => selectedGenes.has(g.symbol))
                    ? 'Deselect shown'
                    : 'Select all shown'}
                </button>
                <button
                  onClick={selectNone}
                  className="text-xs text-gray-500 hover:text-gray-700"
                >
                  Clear all
                </button>
                <span className="text-xs text-gray-400 ml-auto">
                  {selectedGenes.size} selected · {filteredGenes.length} shown
                </span>
              </div>

              {/* Gene table */}
              <div className="border border-gray-200 rounded-lg overflow-hidden max-h-[420px] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200 sticky top-0">
                    <tr>
                      <th className="w-10 px-3 py-2">
                        <input
                          type="checkbox"
                          checked={filteredGenes.length > 0 && filteredGenes.every((g) => selectedGenes.has(g.symbol))}
                          onChange={toggleFiltered}
                          className="rounded border-gray-300"
                        />
                      </th>
                      <th className="text-left px-3 py-2 font-medium text-gray-600">Gene</th>
                      <th className="text-left px-3 py-2 font-medium text-gray-600">Category</th>
                      <th className="text-left px-3 py-2 font-medium text-gray-600 w-20">KO idx</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {filteredGenes.map((g) => (
                      <tr
                        key={g.symbol}
                        className={`cursor-pointer transition-colors ${
                          selectedGenes.has(g.symbol) ? 'bg-brand-50' : 'hover:bg-gray-50'
                        }`}
                        onClick={() => toggleGene(g.symbol)}
                      >
                        <td className="px-3 py-1.5">
                          <input
                            type="checkbox"
                            checked={selectedGenes.has(g.symbol)}
                            onChange={() => toggleGene(g.symbol)}
                            className="rounded border-gray-300"
                          />
                        </td>
                        <td className="px-3 py-1.5 font-mono text-brand-700 text-xs">
                          {g.symbol}
                        </td>
                        <td className="px-3 py-1.5 text-gray-600 text-xs truncate max-w-[180px]">
                          {g.category}
                        </td>
                        <td className="px-3 py-1.5 text-gray-400 text-xs tabular-nums">
                          {g.ko_index}
                        </td>
                      </tr>
                    ))}
                    {filteredGenes.length === 0 && (
                      <tr>
                        <td colSpan={4} className="text-center py-6 text-gray-400">
                          No mechanistic genes match filters.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        {/* Right: Config panel */}
        <div className="space-y-4">
          <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-4">
            <h3 className="text-sm font-semibold text-gray-900">Shared configuration</h3>

            <div>
              <label className="text-xs font-medium text-gray-600 block mb-1">Growth condition</label>
              <select
                value={condition}
                onChange={(e) => {
                  setCondition(e.target.value)
                  setSelectedCondition(e.target.value)
                }}
                className="w-full border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                {conditions.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}{c.doubling_time ? ` — ~${c.doubling_time.toFixed(0)} min` : ''}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-xs font-medium text-gray-600 block mb-1">Timeline (optional)</label>
              <select
                value={timeline}
                onChange={(e) => setTimeline(e.target.value)}
                className="w-full border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                <option value="">None (use condition above)</option>
                {timelines.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name.replace(/^\d+_/, '').replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
              {timeline && condition !== 'basal' && (
                <p className="text-xs text-amber-600 mt-1">Timeline overrides the condition setting</p>
              )}
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1">Seeds</label>
                <input
                  type="number"
                  min={1}
                  max={32}
                  value={seeds}
                  onChange={(e) => setSeeds(Math.max(1, Number(e.target.value)))}
                  className="w-full border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1">Generations</label>
                <input
                  type="number"
                  min={1}
                  max={8}
                  value={generations}
                  onChange={(e) => setGenerations(Math.max(1, Number(e.target.value)))}
                  className="w-full border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1">Max (s)</label>
                <input
                  type="number"
                  min={60}
                  step={60}
                  value={lengthSec}
                  onChange={(e) => setLengthSec(Math.max(60, Number(e.target.value)))}
                  className="w-full border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
                <p className="text-xs text-gray-400 mt-0.5">{(lengthSec / 3600).toFixed(1)} hr</p>
              </div>
            </div>

            <div>
              <label className="text-xs font-medium text-gray-600 block mb-1">Batch description</label>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="e.g. Full KO screen — basal condition"
                className="w-full border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>

            <div className="flex items-start gap-2.5 pt-1 border-t border-gray-100">
              <input
                type="checkbox"
                id="batch-wt"
                checked={includeWildtype}
                onChange={(e) => setIncludeWildtype(e.target.checked)}
                className="mt-0.5 rounded border-gray-300"
              />
              <label htmlFor="batch-wt" className="cursor-pointer">
                <span className="text-xs font-medium text-gray-700">Include wildtype control</span>
                <p className="text-xs text-gray-400 mt-0.5">
                  One WT simulation for {condition} media — required for comparison deltas.
                </p>
              </label>
            </div>
          </div>

          {/* Summary + submit */}
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 space-y-3">
            <h3 className="text-sm font-semibold text-gray-900">Summary</h3>
            <div className="text-sm text-gray-600 space-y-1">
              <p>
                <span className="font-medium">Genes:</span>{' '}
                {usingPreset
                  ? `Screen preset (${SCREEN_PRESETS.find((p) => p.value === screenPreset)?.label})`
                  : `${selectedGenes.size} selected`}
              </p>
              <p><span className="font-medium">Condition:</span> {condition}</p>
              {timeline && (
                <p><span className="font-medium">Timeline:</span> {timeline.replace(/^\d+_/, '').replace(/_/g, ' ')}</p>
              )}
              <p><span className="font-medium">Seeds per gene:</span> {seeds}</p>
              <p><span className="font-medium">Generations:</span> {generations}</p>
              <p><span className="font-medium">Max duration:</span> {lengthSec}s ({(lengthSec / 3600).toFixed(1)} hr)</p>
              {!usingPreset && selectedGenes.size > 0 && (
                <p className="text-xs text-gray-400 mt-2">
                  Total simulation runs: {selectedGenes.size} × {seeds} = {selectedGenes.size * seeds}
                </p>
              )}

              {/* Cost estimator */}
              {(() => {
                const geneCount = usingPreset ? 50 : selectedGenes.size  // estimate 50 for presets
                const totalRuns = geneCount * seeds + (includeWildtype ? seeds : 0)
                const estMinPerGen = 20
                const estTotal = totalRuns * generations * estMinPerGen
                const estHrs = estTotal / 60
                if (geneCount === 0) return null
                return (
                  <div className="mt-3 pt-3 border-t border-gray-200 flex items-center gap-2">
                    <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <span className="text-xs text-gray-500">
                      Est. compute: ~{estHrs < 1 ? `${estTotal} min` : `${estHrs.toFixed(1)} hr`}
                      <span className="text-gray-400 ml-1">
                        ({totalRuns} run{totalRuns > 1 ? 's' : ''} &times; ~{estMinPerGen} min/gen)
                      </span>
                    </span>
                  </div>
                )
              })()}
            </div>

            <button
              onClick={handleSubmit}
              disabled={!canSubmit || submitting}
              className={`w-full py-2.5 rounded-lg text-sm font-medium transition-colors ${
                canSubmit && !submitting
                  ? 'bg-brand-600 hover:bg-brand-700 text-white'
                  : 'bg-gray-200 text-gray-400 cursor-not-allowed'
              }`}
            >
              {submitting ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Creating\u2026
                </span>
              ) : (
                `Create batch experiments`
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
