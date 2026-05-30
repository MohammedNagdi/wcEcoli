import { useState, useEffect, useCallback, useRef } from 'react'
import { Line } from 'react-chartjs-2'
import {
  getMoleculeTypes,
  getMoleculeIds,
  getMoleculeTimeseries,
  searchMolecules,
  getGene,
} from '../../api/client'
import { HelpTip } from '../common/HelpTip'
import type {
  MoleculeTypeInfo,
  MoleculeTimeseries,
  GeneDetail,
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

// Collapsible section for molecule charts
function FocusSection({
  title,
  badge,
  defaultOpen = true,
  children,
}: {
  title: string
  badge?: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border-b border-gray-100 last:border-0">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-gray-50 transition-colors"
      >
        <span className={'text-gray-400 text-xs transition-transform ' + (open ? 'rotate-90' : '')}>&#9654;</span>
        <span className="text-xs font-medium text-gray-600">{title}</span>
        {badge && <span className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">{badge}</span>}
      </button>
      {open && <div className="px-4 pb-3">{children}</div>}
    </div>
  )
}

// Experiment Focus Panel — enriched with gene detail (complexes, downstream targets)
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
  const [complexTs, setComplexTs] = useState<MoleculeTimeseries[]>([])
  const [loading, setLoading] = useState(true)
  const [matchInfo, setMatchInfo] = useState<{ protein: string[]; mRNA: string[]; complex: string[] }>({
    protein: [], mRNA: [], complex: [],
  })
  const [geneDetail, setGeneDetail] = useState<GeneDetail | null>(null)

  useEffect(() => {
    if (!geneSymbol) {
      setProteinTs([])
      setMrnaTs([])
      setComplexTs([])
      setGeneDetail(null)
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    setProteinTs([])
    setMrnaTs([])
    setComplexTs([])
    setMatchInfo({ protein: [], mRNA: [], complex: [] })

    getGene(geneSymbol).catch(() => null)
      .then(async (detail) => {
        if (cancelled) return
        setGeneDetail(detail)

        const queries: string[] = []
        const addQuery = (value: string | null | undefined) => {
          const trimmed = value?.trim()
          if (!trimmed) return
          if (!queries.some((query) => query.toLowerCase() === trimmed.toLowerCase())) {
            queries.push(trimmed)
          }
        }

        addQuery(geneSymbol)
        if (detail?.monomer_id) {
          addQuery(detail.monomer_id.replace(/\[.*\]$/, ''))
        }
        addQuery(detail?.ecoli_id)
        if (detail?.rna_ids) {
          try {
            const parsed = JSON.parse(detail.rna_ids)
            if (Array.isArray(parsed)) {
              for (const id of parsed) {
                if (typeof id === 'string') addQuery(id.replace(/\[.*\]$/, ''))
              }
            }
          } catch {}
        }

        let complexIds: string[] = []
        if (detail?.complex_ids) {
          try {
            const parsed = JSON.parse(detail.complex_ids)
            if (Array.isArray(parsed)) {
              complexIds = parsed
                .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
                .map((id) => id.trim())
                .map((id) => id.includes('[') ? id : id + '[c]')
                .slice(0, 5)
              for (const id of complexIds) {
                addQuery(id.replace(/\[.*\]$/, ''))
              }
            }
          } catch {}
        }

        const searchResponses = await Promise.all(
          queries.map((query) =>
            searchMolecules(jobId, query).catch(() => ({
              query,
              results: {} as Record<string, string[]>,
              total_matches: 0,
            }))
          )
        )
        if (cancelled) return

        const allResults: Record<string, string[]> = {}
        for (const res of searchResponses) {
          for (const [mtype, ids] of Object.entries(res.results)) {
            if (!allResults[mtype]) allResults[mtype] = []
            for (const id of ids) {
              if (!allResults[mtype].includes(id)) allResults[mtype].push(id)
            }
          }
        }

        const proteinIds = (allResults.protein ?? []).slice(0, 3)
        const directMrnaIds = (allResults.mRNA ?? []).slice(0, 3)
        const cistronMrnaIds = (allResults.mRNA_cistron ?? []).slice(
          0,
          Math.max(0, 3 - directMrnaIds.length)
        )
        const mrnaIds = [...directMrnaIds, ...cistronMrnaIds]

        setMatchInfo({ protein: proteinIds, mRNA: mrnaIds, complex: complexIds })

        const promises: Promise<any>[] = []

        if (proteinIds.length > 0) {
          promises.push(
            getMoleculeTimeseries(jobId, 'protein', proteinIds)
              .then((r) => { if (!cancelled) setProteinTs(r.molecules) })
              .catch(() => { if (!cancelled) setProteinTs([]) })
          )
        }
        if (mrnaIds.length > 0) {
          const mrnaFetches: Promise<MoleculeTimeseries[]>[] = []
          if (directMrnaIds.length > 0) {
            mrnaFetches.push(
              getMoleculeTimeseries(jobId, 'mRNA', directMrnaIds)
                .then((r) => r.molecules)
                .catch(() => [])
            )
          }
          if (cistronMrnaIds.length > 0) {
            mrnaFetches.push(
              getMoleculeTimeseries(jobId, 'mRNA_cistron', cistronMrnaIds)
                .then((r) => r.molecules)
                .catch(() => [])
            )
          }
          promises.push(
            Promise.all(mrnaFetches)
              .then((responses) => {
                if (!cancelled) setMrnaTs(responses.flat())
              })
          )
        }
        if (complexIds.length > 0) {
          promises.push(
            getMoleculeTimeseries(jobId, 'protein', complexIds)
              .then((r) => { if (!cancelled) setComplexTs(r.molecules) })
              .catch(() => { if (!cancelled) setComplexTs([]) })
          )
        }

        await Promise.all(promises)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
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

  if (proteinTs.length === 0 && mrnaTs.length === 0 && complexTs.length === 0) return null

  const proteinDatasets = buildChartData(proteinTs)
  const mrnaDatasets = buildChartData(mrnaTs)
  const complexDatasets = buildChartData(complexTs)

  const isKnockout = variantType === 'gene_knockout'
  const label = isKnockout ? 'Knockout target' : 'Experiment focus'

  // Downstream targets (genes this TF regulates)
  const targets = geneDetail?.regulates ?? []
  // Upstream regulators
  const regulators = geneDetail?.regulated_by ?? []

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden mb-4">
      <div className="px-4 py-3 border-b border-gray-100 bg-amber-50">
        <div className="flex items-center gap-2">
          <span className="text-sm">&#9888;&#65039;</span>
          <h3 className="text-sm font-semibold text-amber-900">
            {label}: <span className="font-mono">{geneSymbol}</span>
            {geneDetail?.monomer_name && (
              <span className="font-normal text-amber-700 ml-1">({geneDetail.monomer_name})</span>
            )}
          </h3>
        </div>
        <p className="text-xs text-amber-700 mt-0.5">
          {isKnockout
            ? 'Expression of ' + geneSymbol + ' was knocked out. Showing protein, mRNA' + (complexDatasets.length > 0 ? ', complex' : '') + ' trajectories across all generations.'
            : 'Molecule trajectories related to this experiment\'s gene of interest.'}
        </p>
        {/* Gene product summary badges */}
        <div className="flex flex-wrap gap-1.5 mt-2">
          {geneDetail?.monomer_id && (
            <span className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-mono">
              {geneDetail.monomer_id}
            </span>
          )}
          {matchInfo.mRNA.map((id) => (
            <span key={id} className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-mono">
              {id.replace(/\[.*\]$/, '')}
            </span>
          ))}
          {matchInfo.complex.length > 0 && (
            <span className="text-[10px] bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">
              {matchInfo.complex.length} complex{matchInfo.complex.length > 1 ? 'es' : ''}
            </span>
          )}
          {targets.length > 0 && (
            <span className="text-[10px] bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded">
              TF &#8594; {targets.length} target{targets.length > 1 ? 's' : ''}
            </span>
          )}
        </div>
      </div>

      <div>
        {/* Protein */}
        {proteinDatasets.length > 0 && (
          <FocusSection
            title={'Protein — ' + matchInfo.protein.map((id) => id.replace(/\[.*\]$/, '')).join(', ')}
            badge="molecules"
          >
            <MoleculeChart datasets={proteinDatasets} unit="molecules" />
          </FocusSection>
        )}

        {/* mRNA */}
        {mrnaDatasets.length > 0 && (
          <FocusSection
            title={'mRNA — ' + matchInfo.mRNA.map((id) => id.replace(/\[.*\]$/, '')).join(', ')}
            badge="molecules"
          >
            <MoleculeChart datasets={mrnaDatasets} unit="molecules" />
          </FocusSection>
        )}

        {/* Complexes */}
        {complexDatasets.length > 0 && (
          <FocusSection
            title={'Complexes — ' + matchInfo.complex.map((id) => id.replace(/\[.*\]$/, '')).join(', ')}
            badge="molecules"
            defaultOpen={false}
          >
            <MoleculeChart datasets={complexDatasets} unit="molecules" />
          </FocusSection>
        )}

        {/* Downstream TF targets */}
        {targets.length > 0 && (
          <FocusSection
            title={'Downstream targets (' + targets.length + ' genes regulated by ' + geneSymbol + ')'}
            defaultOpen={false}
          >
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-1.5">
              {targets.slice(0, 20).map((t: any, i: number) => (
                <div key={i} className="flex items-center gap-1.5 text-xs px-2 py-1 rounded bg-gray-50">
                  <span className="font-mono font-medium text-bio-gene">{t.target}</span>
                  <span className={'text-[10px] px-1 rounded ' + (
                    t.type === 'activator' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'
                  )}>
                    {t.type === 'activator' ? '+' : '−'}
                  </span>
                  <span className="text-gray-400 font-mono text-[10px] ml-auto">
                    {t.log2fc > 0 ? '+' : ''}{t.log2fc.toFixed(1)}
                  </span>
                </div>
              ))}
            </div>
            {targets.length > 20 && (
              <p className="text-xs text-gray-400 mt-1.5">
                and {targets.length - 20} more target{targets.length - 20 > 1 ? 's' : ''}...
              </p>
            )}
            {isKnockout && (
              <p className="text-xs text-amber-600 mt-2 bg-amber-50 rounded px-2 py-1.5">
                &#9888; Knocking out {geneSymbol} affects expression of these {targets.length} downstream gene{targets.length > 1 ? 's' : ''}.
                Consider checking their protein levels in the explorer below.
              </p>
            )}
          </FocusSection>
        )}

        {/* Upstream regulators */}
        {regulators.length > 0 && (
          <FocusSection
            title={'Regulated by (' + regulators.length + ' TF' + (regulators.length > 1 ? 's' : '') + ')'}
            defaultOpen={false}
          >
            <div className="flex flex-wrap gap-1.5">
              {regulators.map((r: any, i: number) => (
                <span key={i} className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-gray-50">
                  <span className="font-mono font-medium text-bio-gene">{r.tf}</span>
                  <span className={'text-[10px] px-1 rounded ' + (
                    r.type === 'activator' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'
                  )}>
                    {r.type === 'activator' ? '+' : '−'}
                  </span>
                </span>
              ))}
            </div>
          </FocusSection>
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
  const [explorerOpen, setExplorerOpen] = useState(variantType === 'gene_knockout')
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
