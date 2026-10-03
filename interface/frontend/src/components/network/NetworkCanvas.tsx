import { useEffect, useRef, useState } from 'react'
import cytoscape, {
  type Core,
  type ElementDefinition,
  type EventObject,
  type StylesheetStyle,
} from 'cytoscape'
import type { NetworkPositions } from './networkLayout'

interface Props {
  elements: ElementDefinition[]
  positions: NetworkPositions | null
  viewKey: string
  full: boolean
  stylesheet: StylesheetStyle[]
  resetRequest: number
  onSelect: (gene: string | null) => void
  onReady: (cy: Core) => void
  onCameraChange: (changed: boolean) => void
}
export function NetworkCanvas(props: Props) {
  const host = useRef<HTMLDivElement>(null)
  const core = useRef<Core | null>(null)
  const callbacks = useRef(props)
  callbacks.current = props
  const applied = useRef({ key: '', positions: null as NetworkPositions | null })
  const defaultCamera = useRef<{ zoom: number; pan: { x: number; y: number } } | null>(null)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const cy = cytoscape({
      container: host.current!,
      elements: [],
      style: callbacks.current.stylesheet,
      layout: { name: 'preset' },
      maxZoom: 3,
      minZoom: 0.2,
    })
    core.current = cy
    const select = (event: EventObject) => callbacks.current.onSelect(event.target.data('label'))
    const background = (event: EventObject) => {
      if (event.target === cy) callbacks.current.onSelect(null)
    }
    const camera = () => {
      const base = defaultCamera.current
      if (!base) return
      const pan = cy.pan()
      callbacks.current.onCameraChange(
        !callbacks.current.full ||
          Math.abs(cy.zoom() - base.zoom) > 0.001 ||
          Math.abs(pan.x - base.pan.x) > 1 ||
          Math.abs(pan.y - base.pan.y) > 1,
      )
    }
    cy.on('tap', 'node', select)
    cy.on('tap', background)
    cy.on('pan zoom', camera)
    const observer = new ResizeObserver(() => cy.resize())
    observer.observe(host.current!)
    return () => {
      observer.disconnect()
      cy.off('tap', 'node', select)
      cy.off('tap', background)
      cy.off('pan zoom', camera)
      cy.stop()
      cy.destroy()
      core.current = null
      applied.current = { key: '', positions: null }
    }
  }, [])
  useEffect(() => {
    core.current?.style(props.stylesheet)
  }, [props.stylesheet])
  useEffect(() => {
    const cy = core.current
    if (!cy || !props.positions) {
      setReady(false)
      return
    }
    if (applied.current.key === props.viewKey && applied.current.positions === props.positions)
      return
    cy.stop()
    cy.batch(() => {
      cy.elements().remove()
      cy.add(
        props.elements.map((element) => ({
          ...element,
          position: props.positions![element.data.id!]
            ? { ...props.positions![element.data.id!] }
            : undefined,
        })),
      )
    })
    if (props.full) {
      cy.resize()
      cy.fit(cy.elements(), 30)
      defaultCamera.current = { zoom: cy.zoom(), pan: { ...cy.pan() } }
      props.onCameraChange(false)
    } else {
      cy.layout({
        name: 'concentric',
        animate: !matchMedia('(prefers-reduced-motion: reduce)').matches,
        animationDuration: 450,
        animationEasing: 'ease-in-out-cubic',
        fit: true,
        padding: 70,
        minNodeSpacing: 34,
        avoidOverlap: true,
        nodeDimensionsIncludeLabels: true,
        concentric: (node) => node.data('focusLayer'),
        levelWidth: () => 1,
      }).run()
    }
    applied.current = { key: props.viewKey, positions: props.positions }
    props.onReady(cy)
    const frame = requestAnimationFrame(() => setReady(true))
    return () => cancelAnimationFrame(frame)
  }, [props.viewKey, props.elements, props.positions])
  useEffect(() => {
    const cy = core.current
    if (!props.resetRequest || !props.positions || !cy) return
    cy.stop()
    cy.elements().removeClass('node-hidden edge-hidden dimmed highlighted')
    cy.resize()
    cy.fit(cy.elements(), 30)
    defaultCamera.current = { zoom: cy.zoom(), pan: { ...cy.pan() } }
    callbacks.current.onCameraChange(false)
  }, [props.resetRequest, props.positions])
  return (
    <div
      ref={host}
      className="network-graph"
      data-phase={ready ? 'ready' : 'arranging'}
      role="group"
      aria-label="Regulatory network canvas"
      style={{ width: '100%', height: '100%' }}
    />
  )
}
