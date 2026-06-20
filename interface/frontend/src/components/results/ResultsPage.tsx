import { useState, useEffect, useMemo, useRef } from 'react'
import { useParams, Link, useLocation } from 'react-router-dom'
import { useRegisterAssistantContext } from '../assistant/AssistantProvider'
import { makeAssistantContextKey } from '../../utils/assistantContext'
import { Line } from 'react-chartjs-2'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js'
import { getJob, getJobTimeseries, getExperiment, getGeneByKoIndex, getWtDelta } from '../../api/client'
import { MoleculeExplorer, ResultStateExplorer } from './MoleculeExplorer'
import { HelpTip, HelpNote } from '../common/HelpTip'
import type { SimulationJob, ResultsResponse, ResultsSummary, TimeseriesData, Experiment, WildtypeDelta } from '../../types'
import { useUrlWorkspaceState } from '../../hooks/useUrlWorkspaceState'
import { statusLabel, variantLabel } from '../../utils/labels'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, Filler)

// Channel configuration

function singleGeneSymbol(value?: string) {
  const symbols = (value ?? '')
    .split(',')
    .map((symbol) => symbol.trim())
    .filter(Boolean)
  return symbols.length === 1 ? symbols[0] : undefined
}

interface ChannelDef {
  title: string
  color: string
  fillColor: string
  group: string
}

const CHANNEL_CONFIG: Record<string, ChannelDef> = {
  cell_mass:            { title: 'Cell mass',             color: '#2563eb', fillColor: 'rgba(37,99,235,0.08)',    group: 'Mass & growth' },
  dry_mass:             { title: 'Dry mass',              color: '#1d4ed8', fillColor: 'rgba(29,78,216,0.08)',    group: 'Mass & growth' },
  protein_mass:         { title: 'Protein mass',          color: '#7c3aed', fillColor: 'rgba(124,58,237,0.08)',   group: 'Mass & growth' },
  rna_mass:             { title: 'RNA mass',              color: '#dc2626', fillColor: 'rgba(220,38,38,0.08)',    group: 'Mass & growth' },
  dna_mass:             { title: 'DNA mass',              color: '#d97706', fillColor: 'rgba(217,119,6,0.08)',    group: 'Mass & growth' },
  small_molecule_mass:  { title: 'Small-molecule mass',   color: '#0d9488', fillColor: 'rgba(13,148,136,0.08)',   group: 'Mass & growth' },
  growth_rate:          { title: 'Growth rate',           color: '#059669', fillColor: 'rgba(5,150,105,0.08)',    group: 'Mass & growth' },
  cell_volume:          { title: 'Cell volume',           color: '#6366f1', fillColor: 'rgba(99,102,241,0.08)',   group: 'Mass & growth' },
  mrna_counts:          { title: 'mRNA count',            color: '#0891b2', fillColor: 'rgba(8,145,178,0.08)',    group: 'Gene expression' },
  trna_charged_fraction:{ title: 'tRNA charged fraction', color: '#be185d', fillColor: 'rgba(190,24,93,0.08)',    group: 'Gene expression' },
  ppgpp_conc:           { title: 'ppGpp concentration',   color: '#9333ea', fillColor: 'rgba(147,51,234,0.08)',   group: 'Regulation' },
  aa_pool_size:         { title: 'Amino-acid pool',       color: '#e11d48', fillColor: 'rgba(225,29,72,0.08)',    group: 'Regulation' },
  ntp_pool_size:        { title: 'NTP pool',              color: '#f59e0b', fillColor: 'rgba(245,158,11,0.08)',   group: 'Regulation' },
  aa_supply_total:      { title: 'AA supply rate',        color: '#84cc16', fillColor: 'rgba(132,204,22,0.08)',   group: 'Regulation' },
  aa_synthesis_total:   { title: 'AA synthesis rate',     color: '#22c55e', fillColor: 'rgba(34,197,94,0.08)',    group: 'Regulation' },
  fba_objective:        { title: 'FBA objective',         color: '#14b8a6', fillColor: 'rgba(20,184,166,0.08)',   group: 'Metabolism' },
  exchange_flux_total:  { title: 'Exchange flux (total)', color: '#06b6d4', fillColor: 'rgba(6,182,212,0.08)',    group: 'Metabolism' },
  reaction_flux_total:  { title: 'Reaction flux (total)', color: '#8b5cf6', fillColor: 'rgba(139,92,246,0.08)',   group: 'Metabolism' },
  ribosome_elongation_rate:    { title: 'Ribosome elongation rate',  color: '#f43f5e', fillColor: 'rgba(244,63,94,0.08)',   group: 'Translation' },
  ribosome_actual_elongations: { title: 'Ribosome elongations',      color: '#fb923c', fillColor: 'rgba(251,146,60,0.08)',  group: 'Translation' },
  n_oric:               { title: 'Origins of replication', color: '#a855f7', fillColor: 'rgba(168,85,247,0.08)',  group: 'Replication' },
}

const DEFAULT_ACTIVE = new Set([
  'cell_mass', 'growth_rate', 'protein_mass', 'ppgpp_conc',
])

const CHART_PRESETS = [
  {
    id: 'overview',
    label: 'Overview',
    description: 'Start here for the main phenotype: mass accumulation, growth rate, protein biomass, and ppGpp stress signal.',
    channels: ['cell_mass', 'growth_rate', 'protein_mass', 'ppgpp_conc'],
  },
  {
    id: 'biomass',
    label: 'Biomass',
    description: 'Compare macromolecular composition and cell size over the run.',
    channels: ['cell_mass', 'dry_mass', 'protein_mass', 'rna_mass', 'dna_mass', 'cell_volume'],
  },
  {
    id: 'expression',
    label: 'Expression',
    description: 'Inspect aggregate transcription and translation behavior before drilling into individual RNAs and proteins.',
    channels: ['mrna_counts', 'protein_mass', 'rna_mass', 'ribosome_elongation_rate', 'ribosome_actual_elongations'],
  },
  {
    id: 'regulation',
    label: 'Regulation',
    description: 'Look for nutrient stress and regulatory response signals such as ppGpp and amino-acid supply.',
    channels: ['ppgpp_conc', 'aa_pool_size', 'ntp_pool_size', 'aa_supply_total', 'aa_synthesis_total'],
  },
  {
    id: 'metabolism',
    label: 'Metabolism',
    description: 'Inspect FBA objective and aggregate reaction/exchange flux behavior.',
    channels: ['fba_objective', 'exchange_flux_total', 'reaction_flux_total', 'small_molecule_mass'],
  },
] as const

type ChartPresetId = typeof CHART_PRESETS[number]['id'] | 'custom'

const SEED_COLORS = [
  '#2563eb', '#059669', '#dc2626', '#7c3aed', '#d97706',
  '#0891b2', '#be185d', '#4f46e5', '#ea580c', '#65a30d',
]

// Helpers

function downsample(points: { time: number; value: number }[], maxPoints: number = 400) {
  if (points.length <= maxPoints) return points
  const step = Math.ceil(points.length / maxPoints)
  return points.filter((_, i) => i % step === 0)
}

function groupChannels(channels: string[]): Record<string, string[]> {
  const groups: Record<string, string[]> = {}
  for (const ch of channels) {
    const g = CHANNEL_CONFIG[ch]?.group ?? 'Other'
    if (!groups[g]) groups[g] = []
    groups[g].push(ch)
  }
  return groups
}

function formatPercent(value: number | null | undefined): string {
  if (value == null) return 'Not available'
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`
}

function formatTimeline(value: string | null | undefined): string {
  const timeline = (value || '').trim()
  return timeline || 'No media timeline recorded'
}

function dataSourceLabel(job: SimulationJob, isMock: boolean): string {
  if (isMock) return 'Preview or fallback data'
  if (job.sim_dir) return 'Simulation output'
  return 'Result summary only'
}

function dataSourceDescription(job: SimulationJob, isMock: boolean): string {
  if (isMock) {
    return 'These curves are not confirmed as extracted outputs from a completed simulation directory. Use them for UI inspection, not biological interpretation.'
  }
  if (job.sim_dir) {
    return 'The job is complete and points to a simulation directory. Use the plots and model-output explorer for interpretation.'
  }
  return 'The run has summary metadata, but no simulation directory is attached for detailed output extraction.'
}

function strongestDelta(wtDelta: WildtypeDelta | null): { label: string; value: number } | null {
  if (!wtDelta?.has_wildtype) return null
  const candidates = [
    { label: 'Division time', value: wtDelta.division_time_pct },
    { label: 'Final mass', value: wtDelta.final_mass_pct },
    { label: 'Growth rate', value: wtDelta.growth_rate_pct },
    { label: 'Doubling time', value: wtDelta.doubling_time_pct },
  ].filter((item): item is { label: string; value: number } => item.value != null)
  if (candidates.length === 0) return null
  return candidates.sort((a, b) => Math.abs(b.value) - Math.abs(a.value))[0]
}

type ComparisonMetricRow = {
  key: 'division_time' | 'final_mass' | 'growth_rate' | 'doubling_time'
  label: string
  current: number | null
  wildtype: number | null
  deltaPct: number | null
  unit: string
  help: string
}

function comparisonRows(summary: ResultsSummary | undefined, wtDelta: WildtypeDelta | null): ComparisonMetricRow[] {
  return [
    {
      key: 'division_time',
      label: 'Division time',
      current: summary?.division_time_sec != null ? summary.division_time_sec / 60 : null,
      wildtype: wtDelta?.wt_division_time_min ?? null,
      deltaPct: wtDelta?.division_time_pct ?? null,
      unit: 'min',
      help: 'Observed simulated cell-cycle division time. Higher than WT usually means slower division.',
    },
    {
      key: 'final_mass',
      label: 'Final mass',
      current: summary?.final_mass_fg ?? null,
      wildtype: wtDelta?.wt_final_mass_fg ?? null,
      deltaPct: wtDelta?.final_mass_pct ?? null,
      unit: 'fg',
      help: 'Final simulated cell mass. Interpret with growth and division timing; larger is not automatically better.',
    },
    {
      key: 'growth_rate',
      label: 'Growth rate',
      current: summary?.growth_rate ?? null,
      wildtype: wtDelta?.wt_growth_rate ?? null,
      deltaPct: wtDelta?.growth_rate_pct ?? null,
      unit: 'x10^-3/s',
      help: 'Specific growth rate. Lower than WT is the clearest aggregate growth defect signal.',
    },
    {
      key: 'doubling_time',
      label: 'Doubling time',
      current: summary?.doubling_time_min ?? null,
      wildtype: wtDelta?.wt_doubling_time_min ?? null,
      deltaPct: wtDelta?.doubling_time_pct ?? null,
      unit: 'min',
      help: 'Growth-rate-derived mass doubling time. Higher than WT means slower biomass doubling.',
    },
  ]
}

function formatComparisonValue(row: ComparisonMetricRow, value: number | null): string {
  if (value == null || !Number.isFinite(value)) return 'n/a'
  if (row.key === 'growth_rate') return (value * 1000).toFixed(2)
  if (row.key === 'final_mass') return value.toFixed(1)
  return value.toFixed(1)
}

function comparisonTone(row: ComparisonMetricRow): string {
  const delta = row.deltaPct
  if (delta == null || Math.abs(delta) < 5) return 'text-gray-500'
  if (row.key === 'growth_rate') return delta < 0 ? 'text-red-600' : 'text-emerald-600'
  if (row.key === 'division_time' || row.key === 'doubling_time') return delta > 0 ? 'text-red-600' : 'text-emerald-600'
  return 'text-amber-600'
}

function comparisonInterpretation(row: ComparisonMetricRow): string {
  const delta = row.deltaPct
  if (delta == null) return 'No WT delta'
  if (Math.abs(delta) < 5) return 'Near WT'
  if (row.key === 'growth_rate') return delta < 0 ? 'Growth defect' : 'Faster growth'
  if (row.key === 'division_time') return delta > 0 ? 'Slower division' : 'Faster division'
  if (row.key === 'doubling_time') return delta > 0 ? 'Slower doubling' : 'Faster doubling'
  return delta > 0 ? 'Higher final mass' : 'Lower final mass'
}

function suggestedComparisonPresets(wtDelta: WildtypeDelta | null): Array<{ preset: ChartPresetId; label: string; reason: string }> {
  const strongest = strongestDelta(wtDelta)
  if (!strongest) return []
  if (strongest.label === 'Final mass') {
    return [
      { preset: 'biomass', label: 'Biomass preset', reason: 'Mass changed most; inspect macromolecular composition.' },
      { preset: 'expression', label: 'Expression preset', reason: 'RNA/protein allocation can explain mass shifts.' },
    ]
  }
  if (strongest.label === 'Growth rate') {
    return [
      { preset: 'overview', label: 'Overview preset', reason: 'Confirm the growth-rate curve and mass trajectory.' },
      { preset: 'metabolism', label: 'Metabolism preset', reason: 'Growth-rate changes often track metabolic flux behavior.' },
      { preset: 'regulation', label: 'Regulation preset', reason: 'Check stress and amino-acid supply signals.' },
    ]
  }
  return [
    { preset: 'overview', label: 'Overview preset', reason: 'Confirm timing and growth trajectory first.' },
    { preset: 'regulation', label: 'Regulation preset', reason: 'Division and doubling shifts often need stress-signal context.' },
  ]
}

function statusTone(status: string): string {
  if (status === 'done') return 'border-emerald-200 bg-emerald-50 text-emerald-800'
  if (status === 'failed') return 'border-red-200 bg-red-50 text-red-800'
  if (['pending', 'running_parca', 'running_sim', 'ingesting'].includes(status)) return 'border-blue-200 bg-blue-50 text-blue-800'
  return 'border-gray-200 bg-gray-50 text-gray-700'
}

// Chart component

function TimeseriesChart({
  channel,
  series,
}: {
  channel: string
  series: TimeseriesData[]
}) {
  const config = CHANNEL_CONFIG[channel] ?? { title: channel, color: '#6b7280', fillColor: 'rgba(107,114,128,0.08)', group: 'Other' }
  const multiSeed = series.length > 1

  const datasets = series.map((s, i) => {
    const sampled = downsample(s.points)
    return {
      label: multiSeed ? s.label : config.title,
      data: sampled.map((p) => ({ x: p.time / 60, y: p.value })),
      borderColor: multiSeed ? SEED_COLORS[i % SEED_COLORS.length] : config.color,
      backgroundColor: multiSeed ? 'transparent' : config.fillColor,
      borderWidth: 1.5,
      pointRadius: 0,
      tension: 0.3,
      fill: !multiSeed,
    }
  })

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="text-sm font-medium text-gray-700 mb-3">{config.title}
        <span className="text-xs text-gray-400 ml-2">({series[0]?.unit})</span>
      </h3>
      <div className="h-56">
        <Line
          data={{ datasets }}
          options={{
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
              legend: { display: multiSeed, position: 'top', labels: { boxWidth: 12, font: { size: 11 } } },
              tooltip: {
                callbacks: {
                  title: (items) => 't = ' + (items[0]?.parsed?.x?.toFixed(1) ?? '') + ' min',
                  label: (item) => (item.dataset.label ?? '') + ': ' + (item.parsed.y ?? 0).toPrecision(4) + ' ' + (series[0]?.unit ?? ''),
                },
              },
            },
            scales: {
              x: {
                type: 'linear',
                title: { display: true, text: 'Time (min)', font: { size: 11 } },
                grid: { color: 'rgba(0,0,0,0.04)' },
                ticks: { font: { size: 10 } },
              },
              y: {
                title: { display: true, text: series[0]?.unit ?? '', font: { size: 11 } },
                grid: { color: 'rgba(0,0,0,0.04)' },
                ticks: { font: { size: 10 } },
              },
            },
          }}
        />
      </div>
    </div>
  )
}

// Main page

export function ResultsPage() {
  const { jobId } = useParams<{ jobId: string }>()
  const location = useLocation()
  const { setWorkspaceUrlState } = useUrlWorkspaceState()
  const [job, setJob] = useState<SimulationJob | null>(null)
  const [experiment, setExperiment] = useState<Experiment | null>(null)
  const [resolvedGeneSymbol, setResolvedGeneSymbol] = useState<string | undefined>()
  const [results, setResults] = useState<ResultsResponse | null>(null)
  const [wtDelta, setWtDelta] = useState<WildtypeDelta | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeChannels, setActiveChannels] = useState<Set<string>>(new Set(DEFAULT_ACTIVE))
  const [chartPreset, setChartPreset] = useState<ChartPresetId>('overview')
  const [showChannelGroups, setShowChannelGroups] = useState(false)
  const [showModelDepth, setShowModelDepth] = useState(false)
  const [showRunTable, setShowRunTable] = useState(false)
  const assistantCapturedAt = useRef(new Date().toISOString()).current

  useEffect(() => {
    if (!jobId) return
    const id = parseInt(jobId, 10)
    setLoading(true)
    setError(null)
    setExperiment(null)
    setWtDelta(null)
    setResolvedGeneSymbol(undefined)

    Promise.all([getJob(id), getJobTimeseries(id)])
      .then(async ([jobData, tsData]) => {
        setJob(jobData)
        setResults(tsData)

        let geneSymbol: string | undefined
        let experimentId: number | undefined
        let experimentCondition: string | null = null
        if (jobData.experiment_id) {
          try {
            const exp = await getExperiment(jobData.experiment_id)
            setExperiment(exp)
            experimentId = exp.id
            geneSymbol = exp.gene_symbol || undefined
            experimentCondition = exp.condition || null
          } catch { /* experiment context is optional */ }
        }

        if (!geneSymbol && jobData.variant_type === 'gene_knockout' && jobData.variant_index != null && jobData.variant_index > 0) {
          try {
            const gene = await getGeneByKoIndex(jobData.variant_index)
            geneSymbol = gene.symbol
          } catch { /* best-effort */ }
        }

        const focusGeneSymbol = singleGeneSymbol(geneSymbol)
        setResolvedGeneSymbol(geneSymbol)
        setWorkspaceUrlState(
          {
            selectedGene: focusGeneSymbol ?? null,
            selectedExperimentId: experimentId ?? jobData.experiment_id ?? null,
            selectedJobId: jobData.id,
            selectedCondition: experimentCondition,
            analyzeView: 'results',
          },
          { replace: true }
        )

        // Fetch WT delta for comparison cards
        if (experimentId && jobData.status === 'done') {
          getWtDelta(experimentId)
            .then(setWtDelta)
            .catch(() => {}) // optional: no delta if no WT
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [jobId])

  const toggleChannel = (ch: string) => {
    setChartPreset('custom')
    setActiveChannels((prev) => {
      const next = new Set(prev)
      if (next.has(ch)) next.delete(ch)
      else next.add(ch)
      return next
    })
  }

  const applyPreset = (presetId: ChartPresetId, availableChannels: string[]) => {
    if (presetId === 'custom') return
    const preset = CHART_PRESETS.find((item) => item.id === presetId)
    if (!preset) return
    setChartPreset(presetId)
    setActiveChannels(new Set(preset.channels.filter((channel) => availableChannels.includes(channel))))
  }

  const focusGeneSymbol = singleGeneSymbol(resolvedGeneSymbol)
  const channels = useMemo(() => Object.keys(results?.timeseries ?? {}), [results])
  const grouped = useMemo(() => groupChannels(channels), [channels])
  const primarySummary = results?.summary[0]
  const resultTitle = experiment?.name || (resolvedGeneSymbol ? `${resolvedGeneSymbol} knockout` : job ? `Job #${job.id}` : 'Result detail')
  const strongestWtDelta = useMemo(() => strongestDelta(wtDelta), [wtDelta])
  const selectedPreset = useMemo(() => CHART_PRESETS.find((preset) => preset.id === chartPreset), [chartPreset])
  const visibleChannels = useMemo(() => channels.filter((ch) => activeChannels.has(ch)), [activeChannels, channels])
  const hasWildtype = Boolean(wtDelta?.has_wildtype)
  const comparisonMetricRows = useMemo(() => comparisonRows(primarySummary, wtDelta), [primarySummary, wtDelta])
  const comparisonPresets = useMemo(() => suggestedComparisonPresets(wtDelta), [wtDelta])
  const isMock = job ? (!job.sim_dir || job.status !== 'done') : false
  const resultPageState = useMemo(() => ({
    kind: 'result_detail',
    surface: 'results',
    summary: job
      ? `Result detail for job #${job.id}, status ${statusLabel(job.status)}, with ${results?.summary.length ?? 0} summary row${results?.summary.length === 1 ? '' : 's'} and ${channels.length} available time-series channel${channels.length === 1 ? '' : 's'}.`
      : 'Result detail page loading.',
    dirty: false,
    captured_at: assistantCapturedAt,
    route: `${location.pathname}${location.search}`,
    loading,
    error,
    selected: {
      job_id: job?.id ?? null,
      experiment_id: experiment?.id ?? job?.experiment_id ?? null,
      gene_symbol: focusGeneSymbol ?? null,
      condition: experiment?.condition ?? job?.condition ?? null,
      variant_type: experiment?.variant_type ?? job?.variant_type ?? null,
    },
    job: job
      ? {
        id: job.id,
        experiment_id: job.experiment_id,
        status: job.status,
        status_label: statusLabel(job.status),
        phase: job.phase,
        seed: job.seed,
        generations: job.generations,
        condition: job.condition,
        timeline: job.timeline,
        started_at: job.started_at,
        finished_at: job.finished_at,
        data_source: dataSourceLabel(job, isMock),
        has_sim_dir: Boolean(job.sim_dir),
      }
      : null,
    experiment: experiment
      ? {
        id: experiment.id,
        name: experiment.name,
        variant_type: experiment.variant_type,
        variant_label: variantLabel(experiment.variant_type),
        variant_index: experiment.variant_index,
        condition: experiment.condition,
        timeline: experiment.timeline,
        gene_symbol: experiment.gene_symbol,
        status: experiment.status,
        batch_id: experiment.batch_id,
      }
      : null,
    results: {
      summary_count: results?.summary.length ?? 0,
      primary_summary: primarySummary
        ? {
          job_id: primarySummary.job_id,
          seed: primarySummary.seed,
          generation: primarySummary.generation,
          division_time_min: primarySummary.division_time_sec == null ? null : primarySummary.division_time_sec / 60,
          final_mass_fg: primarySummary.final_mass_fg,
          growth_rate_x10_3_per_s: primarySummary.growth_rate == null ? null : primarySummary.growth_rate * 1000,
          doubling_time_min: primarySummary.doubling_time_min,
        }
        : null,
    },
    timeseries: {
      available_channel_count: channels.length,
      available_channels: channels.slice(0, 50),
      available_channels_truncated: channels.length > 50,
      active_channel_count: visibleChannels.length,
      active_channels: visibleChannels,
      chart_preset: chartPreset,
      selected_preset_label: selectedPreset?.label ?? 'Custom',
      show_channel_groups: showChannelGroups,
      show_model_depth: showModelDepth,
      show_run_table: showRunTable,
    },
    wt_delta: {
      has_wildtype: hasWildtype,
      wt_experiment_id: wtDelta?.wt_experiment_id ?? null,
      wt_status: wtDelta?.wt_status ?? null,
      strongest_delta: strongestWtDelta,
      metrics: {
        division_time_pct: wtDelta?.division_time_pct ?? null,
        final_mass_pct: wtDelta?.final_mass_pct ?? null,
        growth_rate_pct: wtDelta?.growth_rate_pct ?? null,
        doubling_time_pct: wtDelta?.doubling_time_pct ?? null,
      },
    },
  }), [
    channels,
    assistantCapturedAt,
    chartPreset,
    error,
    experiment,
    focusGeneSymbol,
    hasWildtype,
    isMock,
    job,
    loading,
    location.pathname,
    location.search,
    primarySummary,
    results?.summary.length,
    selectedPreset?.label,
    showChannelGroups,
    showModelDepth,
    showRunTable,
    strongestWtDelta,
    visibleChannels,
    wtDelta,
  ])
  useRegisterAssistantContext({
    contextKey: makeAssistantContextKey([
      'result_detail',
      location.pathname,
      location.search,
      job?.id,
      experiment?.id,
      focusGeneSymbol,
      selectedPreset?.label,
      showChannelGroups,
      showModelDepth,
      showRunTable,
      loading,
      isMock,
      hasWildtype,
      results?.summary.length,
    ]),
    context: {
      assistant_surface: 'results',
      route: `${location.pathname}${location.search}`,
      selected_job: job?.id ?? null,
      selected_gene: focusGeneSymbol ?? null,
      selected_experiment: experiment?.id ?? null,
      selected_condition: experiment?.condition ?? null,
      selected_variant_type: experiment?.variant_type ?? job?.variant_type ?? null,
      page_state: resultPageState,
    },
    suggestedPrompt: 'Help me interpret this simulation result. Start with the phenotype summary, WT comparison, and the most useful model outputs to inspect next.',
  })

  if (loading) {
    return (
      <div className="text-center py-12 text-gray-400">
        <div className="inline-block w-5 h-5 border-2 border-brand-500 border-t-transparent rounded-full animate-spin mr-2" />
        Loading results...
      </div>
    )
  }

  if (error) {
    return (
      <div className="max-w-2xl mx-auto py-12 text-center">
        <p className="text-red-600 mb-4">Failed to load results: {error}</p>
        <Link to="/experiments" className="text-brand-600 hover:underline">Back to experiments</Link>
      </div>
    )
  }

  if (!job || !results) return null

  return (
    <div className="h-full overflow-y-auto pr-1">
      <div className="max-w-6xl mx-auto pb-8">
      <div className="mb-5">
        <Link to="/results" className="text-sm font-medium text-gray-400 hover:text-gray-600">&larr; All results</Link>
        <div className="mt-2 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Single simulation result</p>
            <h1 className="text-2xl font-semibold text-gray-900">{resultTitle}</h1>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <span className={'rounded-full border px-2.5 py-1 font-medium ' + statusTone(job.status)}>
              {statusLabel(job.status)}
            </span>
            <span className="rounded-full border border-gray-200 bg-white px-2.5 py-1 text-gray-500">
              Job <span className="font-mono text-gray-700">#{job.id}</span>
            </span>
            <span className="rounded-full border border-gray-200 bg-white px-2.5 py-1 text-gray-500">
              Seed <span className="font-mono text-gray-700">{job.seed}</span>
            </span>
          </div>
        </div>
        <AnalysisPath
          hasWildtype={hasWildtype}
          hasModelOutputs={job.status === 'done'}
          visibleChannels={visibleChannels.length}
          totalChannels={channels.length}
        />
      </div>

      <section id="phenotype" className="mb-6 rounded-lg border border-gray-200 bg-white">
        <div className="border-b border-gray-100 px-4 py-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-gray-900">1. Phenotype summary</h2>
            <HelpTip
              text="This section answers whether the simulation completed, how its growth phenotype compares with the condition-matched wildtype when available, and whether the plotted curves are extracted from a completed run."
              position="right"
            />
          </div>
        </div>
        <div className="grid gap-4 p-4 lg:grid-cols-[1fr,280px]">
          <div>
            {primarySummary && (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <SummaryCard
                  label="Division time"
                  value={primarySummary.division_time_sec != null ? (primarySummary.division_time_sec / 60).toFixed(1) + ' min' : '-'}
                  help="Time from simulated cell birth to division. Compare this with doubling time: division is a discrete cell-cycle event, while doubling time is calculated from growth rate."
                  deltaPct={hasWildtype ? wtDelta?.division_time_pct : undefined}
                />
                <SummaryCard
                  label="Final mass"
                  value={primarySummary.final_mass_fg != null ? primarySummary.final_mass_fg.toFixed(1) + ' fg' : '-'}
                  help="Final simulated cell mass. Large changes can indicate broad biomass allocation effects even when division still occurs."
                  deltaPct={hasWildtype ? wtDelta?.final_mass_pct : undefined}
                />
                <SummaryCard
                  label="Growth rate"
                  value={primarySummary.growth_rate != null ? (primarySummary.growth_rate * 1000).toFixed(2) + ' x10^-3 /s' : '-'}
                  help="Specific growth rate near the end of the simulation. This is often the first phenotype to compare against WT."
                  deltaPct={hasWildtype ? wtDelta?.growth_rate_pct : undefined}
                />
                <SummaryCard
                  label="Doubling time"
                  value={primarySummary.doubling_time_min != null ? primarySummary.doubling_time_min.toFixed(1) + ' min' : '-'}
                  help="Mass-doubling estimate from growth rate. It can differ from observed division time when the simulated cell cycle and biomass growth are not perfectly aligned."
                  deltaPct={hasWildtype ? wtDelta?.doubling_time_pct : undefined}
                />
              </div>
            )}
            <NextStepCallout
              strongestWtDelta={strongestWtDelta}
              hasWildtype={hasWildtype}
              focusGeneSymbol={focusGeneSymbol}
            />
          </div>
          <aside className="rounded-lg border border-gray-200 bg-slate-50 p-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Run context</h3>
            <dl className="mt-3 space-y-2 text-xs">
              <InfoRow label="Experiment" value={experiment?.name || `Experiment #${job.experiment_id}`} />
              <InfoRow label="Type" value={variantLabel(experiment?.variant_type ?? job.variant_type)} />
              <InfoRow label="Gene" value={resolvedGeneSymbol || experiment?.gene_symbol || 'Not gene-specific'} mono />
              <InfoRow label="Condition" value={experiment?.condition || job.condition || 'Not recorded'} />
              <InfoRow label="Timeline" value={formatTimeline(experiment?.timeline || job.timeline)} mono />
              <InfoRow label="Generations" value={String(job.generations)} />
              <InfoRow label="Data source" value={dataSourceLabel(job, isMock)} />
            </dl>
            <p className={'mt-3 rounded border px-2 py-2 text-xs ' + (isMock ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800')}>
              {dataSourceDescription(job, isMock)}
            </p>
          </aside>
        </div>
      </section>

      <ComparisonBaseline
        experiment={experiment}
        wtDelta={wtDelta}
        rows={comparisonMetricRows}
        suggestions={comparisonPresets}
        channels={channels}
        onSelectPreset={(preset) => applyPreset(preset, channels)}
      />

      <section id="timeseries" className="mb-8 rounded-lg border border-gray-200 bg-white p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-gray-900">3. Time-series workbench</h2>
              <HelpTip
                text="Presets choose a small set of simulation channels for a specific interpretation task. You can still toggle individual channels; doing so creates a custom view."
                position="right"
              />
            </div>
            <p className="mt-1 text-xs text-gray-500">
              Selected channels are plotted below. Keep the view narrow while forming a hypothesis, then add channels as needed.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-gray-400">{visibleChannels.length} of {channels.length} channels selected</span>
            <button
              type="button"
              onClick={() => setShowChannelGroups((current) => !current)}
              className="rounded-full border border-gray-200 bg-white px-2.5 py-1 font-medium text-gray-600 hover:bg-gray-50"
            >
              {showChannelGroups ? 'Hide channels' : 'Customize channels'}
            </button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {CHART_PRESETS.map((preset) => {
            const availableCount = preset.channels.filter((channel) => channels.includes(channel)).length
            return (
              <button
                key={preset.id}
                type="button"
                disabled={availableCount === 0}
                onClick={() => applyPreset(preset.id, channels)}
                className={'rounded-lg border px-3 py-2 text-left text-xs transition-colors ' + (
                  chartPreset === preset.id
                    ? 'border-brand-300 bg-brand-50 text-brand-800 shadow-sm'
                    : availableCount === 0
                    ? 'border-gray-100 bg-gray-50 text-gray-300 cursor-not-allowed'
                    : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
                )}
                title={preset.description}
              >
                <span className="block font-semibold">{preset.label}</span>
                <span className="block text-[11px] opacity-75">{availableCount} available channel{availableCount === 1 ? '' : 's'}</span>
              </button>
            )
          })}
          {chartPreset === 'custom' && (
            <span className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs font-medium text-gray-500">
              Custom selection
            </span>
          )}
        </div>

        <p className="mt-3 text-xs text-gray-500">
          {selectedPreset?.description ?? 'Custom view: selected manually from the channel groups below.'}
        </p>

        {showChannelGroups && (
          <div className="mt-4 space-y-2 border-t border-gray-100 pt-4">
            {Object.entries(grouped).map(([groupName, chs]) => (
              <div key={groupName} className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-medium text-gray-400 w-28 shrink-0">{groupName}</span>
                {chs.map((ch) => {
                  const cfg = CHANNEL_CONFIG[ch]
                  const active = activeChannels.has(ch)
                  return (
                    <button
                      key={ch}
                      onClick={() => toggleChannel(ch)}
                      className={'px-2.5 py-1 rounded-full text-xs font-medium transition-colors border ' + (
                        active
                          ? 'border-gray-300 bg-white text-gray-800 shadow-sm'
                          : 'border-transparent bg-gray-100 text-gray-400'
                      )}
                    >
                      <span
                        className="inline-block w-2 h-2 rounded-full mr-1.5"
                        style={{ backgroundColor: cfg?.color ?? '#6b7280', opacity: active ? 1 : 0.3 }}
                      />
                      {cfg?.title ?? ch}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-8">
        {visibleChannels.map((ch) => (
          <TimeseriesChart key={ch} channel={ch} series={results.timeseries[ch]} />
        ))}
      </div>

      {visibleChannels.length === 0 && (
        <div className="mb-8 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          No channels are selected. Choose a preset or turn on individual channels to show plots.
        </div>
      )}

      {job.status === 'done' && (
        <section id="model-outputs" className="mb-8">
          <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold text-gray-900">4. Model outputs</h2>
                <HelpTip
                  text="Use this after the phenotype and time-series pass. It links the selected gene to plot-ready RNAs, proteins, reactions, metabolites, and regulatory neighbors when those outputs exist for this run."
                  position="right"
                />
              </div>
              <p className="mt-1 text-xs text-gray-500">
                Inspect linked state variables and then search the broader simulation output catalog.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowModelDepth((current) => !current)}
              className="w-fit rounded-full border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50"
            >
              {showModelDepth ? 'Hide model-depth note' : 'Show model-depth note'}
            </button>
          </div>
          {showModelDepth && (
            <HelpNote variant="model-depth">
              <strong>Model depth:</strong>{' '}The wcEcoli model tracks transcription, translation, and degradation for all 4,749 E. coli genes, but only ~1,500 have <em>mechanistic downstream effects</em> (enzymatic reactions, TF regulation, complex formation). The remaining genes are passengers: their mRNA and protein levels are simulated, but knocking them out may not visibly alter growth rate.
            </HelpNote>
          )}
          <div className="mt-3" />
          <ResultStateExplorer
            jobId={job.id}
            geneSymbol={focusGeneSymbol}
            variantType={experiment?.variant_type ?? job.variant_type}
          />
          <MoleculeExplorer
            jobId={job.id}
            geneSymbol={focusGeneSymbol}
            variantType={experiment?.variant_type ?? job.variant_type}
          />
        </section>
      )}

      {results.summary.length > 1 && (
        <section id="diagnostics" className="bg-white rounded-lg border border-gray-200 overflow-hidden mb-8">
          <button
            type="button"
            onClick={() => setShowRunTable((current) => !current)}
            className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
          >
            <span>
              <span className="block text-sm font-semibold text-gray-900">Per-generation diagnostics</span>
              <span className="mt-0.5 block text-xs text-gray-500">
                {results.summary.length} summary rows. Open this when checking replicate or generation-level differences.
              </span>
            </span>
            <span className="text-xs font-medium text-gray-500">{showRunTable ? 'Hide table' : 'Show table'}</span>
          </button>
          {showRunTable && (
          <table className="w-full border-t border-gray-100 text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium text-gray-500">Seed</th>
                <th className="text-left px-4 py-2.5 font-medium text-gray-500">Gen</th>
                <th className="text-right px-4 py-2.5 font-medium text-gray-500">Division time</th>
                <th className="text-right px-4 py-2.5 font-medium text-gray-500">Final mass</th>
                <th className="text-right px-4 py-2.5 font-medium text-gray-500">Growth rate</th>
                <th className="text-right px-4 py-2.5 font-medium text-gray-500">Doubling</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {results.summary.map((s, i) => (
                <tr key={`${s.seed}-${s.generation}-${i}`} className="hover:bg-gray-50">
                  <td className="px-4 py-2 font-mono">{s.seed}</td>
                  <td className="px-4 py-2 font-mono">{s.generation}</td>
                  <td className="px-4 py-2 text-right font-mono">
                    {s.division_time_sec != null ? (s.division_time_sec / 60).toFixed(1) + ' min' : '-'}
                  </td>
                  <td className="px-4 py-2 text-right font-mono">
                    {s.final_mass_fg != null ? s.final_mass_fg.toFixed(1) + ' fg' : '-'}
                  </td>
                  <td className="px-4 py-2 text-right font-mono">
                    {s.growth_rate != null ? (s.growth_rate * 1000).toFixed(3) : '-'}
                  </td>
                  <td className="px-4 py-2 text-right font-mono">
                    {s.doubling_time_min != null ? s.doubling_time_min.toFixed(1) + ' min' : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          )}
        </section>
      )}
      </div>
    </div>
  )
}

function AnalysisPath({
  hasWildtype,
  hasModelOutputs,
  visibleChannels,
  totalChannels,
}: {
  hasWildtype: boolean
  hasModelOutputs: boolean
  visibleChannels: number
  totalChannels: number
}) {
  const items = [
    { href: '#phenotype', label: 'Phenotype', detail: 'growth summary' },
    { href: '#comparison', label: 'WT baseline', detail: hasWildtype ? 'available' : 'missing' },
    { href: '#timeseries', label: 'Time-series', detail: `${visibleChannels}/${totalChannels} channels` },
    { href: '#model-outputs', label: 'Model outputs', detail: hasModelOutputs ? 'available' : 'pending' },
  ]

  return (
    <nav className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4" aria-label="Result analysis workflow">
      {items.map((item, index) => (
        <a
          key={item.href}
          href={item.href}
          className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs transition-colors hover:bg-gray-50"
        >
          <span className="block font-semibold text-gray-800">{index + 1}. {item.label}</span>
          <span className="mt-0.5 block text-gray-400">{item.detail}</span>
        </a>
      ))}
    </nav>
  )
}

function NextStepCallout({
  strongestWtDelta,
  hasWildtype,
  focusGeneSymbol,
}: {
  strongestWtDelta: { label: string; value: number } | null
  hasWildtype: boolean
  focusGeneSymbol?: string
}) {
  const message = strongestWtDelta
    ? `${strongestWtDelta.label} has the largest WT delta (${formatPercent(strongestWtDelta.value)}). Start with the matching preset, then inspect linked model outputs.`
    : hasWildtype
    ? 'A WT baseline exists, but no aggregate metric dominates. Inspect the overview curves before drilling into molecules.'
    : 'No matching WT comparison is attached. Treat absolute values cautiously and compare against a compatible WT run if possible.'

  return (
    <div className="mt-4 rounded-lg border border-brand-100 bg-brand-50/50 px-3 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-brand-800">Recommended next step</h3>
          <p className="mt-1 text-sm text-brand-900">{message}</p>
          {focusGeneSymbol && (
            <p className="mt-1 text-xs text-brand-700">
              Model-output inspection will focus on <span className="font-mono">{focusGeneSymbol}</span>.
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 text-xs">
          <a href="#timeseries" className="rounded-full bg-white px-2.5 py-1 font-medium text-brand-700 hover:bg-brand-50">
            Open plots
          </a>
          <a href="#model-outputs" className="rounded-full bg-white px-2.5 py-1 font-medium text-brand-700 hover:bg-brand-50">
            Open outputs
          </a>
        </div>
      </div>
    </div>
  )
}

function SummaryCard({ label, value, help, deltaPct }: {
  label: string; value: string; help?: string; deltaPct?: number | null
}) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 px-4 py-3">
      <p className="text-xs text-gray-400 mb-0.5 flex items-center gap-1">
        {label}
        {help && <HelpTip text={help} position="bottom" />}
      </p>
      <p className="text-lg font-semibold text-gray-900">{value}</p>
      {deltaPct != null && (
        <p className={'text-xs font-medium mt-0.5 ' + (
          deltaPct > 5 ? 'text-red-600' : deltaPct < -5 ? 'text-emerald-600' : 'text-gray-400'
        )}>
          {deltaPct > 0 ? 'up' : deltaPct < 0 ? 'down' : 'same'}{' '}
          {deltaPct > 0 ? '+' : ''}{deltaPct.toFixed(1)}% vs WT
        </p>
      )}
    </div>
  )
}

function InfoRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[90px,1fr] gap-2">
      <dt className="font-medium uppercase tracking-wide text-gray-400">{label}</dt>
      <dd className={(mono ? 'font-mono ' : '') + 'min-w-0 break-words text-gray-700'}>{value}</dd>
    </div>
  )
}

function ComparisonBaseline({
  experiment,
  wtDelta,
  rows,
  suggestions,
  channels,
  onSelectPreset,
}: {
  experiment: Experiment | null
  wtDelta: WildtypeDelta | null
  rows: ComparisonMetricRow[]
  suggestions: Array<{ preset: ChartPresetId; label: string; reason: string }>
  channels: string[]
  onSelectPreset: (preset: ChartPresetId) => void
}) {
  const hasWildtype = Boolean(wtDelta?.has_wildtype)
  const strongest = strongestDelta(wtDelta)
  const compareHref = experiment ? `/results/compare?ids=${experiment.id}` : '/results/compare'
  const pendingStatus = wtDelta?.wt_experiment_id && wtDelta.wt_status && !hasWildtype

  return (
    <section id="comparison" className="mb-8 rounded-lg border border-gray-200 bg-white">
      <div className="flex flex-col gap-3 border-b border-gray-100 px-4 py-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-gray-900">2. WT baseline</h2>
            <HelpTip
              text="This uses the latest completed wildtype experiment with the same condition. It is a phenotype reference, not proof of causality and not necessarily a perfect seed or timeline match."
              position="right"
            />
          </div>
          <p className="mt-1 text-xs text-gray-500">
            Compare this result against the condition-matched WT before deciding which model outputs to inspect.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className={'rounded-full border px-2.5 py-1 font-medium ' + (
            hasWildtype
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : pendingStatus
              ? 'border-blue-200 bg-blue-50 text-blue-800'
              : 'border-amber-200 bg-amber-50 text-amber-800'
          )}>
            {hasWildtype
              ? `WT experiment #${wtDelta?.wt_experiment_id}`
              : pendingStatus
              ? `WT ${statusLabel(wtDelta?.wt_status ?? '')}`
              : 'No completed WT'}
          </span>
          <Link
            to={compareHref}
            className="rounded-full border border-gray-200 bg-white px-2.5 py-1 font-medium text-gray-600 hover:bg-gray-50"
          >
            Open comparison
          </Link>
        </div>
      </div>

      {hasWildtype ? (
        <div className="p-4">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {rows.map((row) => (
              <div key={row.key} className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-gray-800">{row.label}</span>
                  <HelpTip text={row.help} position="bottom" />
                </div>
                <div className="space-y-1 text-xs">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-gray-400">This run</span>
                    <span className="font-mono text-gray-800">
                      {formatComparisonValue(row, row.current)} {row.unit}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-gray-400">WT baseline</span>
                    <span className="font-mono text-gray-600">
                      {formatComparisonValue(row, row.wildtype)} {row.unit}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3 border-t border-gray-200 pt-1">
                    <span className="text-gray-400">{comparisonInterpretation(row)}</span>
                    <span className={'font-mono font-semibold ' + comparisonTone(row)}>
                      {formatPercent(row.deltaPct)}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 grid gap-3 lg:grid-cols-[1fr,1.4fr]">
            <div className="rounded-lg border border-gray-200 bg-white px-3 py-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Interpretation</h3>
              <p className="mt-2 text-sm text-gray-700">
                {strongest
                  ? `${strongest.label} is the largest phenotype shift versus the condition-matched WT (${formatPercent(strongest.value)}). Use it to choose the next plot family; do not infer mechanism from the aggregate metric alone.`
                  : 'The WT baseline is available, but no aggregate metric has a strong percentage shift. Look for subtle timing differences in the time-series workbench.'}
              </p>
            </div>
            <div className="rounded-lg border border-gray-200 bg-white px-3 py-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Suggested next views</h3>
              {suggestions.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {suggestions.map((suggestion) => {
                    const preset = CHART_PRESETS.find((item) => item.id === suggestion.preset)
                    const availableCount = preset?.channels.filter((channel) => channels.includes(channel)).length ?? 0
                    return (
                      <button
                        key={suggestion.preset}
                        type="button"
                        disabled={availableCount === 0}
                        onClick={() => onSelectPreset(suggestion.preset)}
                        className={'rounded-lg border px-3 py-2 text-left text-xs transition-colors ' + (
                          availableCount === 0
                            ? 'border-gray-100 bg-gray-50 text-gray-300 cursor-not-allowed'
                            : 'border-brand-200 bg-brand-50 text-brand-800 hover:bg-brand-100'
                        )}
                        title={suggestion.reason}
                      >
                        <span className="block font-semibold">{suggestion.label}</span>
                        <span className="block max-w-48 text-[11px] opacity-75">{suggestion.reason}</span>
                      </button>
                    )
                  })}
                </div>
              ) : (
                <p className="mt-2 text-sm text-gray-500">
                  No preset recommendation is available until a WT delta is computed.
                </p>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="p-4">
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900">
            {pendingStatus ? (
              <p>
                A condition-matched WT baseline exists as experiment #{wtDelta?.wt_experiment_id}, but it is currently {statusLabel(wtDelta?.wt_status ?? '')}. Relative deltas will appear after it completes.
              </p>
            ) : (
              <p>
                No completed condition-matched WT baseline is available for this result. Absolute curves can still be inspected, but relative fitness or phenotype claims need a compatible WT run.
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
