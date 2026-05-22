import { useMemo, useRef, useState } from 'react'
import type { MouseEvent, PointerEvent, WheelEvent } from 'react'
import { useNavigate } from 'react-router-dom'
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
  dimmedCategories: Set<string>
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

export function CircularGenomeMap({ genes, searchTerm, dimmedCategories }: Props) {
  const navigate = useNavigate()
  const containerRef = useRef<HTMLDivElement>(null)
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)
  const [hoveredSymbol, setHoveredSymbol] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [drag, setDrag] = useState<DragState | null>(null)

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

  const normalizedSearch = searchTerm.trim().toLowerCase()

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
      const next = Math.min(8, Math.max(1, current * factor))
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
    <div ref={containerRef} className="relative">
      <div className="bg-gray-900 rounded-xl overflow-hidden border border-gray-800">
        <svg
          viewBox={`0 0 ${VIEW_SIZE} ${VIEW_SIZE}`}
          className={`w-full max-h-[760px] select-none ${zoom > 1 ? 'cursor-grab' : ''} ${
            drag ? 'cursor-grabbing' : ''
          }`}
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          <rect width={VIEW_SIZE} height={VIEW_SIZE} fill="#111827" />
          <g
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: `${CENTER}px ${CENTER}px`,
              transition: drag ? 'none' : 'transform 120ms ease-out',
            }}
          >
            <GenomeTicks />
            <circle cx={CENTER} cy={CENTER} r={250} fill="#111827" stroke="#374151" strokeWidth="1" />
            <circle cx={CENTER} cy={CENTER} r={298} fill="none" stroke="#1f2937" strokeWidth="1" />
            <circle cx={CENTER} cy={CENTER} r={342} fill="none" stroke="#1f2937" strokeWidth="1" />

            {positionedGenes.map(({ gene, left, right, startAngle, endAngle }) => {
              const isForward = gene.direction === '+'
              const isHovered = hoveredSymbol === gene.symbol
              const isSearchMatch =
                normalizedSearch.length > 0 &&
                gene.symbol.toLowerCase().includes(normalizedSearch)
              const isDimmed = dimmedCategories.has(gene.category)
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
                  opacity={isDimmed ? 0.1 : isHovered || isSearchMatch ? 1 : 0.85}
                  stroke={isHovered || isSearchMatch ? '#f9fafb' : 'none'}
                  strokeWidth={isHovered || isSearchMatch ? 1.25 : 0}
                  className={isSearchMatch ? 'animate-pulse' : undefined}
                  style={{
                    cursor: 'pointer',
                    filter: isSearchMatch ? 'drop-shadow(0 0 7px rgba(250, 204, 21, 0.95))' : undefined,
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
                    navigate(`/?q=${encodeURIComponent(gene.symbol)}`)
                  }}
                />
              )
            })}

            <GenomeMarker bp={ORIC_BP} label="oriC" fill="#facc15" />
            <GenomeMarker bp={TER_BP} label="ter" fill="#60a5fa" />

            <text x={CENTER} y={CENTER - 8} textAnchor="middle" className="fill-gray-200 text-lg font-semibold">
              E. coli K-12
            </text>
            <text x={CENTER} y={CENTER + 20} textAnchor="middle" className="fill-gray-400 text-sm">
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
          className="pointer-events-none absolute z-20 w-60 rounded-lg border border-gray-700 bg-gray-950/95 p-3 text-xs text-gray-200 shadow-xl"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          <div className="font-mono text-sm font-semibold text-white">{tooltip.gene.symbol}</div>
          <div className="mt-1 text-gray-400">{categoryLabel(tooltip.gene.category)}</div>
          <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <span className="text-gray-500">Position</span>
            <span className="font-mono">
              {tooltip.gene.left_end_pos?.toLocaleString()}-{tooltip.gene.right_end_pos?.toLocaleString()}
            </span>
            <span className="text-gray-500">Strand</span>
            <span>{tooltip.gene.direction === '+' ? 'Forward' : tooltip.gene.direction === '-' ? 'Reverse' : 'Unknown'}</span>
          </div>
        </div>
      )}
    </div>
  )
}

function GenomeTicks() {
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
              stroke="#9ca3af"
              strokeWidth="1"
              opacity="0.7"
            />
            <text
              x={label.x}
              y={label.y}
              textAnchor="middle"
              dominantBaseline="middle"
              className="fill-gray-400 text-[11px]"
            >
              {(bp / 1_000_000).toFixed(1)}
            </text>
          </g>
        )
      })}
    </g>
  )
}

function GenomeMarker({ bp, label, fill }: { bp: number; label: string; fill: string }) {
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
        stroke="#111827"
        strokeWidth="1"
      />
      <text
        x={text.x}
        y={text.y}
        textAnchor="middle"
        dominantBaseline="middle"
        className="fill-gray-200 text-[11px] font-medium"
      >
        {label}
      </text>
    </g>
  )
}
