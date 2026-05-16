import { useState, useEffect, useMemo, useRef } from 'react'
import CytoscapeComponent from 'react-cytoscapejs'
import type { Core, EventObject, ElementDefinition } from 'cytoscape'
import { getTFNetwork } from '../../api/client'
import type { TFNetwork, TFNode } from '../../types'
import { SearchInput } from '../common/SearchInput'

const LAYOUT = {
  name: 'cose',
  animate: false,
  nodeDimensionsIncludeLabels: true,
  nodeRepulsion: () => 8000,
  idealEdgeLength: () => 80,
  gravity: 0.3,
  numIter: 300,
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const STYLESHEET: any[] = [
  {
    selector: 'node[type="tf"]',
    style: {
      'background-color': '#534AB7',
      label: 'data(label)',
      color: '#fff',
      'text-valign': 'center',
      'text-halign': 'center',
      'font-size': '9px',
      'font-weight': 'bold',
      width: 'data(size)',
      height: 'data(size)',
      'border-width': 2,
      'border-color': '#3D3690',
    },
  },
  {
    selector: 'node[type="target"]',
    style: {
      'background-color': '#1D9E75',
      label: 'data(label)',
      color: '#fff',
      'text-valign': 'center',
      'text-halign': 'center',
      'font-size': '7px',
      width: 14,
      height: 14,
      'border-width': 1,
      'border-color': '#157A5A',
    },
  },
  {
    selector: 'edge[edgeType="activation"]',
    style: {
      'line-color': '#22C55E',
      'target-arrow-color': '#22C55E',
      'target-arrow-shape': 'triangle',
      'curve-style': 'bezier',
      width: 1,
      opacity: 0.5,
    },
  },
  {
    selector: 'edge[edgeType="repression"]',
    style: {
      'line-color': '#EF4444',
      'target-arrow-color': '#EF4444',
      'target-arrow-shape': 'tee',
      'curve-style': 'bezier',
      width: 1,
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
]

export function TFNetworkPage() {
  const [network, setNetwork] = useState<TFNetwork | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedTF, setSelectedTF] = useState<TFNode | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const cyRef = useRef<Core | null>(null)

  useEffect(() => {
    getTFNetwork()
      .then(setNetwork)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  // Build cytoscape elements
  const elements = useMemo(() => {
    if (!network) return []
    const nodes: ElementDefinition[] = []
    const edges: ElementDefinition[] = []
    const targetSet = new Set<string>()

    for (const tf of network.tfs) {
      const size = Math.max(24, Math.min(60, 20 + tf.target_count * 0.6))
      nodes.push({
        data: { id: `tf_${tf.symbol}`, label: tf.symbol, type: 'tf', size, targetCount: tf.target_count },
      })

      for (const t of tf.targets) {
        const targetId = `tgt_${t.target}`
        if (!targetSet.has(t.target)) {
          targetSet.add(t.target)
          nodes.push({
            data: { id: targetId, label: t.target, type: 'target' },
          })
        }
        const edgeType = t.type.toLowerCase().includes('activat') ? 'activation' : 'repression'
        edges.push({
          data: {
            id: `e_${tf.symbol}_${t.target}`,
            source: `tf_${tf.symbol}`,
            target: targetId,
            edgeType,
            log2fc: t.log2fc,
          },
        })
      }
    }
    return [...nodes, ...edges]
  }, [network])

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
  }, [searchQuery])

  // Handle node click — show TF details
  const handleCyInit = (cy: Core) => {
    cyRef.current = cy
    cy.on('tap', 'node[type="tf"]', (evt: EventObject) => {
      const symbol = evt.target.data('label') as string
      const tf = network?.tfs.find((t) => t.symbol === symbol) ?? null
      setSelectedTF(tf)
    })
    cy.on('tap', (evt: EventObject) => {
      if (evt.target === cy) setSelectedTF(null)
    })
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-65px)]">
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
    <div className="flex gap-6 h-[calc(100vh-65px)]">
      {/* Network canvas */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex items-center gap-4 mb-3">
          <SearchInput
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder="Highlight TF or gene..."
            className="max-w-sm"
          />
          <div className="flex items-center gap-4 text-xs text-gray-400">
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-bio-tf inline-block" />
              Transcription factor ({network?.tfs.length})
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-bio-gene inline-block" />
              Target gene
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-0.5 bg-green-500 inline-block rounded" />
              Activation
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-0.5 bg-red-500 inline-block rounded" />
              Repression
            </span>
          </div>
          <span className="ml-auto text-xs text-gray-400">
            {network?.total_edges.toLocaleString()} regulatory edges
          </span>
        </div>

        <div className="flex-1 rounded-lg border border-gray-200 bg-white overflow-hidden">
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
            {selectedTF.targets
              .slice()
              .sort((a, b) => Math.abs(b.log2fc) - Math.abs(a.log2fc))
              .map((t, i) => {
                const isAct = t.type.toLowerCase().includes('activat')
                return (
                  <div key={i} className="flex items-center gap-2 text-sm py-0.5">
                    <span className="font-mono text-bio-gene text-xs w-20 truncate">{t.target}</span>
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
