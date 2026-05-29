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

const VW = 500
const NODE_R = 15
const LABEL_FONT = 9
const NODE_SPACING = 36
const COL_REG = 70
const COL_FOCAL = 250
const COL_TARGET = 430
const MAX_REG = 7
const MAX_TARGET = 11
const CONTEXT_FILL = '#64748b'

function edgeProps(log2fc: number, type: string): {
  stroke: string
  markerEnd: string
} {
  const isDual = type.toLowerCase().includes('dual')
  if (isDual || log2fc === 0) {
    return { stroke: '#9ca3af', markerEnd: 'url(#tfnet-arr-neu)' }
  }
  if (log2fc > 0) {
    return { stroke: '#16a34a', markerEnd: 'url(#tfnet-arr-act)' }
  }
  return { stroke: '#dc2626', markerEnd: 'url(#tfnet-bar-rep)' }
}

function nodeY(index: number, total: number, centerY: number): number {
  const totalHeight = (total - 1) * NODE_SPACING
  const startY = centerY - totalHeight / 2
  return startY + index * NODE_SPACING
}

function clipSymbol(symbol: string): string {
  return symbol.length > 5 ? `${symbol.slice(0, 4)}...` : symbol
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
  bold = false,
  onClick,
}: {
  x: number
  y: number
  symbol: string
  fill: string
  stroke?: string
  r?: number
  bold?: boolean
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
      <text
        x={x}
        y={y}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={LABEL_FONT}
        fontWeight={bold ? '700' : '500'}
        fill="#ffffff"
        style={{ pointerEvents: 'none' }}
      >
        {clipSymbol(symbol)}
      </text>
      <title>{symbol}</title>
    </g>
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
    <div className="mt-1.5 flex items-center gap-3 text-[10px] text-gray-400">
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
  if (regulatedBy.length === 0 && regulates.length === 0) return null

  const hasReg = regulatedBy.length > 0
  const hasTarget = regulates.length > 0
  const focalX = hasReg && hasTarget ? COL_FOCAL : hasReg ? 300 : 100
  const regX = COL_REG
  const targetX = hasReg && hasTarget ? COL_TARGET : 380

  const shownReg = regulatedBy.slice(0, MAX_REG)
  const overflowReg = regulatedBy.length > MAX_REG ? regulatedBy.length - MAX_REG : 0
  const regNodes: Array<RegEdge | null> = overflowReg > 0 ? [...shownReg, null] : shownReg

  const shownTarget = regulates.slice(0, MAX_TARGET)
  const overflowTarget = regulates.length > MAX_TARGET ? regulates.length - MAX_TARGET : 0
  const targetNodes: Array<RegEdge | null> = overflowTarget > 0 ? [...shownTarget, null] : shownTarget

  const rows = Math.max(regNodes.length, targetNodes.length, 1)
  const svgHeight = rows * NODE_SPACING + 40
  const focalY = svgHeight / 2
  const focalR = NODE_R + 3
  const focalFill = CATEGORY_FILL[focalCategory] ?? CATEGORY_FILL.other

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
        Local regulation
      </p>
      <svg
        viewBox={`0 0 ${VW} ${svgHeight}`}
        width="100%"
        height={svgHeight}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`Local regulation network for ${symbol}`}
      >
        <MarkerDefs />

        {hasReg && regNodes.map((edge, index) => {
          if (!edge) return null
          const ep = edgeProps(edge.log2fc, edge.type)
          const ry = nodeY(index, regNodes.length, focalY)
          return (
            <line
              key={`reg-edge-${edge.symbol}-${index}`}
              x1={regX + NODE_R}
              y1={ry}
              x2={focalX - focalR}
              y2={focalY}
              stroke={ep.stroke}
              strokeWidth={1.5}
              markerEnd={ep.markerEnd}
            />
          )
        })}

        {hasTarget && targetNodes.map((edge, index) => {
          if (!edge) return null
          const ep = edgeProps(edge.log2fc, edge.type)
          const ty = nodeY(index, targetNodes.length, focalY)
          return (
            <line
              key={`target-edge-${edge.symbol}-${index}`}
              x1={focalX + focalR}
              y1={focalY}
              x2={targetX - NODE_R}
              y2={ty}
              stroke={ep.stroke}
              strokeWidth={1.5}
              markerEnd={ep.markerEnd}
            />
          )
        })}

        {hasReg && regNodes.map((edge, index) => {
          const ry = nodeY(index, regNodes.length, focalY)
          if (!edge) {
            return (
              <OverflowNode
                key="overflow-reg"
                x={regX}
                y={ry}
                count={overflowReg}
                label={`${overflowReg} more regulators`}
              />
            )
          }
          return (
            <Node
              key={`reg-node-${edge.symbol}-${index}`}
              x={regX}
              y={ry}
              symbol={edge.symbol}
              fill={CONTEXT_FILL}
              onClick={() => onSelectGene?.(edge.symbol)}
            />
          )
        })}

        <Node
          x={focalX}
          y={focalY}
          symbol={symbol}
          fill={focalFill}
          stroke="#1e40af"
          r={focalR}
          bold
          onClick={() => onSelectGene?.(symbol)}
        />

        {hasTarget && targetNodes.map((edge, index) => {
          const ty = nodeY(index, targetNodes.length, focalY)
          if (!edge) {
            return (
              <OverflowNode
                key="overflow-target"
                x={targetX}
                y={ty}
                count={overflowTarget}
                label={`${overflowTarget} more targets`}
              />
            )
          }
          return (
            <Node
              key={`target-node-${edge.symbol}-${index}`}
              x={targetX}
              y={ty}
              symbol={edge.symbol}
              fill={CONTEXT_FILL}
              onClick={() => onSelectGene?.(edge.symbol)}
            />
          )
        })}

        {hasReg && (
          <text x={regX} y={8} textAnchor="middle" fontSize={7} fill="#9ca3af">
            regulators
          </text>
        )}
        {hasTarget && (
          <text x={targetX} y={8} textAnchor="middle" fontSize={7} fill="#9ca3af">
            targets
          </text>
        )}
      </svg>
      <Legend />
    </div>
  )
}
