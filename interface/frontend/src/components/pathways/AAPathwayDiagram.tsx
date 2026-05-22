import { useMemo, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import type { AAPathway, GeneKOSummary } from '../../types'

interface Props {
  pathways: AAPathway[]
  genes: GeneKOSummary[]
}

interface Edge {
  id: string
  source: string
  target: string
  enzymes: string[]
}

interface NodeInfo {
  key: string
  name: string
  pathway: AAPathway | null
  enzymes: string[]
  severity: 'essential' | 'growth_defect' | 'neutral'
  x: number
  y: number
}

interface TooltipState {
  node: NodeInfo
  x: number
  y: number
}

const NODE_R = 22

const SEVERITY_STYLE = {
  essential: { fill: '#fee2e2', stroke: '#ef4444' },
  growth_defect: { fill: '#fef3c7', stroke: '#f59e0b' },
  neutral: { fill: '#dcfce7', stroke: '#22c55e' },
}

const AA_CODES: Record<string, string> = {
  alanine: 'Ala',
  arginine: 'Arg',
  asparagine: 'Asn',
  aspartate: 'Asp',
  'aspartic acid': 'Asp',
  cysteine: 'Cys',
  glutamate: 'Glu',
  'glutamic acid': 'Glu',
  glutamine: 'Gln',
  glycine: 'Gly',
  histidine: 'His',
  isoleucine: 'Ile',
  leucine: 'Leu',
  lysine: 'Lys',
  methionine: 'Met',
  phenylalanine: 'Phe',
  proline: 'Pro',
  serine: 'Ser',
  threonine: 'Thr',
  tryptophan: 'Trp',
  tyrosine: 'Tyr',
  valine: 'Val',
}

export function AAPathwayDiagram({ pathways, genes }: Props) {
  const navigate = useNavigate()
  const containerRef = useRef<HTMLDivElement>(null)
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)
  const [selectedNode, setSelectedNode] = useState<string | null>(null)

  const model = useMemo(() => buildDiagram(pathways, genes), [pathways, genes])

  const connectedNodes = useMemo(() => {
    if (!selectedNode) return null
    const connected = new Set([selectedNode])
    for (const edge of model.edges) {
      if (edge.source === selectedNode || edge.target === selectedNode) {
        connected.add(edge.source)
        connected.add(edge.target)
      }
    }
    return connected
  }, [model.edges, selectedNode])

  function updateTooltip(event: MouseEvent<SVGCircleElement>, node: NodeInfo) {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    setTooltip({
      node,
      x: event.clientX - rect.left + 14,
      y: event.clientY - rect.top + 14,
    })
  }

  if (pathways.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-sm text-gray-400">
        No amino acid pathway data available.
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className="relative overflow-auto rounded-lg border border-gray-200 bg-gray-50 p-4"
      style={{
        backgroundImage: 'radial-gradient(circle, #d1d5db 1px, transparent 1px)',
        backgroundSize: '18px 18px',
      }}
      onMouseLeave={() => setTooltip(null)}
    >
      <svg width={model.width} height={model.height} className="min-w-full">
        <defs>
          <marker
            id="aa-pathway-arrow"
            markerWidth="8"
            markerHeight="8"
            refX="7"
            refY="4"
            orient="auto"
            markerUnits="strokeWidth"
          >
            <path d="M 0 0 L 8 4 L 0 8 z" fill="#9ca3af" />
          </marker>
        </defs>

        {model.edges.map((edge) => {
          const source = model.nodeByKey.get(edge.source)
          const target = model.nodeByKey.get(edge.target)
          if (!source || !target) return null
          const dimmed = connectedNodes != null && (!connectedNodes.has(edge.source) || !connectedNodes.has(edge.target))
          const label = formatEdgeLabel(edge.enzymes)
          const midX = (source.x + target.x) / 2
          const midY = (source.y + target.y) / 2

          return (
            <g key={edge.id} opacity={dimmed ? 0.18 : 1}>
              <path
                d={edgePath(source, target)}
                fill="none"
                stroke="#9ca3af"
                strokeWidth="1.5"
                markerEnd="url(#aa-pathway-arrow)"
              />
              {label && (
                <text
                  x={midX}
                  y={midY - 8}
                  textAnchor="middle"
                  className="fill-gray-500 text-[10px] font-mono"
                >
                  {label}
                </text>
              )}
            </g>
          )
        })}

        {model.nodes.map((node) => {
          const style = SEVERITY_STYLE[node.severity]
          const dimmed = connectedNodes != null && !connectedNodes.has(node.key)
          const selected = selectedNode === node.key

          return (
            <g key={node.key} opacity={dimmed ? 0.2 : 1}>
              <circle
                cx={node.x}
                cy={node.y}
                r={NODE_R}
                fill={style.fill}
                stroke={selected ? '#111827' : style.stroke}
                strokeWidth={selected ? 3 : 2}
                className="cursor-pointer transition-opacity hover:opacity-90"
                onMouseEnter={(event) => updateTooltip(event, node)}
                onMouseMove={(event) => updateTooltip(event, node)}
                onClick={() => setSelectedNode((current) => (current === node.key ? null : node.key))}
              />
              <text
                x={node.x}
                y={node.y + 4}
                textAnchor="middle"
                className="pointer-events-none fill-gray-900 text-xs font-semibold"
              >
                {aaCode(node.name)}
              </text>
            </g>
          )
        })}
      </svg>

      {tooltip && (
        <div
          className="absolute z-20 w-72 rounded-lg border border-gray-200 bg-white p-3 text-xs text-gray-600 shadow-xl"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          <div className="text-sm font-semibold text-gray-900">{tooltip.node.name}</div>
          <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <span className="text-gray-400">Enzymes</span>
            <span className="flex flex-wrap gap-1">
              {tooltip.node.enzymes.length > 0 ? (
                tooltip.node.enzymes.map((enzyme) => (
                  <button
                    key={enzyme}
                    onClick={() => navigate(`/?q=${encodeURIComponent(enzyme)}`)}
                    className="font-mono text-brand-700 hover:underline"
                  >
                    {enzyme}
                  </button>
                ))
              ) : (
                <span>n/a</span>
              )}
            </span>
            <span className="text-gray-400">kcat</span>
            <span className="font-mono">{tooltip.node.pathway?.kcat != null ? tooltip.node.pathway.kcat : 'n/a'}</span>
            <span className="text-gray-400">Ki range</span>
            <span className="font-mono">
              {tooltip.node.pathway?.ki_lower != null || tooltip.node.pathway?.ki_upper != null
                ? `${tooltip.node.pathway?.ki_lower ?? 'n/a'}-${tooltip.node.pathway?.ki_upper ?? 'n/a'}`
                : 'n/a'}
            </span>
          </div>
          {tooltip.node.pathway?.notes && (
            <p className="mt-2 border-t border-gray-100 pt-2 leading-relaxed text-gray-500">
              {tooltip.node.pathway.notes}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function buildDiagram(pathways: AAPathway[], genes: GeneKOSummary[]) {
  const phenotypeByGene = new Map(genes.map((gene) => [gene.gene_symbol.toLowerCase(), gene.phenotype]))
  const nodeNames = new Map<string, string>()
  const pathwayByKey = new Map<string, AAPathway>()
  const edgeMap = new Map<string, Edge>()

  for (const pathway of pathways) {
    const targetKey = nodeKey(pathway.amino_acid)
    nodeNames.set(targetKey, pathway.amino_acid)
    pathwayByKey.set(targetKey, pathway)

    for (const upstream of parseList(pathway.upstream_aas)) {
      const sourceKey = nodeKey(upstream)
      nodeNames.set(sourceKey, upstream)
      addEdge(edgeMap, sourceKey, targetKey, parseList(pathway.enzymes))
    }

    for (const downstream of parseList(pathway.downstream_aas)) {
      const downstreamKey = nodeKey(downstream)
      nodeNames.set(downstreamKey, downstream)
      addEdge(edgeMap, targetKey, downstreamKey, parseList(pathway.enzymes))
    }
  }

  const edges = Array.from(edgeMap.values())
  const layers = computeLayers(Array.from(nodeNames.keys()), edges)
  const nodesByLayer = new Map<number, string[]>()
  for (const [key, layer] of layers) {
    const list = nodesByLayer.get(layer) ?? []
    list.push(key)
    nodesByLayer.set(layer, list)
  }

  const layerNumbers = Array.from(nodesByLayer.keys()).sort((a, b) => a - b)
  const maxLayerSize = Math.max(1, ...Array.from(nodesByLayer.values()).map((list) => list.length))
  const width = Math.max(760, maxLayerSize * 110 + 120)
  const height = Math.max(360, layerNumbers.length * 120 + 80)
  const nodeByKey = new Map<string, NodeInfo>()

  for (const layer of layerNumbers) {
    const keys = [...(nodesByLayer.get(layer) ?? [])].sort((a, b) => nodeNames.get(a)!.localeCompare(nodeNames.get(b)!))
    const y = 60 + layer * 120
    const spacing = width / (keys.length + 1)
    keys.forEach((key, index) => {
      const pathway = pathwayByKey.get(key) ?? null
      const enzymes = pathway
        ? uniqueList([...parseList(pathway.enzymes), ...parseList(pathway.reverse_enzymes)])
        : []
      const severity = enzymeSeverity(enzymes, phenotypeByGene)
      nodeByKey.set(key, {
        key,
        name: nodeNames.get(key) ?? key,
        pathway,
        enzymes,
        severity,
        x: spacing * (index + 1),
        y,
      })
    })
  }

  return {
    nodes: Array.from(nodeByKey.values()),
    edges,
    nodeByKey,
    width,
    height,
  }
}

function addEdge(edgeMap: Map<string, Edge>, source: string, target: string, enzymes: string[]) {
  if (!source || !target || source === target) return
  const id = `${source}->${target}`
  const existing = edgeMap.get(id)
  if (existing) {
    existing.enzymes = uniqueList([...existing.enzymes, ...enzymes])
    return
  }
  edgeMap.set(id, {
    id,
    source,
    target,
    enzymes: uniqueList(enzymes),
  })
}

function computeLayers(nodes: string[], edges: Edge[]): Map<string, number> {
  const sortedNodes = [...nodes].sort()
  const outgoing = new Map<string, string[]>()
  const indegree = new Map(sortedNodes.map((node) => [node, 0]))

  for (const edge of edges) {
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target])
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1)
  }

  const layers = new Map(sortedNodes.map((node) => [node, 0]))
  const processed = new Set<string>()
  const queue = sortedNodes.filter((node) => (indegree.get(node) ?? 0) === 0)

  while (processed.size < sortedNodes.length) {
    if (queue.length === 0) {
      const next = sortedNodes.find((node) => !processed.has(node))
      if (next) queue.push(next)
    }

    const node = queue.shift()
    if (!node || processed.has(node)) continue
    processed.add(node)

    for (const target of outgoing.get(node) ?? []) {
      layers.set(target, Math.max(layers.get(target) ?? 0, (layers.get(node) ?? 0) + 1))
      indegree.set(target, (indegree.get(target) ?? 0) - 1)
      if ((indegree.get(target) ?? 0) <= 0 && !processed.has(target)) {
        queue.push(target)
      }
    }
  }

  return layers
}

function enzymeSeverity(
  enzymes: string[],
  phenotypeByGene: Map<string, GeneKOSummary['phenotype']>
): NodeInfo['severity'] {
  const phenotypes = enzymes.map((enzyme) => phenotypeByGene.get(enzyme.toLowerCase()))
  if (phenotypes.includes('essential')) return 'essential'
  if (phenotypes.includes('growth_defect')) return 'growth_defect'
  return 'neutral'
}

function edgePath(source: NodeInfo, target: NodeInfo): string {
  const startY = source.y + NODE_R
  const endY = target.y - NODE_R
  const midY = (startY + endY) / 2
  if (Math.abs(source.y - target.y) < 1) {
    const lift = source.x < target.x ? -45 : 45
    return `M ${source.x} ${source.y} C ${source.x} ${source.y + lift} ${target.x} ${target.y + lift} ${target.x} ${target.y}`
  }
  return `M ${source.x} ${startY} C ${source.x} ${midY} ${target.x} ${midY} ${target.x} ${endY}`
}

function parseList(value: string): string[] {
  return value
    .split(/[,;]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && !['none', 'nan', 'null'].includes(item.toLowerCase()))
}

function uniqueList(values: string[]): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b))
}

function nodeKey(name: string): string {
  return name.trim().toLowerCase()
}

function normalizedAAName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/^[ld]-/, '')
    .replace(/\s+/g, ' ')
}

function aaCode(name: string): string {
  const normalized = normalizedAAName(name)
  return AA_CODES[normalized] ?? name.trim().slice(0, 3)
}

function formatEdgeLabel(enzymes: string[]): string {
  if (enzymes.length === 0) return ''
  if (enzymes.length <= 2) return enzymes.join(', ')
  return `${enzymes.slice(0, 2).join(', ')} +${enzymes.length - 2}`
}
