import { useCallback, useState, useEffect, useMemo, useRef } from 'react'
import { Link } from 'react-router-dom'
import CytoscapeComponent from 'react-cytoscapejs'
import type { Core, EventObject, ElementDefinition } from 'cytoscape'
import { getTFNetwork } from '../../api/client'
import type { TFNetwork, TFNode } from '../../types'
import { SearchInput } from '../common/SearchInput'
import { useUrlWorkspaceState } from '../../hooks/useUrlWorkspaceState'
import { regulationEffect } from '../../utils/regulation'

const LAYOUT = {
  name: 'cose',
  animate: false,
  nodeDimensionsIncludeLabels: true,
  nodeRepulsion: () => 8000,
  idealEdgeLength: () => 80,
  gravity: 0.3,
  numIter: 300,
}

type NetworkRole = 'tf' | 'target' | 'both'

interface NetworkNodeData {
  id: string
  label: string
  role: NetworkRole
  isTF: boolean
  isTarget: boolean
  size: number
  targetCount: number
}

function geneNodeId(symbol: string): string {
  return `gene_${symbol}`
}

function nodeRole(isTF: boolean, isTarget: boolean): NetworkRole {
  if (isTF && isTarget) return 'both'
  return isTF ? 'tf' : 'target'
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
  const [network, setNetwork] = useState<TFNetwork | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedTF, setSelectedTF] = useState<TFNode | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [edgeFilter, setEdgeFilter] = useState<'all' | 'activation' | 'repression'>('all')
  const [minTargets, setMinTargets] = useState(1)
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
    cy.animate({ fit: { eles: node, padding: 80 }, duration: 400 })
    const role = node.data('role') as NetworkRole
    if (role === 'tf' || role === 'both') {
      const label = node.data('label') as string
      setSelectedTF(network.tfs.find((t) => t.symbol === label) ?? null)
    }
  }, [network])

  const applyGraphVisibility = useCallback(() => {
    const cy = cyRef.current
    if (!cy || !layoutReadyRef.current) return

    cy.elements().removeClass('node-hidden edge-hidden')

    cy.edges().forEach((edge) => {
      const source = edge.source()
      const sourceTargetCount = source.data('targetCount') as number
      const sourceIsSmallHub = sourceTargetCount > 0 && sourceTargetCount < minTargets
      const hiddenByType = edgeFilter !== 'all' && edge.data('edgeType') !== edgeFilter
      if (sourceIsSmallHub || hiddenByType) edge.addClass('edge-hidden')
    })

    cy.nodes().forEach((node) => {
      const targetCount = node.data('targetCount') as number
      if (targetCount > 0 && targetCount < minTargets) {
        node.addClass('node-hidden')
        return
      }
      let hasVisibleEdge = false
      node.connectedEdges().forEach((edge) => {
        if (!edge.hasClass('edge-hidden')) hasVisibleEdge = true
      })
      if (!hasVisibleEdge) node.addClass('node-hidden')
    })
  }, [edgeFilter, minTargets])

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
            edgeType,
            isSelfLoop: tf.symbol === t.target,
            log2fc: t.log2fc,
            width: edgeWidth,
          },
        })
      }
    }

    const nodes: ElementDefinition[] = [...nodeMap.values()].map((node) => ({ data: node }))
    return [...nodes, ...edges]
  }, [network])

  const graphStats = useMemo(() => {
    const nodes = elements.filter((element) => element.data && !('source' in element.data))
    const both = nodes.filter((node) => node.data.role === 'both').length
    const targetOnly = nodes.filter((node) => node.data.role === 'target').length
    const selfLoops = elements.filter((element) => Boolean(element.data?.isSelfLoop)).length
    return { totalNodes: nodes.length, both, targetOnly, selfLoops }
  }, [elements])

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

  useEffect(() => {
    if (!layoutReadyRef.current) return
    centerSelectedGene(selectedGene)
  }, [centerSelectedGene, selectedGene, elements.length])

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
  }, [searchQuery, elements.length])

  useEffect(() => {
    applyGraphVisibility()
  }, [applyGraphVisibility, elements.length])

  // Handle node click — show TF details
  const handleCyInit = (cy: Core) => {
    cyRef.current = cy
    layoutReadyRef.current = false
    cy.on('tap', 'node', (evt: EventObject) => {
      const symbol = evt.target.data('label') as string
      const role = evt.target.data('role') as NetworkRole
      setSelectedGene(symbol)
      setSelectedTF(role === 'tf' || role === 'both' ? network?.tfs.find((t) => t.symbol === symbol) ?? null : null)
    })
    cy.on('tap', (evt: EventObject) => {
      if (evt.target === cy) setSelectedTF(null)
    })
    window.setTimeout(() => {
      layoutReadyRef.current = true
      applyGraphVisibility()
      centerSelectedGene(selectedGene)
    }, 100)
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
          <SearchInput
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder="Highlight TF or gene..."
            className="w-64 flex-shrink-0"
          />
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
            {graphStats.totalNodes.toLocaleString()} genes · {network?.total_edges.toLocaleString()} edges · {graphStats.selfLoops} self-loops
          </span>
        </div>

        <div className="relative flex-1 overflow-hidden rounded-lg border border-gray-200 bg-white">
          {elements.length > 0 && (
            <CytoscapeComponent
              elements={elements}
              layout={LAYOUT as any}
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

      {/* TF detail sidebar */}
      {selectedTF && (
        <aside className="w-72 flex-shrink-0 border-l border-gray-200 bg-white overflow-y-auto">
          <div className="sticky top-0 bg-white border-b border-gray-100 px-4 py-3 flex items-center justify-between">
            <div>
              <h3 className="font-semibold font-mono text-bio-tf">{selectedTF.symbol}</h3>
              <p className="text-xs text-gray-400">{selectedTF.target_count} targets</p>
            </div>
            <button
              onClick={() => setSelectedTF(null)}
              className="text-gray-400 hover:text-gray-600"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div className="px-4 py-3 space-y-1.5">
            <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wide text-gray-400">
              <span className="w-20">Target</span>
              <span className="w-8">Type</span>
              <span className="ml-auto">log2fc</span>
            </div>
            {selectedTF.targets
              .slice()
              .sort((a, b) => Math.abs(b.log2fc) - Math.abs(a.log2fc))
              .map((t, i) => {
                const isAct = regulationEffect(t.log2fc, t.type) === 'activation'
                return (
                  <div key={i} className="flex items-center gap-2 text-sm py-0.5">
                    <Link
                      to={`/?gene=${encodeURIComponent(t.target)}`}
                      className="font-mono text-bio-gene text-xs w-20 truncate hover:underline"
                    >
                      {t.target}
                    </Link>
                    <span className={`text-xs px-1.5 py-0.5 rounded ${
                      isAct ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
                    }`}>
                      {isAct ? 'act' : 'rep'}
                    </span>
                    <span className="ml-auto font-mono text-xs text-gray-400">
                      {t.log2fc > 0 ? '+' : ''}{t.log2fc.toFixed(2)}
                    </span>
                  </div>
                )
              })}
          </div>
        </aside>
      )}
    </div>
  )
}
