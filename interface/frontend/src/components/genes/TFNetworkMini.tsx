import { useCallback, useEffect, useRef, useMemo } from 'react'
import { Link } from 'react-router-dom'
import {
  ReactFlow,
  Background,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ReactFlowProvider,
  MarkerType,
  Position,
  Handle,
  type NodeProps,
  type Node,
  type Edge,
} from '@xyflow/react'
import Dagre from '@dagrejs/dagre'
import '@xyflow/react/dist/style.css'
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

const COLOR_ACTIVATE = { edge: '#16a34a', marker: '#16a34a' }
const COLOR_REPRESS  = { edge: '#dc2626', marker: '#dc2626' }
const COLOR_NEUTRAL  = { edge: '#94a3b8', marker: '#94a3b8' }
const REGULATOR_BG   = '#475569'
const TARGET_BG      = '#64748b'

function edgeColor(log2fc: number, type: string) {
  const t = type.toLowerCase()
  if (t.includes('activat')) return COLOR_ACTIVATE
  if (t.includes('repres') || t.includes('inhibit')) return COLOR_REPRESS
  if (t.includes('dual')) return COLOR_NEUTRAL
  if (log2fc > 0) return COLOR_ACTIVATE
  if (log2fc < 0) return COLOR_REPRESS
  return COLOR_NEUTRAL
}

function isRepressor(col: { edge: string; marker: string }) {
  return col.edge === COLOR_REPRESS.edge
}

function applyDagreLayout(nodes: Node[], edges: Edge[]): Node[] {
  const g = new Dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'TB', ranksep: 60, nodesep: 30, marginx: 16, marginy: 16 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const node of nodes) {
    g.setNode(node.id, {
      width: (node.measured?.width ?? 80) + 4,
      height: (node.measured?.height ?? 32) + 4,
    })
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target)
  }
  Dagre.layout(g)
  return nodes.map((node) => {
    const pos = g.node(node.id)
    const w = node.measured?.width ?? 80
    const h = node.measured?.height ?? 32
    return { ...node, position: { x: pos.x - w / 2, y: pos.y - h / 2 } }
  })
}

interface GeneNodeData extends Record<string, unknown> {
  label: string
  bg: string
  border?: string
  focal?: boolean
  clickable?: boolean
}

function GeneNode({ data }: NodeProps<Node<GeneNodeData>>) {
  const { label, bg, border, focal, clickable } = data
  const display = label.length > 8 ? label.slice(0, 7) + '…' : label
  return (
    <>
      <Handle type="target" position={Position.Top} style={{ opacity: 0, pointerEvents: 'none' }} />
      <div
        title={label}
        style={{
          background: bg,
          border: '2px solid ' + (border ?? 'transparent'),
          cursor: clickable ? 'pointer' : 'default',
          borderRadius: focal ? 8 : 5,
          padding: focal ? '5px 12px' : '3px 9px',
          color: '#fff',
          fontSize: focal ? 12 : 10,
          fontWeight: focal ? 700 : 500,
          whiteSpace: 'nowrap',
          userSelect: 'none',
          boxShadow: focal ? '0 0 0 3px rgba(30,64,175,0.2)' : '0 1px 2px rgba(0,0,0,0.12)',
        }}
      >
        {display}
      </div>
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0, pointerEvents: 'none' }} />
    </>
  )
}

interface OverflowNodeData extends Record<string, unknown> {
  label: string
  count: number
}

function OverflowNode({ data }: NodeProps<Node<OverflowNodeData>>) {
  return (
    <>
      <Handle type="target" position={Position.Top} style={{ opacity: 0, pointerEvents: 'none' }} />
      <div
        title={data.label}
        style={{
          background: '#e2e8f0',
          border: '1px dashed #94a3b8',
          borderRadius: 5,
          padding: '3px 9px',
          color: '#64748b',
          fontSize: 10,
          fontWeight: 500,
          whiteSpace: 'nowrap',
          userSelect: 'none',
        }}
      >
        +{data.count} more
      </div>
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0, pointerEvents: 'none' }} />
    </>
  )
}

const NODE_TYPES = { gene: GeneNode, overflow: OverflowNode }

const MAX_REG = 7
const MAX_TARGET = 11

function TFNetworkInner({
  initialNodes,
  initialEdges,
  panelHeight,
  onSelectGene,
}: {
  initialNodes: Node[]
  initialEdges: Edge[]
  panelHeight: number
  onSelectGene?: (symbol: string) => void
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, , onEdgesChange] = useEdgesState(initialEdges)
  const { fitView, getNodes } = useReactFlow()
  const laidOut = useRef(false)
  const initialized = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const runLayout = useCallback(() => {
    if (laidOut.current) return
    laidOut.current = true
    setTimeout(() => {
      const measured = getNodes()
      const positioned = applyDagreLayout(measured, initialEdges)
      setNodes(positioned)
      setTimeout(() => fitView({ padding: 0.18, maxZoom: 1.2 }), 30)
    }, 0)
  }, [fitView, getNodes, initialEdges, setNodes])

  useEffect(() => {
    setNodes(initialNodes)
    laidOut.current = false
    if (!initialized.current) return
    const timer = window.setTimeout(runLayout, 0)
    return () => window.clearTimeout(timer)
  }, [initialNodes, runLayout, setNodes])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      if (laidOut.current) {
        fitView({ padding: 0.18, maxZoom: 1.2 })
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [fitView])

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (!onSelectGene) return
      const label = (node.data as GeneNodeData).label
      if (label) onSelectGene(label)
    },
    [onSelectGene]
  )

  const handleInit = () => {
    initialized.current = true
    runLayout()
  }

  return (
    <div ref={containerRef} style={{ height: panelHeight }} className="rounded-md border border-gray-200 bg-white overflow-hidden">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={NODE_TYPES}
        onInit={handleInit}
        onNodeClick={handleNodeClick}
        fitView
        fitViewOptions={{ padding: 0.18, maxZoom: 1.2 }}
        minZoom={0.2}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        preventScrolling={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#f1f5f9" gap={18} size={1} />
      </ReactFlow>
    </div>
  )
}

export function TFNetworkMini({ symbol, focalCategory, regulatedBy, regulates, onSelectGene }: Props) {
  const focalFill = CATEGORY_FILL[focalCategory] ?? CATEGORY_FILL.other

  const { initialNodes, initialEdges } = useMemo(() => {
    const nodes: Node[] = []
    const edges: Edge[] = []

    nodes.push({
      id: 'focal',
      type: 'gene',
      position: { x: 0, y: 0 },
      data: {
        label: symbol,
        bg: focalFill,
        border: '#1e40af',
        focal: true,
        clickable: onSelectGene != null,
      },
    })

    const regSlice = regulatedBy.slice(0, MAX_REG - 1)
    const regOverflow = regulatedBy.length - regSlice.length

    for (const [i, reg] of regSlice.entries()) {
      const id = 'reg-' + i
      const col = edgeColor(reg.log2fc, reg.type)
      const rep = isRepressor(col)
      nodes.push({
        id,
        type: 'gene',
        position: { x: 0, y: 0 },
        data: {
          label: reg.symbol,
          bg: REGULATOR_BG,
          clickable: onSelectGene != null,
        },
      })
      edges.push({
        id: 'er-' + i,
        source: id,
        target: 'focal',
        type: 'smoothstep',
        style: { stroke: col.edge, strokeWidth: rep ? 2 : 1.5 },
        markerEnd: rep ? undefined : { type: MarkerType.ArrowClosed, color: col.marker, width: 14, height: 14 },
        label: rep ? '⊣' : undefined,
        labelStyle: rep ? { fill: col.edge, fontSize: 12, fontWeight: 700 } : undefined,
        labelBgStyle: rep ? { fill: 'transparent' } : undefined,
      })
    }

    if (regOverflow > 0) {
      nodes.push({ id: 'overflow-reg', type: 'overflow', position: { x: 0, y: 0 }, data: { label: regOverflow + ' more regulators', count: regOverflow } })
      edges.push({ id: 'er-overflow', source: 'overflow-reg', target: 'focal', type: 'smoothstep', style: { stroke: '#cbd5e1', strokeWidth: 1, strokeDasharray: '4,3' } })
    }

    const targetSlice = regulates.slice(0, MAX_TARGET - 1)
    const targetOverflow = regulates.length - targetSlice.length

    for (const [i, tgt] of targetSlice.entries()) {
      const id = 'tgt-' + i
      const col = edgeColor(tgt.log2fc, tgt.type)
      const rep = isRepressor(col)
      nodes.push({
        id,
        type: 'gene',
        position: { x: 0, y: 0 },
        data: {
          label: tgt.symbol,
          bg: TARGET_BG,
          clickable: onSelectGene != null,
        },
      })
      edges.push({
        id: 'et-' + i,
        source: 'focal',
        target: id,
        type: 'smoothstep',
        style: { stroke: col.edge, strokeWidth: rep ? 2 : 1.5 },
        markerEnd: rep ? undefined : { type: MarkerType.ArrowClosed, color: col.marker, width: 14, height: 14 },
        label: rep ? '⊣' : undefined,
        labelStyle: rep ? { fill: col.edge, fontSize: 12, fontWeight: 700 } : undefined,
        labelBgStyle: rep ? { fill: 'transparent' } : undefined,
      })
    }

    if (targetOverflow > 0) {
      nodes.push({ id: 'overflow-tgt', type: 'overflow', position: { x: 0, y: 0 }, data: { label: targetOverflow + ' more targets', count: targetOverflow } })
      edges.push({ id: 'et-overflow', source: 'focal', target: 'overflow-tgt', type: 'smoothstep', style: { stroke: '#cbd5e1', strokeWidth: 1, strokeDasharray: '4,3' } })
    }

    return { initialNodes: nodes, initialEdges: edges }
  }, [symbol, focalCategory, regulatedBy, regulates, onSelectGene, focalFill])

  if (regulatedBy.length === 0 && regulates.length === 0) return null

  const numRows = (regulatedBy.length > 0 ? 1 : 0) + 1 + (regulates.length > 0 ? 1 : 0)
  const panelHeight = Math.max(160, numRows * 96 + 32)

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
      <div className="mb-2 flex items-baseline gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Local regulation</p>
        <span className="text-sm font-bold text-blue-700">{symbol}</span>
      </div>
      <ReactFlowProvider>
        <TFNetworkInner
          initialNodes={initialNodes}
          initialEdges={initialEdges}
          panelHeight={panelHeight}
          onSelectGene={onSelectGene}
        />
      </ReactFlowProvider>
      <div className="mt-2 flex items-center justify-between">
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
              <line x1="0" y1="4" x2="15" y2="4" stroke="#dc2626" strokeWidth="2" />
              <line x1="16" y1="0.5" x2="16" y2="7.5" stroke="#dc2626" strokeWidth="2" />
            </svg>
            represses
          </span>
        </div>
        <Link to={'/network?gene=' + encodeURIComponent(symbol)} className="flex-shrink-0 text-[11px] text-brand-600 hover:underline">
          Full network
        </Link>
      </div>
    </div>
  )
}
