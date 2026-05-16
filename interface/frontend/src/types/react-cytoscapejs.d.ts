declare module 'react-cytoscapejs' {
  import type { Core, CytoscapeOptions } from 'cytoscape'
  import type { ComponentType } from 'react'

  interface CytoscapeComponentProps {
    elements: CytoscapeOptions['elements']
    stylesheet?: CytoscapeOptions['style']
    layout?: CytoscapeOptions['layout']
    cy?: (cy: Core) => void
    style?: React.CSSProperties
    maxZoom?: number
    minZoom?: number
    className?: string
  }

  const CytoscapeComponent: ComponentType<CytoscapeComponentProps>
  export default CytoscapeComponent
}
