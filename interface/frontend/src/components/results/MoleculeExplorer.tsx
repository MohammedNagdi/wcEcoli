import { useState, useEffect, useCallback, useRef } from 'react'
import { Line } from 'react-chartjs-2'
import {
  getMoleculeIds,
  getMoleculeTypes,
  getMoleculeTimeseries,
  searchMolecules,
  getResultStateExplorer,
  getStoichiometryNeighborhood,
} from '../../api/client'
import { HelpTip } from '../common/HelpTip'
import type {
  MoleculeTypeInfo,
  MoleculeTimeseries,
  ResultStateVariable,
  ResultStateExplorerResponse,
  StoichiometryMolecule,
  StoichiometryNeighborhoodResponse,
} from '../../types'
import { useTheme } from '../theme/ThemeProvider'

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

const TYPE_DESCRIPTIONS: Record<string, string> = {
  protein: 'Monomer count series from MonomerCounts.',
  mRNA: 'Transcription-unit RNA count series from RNACounts.',
  rRNA: 'Ribosomal RNA count series from RNACounts.',
  mRNA_cistron: 'Gene-level cistron RNA count series from RNACounts.',
  reaction_flux: 'Internal FBA reaction flux series.',
  exchange_flux: 'External exchange flux series.',
  metabolite_delta: 'Metabolite change series from FBAResults.',
  metabolite_count: 'Metabolite count series from EnzymeKinetics.',
  aa_pool: 'Amino-acid pool size series from GrowthLimits.',
}

const CHART_COLORS = [
  '#2563eb', '#dc2626', '#059669', '#7c3aed', '#d97706',
  '#0891b2', '#be185d', '#4f46e5', '#ea580c', '#65a30d',
]

const MAX_SELECTED = 5
const BROWSE_LIMIT = 100

type SelectedMolecule = {
  molecule_type: string
  id: string
}

function selectedKey(item: SelectedMolecule) {
  return item.molecule_type + ':' + item.id
}

function outputTypeLabel(type: string) {
  return TYPE_LABELS[type] ?? type
}

function outputSeriesTotal(types: MoleculeTypeInfo[]) {
  return types.reduce((sum, type) => sum + type.count, 0)
}

// Reaction/exchange/metabolite-delta are FBA optimization outputs; the rest are dynamic state-variable
// counts. Splitting them makes the (large, correct) total legible instead of alarming.
const FBA_OUTPUT_TYPES = new Set(['reaction_flux', 'exchange_flux', 'metabolite_delta'])

function seriesBreakdown(types: MoleculeTypeInfo[]) {
  let fba = 0
  let state = 0
  for (const t of types) {
    if (FBA_OUTPUT_TYPES.has(t.molecule_type)) fba += t.count
    else state += t.count
  }
  return { fba, state, total: fba + state }
}

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

function variableSortScore(variable: ResultStateVariable) {
  if (variable.rank_score != null && Number.isFinite(variable.rank_score)) return variable.rank_score
  if (variable.delta_pct != null && Number.isFinite(variable.delta_pct)) return Math.abs(variable.delta_pct)
  if (variable.delta != null && Number.isFinite(variable.delta)) return Math.abs(variable.delta)
  return 0
}

function variableName(variable: ResultStateVariable) {
  const type = STATE_TYPE_LABELS[variable.display_type] ?? variable.display_type
  return `${variable.gene_symbol} ${type}`
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
  const { resolvedTheme } = useTheme()
  const chartTheme = resolvedTheme === 'dark'
    ? {
      text: '#cbd5e1',
      muted: '#94a3b8',
      grid: 'rgba(148,163,184,0.18)',
      tooltipBg: '#0f172a',
      tooltipBorder: '#334155',
    }
    : {
      text: '#374151',
      muted: '#6b7280',
      grid: 'rgba(0,0,0,0.04)',
      tooltipBg: '#ffffff',
      tooltipBorder: '#e5e7eb',
    }
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
            legend: { display: true, position: 'top' as const, labels: { boxWidth: 12, font: { size: 11 }, color: chartTheme.text } },
            tooltip: {
              backgroundColor: chartTheme.tooltipBg,
              borderColor: chartTheme.tooltipBorder,
              borderWidth: 1,
              titleColor: chartTheme.text,
              bodyColor: chartTheme.text,
              callbacks: {
                title: (items: any[]) => 't = ' + (items[0]?.parsed?.x?.toFixed(1) ?? '') + ' min',
                label: (item: any) => item.dataset.label + ': ' + (item.parsed.y ?? 0).toPrecision(4) + ' ' + unit,
              },
            },
          },
          scales: {
            x: {
              type: 'linear' as const,
              title: { display: true, text: 'Time (min)', font: { size: 11 }, color: chartTheme.muted },
              grid: { color: chartTheme.grid },
              ticks: { font: { size: 10 }, color: chartTheme.muted },
            },
            y: {
              title: { display: true, text: unit, font: { size: 11 }, color: chartTheme.muted },
              grid: { color: chartTheme.grid },
              ticks: { font: { size: 10 }, color: chartTheme.muted },
            },
          },
        }}
      />
    </div>
  )
}

export function ResultStateExplorer({
  jobId,
  geneSymbol,
  variantType,
}: {
  jobId: number
  geneSymbol?: string
  variantType?: string
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
  const changedVariables = [...availableVariables]
    .filter((variable) => variableSortScore(variable) > 0)
    .sort((a, b) => variableSortScore(b) - variableSortScore(a))
    .slice(0, 3)
  const regulatoryEdges = data.edges.filter((edge) => edge.edge_type === 'regulates')
  const isGeneKnockout = variantType === 'gene_knockout'
  const focusLabel = isGeneKnockout ? 'gene knockout target' : 'experiment focus gene'

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
              Maps the {focusLabel} <span className="font-mono font-medium">{data.focus_gene}</span>
              {' '}to plottable mRNAs, proteins, complexes, reactions, metabolites, and regulatory-neighborhood genes.
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

        <div className="rounded-lg border border-indigo-100 bg-indigo-50/40 p-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-indigo-900">
                What to inspect first
              </div>
              <p className="mt-1 text-xs leading-relaxed text-indigo-800">
                Start with the largest available final-value shifts versus the matching WT. This ranks model outputs for inspection; it does not prove which molecule caused the phenotype.
              </p>
            </div>
            <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-indigo-700">
              {data.wt_job_id ? `WT job #${data.wt_job_id}` : 'No WT baseline'}
            </span>
          </div>

          {data.wt_job_id && changedVariables.length > 0 ? (
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              {changedVariables.map((variable) => {
                const key = variableKey(variable)
                const isPlotted = Boolean(plotted[key])
                return (
                  <button
                    key={`priority-${key}-${variable.role}`}
                    type="button"
                    onClick={() => togglePlot(variable)}
                    disabled={plottingKey === key}
                    className="rounded-md border border-indigo-100 bg-white px-3 py-2 text-left transition-colors hover:bg-indigo-50 disabled:cursor-wait disabled:opacity-60"
                  >
                    <span className="block truncate text-xs font-semibold text-gray-900">
                      {variableName(variable)}
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-[11px] text-gray-500">
                      {variable.id}
                    </span>
                    <span className="mt-1 flex items-center justify-between gap-2 text-[11px]">
                      <span className="text-gray-400">{ROLE_LABELS[variable.role] ?? variable.role}</span>
                      <span className="font-mono font-semibold text-indigo-700">
                        {formatDeltaPct(variable.delta_pct)}
                      </span>
                    </span>
                    <span className="mt-1 block text-[11px] font-medium text-brand-700">
                      {plottingKey === key ? 'Loading...' : isPlotted ? 'Hide plot' : 'Plot this output'}
                    </span>
                  </button>
                )
              })}
            </div>
          ) : (
            <p className="mt-3 rounded-md border border-indigo-100 bg-white px-3 py-2 text-xs text-indigo-800">
              {data.wt_job_id
                ? 'No shifted linked outputs were detected in the final-value comparison. Use the table below for absolute trajectories.'
                : 'No condition-matched WT job is available, so linked outputs are shown without relative prioritization.'}
            </p>
          )}
        </div>

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
                        <span className="mt-0.5 block truncate text-[10px] text-gray-400">
                          output table: {outputTypeLabel(variable.molecule_type)}
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
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<Record<string, string[]>>({})
  const [searching, setSearching] = useState(false)
  const [selected, setSelected] = useState<SelectedMolecule[]>([])
  const [timeseries, setTimeseries] = useState<MoleculeTimeseries[]>([])
  const [loadingTs, setLoadingTs] = useState(false)
  const [typesLoading, setTypesLoading] = useState(true)
  const [explorerOpen, setExplorerOpen] = useState(false)
  const [browseType, setBrowseType] = useState<string | null>(null)
  const [browseSearch, setBrowseSearch] = useState('')
  const [browseIds, setBrowseIds] = useState<string[]>([])
  const [browseCount, setBrowseCount] = useState(0)
  const [browseLoading, setBrowseLoading] = useState(false)
  const [browseError, setBrowseError] = useState<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const browseDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setTypesLoading(true)
    getMoleculeTypes(jobId)
      .then((res) => {
        setTypes(res.available_types)
      })
      .catch(() => {})
      .finally(() => setTypesLoading(false))
  }, [jobId])

  useEffect(() => {
    if (!browseType || !explorerOpen) return
    if (browseDebounceRef.current) clearTimeout(browseDebounceRef.current)
    browseDebounceRef.current = setTimeout(() => {
      setBrowseLoading(true)
      setBrowseError(null)
      getMoleculeIds(jobId, browseType, {
        search: browseSearch.trim() || undefined,
        limit: BROWSE_LIMIT,
      })
        .then((res) => {
          setBrowseIds(res.ids)
          setBrowseCount(res.count)
        })
        .catch((err) => {
          setBrowseIds([])
          setBrowseCount(0)
          setBrowseError(err.message ?? 'Failed to load output IDs')
        })
        .finally(() => setBrowseLoading(false))
    }, 200)

    return () => {
      if (browseDebounceRef.current) clearTimeout(browseDebounceRef.current)
    }
  }, [jobId, browseType, browseSearch, explorerOpen])

  async function loadMoreBrowse() {
    if (!browseType || browseLoading) return
    setBrowseLoading(true)
    try {
      const res = await getMoleculeIds(jobId, browseType, {
        search: browseSearch.trim() || undefined,
        limit: BROWSE_LIMIT,
        offset: browseIds.length,
      })
      setBrowseIds((prev) => [...prev, ...res.ids])
      setBrowseCount(res.count)
    } catch (err) {
      setBrowseError(err instanceof Error ? err.message : 'Failed to load more output IDs')
    } finally {
      setBrowseLoading(false)
    }
  }

  const doSearch = useCallback(
    (q: string) => {
      if (q.length < 2) {
        setSearchResults({})
        return
      }
      setSearching(true)
      searchMolecules(jobId, q)
        .then((res) => setSearchResults(res.results))
        .catch(() => setSearchResults({}))
        .finally(() => setSearching(false))
    },
    [jobId]
  )

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => doSearch(searchQuery.trim()), 250)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [searchQuery, doSearch])

  useEffect(() => {
    if (selected.length === 0) {
      setTimeseries([])
      return
    }
    setLoadingTs(true)
    const grouped = selected.reduce<Record<string, string[]>>((acc, item) => {
      if (!acc[item.molecule_type]) acc[item.molecule_type] = []
      acc[item.molecule_type].push(item.id)
      return acc
    }, {})

    Promise.all(
      Object.entries(grouped).map(([moleculeType, ids]) =>
        getMoleculeTimeseries(jobId, moleculeType, ids)
          .then((res) => res.molecules)
          .catch(() => [])
      )
    )
      .then((responses) => setTimeseries(responses.flat()))
      .catch(() => setTimeseries([]))
      .finally(() => setLoadingTs(false))
  }, [jobId, selected])

  const toggleSelect = (item: SelectedMolecule) => {
    const key = selectedKey(item)
    setSelected((prev) => {
      if (prev.some((x) => selectedKey(x) === key)) return prev.filter((x) => selectedKey(x) !== key)
      if (prev.length >= MAX_SELECTED) return prev
      return [...prev, item]
    })
  }

  const clearSelection = () => {
    setSelected([])
    setTimeseries([])
  }

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

  const breakdown = seriesBreakdown(types)
  const totalCount = breakdown.total.toLocaleString()
  const searchPlaceholder = 'Search a gene, protein/metabolite name, reaction, or output ID...'
  const resultGroups = Object.entries(searchResults).filter(([, ids]) => ids.length > 0)
  const selectedBrowseType = types.find((type) => type.molecule_type === browseType)
  const suggestedSearches = [
    geneSymbol ? { term: geneSymbol, description: 'Focus gene symbol' } : null,
    { term: 'GLC', description: 'Glucose metabolite/output search' },
    { term: 'ACET', description: 'Acetate metabolite/output search' },
    { term: 'FBA', description: 'Flux-balance analysis outputs and objective' },
    { term: 'RNA', description: 'RNA output families and RNA IDs' },
  ].filter((item): item is { term: string; description: string } => Boolean(item))

  return (
    <div>
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="w-full px-4 py-3 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
          <div className="text-left">
            <h3 className="text-sm font-semibold text-gray-800 flex items-center gap-1.5">
              Molecule Explorer
              <HelpTip text="Advanced output-series search. Search by gene symbol, EcoCyc ID, protein, metabolite, reaction, or raw output ID. Counts below are plottable simulation output series, not unique biological molecules." position="bottom" />
            </h3>
            <p className="text-xs text-gray-400 mt-0.5">
              {totalCount} plottable output series for this cell —{' '}
              <span className="text-gray-500">{breakdown.state.toLocaleString()} state-variable counts</span>{' '}+{' '}
              <span className="text-gray-500">{breakdown.fba.toLocaleString()} FBA flux/delta terms</span>.
              <HelpTip
                text="Per-cell count of distinct plottable series — not a total across seeds, generations, or other runs (it's the same for every result). It exceeds the number of distinct biological molecules because mRNA is offered at both transcription-unit and gene/cistron level, and reversible reactions appear as forward+reverse fluxes. Plotting one molecule returns one trajectory per cell lineage (seeds × generations)."
                position="bottom"
              />
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
            <div className="mb-3 rounded-lg border border-gray-200 bg-slate-50 px-3 py-3">
              <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                    Search path
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-gray-500">
                    Use the chips below as example searches. They do not filter the catalog or select a biological category; they just fill the search box with common terms. Gene symbols resolve to their model outputs when possible, and raw output IDs are still supported for exact lookup.
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {suggestedSearches.map(({ term, description }) => (
                    <button
                      key={term}
                      type="button"
                      title={description}
                      onClick={() => {
                        setSearchQuery(term)
                        setExplorerOpen(true)
                      }}
                      className="rounded-full border border-gray-200 bg-white px-2 py-1 font-mono text-[11px] text-gray-600 hover:bg-gray-50"
                    >
                      {term}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-5">
              {types.map((t) => (
                <button
                  key={t.molecule_type}
                  type="button"
                  onClick={() => {
                    setBrowseType(t.molecule_type)
                    setBrowseSearch('')
                  }}
                  className={'rounded-md border px-3 py-2 text-left transition-colors ' + (
                    browseType === t.molecule_type
                      ? 'border-brand-300 bg-brand-50'
                      : 'border-gray-200 bg-gray-50 hover:bg-white'
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-gray-700">{outputTypeLabel(t.molecule_type)}</span>
                    <span className="font-mono text-[11px] text-gray-500">{t.count.toLocaleString()}</span>
                  </div>
                  <p className="mt-1 text-[11px] leading-4 text-gray-400">
                    {TYPE_DESCRIPTIONS[t.molecule_type] ?? 'Simulation output series.'}
                  </p>
                </button>
              ))}
            </div>

            {selectedBrowseType && (
              <div className="mb-3 rounded-lg border border-gray-200 bg-white p-3">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <div className="text-xs font-semibold text-gray-800">
                      Browse {outputTypeLabel(selectedBrowseType.molecule_type)}
                    </div>
                    <p className="mt-1 text-xs text-gray-400">
                      Showing plottable output IDs from this family. Filter within the family, then select up to {MAX_SELECTED} outputs to plot together.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setBrowseType(null)
                      setBrowseSearch('')
                      setBrowseIds([])
                      setBrowseCount(0)
                    }}
                    className="self-start rounded-md px-2 py-1 text-xs font-medium text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                  >
                    Close browse
                  </button>
                </div>
                <div className="mt-3 grid gap-3 lg:grid-cols-[260px,1fr]">
                  <input
                    type="text"
                    value={browseSearch}
                    onChange={(event) => setBrowseSearch(event.target.value)}
                    placeholder={`Filter ${outputTypeLabel(selectedBrowseType.molecule_type).toLowerCase()}...`}
                    className="rounded-md border border-gray-200 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
                  />
                  <div className="min-w-0">
                    {browseLoading ? (
                      <div className="flex items-center gap-2 rounded-md border border-gray-100 px-3 py-2 text-xs text-gray-400">
                        <div className="h-3.5 w-3.5 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
                        Loading output IDs...
                      </div>
                    ) : browseError ? (
                      <div className="rounded-md border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">
                        {browseError}
                      </div>
                    ) : (
                      <>
                        <div className="mb-2 text-xs text-gray-400">
                          Showing {browseIds.length.toLocaleString()} of {browseCount.toLocaleString()} output series
                          {browseSearch.trim() ? ' (filtered)' : ''}. Search by gene symbol or name above to narrow.
                        </div>
                        <div className="flex max-h-36 flex-wrap gap-1.5 overflow-y-auto">
                          {browseIds.map((id) => {
                            const item = { molecule_type: selectedBrowseType.molecule_type, id }
                            const key = selectedKey(item)
                            const isSelected = selected.some((x) => selectedKey(x) === key)
                            const canSelect = isSelected || selected.length < MAX_SELECTED
                            return (
                              <button
                                key={key}
                                type="button"
                                onClick={() => canSelect && toggleSelect(item)}
                                disabled={!canSelect}
                                className={'rounded-full border px-2 py-1 font-mono text-[11px] transition-colors ' + (
                                  isSelected
                                    ? 'border-brand-300 bg-brand-50 text-brand-700'
                                    : canSelect
                                    ? 'border-gray-200 bg-gray-50 text-gray-600 hover:bg-white'
                                    : 'cursor-not-allowed border-gray-100 bg-gray-50 text-gray-300'
                                )}
                              >
                                {compactMoleculeId(id)}
                              </button>
                            )
                          })}
                          {browseIds.length === 0 && (
                            <span className="text-xs text-gray-400">No output IDs match this filter.</span>
                          )}
                        </div>
                        {browseIds.length < browseCount && (
                          <button
                            type="button"
                            onClick={loadMoreBrowse}
                            disabled={browseLoading}
                            className="mt-2 rounded-md border border-gray-200 bg-white px-3 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                          >
                            {browseLoading ? 'Loading…' : `Load ${Math.min(BROWSE_LIMIT, browseCount - browseIds.length)} more`}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}

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
                {searchQuery.length >= 2 && resultGroups.length > 0 && (
                  <div className="max-h-72 overflow-y-auto rounded-md border border-gray-200">
                    {resultGroups.map(([moleculeType, ids]) => (
                      <div key={moleculeType} className="border-b border-gray-100 last:border-b-0">
                        <div className="flex items-center justify-between bg-gray-50 px-3 py-1.5">
                          <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                            {outputTypeLabel(moleculeType)}
                          </span>
                          <span className="text-[11px] text-gray-400">{ids.length} match{ids.length === 1 ? '' : 'es'}</span>
                        </div>
                        {ids.map((id) => {
                          const item = { molecule_type: moleculeType, id }
                          const key = selectedKey(item)
                          const isSelected = selected.some((x) => selectedKey(x) === key)
                          const canSelect = isSelected || selected.length < MAX_SELECTED
                          return (
                            <button
                              key={key}
                              type="button"
                              onClick={() => canSelect && toggleSelect(item)}
                              disabled={!canSelect}
                              className={'w-full border-t border-gray-50 px-3 py-1.5 text-left text-xs transition-colors ' + (
                                isSelected
                                  ? 'bg-brand-50 text-brand-700 font-semibold'
                                  : canSelect
                                  ? 'hover:bg-gray-50 text-gray-700'
                                  : 'cursor-not-allowed text-gray-300'
                              )}
                            >
                              <span className="font-mono">{id}</span>
                              <span className="ml-2 text-[11px] text-gray-400">
                                {TYPE_DESCRIPTIONS[moleculeType] ?? 'Simulation output series.'}
                              </span>
                            </button>
                          )
                        })}
                      </div>
                    ))}
                  </div>
                )}
                {searchQuery.length >= 2 && !searching && resultGroups.length === 0 && (
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
                    {selected.map((item, i) => (
                      <div key={selectedKey(item)} className="flex items-center gap-2 px-2 py-1 rounded bg-gray-50 text-xs">
                        <span
                          className="w-2.5 h-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-mono">{item.id}</span>
                          <span className="block truncate text-[10px] text-gray-400">{outputTypeLabel(item.molecule_type)}</span>
                        </span>
                        <button onClick={() => toggleSelect(item)} className="text-gray-400 hover:text-red-500 shrink-0">
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
                <p className="text-sm">Search by biological name; raw output IDs are optional.</p>
                <p className="text-xs mt-1">
                  e.g. <span className="font-mono">aaeB</span>, <span className="font-mono">rpoB</span>, <span className="font-mono">GLC</span>, <span className="font-mono">ACETATEKINA-RXN</span>
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
