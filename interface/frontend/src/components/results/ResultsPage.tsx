import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
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
import { MoleculeExplorer } from './MoleculeExplorer'
import { HelpTip, HelpNote } from '../common/HelpTip'
import type { SimulationJob, ResultsResponse, TimeseriesData, Experiment, WildtypeDelta } from '../../types'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, Filler)

// Channel configuration

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
  'cell_mass', 'growth_rate', 'protein_mass', 'rna_mass', 'dna_mass',
  'fba_objective', 'ppgpp_conc',
])

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
  const [job, setJob] = useState<SimulationJob | null>(null)
  const [experiment, setExperiment] = useState<Experiment | null>(null)
  const [resolvedGeneSymbol, setResolvedGeneSymbol] = useState<string | undefined>()
  const [results, setResults] = useState<ResultsResponse | null>(null)
  const [wtDelta, setWtDelta] = useState<WildtypeDelta | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeChannels, setActiveChannels] = useState<Set<string>>(new Set(DEFAULT_ACTIVE))

  useEffect(() => {
    if (!jobId) return
    const id = parseInt(jobId, 10)
    setLoading(true)
    setError(null)

    Promise.all([getJob(id), getJobTimeseries(id)])
      .then(async ([jobData, tsData]) => {
        setJob(jobData)
        setResults(tsData)

        let geneSymbol: string | undefined
        let experimentId: number | undefined
        if (jobData.experiment_id) {
          try {
            const exp = await getExperiment(jobData.experiment_id)
            setExperiment(exp)
            experimentId = exp.id
            geneSymbol = exp.gene_symbol || undefined
          } catch { /* experiment context is optional */ }
        }

        if (!geneSymbol && jobData.variant_type === 'gene_knockout' && jobData.variant_index != null) {
          try {
            const gene = await getGeneByKoIndex(jobData.variant_index)
            geneSymbol = gene.symbol
          } catch { /* best-effort */ }
        }

        setResolvedGeneSymbol(geneSymbol)

        // Fetch WT delta for comparison cards
        if (experimentId && jobData.status === 'done') {
          getWtDelta(experimentId)
            .then(setWtDelta)
            .catch(() => {}) // optional — no delta if no WT
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [jobId])

  const toggleChannel = (ch: string) => {
    setActiveChannels((prev) => {
      const next = new Set(prev)
      if (next.has(ch)) next.delete(ch)
      else next.add(ch)
      return next
    })
  }

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

  const channels = Object.keys(results.timeseries)
  const isMock = !job.sim_dir || job.status !== 'done'
  const grouped = groupChannels(channels)

  return (
    <div className="max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Link to="/results" className="text-gray-400 hover:text-gray-600 text-sm">&larr; All results</Link>
            <span className="text-gray-300">/</span>
            <h1 className="text-xl font-semibold text-gray-900">
              {experiment?.name || (resolvedGeneSymbol ? `${resolvedGeneSymbol} knockout` : `Job #${job.id}`)} Results
            </h1>
          </div>
          <p className="text-sm text-gray-400">
            {experiment?.name ? `Job #${job.id} · ` : ''}{job.variant_type} &middot; seed {job.seed} &middot; {job.generations} generation(s)
            {isMock && (
              <span className="ml-2 px-1.5 py-0.5 bg-amber-50 text-amber-700 text-xs rounded font-medium">
                Mock data
              </span>
            )}
          </p>
        </div>
      </div>

      {/* Summary cards */}
      {results.summary.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
          {(() => {
            const s = results.summary[0]
            return (
              <>
                <SummaryCard
                  label="Division time"
                  value={s.division_time_sec != null ? (s.division_time_sec / 60).toFixed(1) + ' min' : '\u2014'}
                  help="Time from cell birth to division in the simulation. E. coli typically divides every 20-60 min depending on growth conditions."
                  deltaPct={wtDelta?.has_wildtype ? wtDelta.division_time_pct : undefined}
                />
                <SummaryCard
                  label="Final mass"
                  value={s.final_mass_fg != null ? s.final_mass_fg.toFixed(1) + ' fg' : '\u2014'}
                  help="Dry mass of the cell at division, in femtograms. A typical E. coli cell is ~1,000 fg wet mass (~300 fg dry)."
                  deltaPct={wtDelta?.has_wildtype ? wtDelta.final_mass_pct : undefined}
                />
                <SummaryCard
                  label="Growth rate"
                  value={s.growth_rate != null ? (s.growth_rate * 1000).toFixed(2) + ' \u00d710\u207b\u00b3 /s' : '\u2014'}
                  help="Instantaneous specific growth rate at the end of the simulation (1/s). Calculated from the rate of mass increase."
                  deltaPct={wtDelta?.has_wildtype ? wtDelta.growth_rate_pct : undefined}
                />
                <SummaryCard
                  label="Doubling time"
                  value={s.doubling_time_min != null ? s.doubling_time_min.toFixed(1) + ' min' : '\u2014'}
                  help="Time for the cell to double its mass at the current growth rate: ln(2)/growth_rate. Compare to the observed division time."
                  deltaPct={wtDelta?.has_wildtype ? wtDelta.doubling_time_pct : undefined}
                />
              </>
            )
          })()}
        </div>
      )}

      {/* Channel toggles */}
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-sm font-medium text-gray-700">Simulation channels</h2>
        <HelpTip
          text="Each channel is a time-varying output of the whole-cell simulation. Toggle channels on/off to compare dynamics. Mass channels track macromolecular composition; Regulation channels track intracellular signals like ppGpp and amino acid pools; Metabolism channels show flux-balance analysis (FBA) outputs."
          position="right"
        />
      </div>
      <div className="mb-4 space-y-2">
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

      {/* Charts grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-8">
        {channels
          .filter((ch) => activeChannels.has(ch))
          .map((ch) => (
            <TimeseriesChart key={ch} channel={ch} series={results.timeseries[ch]} />
          ))}
      </div>

      {/* Molecule Explorer */}
      {job.status === 'done' && (
        <div className="mb-8">
          <HelpNote variant="model-depth">
            <strong>Model depth:</strong>{' '}The wcEcoli model tracks transcription, translation, and degradation for all 4,749 E. coli genes, but only ~1,500 have <em>mechanistic downstream effects</em> (enzymatic reactions, TF regulation, complex formation). The remaining genes are passengers: their mRNA and protein levels are simulated, but knocking them out may not visibly alter growth rate.
          </HelpNote>
          <div className="mt-3" />
          <MoleculeExplorer
            jobId={job.id}
            geneSymbol={resolvedGeneSymbol}
            variantType={experiment?.variant_type ?? job.variant_type}
          />
        </div>
      )}

      {/* Results table */}
      {results.summary.length > 1 && (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden mb-8">
          <table className="w-full text-sm">
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
                <tr key={i} className="hover:bg-gray-50">
                  <td className="px-4 py-2 font-mono">{s.seed}</td>
                  <td className="px-4 py-2 font-mono">{s.generation}</td>
                  <td className="px-4 py-2 text-right font-mono">
                    {s.division_time_sec != null ? (s.division_time_sec / 60).toFixed(1) + ' min' : '\u2014'}
                  </td>
                  <td className="px-4 py-2 text-right font-mono">
                    {s.final_mass_fg != null ? s.final_mass_fg.toFixed(1) + ' fg' : '\u2014'}
                  </td>
                  <td className="px-4 py-2 text-right font-mono">
                    {s.growth_rate != null ? (s.growth_rate * 1000).toFixed(3) : '—'}
                  </td>
                  <td className="px-4 py-2 text-right font-mono">
                    {s.doubling_time_min != null ? s.doubling_time_min.toFixed(1) + ' min' : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
          {deltaPct > 0 ? '↑' : deltaPct < 0 ? '↓' : '↔'}{' '}
          {deltaPct > 0 ? '+' : ''}{deltaPct.toFixed(1)}% vs WT
        </p>
      )}
    </div>
  )
}
