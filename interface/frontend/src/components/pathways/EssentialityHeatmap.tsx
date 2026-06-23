import { useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import type { EssentialityStats, GeneKOSummary } from '../../types'
import { categoryLabel } from '../../utils/labels'
import { useUrlWorkspaceState } from '../../hooks/useUrlWorkspaceState'
import { ASSISTANT_GENE_SAMPLE_LIMIT, summarizeKOSummary } from '../../utils/assistantContext'

type Phenotype = GeneKOSummary['phenotype']
type SortMode = 'total' | 'essential' | 'essential_pct'

const CELL_SIZE = 12
const CELL_GAP = 1

const PHENOTYPE_FILL: Record<Phenotype, string> = {
  essential: '#ef4444',
  growth_defect: '#f59e0b',
  neutral: '#22c55e',
  unknown: '#9ca3af',
}

const PHENOTYPE_LABEL: Record<Phenotype, string> = {
  essential: 'Essential',
  growth_defect: 'Growth defect',
  neutral: 'Neutral',
  unknown: 'Unknown',
}

const PHENOTYPE_RANK: Record<Phenotype, number> = {
  essential: 0,
  growth_defect: 1,
  neutral: 2,
  unknown: 3,
}

interface Props {
  essentiality: EssentialityStats[]
  genes: GeneKOSummary[]
  onAssistantSnapshot?: (snapshot: Record<string, unknown>) => void
}

interface HeatmapRow {
  category: string
  genes: GeneKOSummary[]
  total: number
  essential: number
  growthDefect: number
  neutral: number
  unknown: number
  essentialPct: number
}

interface TooltipState {
  gene: GeneKOSummary
  x: number
  y: number
}

export function EssentialityHeatmap({ essentiality, genes, onAssistantSnapshot }: Props) {
  const { setWorkspaceUrlState } = useUrlWorkspaceState()
  const containerRef = useRef<HTMLDivElement>(null)
  const [mechanisticOnly, setMechanisticOnly] = useState(false)
  const [sortMode, setSortMode] = useState<SortMode>('total')
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)

  const filteredGenes = useMemo(() => {
    return mechanisticOnly ? genes.filter((gene) => gene.is_mechanistic) : genes
  }, [genes, mechanisticOnly])

  const totals = useMemo(() => {
    return filteredGenes.reduce(
      (acc, gene) => {
        acc[gene.phenotype] += 1
        acc.total += 1
        return acc
      },
      { total: 0, essential: 0, growth_defect: 0, neutral: 0, unknown: 0 }
    )
  }, [filteredGenes])

  const rows = useMemo<HeatmapRow[]>(() => {
    const grouped = new Map<string, GeneKOSummary[]>()
    for (const gene of filteredGenes) {
      const list = grouped.get(gene.category) ?? []
      list.push(gene)
      grouped.set(gene.category, list)
    }

    const statsByCategory = new Map(essentiality.map((stat) => [stat.category, stat]))
    const categories = new Set<string>([
      ...essentiality.map((stat) => stat.category),
      ...filteredGenes.map((gene) => gene.category),
    ])

    const nextRows = Array.from(categories, (category) => {
      const rowGenes = [...(grouped.get(category) ?? [])].sort((a, b) => {
        const severity = PHENOTYPE_RANK[a.phenotype] - PHENOTYPE_RANK[b.phenotype]
        return severity !== 0 ? severity : a.gene_symbol.localeCompare(b.gene_symbol)
      })

      const counts = rowGenes.reduce(
        (acc, gene) => {
          acc[gene.phenotype] += 1
          return acc
        },
        { essential: 0, growth_defect: 0, neutral: 0, unknown: 0 }
      )
      const stat = statsByCategory.get(category)
      const total = rowGenes.length || stat?.total || 0
      const essential = rowGenes.length ? counts.essential : stat?.essential ?? 0
      const growthDefect = rowGenes.length ? counts.growth_defect : stat?.growth_defect ?? 0
      const neutral = rowGenes.length ? counts.neutral : stat?.neutral ?? 0
      const unknown = rowGenes.length ? counts.unknown : stat?.unknown ?? 0
      const essentialPct = total > 0 ? (essential / total) * 100 : 0

      return {
        category,
        genes: rowGenes,
        total,
        essential,
        growthDefect,
        neutral,
        unknown,
        essentialPct,
      }
    }).filter((row) => row.total > 0)

    return nextRows.sort((a, b) => {
      if (sortMode === 'essential') return b.essential - a.essential || b.total - a.total
      if (sortMode === 'essential_pct') return b.essentialPct - a.essentialPct || b.total - a.total
      return b.total - a.total
    })
  }, [essentiality, filteredGenes, sortMode])

  const assistantSnapshot = useMemo(() => {
    const categorySample = rows.slice(0, ASSISTANT_GENE_SAMPLE_LIMIT).map((row) => ({
      category: row.category,
      label: categoryLabel(row.category),
      total: row.total,
      essential: row.essential,
      growth_defect: row.growthDefect,
      neutral: row.neutral,
      unknown: row.unknown,
      essential_pct: Number(row.essentialPct.toFixed(2)),
      gene_sample: row.genes.slice(0, 8).map(summarizeKOSummary),
      gene_sample_truncated: row.genes.length > 8,
    }))
    return {
      kind: 'essentiality_heatmap',
      filters: {
        mechanistic_only: mechanisticOnly,
        sort_mode: sortMode,
      },
      totals,
      visible_categories: rows.length,
      category_sample: categorySample,
      category_sample_truncated: rows.length > categorySample.length,
      hovered_gene: tooltip ? summarizeKOSummary(tooltip.gene) : null,
    }
  }, [mechanisticOnly, rows, sortMode, tooltip, totals])

  useEffect(() => {
    onAssistantSnapshot?.(assistantSnapshot)
  }, [assistantSnapshot, onAssistantSnapshot])

  function updateTooltip(event: MouseEvent<SVGRectElement>, gene: GeneKOSummary) {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    setTooltip({
      gene,
      x: event.clientX - rect.left + 12,
      y: event.clientY - rect.top + 12,
    })
  }

  if (genes.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-sm text-gray-400">
        No gene essentiality data available.
      </div>
    )
  }

  return (
    <div ref={containerRef} className="relative space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="inline-flex items-center gap-2 text-sm text-gray-600">
          <input
            type="checkbox"
            checked={mechanisticOnly}
            onChange={(event) => setMechanisticOnly(event.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
          />
          Mechanistic only
        </label>

        <label className="flex items-center gap-2 text-sm text-gray-600">
          Sort rows
          <select
            value={sortMode}
            onChange={(event) => setSortMode(event.target.value as SortMode)}
            className="rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
          >
            <option value="total">Total genes</option>
            <option value="essential">Essential count</option>
            <option value="essential_pct">Essential percentage</option>
          </select>
        </label>
      </div>

      <div className="space-y-2">
        <div className="flex h-4 overflow-hidden rounded-full bg-gray-100">
          <SummarySegment count={totals.essential} total={totals.total} fill={PHENOTYPE_FILL.essential} />
          <SummarySegment count={totals.growth_defect} total={totals.total} fill={PHENOTYPE_FILL.growth_defect} />
          <SummarySegment count={totals.neutral} total={totals.total} fill={PHENOTYPE_FILL.neutral} />
          <SummarySegment count={totals.unknown} total={totals.total} fill={PHENOTYPE_FILL.unknown} />
        </div>
        <div className="flex flex-wrap gap-4 text-xs text-gray-500">
          {(Object.keys(PHENOTYPE_FILL) as Phenotype[]).map((phenotype) => (
            <span key={phenotype} className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: PHENOTYPE_FILL[phenotype] }} />
              {PHENOTYPE_LABEL[phenotype]} {totals[phenotype].toLocaleString()}
            </span>
          ))}
        </div>
      </div>

      <div className="space-y-2 overflow-x-auto pb-2" onMouseLeave={() => setTooltip(null)}>
        {rows.map((row) => {
          const width = Math.max(row.genes.length * (CELL_SIZE + CELL_GAP), 40)
          return (
            <div key={row.category} className="flex items-center gap-3">
              <div className="w-56 shrink-0 text-right">
                <div className="truncate text-sm font-medium text-gray-700" title={categoryLabel(row.category)}>
                  {categoryLabel(row.category)}
                </div>
                <div className="text-xs text-gray-400">
                  {row.total.toLocaleString()} genes, {row.essentialPct.toFixed(1)}% essential
                </div>
              </div>
              <svg
                width={width}
                height={CELL_SIZE}
                className="shrink-0 overflow-visible"
                role="img"
                aria-label={`${categoryLabel(row.category)} essentiality heatmap row`}
              >
                {row.genes.map((gene, index) => (
                  <rect
                    key={gene.gene_symbol}
                    x={index * (CELL_SIZE + CELL_GAP)}
                    y={0}
                    width={CELL_SIZE}
                    height={CELL_SIZE}
                    rx={2}
                    fill={PHENOTYPE_FILL[gene.phenotype]}
                    className="cursor-pointer transition-opacity hover:opacity-80"
                    onMouseEnter={(event) => updateTooltip(event, gene)}
                    onMouseMove={(event) => updateTooltip(event, gene)}
                    onClick={() => {
                      setWorkspaceUrlState(
                        { selectedGene: gene.gene_symbol, selectedCategory: gene.category, exploreView: 'genes' },
                        { pathname: '/', replace: false }
                      )
                    }}
                  />
                ))}
              </svg>
            </div>
          )
        })}
      </div>

      {tooltip && (
        <div
          className="pointer-events-none absolute z-20 w-64 rounded-lg border border-gray-200 bg-white p-3 text-xs text-gray-600 shadow-xl"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          <div className="font-mono text-sm font-semibold text-gray-900">{tooltip.gene.gene_symbol}</div>
          <div className="mt-1">{categoryLabel(tooltip.gene.category)}</div>
          <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <span className="text-gray-400">Phenotype</span>
            <span>{PHENOTYPE_LABEL[tooltip.gene.phenotype]}</span>
            <span className="text-gray-400">Growth</span>
            <span className="font-mono">
              {tooltip.gene.mean_growth_rate != null ? tooltip.gene.mean_growth_rate.toFixed(6) : 'n/a'}
            </span>
            <span className="text-gray-400">Doubling</span>
            <span className="font-mono">
              {tooltip.gene.mean_doubling_time_min != null
                ? `${tooltip.gene.mean_doubling_time_min.toFixed(1)} min`
                : 'n/a'}
            </span>
            <span className="text-gray-400">Runs</span>
            <span className="font-mono">{tooltip.gene.n_completed}</span>
          </div>
        </div>
      )}
    </div>
  )
}

function SummarySegment({ count, total, fill }: { count: number; total: number; fill: string }) {
  if (count === 0 || total === 0) return null
  return (
    <div
      style={{
        width: `${(count / total) * 100}%`,
        backgroundColor: fill,
      }}
      title={`${count.toLocaleString()} genes`}
    />
  )
}
