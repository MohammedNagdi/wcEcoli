import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent, PointerEvent } from 'react'
import type { Gene } from '../../types'
import {
  CATEGORY_FILL,
  GENOME_LENGTH,
  arcPath,
  bpToAngle,
  hasGenomePosition,
  polarToCartesian,
} from '../../utils/genome'
import { categoryLabel } from '../../utils/labels'

const VIEW_SIZE = 800
const CENTER = 400
const MIN_ZOOM = 1
const MAX_ZOOM = 16
const FOCUS_ZOOM = 8
const FORWARD_INNER_R = 300
const FORWARD_OUTER_R = 340
const REVERSE_INNER_R = 260
const REVERSE_OUTER_R = 295
const MIN_ARC_RAD = (0.3 * Math.PI) / 180
const ORIC_BP = 3_925_744
const TER_BP = 1_590_000

export interface GenomeFocusRequest {
  symbol: string
  sequence: number
}
interface Props {
  genes: Gene[]
  searchTerm: string
  highlightedCategories: Set<string>
  selectedGene?: string | null
  focusRequest?: GenomeFocusRequest | null
  onSelectGene: (symbol: string) => void
  compact?: boolean
  darkMode?: boolean
  onViewDetails?: () => void
}
interface Camera {
  zoom: number
  x: number
  y: number
}
interface DragState {
  pointerId: number
  x: number
  y: number
  camera: Camera
  moved: boolean
}

export function matchesGenomeSearch(gene: Gene, search: string) {
  const term = search.trim().toLowerCase()
  return (
    Boolean(term) &&
    [gene.symbol, gene.ecoli_id, gene.synonyms].some((value) => value?.toLowerCase().includes(term))
  )
}

export function CircularGenomeMap({
  genes,
  searchTerm,
  highlightedCategories,
  selectedGene = null,
  focusRequest = null,
  onSelectGene,
  compact = false,
  darkMode = false,
  onViewDetails,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapFrameRef = useRef<HTMLDivElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const cameraRef = useRef<Camera>({ zoom: 1, x: 0, y: 0 })
  const suppressClick = useRef(false)
  const appliedFocus = useRef<GenomeFocusRequest | null>(null)
  const [dragging, setDragging] = useState(false)
  const [viewportSize, setViewportSize] = useState(0)
  const [camera, setCamera] = useState<Camera>({ zoom: 1, x: 0, y: 0 })
  const [tooltip, setTooltip] = useState<{ gene: Gene; x: number; y: number } | null>(null)
  const palette = useMemo(
    () =>
      darkMode
        ? { bg: '#19191f', ring: '#363640', text: '#f4f4f7', muted: '#a3a3b4', outline: '#c4b5fd' }
        : { bg: '#ffffff', ring: '#e4e4ec', text: '#1c1c24', muted: '#686874', outline: '#6d28d9' },
    [darkMode],
  )
  const positionedGenes = useMemo(
    () =>
      genes.filter(hasGenomePosition).map((gene) => {
        const left = Math.min(gene.left_end_pos, gene.right_end_pos)
        const right = Math.max(gene.left_end_pos, gene.right_end_pos)
        const startAngle = bpToAngle(left)
        const endAngle = Math.max(bpToAngle(right), startAngle + MIN_ARC_RAD)
        const forward = gene.direction === '+'
        const path = arcPath(
          CENTER,
          CENTER,
          forward ? FORWARD_INNER_R : REVERSE_INNER_R,
          forward ? FORWARD_OUTER_R : REVERSE_OUTER_R,
          startAngle,
          endAngle,
        )
        return { gene, left, right, startAngle, endAngle, path }
      }),
    [genes],
  )

  useEffect(() => {
    if (!focusRequest || appliedFocus.current === focusRequest) return
    const entry = positionedGenes.find(
      (item) => item.gene.symbol.toLowerCase() === focusRequest.symbol.toLowerCase(),
    )
    if (!entry) return
    const angle = (entry.startAngle + entry.endAngle) / 2
    const radius =
      entry.gene.direction === '-'
        ? (REVERSE_INNER_R + REVERSE_OUTER_R) / 2
        : (FORWARD_INNER_R + FORWARD_OUTER_R) / 2
    setCamera({
      zoom: FOCUS_ZOOM,
      x: -radius * Math.cos(angle) * FOCUS_ZOOM,
      y: -radius * Math.sin(angle) * FOCUS_ZOOM,
    })
    appliedFocus.current = focusRequest
  }, [focusRequest, positionedGenes])

  const zoomBy = (factor: number) =>
    setCamera((current) => {
      const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, current.zoom * factor))
      const ratio = zoom / current.zoom
      return zoom === 1
        ? { zoom, x: 0, y: 0 }
        : { zoom, x: current.x * ratio, y: current.y * ratio }
    })
  useLayoutEffect(() => {
    const frame = mapFrameRef.current
    if (!frame) return
    let styleFrame: number | undefined
    const measure = () => {
      // Do not measure the unstyled frame during a cold stylesheet load.
      if (getComputedStyle(frame).overflowX === 'auto') {
        if (styleFrame != null) cancelAnimationFrame(styleFrame)
        styleFrame = undefined
        setViewportSize(frame.getBoundingClientRect().width)
      } else if (styleFrame == null) {
        styleFrame = requestAnimationFrame(() => {
          styleFrame = undefined
          measure()
        })
      }
    }
    const observer = new ResizeObserver(measure)
    observer.observe(frame)
    measure()
    return () => {
      observer.disconnect()
      if (styleFrame != null) cancelAnimationFrame(styleFrame)
    }
  }, [])

  useLayoutEffect(() => {
    cameraRef.current = camera
    const frame = mapFrameRef.current
    if (!frame || !viewportSize) return
    const scale = viewportSize / VIEW_SIZE
    frame.scrollLeft = (CENTER * camera.zoom - camera.x) * scale - frame.clientWidth / 2
    frame.scrollTop = (CENTER * camera.zoom - camera.y) * scale - frame.clientHeight / 2
    if (camera.zoom > 1) {
      const x = CENTER * camera.zoom - (frame.scrollLeft + frame.clientWidth / 2) / scale
      const y = CENTER * camera.zoom - (frame.scrollTop + frame.clientHeight / 2) / scale
      if (Math.abs(x - camera.x) > 0.01 || Math.abs(y - camera.y) > 0.01)
        setCamera((current) => ({ ...current, x, y }))
    }
  }, [camera, viewportSize])

  useEffect(() => {
    const frame = mapFrameRef.current
    if (!frame || !viewportSize) return
    type Gesture = Event & { scale: number; clientX: number; clientY: number }
    type Pinch = { camera: Camera; x: number; y: number; distance: number }
    let touchPinch: Pinch | null = null
    let trackpadPinch: Pinch | null = null
    let animationFrame = 0
    let pending: ((current: Camera) => Camera) | null = null
    const queue = (update: (current: Camera) => Camera) => {
      const previous = pending
      pending = previous ? (current) => update(previous(current)) : update
      if (animationFrame) return
      animationFrame = requestAnimationFrame(() => {
        animationFrame = 0
        const apply = pending
        pending = null
        if (apply) setCamera(apply)
      })
    }
    const point = (clientX: number, clientY: number) => {
      const rect = frame.getBoundingClientRect()
      const scale = viewportSize / VIEW_SIZE
      return {
        x: (clientX - rect.left - frame.clientWidth / 2) / scale,
        y: (clientY - rect.top - frame.clientHeight / 2) / scale,
      }
    }
    const pinchCamera = (start: Pinch, factor: number, x: number, y: number): Camera => {
      const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, start.camera.zoom * factor))
      const ratio = zoom / start.camera.zoom
      return zoom === MIN_ZOOM
        ? { zoom, x: 0, y: 0 }
        : {
            zoom,
            x: x - (start.x - start.camera.x) * ratio,
            y: y - (start.y - start.camera.y) * ratio,
          }
    }
    const beginPinch = () => {
      dragRef.current = null
      suppressClick.current = true
      setDragging(false)
      setTooltip(null)
    }
    // Chromium represents trackpad pinch as ctrl-wheel. Ordinary and Shift-wheel stay native.
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey || !event.cancelable) return
      event.preventDefault()
      if (trackpadPinch || touchPinch) return
      const anchor = point(event.clientX, event.clientY)
      const delta =
        event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? frame.clientHeight : 1)
      beginPinch()
      queue((current) =>
        pinchCamera(
          { camera: current, ...anchor, distance: 1 },
          Math.exp(-delta * 0.01),
          anchor.x,
          anchor.y,
        ),
      )
    }
    // Safari exposes its trackpad pinch through native gesture events.
    const gestureStart = (event: Event) => {
      event.preventDefault()
      if (touchPinch) return
      const gesture = event as Gesture
      const rect = frame.getBoundingClientRect()
      const anchor = point(
        gesture.clientX || rect.left + frame.clientWidth / 2,
        gesture.clientY || rect.top + frame.clientHeight / 2,
      )
      trackpadPinch = { camera: cameraRef.current, ...anchor, distance: gesture.scale || 1 }
      beginPinch()
    }
    const gestureChange = (event: Event) => {
      event.preventDefault()
      if (!trackpadPinch || touchPinch) return
      const start = trackpadPinch
      const scale = (event as Gesture).scale / start.distance
      if (Number.isFinite(scale) && scale > 0)
        queue(() => pinchCamera(start, scale, start.x, start.y))
    }
    const gestureEnd = (event: Event) => {
      event.preventDefault()
      trackpadPinch = null
    }
    const touchStart = (event: TouchEvent) => {
      if (event.touches.length !== 2) return
      event.preventDefault()
      const [a, b] = Array.from(event.touches)
      const anchor = point((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2)
      touchPinch = {
        camera: cameraRef.current,
        ...anchor,
        distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
      }
      beginPinch()
    }
    const touchMove = (event: TouchEvent) => {
      if (!touchPinch || event.touches.length !== 2) return
      event.preventDefault()
      const [a, b] = Array.from(event.touches)
      const anchor = point((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2)
      const start = touchPinch
      const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
      if (start.distance > 0 && distance > 0)
        queue(() => pinchCamera(start, distance / start.distance, anchor.x, anchor.y))
    }
    const touchEnd = (event: TouchEvent) => {
      if (event.touches.length < 2) touchPinch = null
    }
    frame.addEventListener('wheel', wheel, { passive: false })
    frame.addEventListener('gesturestart', gestureStart, { passive: false })
    frame.addEventListener('gesturechange', gestureChange, { passive: false })
    frame.addEventListener('gestureend', gestureEnd, { passive: false })
    frame.addEventListener('touchstart', touchStart, { passive: false })
    frame.addEventListener('touchmove', touchMove, { passive: false })
    frame.addEventListener('touchend', touchEnd)
    frame.addEventListener('touchcancel', touchEnd)
    return () => {
      cancelAnimationFrame(animationFrame)
      frame.removeEventListener('wheel', wheel)
      frame.removeEventListener('gesturestart', gestureStart)
      frame.removeEventListener('gesturechange', gestureChange)
      frame.removeEventListener('gestureend', gestureEnd)
      frame.removeEventListener('touchstart', touchStart)
      frame.removeEventListener('touchmove', touchMove)
      frame.removeEventListener('touchend', touchEnd)
      frame.removeEventListener('touchcancel', touchEnd)
    }
  }, [viewportSize])

  function pointerDown(event: PointerEvent<SVGSVGElement>) {
    if (event.button !== 0) return
    event.preventDefault()
    mapFrameRef.current?.focus({ preventScroll: true })
    suppressClick.current = false
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      camera,
      moved: false,
    }
  }
  function pointerMove(event: PointerEvent<SVGSVGElement>) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    if (Math.hypot(dx, dy) < 4 && !drag.moved) return
    drag.moved = true
    suppressClick.current = true
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
    setTooltip(null)
    if (camera.zoom <= 1) return
    const rect = mapFrameRef.current!.getBoundingClientRect()
    setCamera({
      ...drag.camera,
      x: drag.camera.x + (dx * VIEW_SIZE) / rect.width,
      y: drag.camera.y + (dy * VIEW_SIZE) / rect.height,
    })
  }
  function pointerUp(event: PointerEvent<SVGSVGElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
    dragRef.current = null
    setDragging(false)
  }
  const updateTooltip = useCallback((event: MouseEvent<SVGPathElement>, gene: Gene) => {
    if (dragRef.current?.moved) return
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    setTooltip({
      gene,
      x: Math.max(8, Math.min(event.clientX - rect.left + 14, rect.width - Math.min(260, rect.width - 16) - 8)),
      y: Math.max(8, 8 - rect.top, Math.min(event.clientY - rect.top + 14, Math.min(rect.height, window.innerHeight - rect.top) - (tooltipRef.current?.offsetHeight ?? 190) - 8)),
    })
  }, [])
  const hasSearch = Boolean(searchTerm.trim())
  const hasHighlights = highlightedCategories.size > 0
  // Camera and tooltip changes must not rebuild thousands of scientific glyphs.
  const chromosomeScene = useMemo(
    () => (
      <g>
        <circle cx={CENTER} cy={CENTER} r={250} fill={palette.bg} stroke={palette.ring} />
        <circle cx={CENTER} cy={CENTER} r={298} fill="none" stroke={palette.ring} />
        <circle cx={CENTER} cy={CENTER} r={342} fill="none" stroke={palette.ring} />
        {positionedGenes.map(({ gene, left, right, path }) => {
          const selected = gene.symbol.toLowerCase() === selectedGene?.toLowerCase()
          const matched =
            matchesGenomeSearch(gene, searchTerm) || highlightedCategories.has(gene.category)
          const dimmed = (hasSearch || hasHighlights) && !matched && !selected
          return (
            <path
              key={`${gene.id}-${left}-${right}`}
              data-gene={gene.symbol}
              role="button"
              tabIndex={-1}
              aria-label={`Select ${gene.symbol}`}
              aria-pressed={selected}
              d={path}
              fill={CATEGORY_FILL[gene.category] ?? CATEGORY_FILL.other}
              opacity={dimmed ? 0.25 : 0.9}
              stroke={selected ? palette.outline : matched ? palette.text : 'none'}
              strokeWidth={selected ? 3 : matched ? 1 : 0}
              vectorEffect="non-scaling-stroke"
              onMouseEnter={(event) => updateTooltip(event, gene)}
              onMouseMove={(event) => updateTooltip(event, gene)}
              onMouseLeave={() => setTooltip(null)}
              onClick={(event) => {
                event.stopPropagation()
                if (!suppressClick.current) onSelectGene(gene.symbol)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onSelectGene(gene.symbol)
                }
              }}
            >
              <title>
                {gene.symbol}: {categoryLabel(gene.category)}, {left.toLocaleString()}–
                {right.toLocaleString()} bp
              </title>
            </path>
          )
        })}
      </g>
    ),
    [
      positionedGenes,
      selectedGene,
      searchTerm,
      highlightedCategories,
      hasSearch,
      hasHighlights,
      palette,
      updateTooltip,
      onSelectGene,
    ],
  )
  // Text scales with the fitted viewport; camera updates reuse the gene scene.
  const annotationScale = VIEW_SIZE / (viewportSize || VIEW_SIZE)
  const annotations = useMemo(() => (
    <g className="genome-map-annotations">
      <GenomeTicks posText={palette.muted} fontSize={11 * annotationScale} />
        <GenomeMarker
          bp={ORIC_BP}
          label="oriC"
          fill="#facc15"
          stroke={palette.bg}
          textFill={palette.text}
          fontSize={11 * annotationScale}
        />
        <GenomeMarker
          bp={TER_BP}
          label="ter"
          fill="#60a5fa"
          stroke={palette.bg}
          textFill={palette.text}
          fontSize={11 * annotationScale}
        />
        <text
          x={CENTER}
          y={CENTER - 8 * annotationScale}
          textAnchor="middle"
          fill={palette.text}
          fontSize={14 * annotationScale}
          className="font-semibold"
        >
          E. coli K-12 MG1655
        </text>
        <text
          x={CENTER}
          y={CENTER + 20 * annotationScale}
          textAnchor="middle"
          fill={palette.muted}
          fontSize={12 * annotationScale}
        >
          {(GENOME_LENGTH / 1_000_000).toFixed(2)} Mbp
        </text>
    </g>
  ), [palette, annotationScale])
  return (
    <div className={`genome-map ${compact ? 'genome-map-compact' : ''}`} ref={containerRef}>
      <div className="genome-map-controls" role="group" aria-label="Map controls">
        <button
          type="button"
          onClick={() => zoomBy(1.4)}
          disabled={camera.zoom >= MAX_ZOOM}
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          type="button"
          onClick={() => zoomBy(1 / 1.4)}
          disabled={camera.zoom <= MIN_ZOOM}
          aria-label="Zoom out"
        >
          −
        </button>
        <output aria-label="Map zoom" className="font-mono">
          {camera.zoom.toFixed(1)}×
        </output>
        <button type="button" onClick={() => setCamera({ zoom: 1, x: 0, y: 0 })}>
          Fit genome
        </button>
        {onViewDetails && <button type="button" onClick={onViewDetails}>View gene details</button>}
      </div>
      <div
        className="genome-map-frame"
        ref={mapFrameRef}
        role="group"
        aria-label="Interactive chromosome map"
        tabIndex={0}
        onKeyDown={(event) => {
          if (
            event.target !== event.currentTarget ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey
          )
            return
          if (event.key === '+' || event.key === '=') {
            event.preventDefault()
            zoomBy(1.4)
          } else if (event.key === '-') {
            event.preventDefault()
            zoomBy(1 / 1.4)
          } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
            event.preventDefault()
            if (camera.zoom > 1)
              setCamera((current) => ({
                ...current,
                x:
                  current.x +
                  (event.key === 'ArrowLeft' ? 40 : event.key === 'ArrowRight' ? -40 : 0),
                y: current.y + (event.key === 'ArrowUp' ? 40 : event.key === 'ArrowDown' ? -40 : 0),
              }))
          }
        }}
        style={viewportSize ? { height: viewportSize } : undefined}
        onScroll={() => {
          const frame = mapFrameRef.current
          if (!frame || !viewportSize || camera.zoom === 1) return
          const scale = viewportSize / VIEW_SIZE
          const x = CENTER * camera.zoom - (frame.scrollLeft + frame.clientWidth / 2) / scale
          const y = CENTER * camera.zoom - (frame.scrollTop + frame.clientHeight / 2) / scale
          if (Math.abs(x - camera.x) > 1 || Math.abs(y - camera.y) > 1)
            setCamera((current) => ({ ...current, x, y }))
          setTooltip(null)
        }}
      >
        <svg
          viewBox={`0 0 ${VIEW_SIZE} ${VIEW_SIZE}`}
          role="group"
          aria-label="Chromosome genes"
          style={{
            touchAction: camera.zoom > 1 ? 'none' : 'pan-y',
            width: viewportSize ? viewportSize * camera.zoom : '100%',
            height: viewportSize ? viewportSize * camera.zoom : '100%',
          }}
          className={dragging ? 'genome-dragging' : ''}
          onPointerDown={pointerDown}
          onPointerMove={pointerMove}
          onPointerUp={pointerUp}
          onPointerCancel={pointerUp}
          onLostPointerCapture={() => {
            dragRef.current = null
            setDragging(false)
          }}
        >
          <rect width={VIEW_SIZE} height={VIEW_SIZE} fill={palette.bg} />
          <g
            data-testid="genome-camera"
            data-zoom={camera.zoom}
            data-pan-x={camera.x}
            data-pan-y={camera.y}
          >
            {chromosomeScene}
            {annotations}
          </g>
        </svg>
      </div>
      {tooltip && (
        <div ref={tooltipRef} className="genome-map-tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
          <strong className="font-mono">{tooltip.gene.symbol}</strong>
          <p>{categoryLabel(tooltip.gene.category)}</p>
          <p className="font-mono">
            {tooltip.gene.left_end_pos?.toLocaleString()}–
            {tooltip.gene.right_end_pos?.toLocaleString()} bp
          </p>
          <p>{tooltip.gene.direction === '+' ? 'Forward strand' : 'Reverse strand'}</p>
          <p>Click to inspect on this map</p>
        </div>
      )}
    </div>
  )
}

function GenomeTicks({ posText, fontSize }: { posText: string; fontSize: number }) {
  const ticks = Array.from({ length: 9 }, (_, index) => (index + 1) * 500_000).filter(
    (bp) => bp < GENOME_LENGTH,
  )

  return (
    <g>
      {ticks.map((bp) => {
        const angle = bpToAngle(bp)
        const inner = polarToCartesian(CENTER, CENTER, 350, angle)
        const outer = polarToCartesian(CENTER, CENTER, 368, angle)
        const label = polarToCartesian(CENTER, CENTER, 388, angle)
        return (
          <g key={bp}>
            <line
              x1={inner.x}
              y1={inner.y}
              x2={outer.x}
              y2={outer.y}
              stroke={posText}
              strokeWidth="1"
              opacity="0.7"
            />
            <text
              x={label.x}
              y={label.y}
              textAnchor={label.x < 40 ? 'start' : label.x > VIEW_SIZE - 40 ? 'end' : 'middle'}
              dominantBaseline="middle"
              fill={posText}
              fontSize={fontSize}
            >
              {(bp / 1_000_000).toFixed(1)}
            </text>
          </g>
        )
      })}
    </g>
  )
}

function GenomeMarker({
  bp,
  label,
  fill,
  stroke,
  textFill,
  fontSize,
}: {
  bp: number
  label: string
  fill: string
  stroke: string
  textFill: string
  fontSize: number
}) {
  const angle = bpToAngle(bp)
  const tip = polarToCartesian(CENTER, CENTER, 356, angle)
  const left = polarToCartesian(CENTER, CENTER, 338, angle - 0.025)
  const right = polarToCartesian(CENTER, CENTER, 338, angle + 0.025)
  const text = polarToCartesian(CENTER, CENTER, 378, angle)

  return (
    <g>
      <polygon
        points={`${tip.x},${tip.y} ${left.x},${left.y} ${right.x},${right.y}`}
        fill={fill}
        stroke={stroke}
        strokeWidth="1"
      />
      <text
        x={text.x}
        y={text.y}
        textAnchor="middle"
        dominantBaseline="middle"
        fill={textFill}
        fontSize={fontSize}
        className="font-medium"
      >
        {label}
      </text>
    </g>
  )
}
