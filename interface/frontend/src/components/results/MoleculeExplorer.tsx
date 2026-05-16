import { useState, useEffect, useCallback, useRef } from 'react'
import { Line } from 'react-chartjs-2'
import {
  getMoleculeTypes,
  getMoleculeIds,
  getMoleculeTimeseries,
  searchMolecules,
} from '../../api/client'
import { HelpTip } from '../common/HelpTip'
import type {
  MoleculeTypeInfo,
  MoleculeTimeseries,
} from '../../types'

// Constants
const TYPE_LABELS: Record<string, string> = {
  protein: 'Proteins',
  mRNA: 'mRNAs',
  rRNA: 'rRNAs',
  mRNA_cistron: 'mRNA (cistron)',
}

const CHART_COLORS = [
  '#2563eb', '#dc2626', '#059669', '#7c3aed', '#d97706',
  '#0891b2', '#be185d', '#4f46e5', '#ea580c', '#65a30d',
]

const MAX_SELECTED = 5

function downsample(points: { time: number; value: number }[], max = 500) {
  if (points.length <= max) return points
  const step = Math.ceil(points.length / max)
  return points.filter((_, i) => i % step === 0)
}

// Shared chart builder
function buildChartData(timeseries: MoleculeTimeseries[]) {
  const grouped: Record<string, MoleculeTimeseries[]> = {}
  for (const ts of timeseries) {
    if (!grouped[ts.molecule_id]) grouped[ts.molecule_id] = []
    grouped[ts.molecule_id].push(ts)
  }

  return Object.entries(grouped).flatMap(([molId, series], molIdx) => {
    const color = CHART_COLORS[molIdx % CHART_COLORS.length]
    const sorted = [...series].sort((a, b) => a.generation - b.generation)

    if (sorted.length === 1) {
      const pts = downsample(sorted[0].points)
      return [{
        label: molId,
        data: pts.map((p) => ({ x: p.time / 60, y: p.value })),
        borderColor: color,
        backgroundColor: 'transparent',
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.3,
      }]
    }

    return sorted.map((s, genIdx) => {
      const pts = downsample(s.points)
      return {
        label: molId + ' (gen ' + s.generation + ')',
        data: pts.map((p) => ({ x: p.time / 60, y: p.value })),
        borderColor: color,
        backgroundColor: 'transparent',
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.3,
        borderDash: genIdx > 0 ? [4, 2] : undefined,
      }
    })
  })
}

function MoleculeChart({ datasets, unit }: { datasets: any[]; unit: string }) {
  if (datasets.length === 0) return null
  return (
    <div className="h-72">
      <Line
        data={{ datasets }}
        options={{
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index' as const, intersect: false },
          plugins: {
            legend: { display: true, position: 'top' as const, labels: { boxWidth: 12, font: { size: 11 } } },
            tooltip: {
              callbacks: {
                title: (items: any[]) => 't = ' + (items[0]?.parsed?.x?.toFixed(1) ?? '') + ' min',
                label: (item: any) => item.dataset.label + ': ' + (item.parsed.y ?? 0).toPrecision(4) + ' ' + unit,
              },
            },
          },
          scales: {
            x: {
              type: 'linear' as const,
              title: { display: true, text: 'Time (min)', font: { size: 11 } },
              grid: { color: 'rgba(0,0,0,0.04)' },
              ticks: { font: { size: 10 } },
            },
            y: {
              title: { display: true, text: unit, font: { size: 11 } },
              grid: { color: 'rgba(0,0,0,0.04)' },
              ticks: { font: { size: 10 } },
            },
          },
        }}
      />
    </div>
  )
}

// Experiment Focus Panel
function ExperimentFocusPanel({
  jobId,
  geneSymbol,
  variantType,
}: {
  jobId: number
  geneSymbol: string
  variantType: string
}) {
  const [proteinTs, setProteinTs] = useState<MoleculeTimeseries[]>([])
  const [mrnaTs, setMrnaTs] = useState<MoleculeTimeseries[]>([])
  const [loading, setLoading] = useState(true)
  const [matchInfo, setMatchInfo] = useState<{ protein: string[]; mRNA: string[] }>({ protein: [], mRNA: [] })

  useEffect(() => {
    if (!geneSymbol) return
    setLoading(true)

    searchMolecules(jobId, geneSymbol)
      .then(async (res) => {
        const proteinIds = (res.results.protein ?? []).slice(0, 3)
        const mrnaIds = (res.results.mRNA ?? []).slice(0, 3)
        setMatchInfo({ protein: proteinIds, mRNA: mrnaIds })

        const promises: Promise<any>[] = []

        if (proteinIds.length > 0) {
          promises.push(
            getMoleculeTimeseries(jobId, 'protein', proteinIds)
              .then((r) => setProteinTs(r.molecules))
              .catch(() => {})
          )
        }
        if (mrnaIds.length > 0) {
          promises.push(
            getMoleculeTimeseries(jobId, 'mRNA', mrnaIds)
              .then((r) => setMrnaTs(r.molecules))
              .catch(() => {})
          )
        }

        await Promise.all(promises)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [jobId, geneSymbol])

  if (loading) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-4">
        <div className="flex items-center gap-2 text-amber-700 text-sm">
          <div className="w-4 h-4 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
          Loading knockout target trajectories...
        </div>
      </div>
    )
  }

  if (proteinTs.length === 0 && mrnaTs.length === 0) return null

  const proteinDatasets = buildChartData(proteinTs)
  const mrnaDatasets = buildChartData(mrnaTs)

  const isKnockout = variantType === 'gene_knockout'
  const label = isKnockout ? 'Knockout target' : 'Experiment focus'

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden mb-4">
      <div className="px-4 py-3 border-b border-gray-100 bg-amber-50">
        <div className="flex items-center gap-2">
          <span className="text-sm">&#9888;&#65039;</span>
          <h3 className="text-sm font-semibold text-amber-900">
            {label}: <span className="font-mono">{geneSymbol}</span>
          </h3>
        </div>
        <p className="text-xs text-amber-700 mt-0.5">
          {isKnockout
            ? 'Expression of ' + geneSymbol + ' was knocked out in this experiment. These plots show the protein and mRNA levels of the targeted gene across all generations.'
            : 'Molecule trajectories related to this experiment\'s gene of interest.'}
        </p>
      </div>

      <div className="p-4">
        {proteinDatasets.length > 0 && (
          <div className="mb-4">
            <h4 className="text-xs font-medium text-gray-500 mb-2">
              Protein count &mdash; {matchInfo.protein.map((id) => id.replace(/\[.*\]$/, '')).join(', ')}
              <span className="ml-1 text-gray-400 font-normal">(molecules)</span>
            </h4>
            <MoleculeChart datasets={proteinDatasets} unit="molecules" />
          </div>
        )}
        {mrnaDatasets.length > 0 && (
          <div>
            <h4 className="text-xs font-medium text-gray-500 mb-2">
              mRNA count &mdash; {matchInfo.mRNA.map((id) => id.replace(/\[.*\]$/, '')).join(', ')}
              <span className="ml-1 text-gray-400 font-normal">(molecules)</span>
            </h4>
            <MoleculeChart datasets={mrnaDatasets} unit="molecules" />
          </div>
        )}
      </div>
    </div>
  )
}

// Main Molecule Explorer
export function MoleculeExplorer({
  jobId,
  geneSymbol,
  variantType,
}: {
  jobId: number
  geneSymbol?: string
  variantType?: string
}) {
  const [types, setTypes] = useState<MoleculeTypeInfo[]>([])
  const [activeType, setActiveType] = useState<string>('protein')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<string[]>([])
  const [searching, setSearching] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [timeseries, setTimeseries] = useState<MoleculeTimeseries[]>([])
  const [loadingTs, setLoadingTs] = useState(false)
  const [typesLoading, setTypesLoading] = useState(true)
  const [explorerOpen, setExplorerOpen] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setTypesLoading(true)
    getMoleculeTypes(jobId)
      .then((res) => {
        setTypes(res.available_types)
        if (res.available_types.length > 0) {
          setActiveType(res.available_types[0].molecule_type)
        }
      })
      .catch(() => {})
      .finally(() => setTypesLoading(false))
  }, [jobId])

  const doSearch = useCallback(
    (q: string, type: string) => {
      if (q.length < 2) {
        setSearchResults([])
        return
      }
      setSearching(true)
      getMoleculeIds(jobId, type, { search: q, limit: 50 })
        .then((res) => setSearchResults(res.ids))
        .catch(() => setSearchResults([]))
        .finally(() => setSearching(false))
    },
    [jobId]
  )

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => doSearch(searchQuery, activeType), 250)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [searchQuery, activeType, doSearch])

  useEffect(() => {
    if (selected.length === 0) {
      setTimeseries([])
      return
    }
    setLoadingTs(true)
    getMoleculeTimeseries(jobId, activeType, selected)
      .then((res) => setTimeseries(res.molecules))
      .catch(() => setTimeseries([]))
      .finally(() => setLoadingTs(false))
  }, [jobId, activeType, selected])

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id)
      if (prev.length >= MAX_SELECTED) return prev
      return [...prev, id]
    })
  }

  const clearSelection = () => {
    setSelected([])
    setTimeseries([])
  }

  const switchType = (type: string) => {
    setActiveType(type)
    setSelected([])
    setTimeseries([])
    setSearchQuery('')
    setSearchResults([])
  }

  const activeInfo = types.find((t) => t.molecule_type === activeType)
  const datasets = buildChartData(timeseries)
  const unit = timeseries[0]?.unit ?? 'molecules'

  if (typesLoading) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <div className="flex items-center gap-2 text-gray-400 text-sm">
          <div className="w-4 h-4 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
          Loading molecule data...
        </div>
      </div>
    )
  }

  if (types.length === 0) return null

  const totalCount = types.reduce((s, t) => s + t.count, 0).toLocaleString()
  const searchPlaceholder = 'Search ' + (activeInfo?.count.toLocaleString() ?? '') + ' ' + (TYPE_LABELS[activeType]?.toLowerCase() ?? 'molecules') + '...'

  return (
    <div>
      {geneSymbol && (
        <ExperimentFocusPanel
          jobId={jobId}
          geneSymbol={geneSymbol}
          variantType={variantType ?? ''}
        />
      )}

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <button
          onClick={() => setExplorerOpen(!explorerOpen)}
          className="w-full px-4 py-3 border-b border-gray-100 bg-gray-50 flex items-center justify-between hover:bg-gray-100 transition-colors"
        >
          <div className="text-left">
            <h3 className="text-sm font-semibold text-gray-800 flex items-center gap-1.5">
              Molecule Explorer
              <HelpTip text="Browse and plot time trajectories of individual proteins, mRNAs, rRNAs, and mRNA cistrons from the simulation output. Molecule IDs use EcoCyc names with compartment tags (e.g. RPOB-MONOMER[c]). You can search by gene name and it will find matching protein and mRNA IDs." position="bottom" />
            </h3>
            <p className="text-xs text-gray-400 mt-0.5">
              Search and plot any of the {totalCount} tracked proteins, mRNAs, and rRNAs
            </p>
          </div>
          <span className={'text-gray-400 transition-transform ' + (explorerOpen ? 'rotate-180' : '')}>
            &#9660;
          </span>
        </button>

        {explorerOpen && (
          <div className="p-4">
            <div className="flex gap-2 mb-3">
              {types.map((t) => (
                <button
                  key={t.molecule_type}
                  onClick={() => switchType(t.molecule_type)}
                  className={'px-3 py-1.5 rounded text-xs font-medium transition-colors ' + (
                    activeType === t.molecule_type
                      ? 'bg-brand-600 text-white'
                      : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                  )}
                >
                  {TYPE_LABELS[t.molecule_type] ?? t.molecule_type}
                  <span className="ml-1 opacity-70">({t.count.toLocaleString()})</span>
                </button>
              ))}
            </div>

            <div className="relative mb-3">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={searchPlaceholder}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500"
              />
              {searching && (
                <div className="absolute right-3 top-2.5">
                  <div className="w-4 h-4 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
                </div>
              )}
            </div>

            <div className="flex gap-4">
              <div className="flex-1 min-w-0">
                {searchQuery.length >= 2 && searchResults.length > 0 && (
                  <div className="border border-gray-200 rounded-md max-h-48 overflow-y-auto">
                    {searchResults.map((id) => {
                      const isSelected = selected.includes(id)
                      const canSelect = isSelected || selected.length < MAX_SELECTED
                      return (
                        <button
                          key={id}
                          onClick={() => canSelect && toggleSelect(id)}
                          disabled={!canSelect}
                          className={'w-full text-left px-3 py-1.5 text-xs font-mono border-b border-gray-50 last:border-0 transition-colors ' + (
                            isSelected
                              ? 'bg-brand-50 text-brand-700 font-semibold'
                              : canSelect
                              ? 'hover:bg-gray-50 text-gray-700'
                              : 'text-gray-300 cursor-not-allowed'
                          )}
                        >
                          {isSelected && <span className="mr-1.5">&#10003;</span>}
                          {id}
                        </button>
                      )
                    })}
                  </div>
                )}
                {searchQuery.length >= 2 && !searching && searchResults.length === 0 && (
                  <p className="text-xs text-gray-400 py-2">No matches for &ldquo;{searchQuery}&rdquo;</p>
                )}
                {searchQuery.length < 2 && searchQuery.length > 0 && (
                  <p className="text-xs text-gray-400 py-2">Type at least 2 characters to search</p>
                )}
              </div>

              {selected.length > 0 && (
                <div className="w-52 shrink-0">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-medium text-gray-500">
                      Selected ({selected.length}/{MAX_SELECTED})
                    </span>
                    <button onClick={clearSelection} className="text-xs text-gray-400 hover:text-red-500">
                      Clear all
                    </button>
                  </div>
                  <div className="space-y-1">
                    {selected.map((id, i) => (
                      <div key={id} className="flex items-center gap-2 px-2 py-1 rounded bg-gray-50 text-xs">
                        <span
                          className="w-2.5 h-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }}
                        />
                        <span className="font-mono truncate flex-1">{id}</span>
                        <button onClick={() => toggleSelect(id)} className="text-gray-400 hover:text-red-500 shrink-0">
                          &times;
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {selected.length > 0 && (
              <div className="mt-4">
                {loadingTs ? (
                  <div className="flex items-center justify-center h-56 text-gray-400 text-sm">
                    <div className="w-4 h-4 border-2 border-brand-500 border-t-transparent rounded-full animate-spin mr-2" />
                    Loading trajectories...
                  </div>
                ) : datasets.length > 0 ? (
                  <MoleculeChart datasets={datasets} unit={unit} />
                ) : (
                  <p className="text-xs text-gray-400 text-center py-8">
                    No timeseries data available for the selected molecules.
                  </p>
                )}
              </div>
            )}

            {selected.length === 0 && searchQuery.length === 0 && (
              <div className="text-center py-6 text-gray-400">
                <p className="text-sm">Search for a gene or protein name to plot its trajectory</p>
                <p className="text-xs mt-1">
                  e.g. <span className="font-mono">rpoB</span>, <span className="font-mono">ADHE</span>, <span className="font-mono">pfkA</span>
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
