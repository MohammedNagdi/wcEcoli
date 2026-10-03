import cytoscape, { type Core } from 'cytoscape'
import type { LayoutRequest, LayoutResult, NetworkPositions } from './networkLayout'

self.onmessage = (event: MessageEvent<LayoutRequest>) => {
  const { key, elements, viewport } = event.data
  let cy: Core | undefined
  try {
    cy = cytoscape({
      headless: true,
      styleEnabled: true,
      elements,
      style: [
        {
          selector: 'node',
          style: {
            width: 'data(size)',
            height: 'data(size)',
            'border-width': 2,
            label: 'data(label)',
            'font-size': 8,
          },
        },
        { selector: 'node[role="tf"]', style: { 'font-size': 9 } },
        { selector: 'node[role="target"]', style: { 'border-width': 1, 'font-size': 7 } },
        { selector: 'node[role="both"]', style: { 'border-width': 3, 'font-size': 9 } },
      ],
      layout: { name: 'preset' },
    })
    // Match the original canvas aspect ratio when CoSE packs disconnected components.
    cy.width = () => Math.max(1, viewport.width)
    cy.height = () => Math.max(1, viewport.height)
    cy.layout({
      name: 'cose',
      numIter: 300,
      randomize: false,
      animate: false,
      fit: false,
      nodeDimensionsIncludeLabels: true,
      nodeRepulsion: () => 8000,
      idealEdgeLength: () => 80,
      gravity: 0.3,
    }).run()
    const positions: NetworkPositions = Object.fromEntries(
      cy.nodes().map((node) => [node.id(), { ...node.position() }]),
    )
    self.postMessage({ key, positions } satisfies LayoutResult)
  } catch (error) {
    self.postMessage({
      key,
      error: error instanceof Error ? error.message : 'Could not arrange the network.',
    } satisfies LayoutResult)
  } finally {
    cy?.destroy()
  }
}
