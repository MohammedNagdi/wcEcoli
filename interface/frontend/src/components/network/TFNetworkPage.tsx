import { useCallback, useState, useEffect, useMemo, useRef } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { useRegisterAssistantContext } from '../assistant/AssistantProvider'
import CytoscapeComponent from 'react-cytoscapejs'
import type { Core, EventObject, ElementDefinition } from 'cytoscape'
import { getTFNetwork } from '../../api/client'
import type { TFNetwork } from '../../types'
import { SearchInput } from '../common/SearchInput'
import { useUrlWorkspaceState } from '../../hooks/useUrlWorkspaceState'
import { type RegulationEffect, regulationEffect } from '../../utils/regulation'

const FULL_LAYOUT = {
  name: 'cose',
  animate: false,
  nodeDimensionsIncludeLabels: true,
  nodeRepulsion: () => 8000,
  idealEdgeLength: () => 80,
  gravity: 0.3,
  numIter: 300,
}

const SELECTED_GENE_MIN_ZOOM = 1.1
const SELECTED_GENE_MAX_ZOOM = 1.65
const SELECTED_GENE_DEFAULT_ZOOM = 1.3
const SELECTED_GENE_ANIMATION_MS = 700

type NetworkRole = 'tf' | 'target' | 'both'
type NetworkViewMode = 'full' | 'neighborhood' | 'regulon' | 'incoming'

interface NetworkNodeData {
  id: string
  label: string
  role: NetworkRole
  isTF: boolean
  isTarget: boolean
  size: number
  targetCount: number
  focusLayer: number
}

interface InspectorEdge {
  tf: string
  target: string
  partner: string
  effect: RegulationEffect
  log2fc: number
  log2fcStd: number | null
  rawType: string
  isSelfLoop: boolean
}

interface GeneInspector {
  symbol: string
  role: NetworkRole
  incoming: InspectorEdge[]
  outgoing: InspectorEdge[]
  selfLoops: InspectorEdge[]
  targetCount: number
  regulatorCount: number
}

function geneNodeId(symbol: string): string {
  return `gene_${symbol}`
}

function nodeRole(isTF: boolean, isTarget: boolean): NetworkRole {
  if (isTF && isTarget) return 'both'
  return isTF ? 'tf' : 'target'
}

function roleLabel(role: NetworkRole): string {
  if (role === 'both') return 'TF and target'
  return role === 'tf' ? 'Transcription factor' : 'Target gene'
}

function effectClasses(effect: RegulationEffect): string {
  if (effect === 'activation') return 'bg-green-50 text-green-700'
  if (effect === 'repression') return 'bg-red-50 text-red-700'
  return 'bg-gray-100 text-gray-600'
}

function effectLabel(effect: RegulationEffect): string {
  if (effect === 'activation') return 'act'
  if (effect === 'repression') return 'rep'
  return effect
}

function formatSigned(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}`
}

function formatStd(value: number | null): string {
  return value == null ? 'n/a' : value.toFixed(2)
}

function selectedGeneZoom(currentZoom: number, maxZoom: number): number {
  const boundedCurrent = Math.min(Math.max(currentZoom, SELECTED_GENE_MIN_ZOOM), SELECTED_GENE_MAX_ZOOM)
  const target = currentZoom < SELECTED_GENE_MIN_ZOOM ? SELECTED_GENE_DEFAULT_ZOOM : boundedCurrent
  return Math.min(target, maxZoom)
}

function networkViewModeFromParam(value: string | null): NetworkViewMode | null {
  if (value === 'full' || value === 'neighborhood' || value === 'regulon' || value === 'incoming') {
    return value
  }
  return null
}

function networkModeLabel(mode: NetworkViewMode): string {
  if (mode === 'full') return 'Full'
  if (mode === 'neighborhood') return 'Neighborhood'
  if (mode === 'regulon') return 'Regulon'
  return 'Regulators'
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const STYLESHEET: any[] = [
  {
    selector: 'node',
    style: {
      label: 'data(label)',
      color: '#fff',
      'text-valign': 'center',
      'text-halign': 'center',
      width: 'data(size)',
      height: 'data(size)',
      'font-size': '8px',
      'font-weight': 600,
      'border-width': 2,
    },
  },
  {
    selector: 'node[role="tf"]',
    style: {
      'background-color': '#534AB7',
      'border-color': '#3D3690',
      'font-size': '9px',
    },
  },
  {
    selector: 'node[role="target"]',
    style: {
      'background-color': '#1D9E75',
      'font-size': '7px',
      'border-width': 1,
      'border-color': '#157A5A',
    },
  },
  {
    selector: 'node[role="both"]',
    style: {
      'background-color': '#2563EB',
      'border-width': 3,
      'border-color': '#16A34A',
      'font-size': '9px',
      'font-weight': 'bold',
    },
  },
  {
    selector: 'edge[edgeType="activation"]',
    style: {
      'line-color': '#22C55E',
      'target-arrow-color': '#22C55E',
      'target-arrow-shape': 'triangle',
      'curve-style': 'bezier',
      width: 'data(width)',
      opacity: 0.5,
    },
  },
  {
    selector: 'edge[isSelfLoop]',
    style: {
      'loop-direction': '45deg',
      'loop-sweep': '70deg',
      'control-point-step-size': 45,
    },
  },
  {
    selector: 'edge[edgeType="repression"]',
    style: {
      'line-color': '#EF4444',
      'target-arrow-color': '#EF4444',
      'target-arrow-shape': 'tee',
      'curve-style': 'bezier',
      width: 'data(width)',
      opacity: 0.5,
    },
  },
  {
    selector: 'node:selected',
    style: {
      'border-width': 3,
      'border-color': '#F59E0B',
    },
  },
  {
    selector: 'node.highlighted',
    style: {
      'border-width': 3,
      'border-color': '#F59E0B',
      'background-color': '#F59E0B',
    },
  },
  {
    selector: '.dimmed',
    style: {
      opacity: 0.1,
    },
  },
  {
    selector: 'edge.edge-hidden',
    style: {
      display: 'none',
    },
  },
  {
    selector: '.node-hidden',
    style: {
      display: 'none',
    },
  },
]

interface TFNetworkPageProps {
  embedded?: boolean
}

export function TFNetworkPage({ embedded = false }: TFNetworkPageProps) {
  const { selectedGene, setSelectedGene } = useUrlWorkspaceState()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const initialMode = networkViewModeFromParam(searchParams.get('mode')) ?? 'full'
  const [network, setNetwork] = useState<TFNetwork | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [edgeFilter, setEdgeFilter] = useState<'all' | 'activation' | 'repression'>('all')
  const [minTargets, setMinTargets] = useState(1)
  const [networkMode, setNetworkMode] = useState<NetworkViewMode>(initialMode)
  const cyRef = useRef<Core | null>(null)
  const layoutReadyRef = useRef(false)
  const viewportHeightClass = embedded
    ? 'h-[calc(100vh-215px)] min-h-[520px]'
    : 'h-[calc(100vh-65px)]'

  useEffect(() => {
    getTFNetwork()
      .then(setNetwork)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (selectedGene) {
      setSearchQuery(selectedGene)
    }
  }, [selectedGene])

  useEffect(() => {
    const urlMode = networkViewModeFromParam(searchParams.get('mode'))
    if (urlMode && urlMode !== networkMode) setNetworkMode(urlMode)
  }, [networkMode, searchParams])

  const setMode = useCallback((mode: NetworkViewMode) => {
    setNetworkMode(mode)
    const next = new URLSearchParams(searchParams)
    if (mode === 'full') {
      next.delete('mode')
    } else {
      next.set('mode', mode)
    }
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

  useEffect(() => {
    if (selectedGene || networkMode === 'full') return
    setMode('full')
  }, [networkMode, selectedGene, setMode])

  const centerSelectedGene = useCallback((geneSymbol: string | null) => {
    const cy = cyRef.current
    if (!cy || !network || !geneSymbol) return
    let node = cy.getElementById(geneNodeId(geneSymbol))
    if (node.length === 0) {
      node = cy.nodes().filter(
        (n) => (n.data('label') as string).toLowerCase() === geneSymbol.toLowerCase()
      )
    }
    if (node.length === 0) return
    cy.stop(false, true)
    cy.animate(
      {
        center: { eles: node },
        zoom: selectedGeneZoom(cy.zoom(), cy.maxZoom()),
      },
      {
        duration: SELECTED_GENE_ANIMATION_MS,
        easing: 'ease-in-out-cubic',
      }
    )
  }, [network])

  const applyGraphVisibility = useCallback(() => {
    const cy = cyRef.current
    if (!cy || !layoutReadyRef.current) return

    cy.elements().removeClass('node-hidden edge-hidden')

    cy.edges().forEach((edge) => {
      const source = edge.source()
      const sourceTargetCount = source.data('targetCount') as number
      const sourceIsSmallHub = networkMode === 'full' && sourceTargetCount > 0 && sourceTargetCount < minTargets
      const hiddenByType = edgeFilter !== 'all' && edge.data('edgeType') !== edgeFilter
      if (sourceIsSmallHub || hiddenByType) edge.addClass('edge-hidden')
    })

    cy.nodes().forEach((node) => {
      const targetCount = node.data('targetCount') as number
      const isSelectedNode = selectedGene != null && (node.data('label') as string).toLowerCase() === selectedGene.toLowerCase()
      if (networkMode === 'full' && targetCount > 0 && targetCount < minTargets) {
        node.addClass('node-hidden')
        return
      }
      let hasVisibleEdge = false
      node.connectedEdges().forEach((edge) => {
        if (!edge.hasClass('edge-hidden')) hasVisibleEdge = true
      })
      if (networkMode !== 'full' && isSelectedNode) return
      if (!hasVisibleEdge) node.addClass('node-hidden')
    })
  }, [edgeFilter, minTargets, networkMode, selectedGene])

  // Build cytoscape elements
  const elements = useMemo(() => {
    if (!network) return []
    const nodeMap = new Map<string, NetworkNodeData>()
    const edges: ElementDefinition[] = []

    const ensureNode = (symbol: string) => {
      const id = geneNodeId(symbol)
      const existing = nodeMap.get(symbol)
      if (existing) return existing
      const node = {
        id,
        label: symbol,
        role: 'target' as NetworkRole,
        isTF: false,
        isTarget: false,
        size: 14,
        targetCount: 0,
        focusLayer: 1,
      }
      nodeMap.set(symbol, node)
      return node
    }

    for (const tf of network.tfs) {
      const tfNode = ensureNode(tf.symbol)
      tfNode.isTF = true
      tfNode.targetCount = tf.target_count
      tfNode.role = nodeRole(tfNode.isTF, tfNode.isTarget)
      tfNode.size = Math.max(24, Math.min(60, 20 + tf.target_count * 0.6))

      for (const t of tf.targets) {
        const targetNode = ensureNode(t.target)
        targetNode.isTarget = true
        targetNode.role = nodeRole(targetNode.isTF, targetNode.isTarget)
        if (targetNode.role === 'target') targetNode.size = 14
        const edgeType = regulationEffect(t.log2fc, t.type)
        const absLfc = Math.abs(t.log2fc)
        const edgeWidth = Math.max(0.5, Math.min(4, 0.5 + absLfc * 0.6))
        edges.push({
          data: {
            id: `e_${tf.symbol}_${t.target}`,
            source: geneNodeId(tf.symbol),
            target: geneNodeId(t.target),
            tf: tf.symbol,
            targetSymbol: t.target,
            edgeType,
            isSelfLoop: tf.symbol === t.target,
            log2fc: t.log2fc,
            log2fcStd: t.log2fc_std ?? null,
            width: edgeWidth,
          },
        })
      }
    }

    const nodes: ElementDefinition[] = [...nodeMap.values()].map((node) => ({ data: node }))
    return [...nodes, ...edges]
  }, [network])

  const inspectorBySymbol = useMemo(() => {
    const inspectors = new Map<string, GeneInspector>()

    const ensureInspector = (symbol: string) => {
      const existing = inspectors.get(symbol)
      if (existing) return existing
      const inspector: GeneInspector = {
        symbol,
        role: 'target',
        incoming: [],
        outgoing: [],
        selfLoops: [],
        targetCount: 0,
        regulatorCount: 0,
      }
      inspectors.set(symbol, inspector)
      return inspector
    }

    if (!network) return inspectors

    for (const tf of network.tfs) {
      const tfInspector = ensureInspector(tf.symbol)
      tfInspector.role = nodeRole(true, tfInspector.incoming.length > 0)
      tfInspector.targetCount = tf.target_count

      for (const target of tf.targets) {
        const targetInspector = ensureInspector(target.target)
        const effect = regulationEffect(target.log2fc, target.type)
        const edge: InspectorEdge = {
          tf: tf.symbol,
          target: target.target,
          partner: target.target,
          effect,
          log2fc: target.log2fc,
          log2fcStd: target.log2fc_std ?? null,
          rawType: target.type,
          isSelfLoop: tf.symbol === target.target,
        }
        tfInspector.outgoing.push(edge)
        if (edge.isSelfLoop) tfInspector.selfLoops.push(edge)

        const incomingEdge = { ...edge, partner: tf.symbol }
        targetInspector.incoming.push(incomingEdge)
        if (incomingEdge.isSelfLoop) targetInspector.selfLoops.push(incomingEdge)
        targetInspector.role = nodeRole(targetInspector.outgoing.length > 0, true)
        targetInspector.regulatorCount = targetInspector.incoming.length
      }
    }

    for (const inspector of inspectors.values()) {
      inspector.outgoing.sort((a, b) => Math.abs(b.log2fc) - Math.abs(a.log2fc))
      inspector.incoming.sort((a, b) => Math.abs(b.log2fc) - Math.abs(a.log2fc))
      inspector.selfLoops = inspector.selfLoops.filter((edge, index, list) =>
        list.findIndex((item) => item.tf === edge.tf && item.target === edge.target) === index
      )
      inspector.role = nodeRole(inspector.outgoing.length > 0, inspector.incoming.length > 0)
      inspector.targetCount = inspector.outgoing.length
      inspector.regulatorCount = inspector.incoming.length
    }

    return inspectors
  }, [network])

  const selectedInspector = selectedGene ? inspectorBySymbol.get(selectedGene) ?? null : null

  const graphElements = useMemo(() => {
    if (networkMode === 'full' || !selectedGene || !selectedInspector) {
      return elements
    }

    const selected = selectedInspector.symbol
    const nodeSymbols = new Set<string>([selected])
    const edgeIds = new Set<string>()

    const includeEdges = (edges: InspectorEdge[]) => {
      for (const edge of edges) {
        nodeSymbols.add(edge.tf)
        nodeSymbols.add(edge.target)
        edgeIds.add(`e_${edge.tf}_${edge.target}`)
      }
    }

    if (networkMode === 'neighborhood') {
      includeEdges(selectedInspector.incoming)
      includeEdges(selectedInspector.outgoing)
    } else if (networkMode === 'regulon') {
      includeEdges(selectedInspector.outgoing)
    } else if (networkMode === 'incoming') {
      includeEdges(selectedInspector.incoming)
    }

    return elements
      .filter((element) => {
        const data = element.data
        if (!data) return false
        if ('source' in data) return edgeIds.has(data.id as string)
        return nodeSymbols.has(data.label as string)
      })
      .map((element) => {
        const data = element.data
        if (!data || 'source' in data) return element
        const symbol = data.label as string
        const isSelected = symbol.toLowerCase() === selected.toLowerCase()
        const isRegulator = selectedInspector.incoming.some((edge) => edge.tf === symbol)
        return {
          ...element,
          data: {
            ...data,
            focusLayer: isSelected ? 3 : isRegulator ? 2 : 1,
            size: isSelected ? Math.max(data.size as number, 42) : data.size,
          },
        }
      })
  }, [elements, networkMode, selectedGene, selectedInspector])

  const graphLayout = useMemo(() => {
    if (networkMode === 'full') return FULL_LAYOUT
    return {
      name: 'concentric',
      animate: true,
      animationDuration: 450,
      animationEasing: 'ease-in-out-cubic',
      fit: true,
      padding: 70,
      minNodeSpacing: 34,
      avoidOverlap: true,
      nodeDimensionsIncludeLabels: true,
      concentric: (node: { data: (key: string) => unknown }) => node.data('focusLayer') as number,
      levelWidth: () => 1,
    }
  }, [networkMode])

  const graphKey = networkMode === 'full'
    ? 'full'
    : `${networkMode}-${selectedGene ?? 'none'}`

  const graphStats = useMemo(() => {
    const nodes = graphElements.filter((element) => element.data && !('source' in element.data))
    const nodeData = nodes.map((node) => node.data as Partial<NetworkNodeData>)
    const both = nodeData.filter((data) => data.role === 'both').length
    const targetOnly = nodeData.filter((data) => data.role === 'target').length
    const selfLoops = graphElements.filter((element) => Boolean((element.data as { isSelfLoop?: boolean } | undefined)?.isSelfLoop)).length
    const edges = graphElements.filter((element) => element.data && 'source' in element.data).length
    return { totalNodes: nodes.length, both, targetOnly, selfLoops, edges }
  }, [graphElements])

  const edgeCounts = useMemo(() => {
    if (!network) return { activation: 0, repression: 0, all: 0 }
    let activation = 0
    let repression = 0
    for (const tf of network.tfs) {
      if (tf.target_count < minTargets) continue
      for (const target of tf.targets) {
        if (regulationEffect(target.log2fc, target.type) === 'activation') {
          activation += 1
        } else if (regulationEffect(target.log2fc, target.type) === 'repression') {
          repression += 1
        }
      }
    }
    return { activation, repression, all: activation + repression }
  }, [network, minTargets])

  useRegisterAssistantContext({
    context: {
      assistant_surface: 'network',
      route: `${location.pathname}${location.search}`,
      selected_gene: selectedGene,
    },
    suggestedPrompt: `Help me interpret the transcription-factor network. Focus on the ${networkMode} view, ${edgeFilter} regulation edges, hub threshold ${minTargets}, and any selected gene or TF context.`,
  })

  useEffect(() => {
    if (!layoutReadyRef.current) return
    if (networkMode !== 'full') return
    const firstFrame = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => centerSelectedGene(selectedGene))
    })
    return () => window.cancelAnimationFrame(firstFrame)
  }, [centerSelectedGene, networkMode, selectedGene, graphElements.length])

  useEffect(() => {
    applyGraphVisibility()
  }, [applyGraphVisibility])

  // Handle search / highlight
  useEffect(() => {
    const cy = cyRef.current
    if (!cy || !searchQuery) {
      cy?.elements().removeClass('dimmed highlighted')
      return
    }
    const q = searchQuery.toLowerCase()
    cy.elements().addClass('dimmed')
    const matched = cy.nodes().filter((n) => {
      const label = (n.data('label') as string).toLowerCase()
      return label.includes(q)
    })
    matched.removeClass('dimmed').addClass('highlighted')
    matched.connectedEdges().removeClass('dimmed')
    matched.connectedEdges().connectedNodes().removeClass('dimmed')
  }, [searchQuery, graphElements.length])

  useEffect(() => {
    applyGraphVisibility()
  }, [applyGraphVisibility, graphElements.length])

  // Handle node click — show TF details
  const handleCyInit = (cy: Core) => {
    cyRef.current = cy
    layoutReadyRef.current = false
    let layoutReadyFallback = 0
    const markLayoutReady = () => {
      if (layoutReadyRef.current) return
      layoutReadyRef.current = true
      if (layoutReadyFallback) window.clearTimeout(layoutReadyFallback)
      applyGraphVisibility()
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          if (networkMode === 'full') centerSelectedGene(selectedGene)
        })
      })
    }
    cy.on('tap', 'node', (evt: EventObject) => {
      const symbol = evt.target.data('label') as string
      setSelectedGene(symbol)
    })
    cy.on('tap', (evt: EventObject) => {
      if (evt.target === cy) setSelectedGene(null)
    })
    cy.one('layoutstop', markLayoutReady)
    layoutReadyFallback = window.setTimeout(markLayoutReady, 500)
  }

  if (loading) {
    return (
      <div className={`flex items-center justify-center ${viewportHeightClass}`}>
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm text-gray-400">Loading TF regulatory network...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm m-6">
        Failed to load network: {error}
      </div>
    )
  }

  return (
    <div className={`flex gap-6 ${viewportHeightClass}`}>
      {/* Network canvas */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <div className="flex overflow-hidden rounded-md border border-gray-200 text-xs">
            {(['full', 'neighborhood', 'regulon', 'incoming'] as const).map((mode) => {
              const needsGene = mode !== 'full'
              const isDisabled = needsGene && !selectedInspector
              return (
                <button
                  key={mode}
                  type="button"
                  onClick={() => !isDisabled && setMode(mode)}
                  disabled={isDisabled}
                  className={`px-2.5 py-1.5 disabled:cursor-not-allowed disabled:opacity-40 ${
                    networkMode === mode ? 'bg-brand-600 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'
                  }`}
                >
                  {networkModeLabel(mode)}
                </button>
              )
            })}
          </div>
          <SearchInput
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder="Highlight TF or gene..."
            className="w-64 flex-shrink-0"
          />
          {selectedGene && (
            <button
              type="button"
              onClick={() => setSelectedGene(null)}
              className="inline-flex items-center gap-1 rounded-md border border-brand-100 bg-brand-50 px-2.5 py-1.5 text-xs font-medium text-brand-700 hover:bg-brand-100"
            >
              <span className="font-mono">{selectedGene}</span>
              <span className="text-brand-400">x</span>
            </button>
          )}
          <div className="flex overflow-hidden rounded-md border border-gray-200 text-xs">
            {(['all', 'activation', 'repression'] as const).map((opt) => {
              const count = opt === 'all' ? edgeCounts.all : edgeCounts[opt]
              const isDisabled = opt !== 'all' && count === 0
              return (
                <button
                  key={opt}
                  onClick={() => !isDisabled && setEdgeFilter(opt)}
                  disabled={isDisabled}
                  className={`px-2.5 py-1.5 capitalize disabled:cursor-not-allowed disabled:opacity-40 ${
                    edgeFilter === opt ? 'bg-gray-900 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'
                  }`}
                  type="button"
                >
                  {opt === 'all' ? 'All' : opt.charAt(0).toUpperCase() + opt.slice(1)}
                  <span className="ml-1 text-[10px] opacity-60">({count})</span>
                </button>
              )
            })}
          </div>
          <label className="flex items-center gap-2 text-xs text-gray-500">
            Hub TFs ≥
            <input
              type="range"
              min={1}
              max={50}
              value={minTargets}
              onChange={(e) => setMinTargets(Number(e.target.value))}
              className="w-24 accent-brand-500"
            />
            <span className="w-6 text-right font-mono">{minTargets}</span>
          </label>
          <div className="flex items-center gap-4 text-xs text-gray-400">
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-bio-tf inline-block" />
              Transcription factor ({network?.tfs.length})
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-bio-gene inline-block" />
              Target gene ({graphStats.targetOnly})
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full border-2 border-green-600 bg-blue-600 inline-block" />
              Both ({graphStats.both})
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-0.5 bg-green-500 inline-block rounded" />
              Activation
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-0.5 bg-red-500 inline-block rounded" />
              Repression
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-3 bg-gray-400" style={{ height: 1 }} />
              <span className="inline-block w-3 bg-gray-400" style={{ height: 2.5 }} />
              <span className="inline-block w-3 bg-gray-400" style={{ height: 4 }} />
              edge = |log2fc|
            </span>
          </div>
          <span className="ml-auto text-xs text-gray-400">
            {graphStats.totalNodes.toLocaleString()} genes · {graphStats.edges.toLocaleString()} edges · {graphStats.selfLoops} self-loops
            {networkMode !== 'full' && network && (
              <span className="ml-1 text-gray-300">
                {' '}of {network.total_edges.toLocaleString()}
              </span>
            )}
          </span>
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <span className="font-medium">Static reconstruction network.</span>
          <span>Edges come from <span className="font-mono">reconstruction/ecoli/flat/fold_changes.tsv</span>.</span>
          <span className="text-amber-700">Simulation overlays are paused until the experiment recipe schema stabilizes.</span>
        </div>

        <div className="relative flex-1 overflow-hidden rounded-lg border border-gray-200 bg-white">
          {graphElements.length > 0 && (
            <CytoscapeComponent
              key={graphKey}
              elements={graphElements}
              layout={graphLayout as any}
              stylesheet={STYLESHEET as any}
              cy={handleCyInit}
              style={{ width: '100%', height: '100%' }}
              maxZoom={3}
              minZoom={0.2}
            />
          )}
          {edgeFilter !== 'all' && edgeCounts[edgeFilter] === 0 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <p className="rounded-lg bg-white/80 px-4 py-2 text-sm text-gray-400 shadow">
                No {edgeFilter} edges in current view
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Gene detail sidebar */}
      {selectedInspector && (
        <aside className="w-80 flex-shrink-0 border-l border-gray-200 bg-white overflow-y-auto">
          <div className="sticky top-0 bg-white border-b border-gray-100 px-4 py-3 flex items-center justify-between">
            <div>
              <h3 className="font-semibold font-mono text-gray-900">{selectedInspector.symbol}</h3>
              <p className="text-xs text-gray-400">
                {roleLabel(selectedInspector.role)}
              </p>
            </div>
            <button
              onClick={() => setSelectedGene(null)}
              className="text-gray-400 hover:text-gray-600"
              aria-label="Close network inspector"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="space-y-4 px-4 py-3">
            <div className="grid grid-cols-3 gap-2 rounded-md border border-gray-100 bg-gray-50 p-2 text-center">
              <div>
                <p className="text-[10px] uppercase tracking-wide text-gray-400">Regulators</p>
                <p className="font-mono text-sm font-semibold text-gray-800">{selectedInspector.regulatorCount}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wide text-gray-400">Targets</p>
                <p className="font-mono text-sm font-semibold text-gray-800">{selectedInspector.targetCount}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wide text-gray-400">Self</p>
                <p className="font-mono text-sm font-semibold text-gray-800">{selectedInspector.selfLoops.length}</p>
              </div>
            </div>

            <div className="rounded-md border border-amber-100 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-900">
              Source: reconstruction fold-change table via <span className="font-mono">/api/tf-network</span>.
              This is a static regulatory edge catalog, not a time-resolved simulation trace.
            </div>

            <InspectorEdgeSection
              title="Regulated by"
              empty="No incoming TF edges"
              edges={selectedInspector.incoming}
              direction="incoming"
              onInspect={setSelectedGene}
            />

            <InspectorEdgeSection
              title="Regulates"
              empty="No outgoing target edges"
              edges={selectedInspector.outgoing}
              direction="outgoing"
              onInspect={setSelectedGene}
            />

            {selectedInspector.selfLoops.length > 0 && (
              <InspectorEdgeSection
                title="Autoregulation"
                empty=""
                edges={selectedInspector.selfLoops}
                direction="self"
                onInspect={setSelectedGene}
              />
            )}

            <div className="flex gap-2 border-t border-gray-100 pt-3">
              <Link
                to={`/?gene=${encodeURIComponent(selectedInspector.symbol)}`}
                className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700"
              >
                Open Workspace
              </Link>
              <Link
                to={`/genome?gene=${encodeURIComponent(selectedInspector.symbol)}`}
                className="rounded-md border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
              >
                Genome Map
              </Link>
            </div>
          </div>
        </aside>
      )}
    </div>
  )
}

function InspectorEdgeSection({
  title,
  empty,
  edges,
  direction,
  onInspect,
}: {
  title: string
  empty: string
  edges: InspectorEdge[]
  direction: 'incoming' | 'outgoing' | 'self'
  onInspect: (symbol: string) => void
}) {
  const visibleEdges = edges.slice(0, 14)

  return (
    <section>
      <div className="mb-1.5 flex items-center justify-between">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-400">{title}</h4>
        <span className="font-mono text-[10px] text-gray-400">{edges.length}</span>
      </div>
      {edges.length === 0 ? (
        <div className="rounded-md border border-dashed border-gray-200 px-3 py-2 text-xs text-gray-400">
          {empty}
        </div>
      ) : (
        <div className="space-y-1.5">
          <div className="grid grid-cols-[minmax(0,1fr)_36px_52px_44px] gap-2 px-1 text-[10px] uppercase tracking-wide text-gray-400">
            <span>{direction === 'incoming' ? 'TF' : 'Target'}</span>
            <span>Type</span>
            <span>log2FC</span>
            <span>std</span>
          </div>
          {visibleEdges.map((edge) => (
            <button
              key={`${direction}-${edge.tf}-${edge.target}`}
              type="button"
              onClick={() => onInspect(edge.partner)}
              className="grid w-full grid-cols-[minmax(0,1fr)_36px_52px_44px] items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-gray-50"
            >
              <span className="truncate font-mono text-bio-gene">
                {direction === 'self' ? edge.target : edge.partner}
              </span>
              <span className={`rounded px-1.5 py-0.5 text-center text-[10px] ${effectClasses(edge.effect)}`}>
                {effectLabel(edge.effect)}
              </span>
              <span className="font-mono text-gray-600">{formatSigned(edge.log2fc)}</span>
              <span className="font-mono text-gray-400">{formatStd(edge.log2fcStd)}</span>
            </button>
          ))}
          {edges.length > visibleEdges.length && (
            <div className="px-1 text-[11px] text-gray-400">
              +{edges.length - visibleEdges.length} more
            </div>
          )}
        </div>
      )}
    </section>
  )
}
