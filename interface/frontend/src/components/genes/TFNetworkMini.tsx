import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { CATEGORY_FILL } from '../../utils/genome'

interface RegEdge {
  symbol: string
  log2fc: number
  type: string
}

interface Props {
  symbol: string
  focalCategory: string
  regulatedBy: RegEdge[]
  regulates: RegEdge[]
  onSelectGene?: (symbol: string) => void
}

const NODE_R = 14
const FOCAL_R = NODE_R + 3
const ROW_SPACING = 80
const PAD_TOP = 36
const PAD_BOTTOM = 24
const PAD_SIDE = 36
const REG_LABEL_ABOVE = -(NODE_R + 10)
const TARGET_LABEL_BELOW = NODE_R + 14
const FOCAL_LABEL_ABOVE = -(FOCAL_R + 10)
const LABEL_FONT = 9
const MAX_REG = 7
const MAX_TARGET = 11
const CONTEXT_FILL = '#64748b'
const NODE_IDEAL_SPACING = 64

function edgeProps(log2fc: number, type: string): {
  stroke: string
  markerEnd: string
} {
  const t = type.toLowerCase()
  if (t.includes('activat')) return { stroke: '#16a34a', markerEnd: 'url(#tfnet-arr-act)' }
  if (t.includes('repres') || t.includes('inhibit')) return { stroke: '#dc2626', markerEnd: 'url(#tfnet-bar-rep)' }
  if (t.includes('dual')) return { stroke: '#9ca3af', markerEnd: 'url(#tfnet-arr-neu)' }
  if (log2fc > 0) return { stroke: '#16a34a', markerEnd: 'url(#tfnet-arr-act)' }
  if (log2fc < 0) return { stroke: '#dc2626', markerEnd: 'url(#tfnet-bar-rep)' }
  return { stroke: '#9ca3af', markerEnd: 'url(#tfnet-arr-neu)' }
}

function rowNodeX(index: number, total: number, svgWidth: number): number {
  if (total === 1) return svgWidth / 2
  const naturalSpread = (total - 1) * NODE_IDEAL_SPACING
  const maxSpread = svgWidth - PAD_SIDE * 2
  const spread = Math.min(naturalSpread, maxSpread)
  const startX = svgWidth / 2 - spread / 2
  return startX + (index / (total - 1)) * spread
}

function clipLabel(symbol: string): string {
  return symbol.length > 6 ? `${symbol.slice(0, 5)}...` : symbol
}

function withOverflow(edges: RegEdge[], maxNodes: number): Array<RegEdge | null> {
  if (edges.length <= maxNodes) return edges
  return [...edges.slice(0, maxNodes - 1), null]
}

function overflowCount(edges: RegEdge[], maxNodes: number): number {
  return edges.length > maxNodes ? edges.length - (maxNodes - 1) : 0
}

function MarkerDefs() {
  return (
    <defs>
      <marker id="tfnet-arr-act" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto" markerUnits="strokeWidth">
        <path d="M0,0 L0,6 L8,3 Z" fill="#16a34a" />
      </marker>
      <marker id="tfnet-bar-rep" markerWidth="4" markerHeight="10" refX="2" refY="5" orient="auto" markerUnits="strokeWidth">
        <line x1="2" y1="0" x2="2" y2="10" stroke="#dc2626" strokeWidth="2" />
      </marker>
      <marker id="tfnet-arr-neu" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto" markerUnits="strokeWidth">
        <path d="M0,0 L0,6 L8,3 Z" fill="#9ca3af" />
      </marker>
    </defs>
  )
}

function Node({
  x,
  y,
  symbol,
  fill,
  stroke,
  r = NODE_R,
  onClick,
}: {
  x: number
  y: number
  symbol: string
  fill: string
  stroke?: string
  r?: number
  onClick?: () => void
}) {
  return (
    <g
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-label={onClick ? `Select ${symbol}` : undefined}
      onClick={onClick}
      onKeyDown={(event) => {
        if (!onClick) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onClick()
        }
      }}
      style={{ cursor: onClick ? 'pointer' : 'default' }}
    >
      <circle
        cx={x}
        cy={y}
        r={r}
        fill={fill}
        stroke={stroke ?? 'none'}
        strokeWidth={stroke ? 2 : 0}
        opacity={0.9}
      />
      <title>{symbol}</title>
    </g>
  )
}

function NodeLabel({
  x,
  y,
  label,
  focal = false,
}: {
  x: number
  y: number
  label: string
  focal?: boolean
}) {
  return (
    <text
      x={x}
      y={y}
      textAnchor="middle"
      fontSize={focal ? 11 : LABEL_FONT}
      fontWeight={focal ? '700' : '400'}
      fill={focal ? '#1d4ed8' : '#6b7280'}
      style={{ pointerEvents: 'none' }}
    >
      {focal ? label : clipLabel(label)}
    </text>
  )
}

function OverflowNode({ x, y, count, label }: { x: number; y: number; count: number; label: string }) {
  return (
    <g>
      <circle cx={x} cy={y} r={NODE_R} fill="#e5e7eb" />
      <text x={x} y={y} textAnchor="middle" dominantBaseline="central" fontSize={LABEL_FONT} fill="#6b7280">
        +{count}
      </text>
      <title>{label}</title>
    </g>
  )
}

function Legend() {
  return (
    <div className="flex items-center gap-3 text-[10px] text-gray-400">
      <span className="flex items-center gap-1">
        <svg width="20" height="8" viewBox="0 0 20 8">
          <line x1="0" y1="4" x2="13" y2="4" stroke="#16a34a" strokeWidth="1.5" />
          <path d="M13,1 L19,4 L13,7 Z" fill="#16a34a" />
        </svg>
        activates
      </span>
      <span className="flex items-center gap-1">
        <svg width="20" height="8" viewBox="0 0 20 8">
          <line x1="0" y1="4" x2="15" y2="4" stroke="#dc2626" strokeWidth="1.5" />
          <line x1="16" y1="0.5" x2="16" y2="7.5" stroke="#dc2626" strokeWidth="2" />
        </svg>
        represses
      </span>
    </div>
  )
}

export function TFNetworkMini({ symbol, focalCategory, regulatedBy, regulates, onSelectGene }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [svgWidth, setSvgWidth] = useState(360)

  useEffect(() => {
    const element = containerRef.current
    if (!element) return

    const observer = new ResizeObserver(([entry]) => {
      setSvgWidth(Math.max(260, Math.floor(entry.contentRect.width)))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  if (regulatedBy.length === 0 && regulates.length === 0) return null

  const hasReg = regulatedBy.length > 0
  const hasTarget = regulates.length > 0
  const focalRowIndex = hasReg ? 1 : 0
  const targetRowIndex = hasTarget ? focalRowIndex + 1 : null
  const numRows = focalRowIndex + (hasTarget ? 2 : 1)
  const svgHeight = PAD_TOP + numRows * ROW_SPACING + PAD_BOTTOM
  const rowY = (rowIndex: number) => PAD_TOP + rowIndex * ROW_SPACING + NODE_R

  const regNodes = withOverflow(regulatedBy, MAX_REG)
  const targetNodes = withOverflow(regulates, MAX_TARGET)
  const overflowReg = overflowCount(regulatedBy, MAX_REG)
  const overflowTarget = overflowCount(regulates, MAX_TARGET)
  const focalX = svgWidth / 2
  const focalY = rowY(focalRowIndex)
  const focalFill = CATEGORY_FILL[focalCategory] ?? CATEGORY_FILL.other

  return (
    <div ref={containerRef} className="rounded-lg border border-gray-200 bg-gray-50 p-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
        Local regulation
      </p>
      <svg
        width={svgWidth}
        height={svgHeight}
        role="img"
        aria-label={`Local regulation network for ${symbol}`}
      >
        <MarkerDefs />

        {hasReg && regNodes.map((edge, index) => {
          if (!edge) return null
          const regX = rowNodeX(index, regNodes.length, svgWidth)
          const regY = rowY(0)
          const ep = edgeProps(edge.log2fc, edge.type)
          return (
            <line
              key={`reg-edge-${edge.symbol}-${index}`}
              x1={regX}
              y1={regY + NODE_R}
              x2={focalX}
              y2={focalY - FOCAL_R}
              stroke={ep.stroke}
              strokeWidth={1.5}
              markerEnd={ep.markerEnd}
            />
          )
        })}

        {hasTarget && targetRowIndex != null && targetNodes.map((edge, index) => {
          if (!edge) return null
          const targetX = rowNodeX(index, targetNodes.length, svgWidth)
          const targetY = rowY(targetRowIndex)
          const ep = edgeProps(edge.log2fc, edge.type)
          return (
            <line
              key={`target-edge-${edge.symbol}-${index}`}
              x1={focalX}
              y1={focalY + FOCAL_R}
              x2={targetX}
              y2={targetY - NODE_R}
              stroke={ep.stroke}
              strokeWidth={1.5}
              markerEnd={ep.markerEnd}
            />
          )
        })}

        {hasReg && regNodes.map((edge, index) => {
          const regX = rowNodeX(index, regNodes.length, svgWidth)
          const regY = rowY(0)
          if (!edge) {
            return (
              <OverflowNode
                key="overflow-reg"
                x={regX}
                y={regY}
                count={overflowReg}
                label={`${overflowReg} more regulators`}
              />
            )
          }
          return (
            <g key={`reg-node-${edge.symbol}-${index}`}>
              <Node
                x={regX}
                y={regY}
                symbol={edge.symbol}
                fill={CONTEXT_FILL}
                onClick={() => onSelectGene?.(edge.symbol)}
              />
              <NodeLabel x={regX} y={regY + REG_LABEL_ABOVE} label={edge.symbol} />
            </g>
          )
        })}

        <Node
          x={focalX}
          y={focalY}
          symbol={symbol}
          fill={focalFill}
          stroke="#1e40af"
          r={FOCAL_R}
          onClick={() => onSelectGene?.(symbol)}
        />
        <NodeLabel x={focalX} y={focalY + FOCAL_LABEL_ABOVE} label={symbol} focal />

        {hasTarget && targetRowIndex != null && targetNodes.map((edge, index) => {
          const targetX = rowNodeX(index, targetNodes.length, svgWidth)
          const targetY = rowY(targetRowIndex)
          if (!edge) {
            return (
              <OverflowNode
                key="overflow-target"
                x={targetX}
                y={targetY}
                count={overflowTarget}
                label={`${overflowTarget} more targets`}
              />
            )
          }
          return (
            <g key={`target-node-${edge.symbol}-${index}`}>
              <Node
                x={targetX}
                y={targetY}
                symbol={edge.symbol}
                fill={CONTEXT_FILL}
                onClick={() => onSelectGene?.(edge.symbol)}
              />
              <NodeLabel x={targetX} y={targetY + TARGET_LABEL_BELOW} label={edge.symbol} />
            </g>
          )
        })}

        {hasReg && (
          <text x={focalX} y={10} textAnchor="middle" fontSize={7} fill="#9ca3af">
            regulators
          </text>
        )}
        {hasTarget && targetRowIndex != null && (
          <text x={focalX} y={rowY(targetRowIndex) - 30} textAnchor="middle" fontSize={7} fill="#9ca3af">
            targets
          </text>
        )}
      </svg>
      <div className="mt-2 flex items-center justify-between">
        <Legend />
        {/* TODO: NetworkPage should auto-open a gene detail panel when ?gene= is present in URL */}
        <Link
          to={`/network?gene=${encodeURIComponent(symbol)}`}
          className="flex-shrink-0 text-[11px] text-brand-600 hover:underline"
        >
          Full network -&gt;
        </Link>
      </div>
    </div>
  )
}
