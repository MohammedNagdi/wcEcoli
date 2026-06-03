import { useState, useEffect, useCallback, useRef } from 'react'
import { Line } from 'react-chartjs-2'
import {
  getMoleculeTypes,
  getMoleculeIds,
  getMoleculeTimeseries,
  searchMolecules,
  getResultStateExplorer,
  getStoichiometryNeighborhood,
  getGene,
} from '../../api/client'
import { HelpTip } from '../common/HelpTip'
import type {
  MoleculeTypeInfo,
  MoleculeTimeseries,
  GeneDetail,
  ResultStateVariable,
  ResultStateExplorerResponse,
  StoichiometryMolecule,
  StoichiometryNeighborhoodResponse,
} from '../../types'

// Constants
const TYPE_LABELS: Record<string, string> = {
  protein: 'Proteins',
  mRNA: 'mRNAs',
  rRNA: 'rRNAs',
  mRNA_cistron: 'mRNA (cistron)',
  reaction_flux: 'Reaction fluxes',
  exchange_flux: 'Exchange fluxes',
  metabolite_delta: 'Metabolite deltas',
  metabolite_count: 'Metabolite counts',
  aa_pool: 'AA pools',
}

const CHART_COLORS = [
  '#2563eb', '#dc2626', '#059669', '#7c3aed', '#d97706',
  '#0891b2', '#be185d', '#4f46e5', '#ea580c', '#65a30d',
]

const MAX_SELECTED = 5

const ROLE_LABELS: Record<string, string> = {
  focus: 'Focus gene',
  downstream_target: 'Downstream target',
  upstream_regulator: 'Upstream regulator',
}

const STATE_TYPE_LABELS: Record<string, string> = {
  protein: 'Protein',
  mRNA: 'mRNA',
  complex: 'Complex',
  'reaction flux': 'Reaction flux',
  exchange: 'Exchange flux',
  metabolite: 'Metabolite',
  'amino acid pool': 'AA pool',
}

function formatValue(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return 'n/a'
  if (Math.abs(value) >= 1000) return value.toLocaleString(undefined, { maximumFractionDigits: 0 })
  if (Math.abs(value) >= 10) return value.toLocaleString(undefined, { maximumFractionDigits: 1 })
  return value.toLocaleString(undefined, { maximumFractionDigits: 3 })
}

function formatDeltaPct(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return 'n/a'
  const sign = value > 0 ? '+' : ''
  return sign + value.toFixed(1) + '%'
}

function variableKey(variable: ResultStateVariable) {
  return variable.molecule_type + ':' + variable.id
}

function downsample(points: { time: number; value: number }[], max = 500) {
  if (points.length <= max) return points
  const step = Math.ceil(points.length / max)
  return points.filter((_, i) => i % step === 0)
}

function compactMoleculeId(id: string) {
  return id
    .replace(/\[CCO-CYTOSOL\]$/, '[c]')
    .replace(/\[CCO-PERI-BAC\]$/, '[p]')
    .replace(/\[CCO-EXTRACELLULAR\]$/, '[e]')
}

function formatStoichTerm(molecule: StoichiometryMolecule) {
  const coefficient = Math.abs(molecule.coefficient)
  const prefix = coefficient === 1 ? '' : coefficient.toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' '
  return prefix + compactMoleculeId(molecule.id)
}

function StoichiometryPanel({
  data,
}: {
  data: StoichiometryNeighborhoodResponse | null
}) {
  if (!data || data.reactions.length === 0) return null

  return (
    <div className="rounded-lg border border-cyan-100 bg-cyan-50/40 p-3">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-cyan-900">
            Stoichiometry neighborhood
          </div>
          <p className="mt-0.5 text-xs text-cyan-800">
            Reconstruction reactions catalyzed by {data.focus_gene}; adjacency only, not causal evidence.
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-cyan-700">
          {data.reactions.length} reaction{data.reactions.length === 1 ? '' : 's'}
        </span>
      </div>

      <div className="space-y-2">
        {data.reactions.slice(0, 6).map((reaction) => {
          const reactants = reaction.reactants.map(formatStoichTerm).join(' + ') || 'n/a'
          const products = reaction.products.map(formatStoichTerm).join(' + ') || 'n/a'
          const plottableMetabolites = [...reaction.reactants, ...reaction.products]
            .filter((molecule) => molecule.available_types.length > 0)
            .length
          return (
            <div key={reaction.id} className="rounded-md border border-cyan-100 bg-white p-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs font-semibold text-gray-900">{reaction.id}</span>
                <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">
                  {reaction.direction || 'direction n/a'}
                </span>
                {reaction.reaction_flux_available && (
                  <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-700">
                    flux plottable
                  </span>
                )}
                {plottableMetabolites > 0 && (
                  <span className="rounded bg-violet-50 px-1.5 py-0.5 text-[10px] text-violet-700">
                    {plottableMetabolites} metabolite output{plottableMetabolites === 1 ? '' : 's'}
                  </span>
                )}
              </div>
              <div className="mt-1 font-mono text-[11px] leading-5 text-gray-700">
                <span className="text-red-700">{reactants}</span>
                <span className="px-1.5 text-gray-400">-&gt;</span>
                <span className="text-emerald-700">{products}</span>
              </div>
              <div className="mt-1 truncate text-[11px] text-gray-400">
                catalysts: {reaction.catalysts.join(', ') || 'n/a'}
              </div>
            </div>
          )
        })}
      </div>

      {data.reactions.length > 6 && (
        <p className="mt-2 text-xs text-cyan-700">
          Showing first 6 of {data.reactions.length}; use reaction search for the rest.
        </p>
      )}
    </div>
  )
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

export function ResultStateExplorer({
  jobId,
  geneSymbol,
}: {
  jobId: number
  geneSymbol?: string
}) {
  const [data, setData] = useState<ResultStateExplorerResponse | null>(null)
  const [stoichiometry, setStoichiometry] = useState<StoichiometryNeighborhoodResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [plottingKey, setPlottingKey] = useState<string | null>(null)
  const [plotted, setPlotted] = useState<Record<string, MoleculeTimeseries[]>>({})

  useEffect(() => {
    if (!geneSymbol) {
      setData(null)
      setStoichiometry(null)
      setError(null)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)
    setPlotted({})

    getResultStateExplorer(jobId, geneSymbol)
      .then((response) => {
        if (!cancelled) setData(response)
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message ?? 'Failed to load result state explorer')
          setData(null)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    getStoichiometryNeighborhood(jobId, geneSymbol)
      .then((response) => {
        if (!cancelled) setStoichiometry(response)
      })
      .catch(() => {
        if (!cancelled) setStoichiometry(null)
      })

    return () => {
      cancelled = true
    }
  }, [jobId, geneSymbol])

  const togglePlot = (variable: ResultStateVariable) => {
    const key = variableKey(variable)
    if (plotted[key]) {
      setPlotted((prev) => {
        const next = { ...prev }
        delete next[key]
        return next
      })
      return
    }

    setPlottingKey(key)
    getMoleculeTimeseries(jobId, variable.molecule_type, [variable.id])
      .then((response) => {
        setPlotted((prev) => ({ ...prev, [key]: response.molecules }))
      })
      .catch(() => {
        setPlotted((prev) => ({ ...prev, [key]: [] }))
      })
      .finally(() => setPlottingKey(null))
  }

  if (!geneSymbol) return null

  if (loading) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-4 mb-4">
        <div className="flex items-center gap-2 text-gray-400 text-sm">
          <div className="w-4 h-4 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
          Resolving result-linked state variables...
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-4 mb-4">
        <p className="text-sm text-red-600">State explorer unavailable: {error}</p>
      </div>
    )
  }

  if (!data || data.variables.length === 0) return null

  const availableVariables = data.variables.filter((variable) => variable.available)
  const topVariables = availableVariables.slice(0, 16)
  const regulatoryEdges = data.edges.filter((edge) => edge.edge_type === 'regulates')

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden mb-4">
      <div className="px-4 py-3 border-b border-gray-100 bg-slate-50">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
              Result state explorer
              <HelpTip
                text="Maps the selected result gene to model state variables that can be plotted directly. Rows are grouped by biological role and ranked by absolute final-value delta versus the matching wildtype job when one is available."
                position="bottom"
              />
            </h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Focus <span className="font-mono font-medium">{data.focus_gene}</span>
              {' '}to mRNAs, proteins, complexes, and regulatory-neighborhood genes.
            </p>
          </div>
          <div className="text-right text-xs text-gray-400">
            <div>{availableVariables.length} plottable state variable{availableVariables.length === 1 ? '' : 's'}</div>
            <div>{data.wt_job_id ? 'WT job #' + data.wt_job_id : 'No WT comparison'}</div>
          </div>
        </div>
      </div>

      <div className="p-4 space-y-4">
        <StoichiometryPanel data={stoichiometry} />

        {regulatoryEdges.length > 0 && (
          <div>
            <div className="text-xs font-medium text-gray-500 mb-2">Regulatory links</div>
            <div className="flex flex-wrap gap-1.5">
              {regulatoryEdges.slice(0, 12).map((edge, index) => {
                const source = edge.source.replace(/^gene:/, '')
                const target = edge.target.replace(/^gene:/, '')
                const isActivation = edge.regulation === 'activation'
                return (
                  <span
                    key={edge.source + edge.target + index}
                    className={'inline-flex items-center gap-1.5 rounded border px-2 py-1 text-xs ' + (
                      isActivation
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                        : 'border-red-200 bg-red-50 text-red-800'
                    )}
                  >
                    <span className="font-mono">{source}</span>
                    <span>{isActivation ? 'activates' : 'represses'}</span>
                    <span className="font-mono">{target}</span>
                    {edge.log2fc != null && (
                      <span className="text-[10px] opacity-70">
                        {edge.log2fc > 0 ? '+' : ''}{edge.log2fc.toFixed(1)}
                      </span>
                    )}
                  </span>
                )
              })}
              {regulatoryEdges.length > 12 && (
                <span className="text-xs text-gray-400 py-1">
                  +{regulatoryEdges.length - 12} more
                </span>
              )}
            </div>
          </div>
        )}

        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-medium text-gray-500">Recommended state variables</div>
            <div className="text-xs text-gray-400">
              final value vs WT delta
            </div>
          </div>
          <div className="border border-gray-200 rounded-lg overflow-x-auto">
            <div className="min-w-[760px]">
              <div className="grid grid-cols-[1.1fr_1fr_1.4fr_0.9fr_0.9fr_auto] gap-3 bg-gray-50 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-gray-400">
                <span>Role</span>
                <span>Gene</span>
                <span>State variable</span>
                <span className="text-right">Final</span>
                <span className="text-right">Delta</span>
                <span />
              </div>
              {topVariables.map((variable) => {
                const key = variableKey(variable)
                const series = plotted[key]
                const datasets = series ? buildChartData(series) : []
                const unit = series?.[0]?.unit ?? 'molecules'
                const isFocus = variable.role === 'focus'
                const deltaClass = variable.delta_pct == null
                  ? 'text-gray-400'
                  : Math.abs(variable.delta_pct) < 1
                  ? 'text-gray-500'
                  : variable.delta_pct > 0
                  ? 'text-red-600'
                  : 'text-emerald-600'
                return (
                  <div key={key + variable.role} className="border-t border-gray-100 first:border-t-0">
                    <div className={'grid grid-cols-[1.1fr_1fr_1.4fr_0.9fr_0.9fr_auto] gap-3 px-3 py-2 text-xs items-center ' + (isFocus ? 'bg-amber-50/60' : 'bg-white')}>
                      <span className="text-gray-500">{ROLE_LABELS[variable.role] ?? variable.role}</span>
                      <span className="font-mono font-medium text-bio-gene">{variable.gene_symbol}</span>
                      <span className="min-w-0">
                        <span className="inline-flex max-w-full items-center gap-1.5">
                          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">
                            {STATE_TYPE_LABELS[variable.display_type] ?? variable.display_type}
                          </span>
                          <span className="truncate font-mono text-gray-800">{variable.id}</span>
                        </span>
                      </span>
                      <span className="text-right font-mono text-gray-700">{formatValue(variable.final_value)}</span>
                      <span className={'text-right font-mono font-medium ' + deltaClass}>
                        {formatDeltaPct(variable.delta_pct)}
                      </span>
                      <button
                        type="button"
                        disabled={!variable.available || plottingKey === key}
                        onClick={() => togglePlot(variable)}
                        className={'rounded px-2 py-1 text-xs font-medium transition-colors ' + (
                          variable.available
                            ? plotted[key]
                              ? 'bg-gray-900 text-white'
                              : 'bg-brand-50 text-brand-700 hover:bg-brand-100'
                            : 'bg-gray-50 text-gray-300 cursor-not-allowed'
                        )}
                      >
                        {plottingKey === key ? 'Loading' : plotted[key] ? 'Hide' : 'Plot'}
                      </button>
                    </div>
                    {series && (
                      <div className="px-3 pb-3 bg-white">
                        {datasets.length > 0 ? (
                          <MoleculeChart datasets={datasets} unit={unit} />
                        ) : (
                          <p className="text-xs text-gray-400 py-3">
                            No trajectory was returned for {variable.id}.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        {data.unavailable_count > 0 && (
          <p className="text-xs text-gray-400">
            {data.unavailable_count} linked state variable{data.unavailable_count === 1 ? '' : 's'} are cataloged but not exposed as plottable molecule outputs for this job.
          </p>
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
        <div className="w-full px-4 py-3 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
          <div className="text-left">
            <h3 className="text-sm font-semibold text-gray-800 flex items-center gap-1.5">
              Molecule Explorer
              <HelpTip text="Browse and plot time trajectories of individual proteins, mRNAs, rRNAs, and mRNA cistrons from the simulation output. Molecule IDs use EcoCyc names with compartment tags (e.g. RPOB-MONOMER[c]). You can search by gene name and it will find matching protein and mRNA IDs." position="bottom" />
            </h3>
            <p className="text-xs text-gray-400 mt-0.5">
              Search and plot any of the {totalCount} tracked proteins, mRNAs, and rRNAs
            </p>
          </div>
          <button
            type="button"
            onClick={() => setExplorerOpen(!explorerOpen)}
            className="rounded-md p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
            aria-label={explorerOpen ? 'Collapse molecule explorer' : 'Expand molecule explorer'}
          >
            <span className={'block transition-transform ' + (explorerOpen ? 'rotate-180' : '')}>
              &#9660;
            </span>
          </button>
        </div>

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
