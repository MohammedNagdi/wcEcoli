import { useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent, PointerEvent, WheelEvent } from 'react'
import type { Gene } from '../../types'
import {
  CATEGORY_FILL,
  GENOME_LENGTH,
  arcPath,
  bpToAngle,
  hasGenomePosition,
  polarToCartesian,
} from '../../utils/genome'
import { categoryLabel } from '../../utils/labels'
import { useUrlWorkspaceState } from '../../hooks/useUrlWorkspaceState'

const VIEW_SIZE = 800
const CENTER = 400
const FORWARD_INNER_R = 300
const FORWARD_OUTER_R = 340
const REVERSE_INNER_R = 260
const REVERSE_OUTER_R = 295
const MIN_ARC_RAD = (0.3 * Math.PI) / 180
const ORIC_BP = 3_925_744
const TER_BP = 1_590_000

interface Props {
  genes: Gene[]
  searchTerm: string
  highlightedCategories: Set<string>
  focusGene?: string | null
  compact?: boolean
  darkMode?: boolean
}

interface TooltipState {
  gene: Gene
  x: number
  y: number
}

interface DragState {
  x: number
  y: number
  panX: number
  panY: number
}

export function CircularGenomeMap({
  genes,
  searchTerm,
  highlightedCategories,
  focusGene = null,
  compact = false,
  darkMode = true,
}: Props) {
  const { setWorkspaceUrlState } = useUrlWorkspaceState()
  const containerRef = useRef<HTMLDivElement>(null)
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)
  const [hoveredSymbol, setHoveredSymbol] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [drag, setDrag] = useState<DragState | null>(null)
  const hasAppliedFocusRef = useRef<string | null>(null)
  const warnedFocusRef = useRef<string | null>(null)
  const palette = darkMode
    ? {
        bg: '#111827',
        wrapperCls: 'bg-gray-900 border border-gray-800',
        ring: '#374151',
        tooltipCls: 'border border-gray-700 bg-gray-950/95 text-gray-200',
        tooltipTitle: 'text-white',
        tooltipMuted: 'text-gray-400',
        tooltipLabel: 'text-gray-500',
        posText: '#9ca3af',
        centerTitle: '#e5e7eb',
        centerSubtitle: '#9ca3af',
      }
    : {
        bg: '#ffffff',
        wrapperCls: 'bg-white border border-gray-200',
        ring: '#e5e7eb',
        tooltipCls: 'border border-gray-200 bg-white text-gray-900 shadow',
        tooltipTitle: 'text-gray-900',
        tooltipMuted: 'text-gray-500',
        tooltipLabel: 'text-gray-400',
        posText: '#6b7280',
        centerTitle: '#111827',
        centerSubtitle: '#6b7280',
      }

  const positionedGenes = useMemo(() => {
    return genes.filter(hasGenomePosition).map((gene) => {
      const left = Math.min(gene.left_end_pos, gene.right_end_pos)
      const right = Math.max(gene.left_end_pos, gene.right_end_pos)
      const startAngle = bpToAngle(left)
      let endAngle = bpToAngle(right)
      if (endAngle <= startAngle) endAngle += Math.PI * 2
      if (endAngle - startAngle < MIN_ARC_RAD) endAngle = startAngle + MIN_ARC_RAD
      return { gene, left, right, startAngle, endAngle }
    })
  }, [genes])

  useEffect(() => {
    hasAppliedFocusRef.current = null
    warnedFocusRef.current = null
  }, [focusGene])

  useEffect(() => {
    if (!focusGene) return
    if (hasAppliedFocusRef.current === focusGene) return

    const entry = positionedGenes.find(
      (pg) => pg.gene.symbol.toLowerCase() === focusGene.toLowerCase()
    )
    if (!entry) {
      if (positionedGenes.length > 4000 && warnedFocusRef.current !== focusGene) {
        console.warn(`[GenomeMap] focusGene "${focusGene}" not found in mapped genes`)
        warnedFocusRef.current = focusGene
      }
      return
    }

    const midAngle = (entry.startAngle + entry.endAngle) / 2
    const focusRadius = entry.gene.direction === '-'
      ? (REVERSE_INNER_R + REVERSE_OUTER_R) / 2
      : (FORWARD_INNER_R + FORWARD_OUTER_R) / 2
    const arcX = CENTER + focusRadius * Math.cos(midAngle)
    const arcY = CENTER + focusRadius * Math.sin(midAngle)
    const targetZoom = 8
    setZoom(targetZoom)
    setPan({
      x: (CENTER - arcX) * targetZoom,
      y: (CENTER - arcY) * targetZoom,
    })
    hasAppliedFocusRef.current = focusGene
  }, [focusGene, positionedGenes])

  const normalizedSearch = searchTerm.trim().toLowerCase()
  const hasSearch = normalizedSearch.length > 0
  const hasHighlightedCategories = highlightedCategories.size > 0
  const hasFocusGene = focusGene != null
  const glowFilter = darkMode
    ? 'drop-shadow(0 0 8px rgba(250, 204, 21, 0.95))'
    : 'drop-shadow(0 0 8px rgba(15, 23, 42, 0.85)) drop-shadow(0 0 4px rgba(234, 88, 12, 0.7))'

  function updateTooltip(event: MouseEvent<SVGPathElement>, gene: Gene) {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    setTooltip({
      gene,
      x: event.clientX - rect.left + 14,
      y: event.clientY - rect.top + 14,
    })
  }

  function handleWheel(event: WheelEvent<SVGSVGElement>) {
    event.preventDefault()
    const factor = event.deltaY < 0 ? 1.15 : 0.85
    setZoom((current) => {
      const next = Math.min(16, Math.max(1, current * factor))
      if (next === 1) setPan({ x: 0, y: 0 })
      return next
    })
  }

  function handlePointerDown(event: PointerEvent<SVGSVGElement>) {
    if (zoom <= 1 || event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    setDrag({
      x: event.clientX,
      y: event.clientY,
      panX: pan.x,
      panY: pan.y,
    })
  }

  function handlePointerMove(event: PointerEvent<SVGSVGElement>) {
    if (!drag) return
    setPan({
      x: drag.panX + event.clientX - drag.x,
      y: drag.panY + event.clientY - drag.y,
    })
  }

  function handlePointerUp(event: PointerEvent<SVGSVGElement>) {
    if (drag) event.currentTarget.releasePointerCapture(event.pointerId)
    setDrag(null)
  }

  return (
    <div
      ref={containerRef}
      className={`relative ${
        compact
          ? 'flex min-h-0 flex-1 items-center justify-center'
          : 'flex h-full min-h-0 items-center justify-center'
      }`}
    >
      <div className={`relative mx-auto aspect-square overflow-hidden rounded-xl ${compact ? 'h-full max-h-[420px] max-w-full' : 'h-full max-w-full'} ${palette.wrapperCls}`}>
        <svg
          viewBox={`0 0 ${VIEW_SIZE} ${VIEW_SIZE}`}
          className={`h-full w-full select-none ${zoom > 1 ? 'cursor-grab' : ''} ${
            drag ? 'cursor-grabbing' : ''
          }`}
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          <rect width={VIEW_SIZE} height={VIEW_SIZE} fill={palette.bg} />
          <g
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: `${CENTER}px ${CENTER}px`,
              transition: drag ? 'none' : 'transform 120ms ease-out',
            }}
          >
            <GenomeTicks posText={palette.posText} />
            <circle cx={CENTER} cy={CENTER} r={250} fill={palette.bg} stroke={palette.ring} strokeWidth="1" />
            <circle cx={CENTER} cy={CENTER} r={298} fill="none" stroke={palette.ring} strokeWidth="1" />
            <circle cx={CENTER} cy={CENTER} r={342} fill="none" stroke={palette.ring} strokeWidth="1" />

            {positionedGenes.map(({ gene, left, right, startAngle, endAngle }) => {
              const isForward = gene.direction === '+'
              const isHovered = hoveredSymbol === gene.symbol
              const isFocusGene = hasFocusGene && gene.symbol.toLowerCase() === focusGene?.toLowerCase()
              const isSearchMatch = hasSearch && gene.symbol.toLowerCase().includes(normalizedSearch)
              const isCategoryHighlight = hasHighlightedCategories && highlightedCategories.has(gene.category)
              const isGlowing = isHovered || isSearchMatch || isFocusGene || isCategoryHighlight
              const hasAnyFilter = hasSearch || hasHighlightedCategories || hasFocusGene
              const isDimmedOut = hasAnyFilter && !isGlowing
              const fill = CATEGORY_FILL[gene.category] ?? CATEGORY_FILL.other
              const d = arcPath(
                CENTER,
                CENTER,
                isForward ? FORWARD_INNER_R : REVERSE_INNER_R,
                isForward ? FORWARD_OUTER_R : REVERSE_OUTER_R,
                startAngle,
                endAngle
              )

              return (
                <path
                  key={`${gene.id}-${left}-${right}`}
                  d={d}
                  fill={fill}
                  opacity={isDimmedOut ? 0.08 : isGlowing ? 1 : 0.85}
                  stroke={isGlowing ? (darkMode ? '#f9fafb' : '#0f172a') : 'none'}
                  strokeWidth={isFocusGene ? 5 : isGlowing ? 1.25 : 0}
                  className={isSearchMatch || isCategoryHighlight || isFocusGene ? 'animate-pulse' : undefined}
                  style={{
                    cursor: 'pointer',
                    filter: isGlowing ? glowFilter : undefined,
                    transition: 'opacity 120ms ease, stroke-width 120ms ease',
                  }}
                  onPointerDown={(event) => event.stopPropagation()}
                  onMouseEnter={(event) => {
                    setHoveredSymbol(gene.symbol)
                    updateTooltip(event, gene)
                  }}
                  onMouseMove={(event) => updateTooltip(event, gene)}
                  onMouseLeave={() => {
                    setHoveredSymbol(null)
                    setTooltip(null)
                  }}
                  onClick={(event) => {
                    event.stopPropagation()
                    setWorkspaceUrlState(
                      { selectedGene: gene.symbol, exploreView: 'genes' },
                      { pathname: '/', replace: false }
                    )
                  }}
                />
              )
            })}

            <GenomeMarker bp={ORIC_BP} label="oriC" fill="#facc15" stroke={palette.bg} textFill={palette.centerTitle} />
            <GenomeMarker bp={TER_BP} label="ter" fill="#60a5fa" stroke={palette.bg} textFill={palette.centerTitle} />

            <text x={CENTER} y={CENTER - 8} textAnchor="middle" fill={palette.centerTitle} className="text-lg font-semibold">
              E. coli K-12
            </text>
            <text x={CENTER} y={CENTER + 20} textAnchor="middle" fill={palette.centerSubtitle} className="text-sm">
              4.64 Mbp
            </text>
          </g>
        </svg>
      </div>

      <div className="absolute left-4 top-4 flex items-center gap-2 rounded-md bg-gray-950/70 px-2.5 py-1.5 text-xs text-gray-300">
        <span>{zoom.toFixed(1)}x</span>
        {zoom > 1 && (
          <button
            onClick={() => {
              setZoom(1)
              setPan({ x: 0, y: 0 })
            }}
            className="text-gray-400 hover:text-white"
          >
            Reset
          </button>
        )}
      </div>

      {tooltip && (
        <div
          className={`pointer-events-none absolute z-20 w-60 rounded-lg p-3 text-xs shadow-xl ${palette.tooltipCls}`}
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          <div className={`font-mono text-sm font-semibold ${palette.tooltipTitle}`}>{tooltip.gene.symbol}</div>
          <div className={`mt-1 ${palette.tooltipMuted}`}>{categoryLabel(tooltip.gene.category)}</div>
          <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <span className={palette.tooltipLabel}>Position</span>
            <span className="font-mono">
              {tooltip.gene.left_end_pos?.toLocaleString()}-{tooltip.gene.right_end_pos?.toLocaleString()}
            </span>
            <span className={palette.tooltipLabel}>Strand</span>
            <span>{tooltip.gene.direction === '+' ? 'Forward' : tooltip.gene.direction === '-' ? 'Reverse' : 'Unknown'}</span>
          </div>
          <div className={`mt-2 border-t ${darkMode ? 'border-gray-700' : 'border-gray-200'} pt-1.5 text-[10px] opacity-60`}>
            Click to open in Explore
          </div>
        </div>
      )}
    </div>
  )
}

function GenomeTicks({ posText }: { posText: string }) {
  const ticks = Array.from({ length: 9 }, (_, index) => (index + 1) * 500_000).filter(
    (bp) => bp < GENOME_LENGTH
  )

  return (
    <g>
      {ticks.map((bp) => {
        const angle = bpToAngle(bp)
        const inner = polarToCartesian(CENTER, CENTER, 350, angle)
        const outer = polarToCartesian(CENTER, CENTER, 368, angle)
        const label = polarToCartesian(CENTER, CENTER, 388, angle)
        return (
          <g key={bp}>
            <line
              x1={inner.x}
              y1={inner.y}
              x2={outer.x}
              y2={outer.y}
              stroke={posText}
              strokeWidth="1"
              opacity="0.7"
            />
            <text
              x={label.x}
              y={label.y}
              textAnchor="middle"
              dominantBaseline="middle"
              fill={posText}
              className="text-[11px]"
            >
              {(bp / 1_000_000).toFixed(1)}
            </text>
          </g>
        )
      })}
    </g>
  )
}

function GenomeMarker({ bp, label, fill, stroke, textFill }: { bp: number; label: string; fill: string; stroke: string; textFill: string }) {
  const angle = bpToAngle(bp)
  const tip = polarToCartesian(CENTER, CENTER, 356, angle)
  const left = polarToCartesian(CENTER, CENTER, 338, angle - 0.025)
  const right = polarToCartesian(CENTER, CENTER, 338, angle + 0.025)
  const text = polarToCartesian(CENTER, CENTER, 378, angle)

  return (
    <g>
      <polygon
        points={`${tip.x},${tip.y} ${left.x},${left.y} ${right.x},${right.y}`}
        fill={fill}
        stroke={stroke}
        strokeWidth="1"
      />
      <text
        x={text.x}
        y={text.y}
        textAnchor="middle"
        dominantBaseline="middle"
        fill={textFill}
        className="text-[11px] font-medium"
      >
        {label}
      </text>
    </g>
  )
}
