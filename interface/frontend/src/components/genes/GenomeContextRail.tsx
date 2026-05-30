import { useEffect, useMemo, useRef, useState } from 'react'
import { getGeneNeighbors } from '../../api/client'
import type { Gene } from '../../types'
import { CATEGORY_FILL } from '../../utils/genome'
import { categoryLabel } from '../../utils/labels'

interface Props {
  symbol: string
  window?: number
  onSelectGene?: (symbol: string) => void
}

const TRACK_HEIGHT = 20
const LABEL_HEIGHT = 26
const AXIS_Y = LABEL_HEIGHT + TRACK_HEIGHT + 4
const FWD_LANE_TOP = LABEL_HEIGHT
const REV_LANE_TOP = AXIS_Y + 4 + 1
const SVG_HEIGHT = REV_LANE_TOP + TRACK_HEIGHT + LABEL_HEIGHT + 40
const TRACK_PAD = 16
const LABEL_CHAR_W = 5.8
const LABEL_MIN_GAP = 5
const MIN_LABEL_BODY_WIDTH = 16

interface PositionedGene {
  gene: Gene
  left: number
  right: number
  direction: '+' | '-' | null
}

function geneArrowPoints(
  x: number,
  width: number,
  y: number,
  height: number,
  direction: '+' | '-' | null
): string {
  const arrowTip = Math.min(8, width * 0.4)
  const mid = y + height / 2

  if (direction === '+') {
    if (width <= arrowTip) {
      return x + ',' + y + ' ' + (x + width) + ',' + mid + ' ' + x + ',' + (y + height)
    }
    return [
      x + ',' + y,
      (x + width - arrowTip) + ',' + y,
      (x + width) + ',' + mid,
      (x + width - arrowTip) + ',' + (y + height),
      x + ',' + (y + height),
    ].join(' ')
  }

  if (width <= arrowTip) {
    return (x + width) + ',' + y + ' ' + x + ',' + mid + ' ' + (x + width) + ',' + (y + height)
  }
  return [
    (x + arrowTip) + ',' + y,
    (x + width) + ',' + y,
    (x + width) + ',' + (y + height),
    (x + arrowTip) + ',' + (y + height),
    x + ',' + mid,
  ].join(' ')
}

function niceScale(spanBp: number): number {
  const targets = [500, 1000, 2000, 5000]
  const matchingTargets = targets.filter((target) => target <= spanBp * 0.4)
  return matchingTargets[matchingTargets.length - 1] ?? targets[0]
}

function normalizeDirection(direction: string | null): '+' | '-' | null {
  if (direction === '+') return '+'
  if (direction === '-') return '-'
  return null
}

function formatBp(value: number | null): string {
  return value == null ? 'unknown' : value.toLocaleString()
}

function scaleLabel(scaleBp: number): string {
  return scaleBp >= 1000 ? (scaleBp / 1000) + ' kbp' : scaleBp + ' bp'
}

function strandGapSegments(genes: PositionedGene[], direction: '+' | '-' | null) {
  const strandGenes = genes
    .filter((item) => item.direction === direction)
    .sort((a, b) => a.left - b.left)
  const segments: Array<{ x1: number; x2: number }> = []

  for (let index = 1; index < strandGenes.length; index += 1) {
    const prev = strandGenes[index - 1]
    const next = strandGenes[index]
    if (next.left > prev.right) {
      segments.push({ x1: prev.right, x2: next.left })
    }
  }

  return segments
}

function buildVisibleLabels(
  genes: Array<{ gene: { symbol: string }; x: number; width: number; direction: '+' | '-' | null }>,
  selectedSymbol: string
): Map<string, 0 | 1> {
  const visible = new Map<string, 0 | 1>()

  for (const strandDir of ['+', '-'] as const) {
    const strand = genes
      .filter((g) => g.direction === strandDir)
      .sort((a, b) => (a.x + a.width / 2) - (b.x + b.width / 2))

    let lastRight0 = -Infinity
    let lastRight1 = -Infinity

    for (const g of strand) {
      const sym = g.gene.symbol.slice(0, 8)
      const halfW = (sym.length * LABEL_CHAR_W) / 2
      const cx = g.x + g.width / 2
      const labelLeft = cx - halfW
      const labelRight = cx + halfW
      const isSelected = g.gene.symbol === selectedSymbol

      if (isSelected) {
        visible.set(g.gene.symbol, 0)
        if (labelRight > lastRight0) lastRight0 = labelRight
      } else if (g.width < MIN_LABEL_BODY_WIDTH) {
        continue
      } else if (labelLeft >= lastRight0 + LABEL_MIN_GAP) {
        visible.set(g.gene.symbol, 0)
        lastRight0 = labelRight
      } else if (labelLeft >= lastRight1 + LABEL_MIN_GAP) {
        visible.set(g.gene.symbol, 1)
        lastRight1 = labelRight
      }
    }

    const selectedGene = strand.find((g) => g.gene.symbol === selectedSymbol)
    if (selectedGene && visible.has(selectedSymbol)) {
      const selectedSym = selectedSymbol.slice(0, 8)
      const selectedCx = selectedGene.x + selectedGene.width / 2
      const selectedHalfW = (selectedSym.length * LABEL_CHAR_W) / 2
      const selectedLeft = selectedCx - selectedHalfW - LABEL_MIN_GAP
      const selectedRight = selectedCx + selectedHalfW + LABEL_MIN_GAP

      for (const [sym, row] of [...visible.entries()]) {
        if (sym === selectedSymbol || row !== 0) continue
        const gene = strand.find((g) => g.gene.symbol === sym)
        if (!gene) continue
        const otherSym = sym.slice(0, 8)
        const otherCx = gene.x + gene.width / 2
        const otherHalfW = (otherSym.length * LABEL_CHAR_W) / 2
        if (otherCx + otherHalfW > selectedLeft && otherCx - otherHalfW < selectedRight) {
          visible.delete(sym)
        }
      }
    }
  }

  return visible
}

export function GenomeContextRail({ symbol, window = 5000, onSelectGene }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [trackWidth, setTrackWidth] = useState(400)
  const [neighbors, setNeighbors] = useState<Gene[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const element = containerRef.current
    if (!element) return

    const observer = new ResizeObserver(([entry]) => {
      setTrackWidth(Math.max(240, Math.floor(entry.contentRect.width)))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let active = true
    setLoading(true)
    getGeneNeighbors(symbol, window)
      .then((genes) => {
        if (active) setNeighbors(genes)
      })
      .catch(() => {
        if (active) setNeighbors([])
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [symbol, window])

  const positionedGenes = useMemo<PositionedGene[]>(
    () =>
      neighbors
        .filter((gene) => gene.left_end_pos != null && gene.right_end_pos != null)
        .map((gene) => {
          const left = Math.min(gene.left_end_pos ?? 0, gene.right_end_pos ?? 0)
          const right = Math.max(gene.left_end_pos ?? 0, gene.right_end_pos ?? 0)
          return { gene, left, right, direction: normalizeDirection(gene.direction) }
        }),
    [neighbors]
  )

  const bounds = useMemo(() => {
    if (positionedGenes.length === 0) return null
    const min = Math.min(...positionedGenes.map((item) => item.left))
    const max = Math.max(...positionedGenes.map((item) => item.right))
    return { min, max, span: Math.max(1, max - min) }
  }, [positionedGenes])

  const scale = (position: number) => {
    if (!bounds) return TRACK_PAD
    return TRACK_PAD + ((position - bounds.min) / bounds.span) * (trackWidth - TRACK_PAD * 2)
  }

  const renderedGenes = useMemo(
    () =>
      positionedGenes.map((item) => {
        const left = scale(item.left)
        const right = scale(item.right)
        return {
          ...item,
          x: left,
          width: Math.max(4, right - left),
          laneTop: item.direction === '+' ? FWD_LANE_TOP : REV_LANE_TOP,
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bounds, positionedGenes, trackWidth]
  )

  const visibleLabels = useMemo(
    () => buildVisibleLabels(renderedGenes, symbol),
    [renderedGenes, symbol]
  )

  const forwardGaps = useMemo(
    () => strandGapSegments(renderedGenes, '+'),
    [renderedGenes]
  )
  const reverseGaps = useMemo(
    () => strandGapSegments(renderedGenes, '-'),
    [renderedGenes]
  )
  const scaleBp = bounds ? niceScale(bounds.span) : 0
  const scaleWidth = bounds ? (scaleBp / bounds.span) * (trackWidth - TRACK_PAD * 2) : 0
  const scaleY = SVG_HEIGHT - 20

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
            Genomic context
          </p>
          <p className="text-xs text-gray-500">Nearby genes (±{window.toLocaleString()} bp)</p>
        </div>
        {loading && <span className="text-xs text-gray-400">Loading</span>}
      </div>

      <div ref={containerRef}>
        {bounds && renderedGenes.length > 0 ? (
          <div className="overflow-x-auto rounded-md border border-gray-200 bg-white px-2 py-2">
            <svg
              width={trackWidth}
              height={SVG_HEIGHT}
              role="img"
              aria-label={'Genomic context around ' + symbol}
              style={{ minWidth: '200px' }}
            >
            <line x1={TRACK_PAD} y1={AXIS_Y} x2={trackWidth - TRACK_PAD} y2={AXIS_Y} stroke="#d1d5db" strokeWidth={1} />

            {forwardGaps.map((segment, index) => (
              <line
                key={'fwd-gap-' + index}
                x1={segment.x1}
                y1={FWD_LANE_TOP + TRACK_HEIGHT / 2}
                x2={segment.x2}
                y2={FWD_LANE_TOP + TRACK_HEIGHT / 2}
                stroke="#e5e7eb"
                strokeWidth={1}
              />
            ))}
            {reverseGaps.map((segment, index) => (
              <line
                key={'rev-gap-' + index}
                x1={segment.x1}
                y1={REV_LANE_TOP + TRACK_HEIGHT / 2}
                x2={segment.x2}
                y2={REV_LANE_TOP + TRACK_HEIGHT / 2}
                stroke="#e5e7eb"
                strokeWidth={1}
              />
            ))}

            {renderedGenes.map((item) => {
              const { gene, x, width, laneTop, direction } = item
              const selected = gene.symbol === symbol
              const fill = CATEGORY_FILL[gene.category] ?? CATEGORY_FILL.other
              const labelRow = visibleLabels.get(gene.symbol)
              const showLabel = labelRow !== undefined
              const labelY = direction === '+'
                ? FWD_LANE_TOP - 2 - (labelRow === 1 ? 10 : 0)
                : REV_LANE_TOP + TRACK_HEIGHT + 11 + (labelRow === 1 ? 10 : 0)

              return (
                <g
                  key={gene.symbol}
                  role="button"
                  tabIndex={0}
                  aria-label={'Select ' + gene.symbol}
                  onClick={() => onSelectGene?.(gene.symbol)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      onSelectGene?.(gene.symbol)
                    }
                  }}
                  style={{ cursor: 'pointer' }}
                >
                  <polygon
                    points={geneArrowPoints(x, width, laneTop, TRACK_HEIGHT, direction)}
                    fill={fill}
                    opacity={selected ? 1 : 0.75}
                    stroke={selected ? '#ffffff' : 'none'}
                    strokeWidth={selected ? 1.5 : 0}
                  >
                    <title>
                      {gene.symbol} - {categoryLabel(gene.category)} - {formatBp(gene.left_end_pos)}-{formatBp(gene.right_end_pos)}
                    </title>
                  </polygon>
                  {showLabel && (
                    <>
                      {labelRow === 1 && !selected && (
                        <line
                          x1={x + width / 2}
                          y1={direction === '+' ? labelY + 3 : labelY - 3}
                          x2={x + width / 2}
                          y2={direction === '+' ? laneTop : laneTop + TRACK_HEIGHT}
                          stroke="#d1d5db"
                          strokeWidth={0.75}
                          strokeDasharray="2,2"
                          style={{ pointerEvents: 'none' }}
                        />
                      )}
                      <text
                        x={x + width / 2}
                        y={labelY}
                        textAnchor="middle"
                        fontSize={selected ? 12 : 11}
                        fontWeight={selected ? '600' : '400'}
                        fill={selected ? '#1e3a5f' : '#6b7280'}
                      >
                        {gene.symbol.slice(0, 8)}
                      </text>
                    </>
                  )}
                </g>
              )
            })}

            <g>
              <line x1={TRACK_PAD} y1={scaleY} x2={TRACK_PAD + scaleWidth} y2={scaleY} stroke="#9ca3af" strokeWidth={1.5} />
              <line x1={TRACK_PAD} y1={scaleY - 3} x2={TRACK_PAD} y2={scaleY + 3} stroke="#9ca3af" strokeWidth={1.5} />
              <line
                x1={TRACK_PAD + scaleWidth}
                y1={scaleY - 3}
                x2={TRACK_PAD + scaleWidth}
                y2={scaleY + 3}
                stroke="#9ca3af"
                strokeWidth={1.5}
              />
              <text x={TRACK_PAD + scaleWidth / 2} y={scaleY - 4} textAnchor="middle" fontSize={10} fill="#9ca3af">
                {scaleLabel(scaleBp)}
              </text>
              <text x={TRACK_PAD} y={scaleY + 12} textAnchor="start" fontSize={9} fill="#c4c9d0">
                {bounds.min.toLocaleString()} bp
              </text>
              <text x={trackWidth - TRACK_PAD} y={scaleY + 12} textAnchor="end" fontSize={9} fill="#c4c9d0">
                {bounds.max.toLocaleString()} bp
              </text>
            </g>
            </svg>
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-gray-200 bg-white px-3 py-4 text-xs text-gray-400">
            No neighboring genes with genomic coordinates found.
          </div>
        )}
      </div>
    </div>
  )
}
