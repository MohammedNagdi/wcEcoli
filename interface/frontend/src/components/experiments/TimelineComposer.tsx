import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import type { Condition, MediaRecipe, Timeline, UserTimeline } from '../../types'
import { getTimelines, getUserTimelines, saveUserTimeline } from '../../api/client'

interface TLEvent {
  id: string
  timeSec: number
  mediaId: string
}

const HEX_COLORS = [
  '#475569', '#059669', '#7c3aed', '#ea580c', '#0891b2',
  '#d97706', '#e11d48', '#0d9488', '#4f46e5',
]

const TICK_INTERVAL_SEC = 1200
const COMMON_MEDIA_IDS = [
  'minimal',
  'minimal_plus_amino_acids',
  'minimal_acetate',
  'minimal_no_glucose',
  'minimal_minus_oxygen',
]

let _idCounter = 0
function uid() { return `ev${++_idCounter}` }

function fmtSec(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (h > 0 && m > 0) return `${h}h ${m}m`
  if (h > 0) return `${h}h`
  return `${m}m`
}

function humanize(id: string): string {
  return id.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function humanizePreset(name: string): string {
  return humanize(name.replace(/^\d+_/, ''))
}

function clampTime(sec: number, maxSec: number): number {
  return Math.max(0, Math.min(maxSec, Math.round(sec / 60) * 60))
}

function nearestOpenTime(
  requestedTime: number,
  originalTime: number,
  occupiedTimes: Set<number>,
  maxSec: number,
): number | null {
  let candidate = clampTime(requestedTime, maxSec)
  if (candidate === 0) candidate = 60
  if (!occupiedTimes.has(candidate)) return candidate

  const step = requestedTime >= originalTime ? 60 : -60
  for (let t = candidate + step; t > 0 && t <= maxSec; t += step) {
    if (!occupiedTimes.has(t)) return t
  }
  for (let t = candidate - step; t > 0 && t <= maxSec; t -= step) {
    if (!occupiedTimes.has(t)) return t
  }
  return null
}

function buildEventString(events: TLEvent[]): string {
  return [...events]
    .sort((a, b) => a.timeSec - b.timeSec)
    .map(e => `${e.timeSec} ${e.mediaId}`)
    .join(', ')
}

function parseDefinition(def: string, knownMediaIds: Set<string>, maxSec: number): TLEvent[] {
  const seen = new Set<number>()
  return def.trim().replace(/^["']|["']$/g, '').split(',').flatMap(part => {
    const bits = part.trim().split(/\s+/, 2)
    if (bits.length !== 2) return []
    const timeSec = clampTime(Number(bits[0]), maxSec)
    const mediaId = bits[1]
    if (!Number.isFinite(timeSec) || !knownMediaIds.has(mediaId) || seen.has(timeSec)) return []
    seen.add(timeSec)
    return [{ id: uid(), timeSec, mediaId }]
  }).sort((a, b) => a.timeSec - b.timeSec)
}

function recipeSummary(r: MediaRecipe): string {
  const parts: string[] = []
  if (r.added_media) parts.push(r.added_media)
  try {
    const parsed: string[] = JSON.parse(r.ingredients.replace(/'/g, '"'))
    if (parsed.length) parts.push(...parsed.slice(0, 2).map(s => s.toLowerCase()))
    if (parsed.length > 2) parts.push(`+${parsed.length - 2} more`)
  } catch { /* ignore malformed ingredient lists */ }
  return parts.length ? parts.join(', ') : r.base_media
}

interface Props {
  mediaRecipes: MediaRecipe[]
  conditions: Condition[]
  onChange: (timelineStr: string) => void
  maxSec?: number
}

export function TimelineComposer({ mediaRecipes, conditions, onChange, maxSec = 10800 }: Props) {
  const [selectedMediaId, setSelectedMediaId] = useState('')
  const [events, setEvents] = useState<TLEvent[]>([])
  const [hoverPct, setHoverPct] = useState<number | null>(null)
  const [draggingEventId, setDraggingEventId] = useState<string | null>(null)
  const [dragPreview, setDragPreview] = useState<{ id: string; timeSec: number } | null>(null)
  const [draggingMediaId, setDraggingMediaId] = useState<string | null>(null)
  const [vialSearch, setVialSearch] = useState('')
  const [browseVialsOpen, setBrowseVialsOpen] = useState(false)
  const barRef = useRef<HTMLDivElement>(null)

  const [presetOpen, setPresetOpen] = useState(false)
  const [preconfTimelines, setPreconfTimelines] = useState<Timeline[]>([])
  const [userTimelines, setUserTimelines] = useState<UserTimeline[]>([])
  const [selectedPreset, setSelectedPreset] = useState('')
  const [presetWarning, setPresetWarning] = useState('')
  const [loadedPreset, setLoadedPreset] = useState<{ label: string; definition: string } | null>(null)

  const [timelineName, setTimelineName] = useState('')
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [saveError, setSaveError] = useState('')

  const knownMediaIds = useMemo(() => new Set(mediaRecipes.map(r => r.media_id)), [mediaRecipes])
  const recipeById = useMemo(() => new Map(mediaRecipes.map(r => [r.media_id, r])), [mediaRecipes])
  const conditionByMediaId = useMemo(
    () => new Map(conditions.map(c => [c.nutrients, c.name])),
    [conditions],
  )

  const sorted = useMemo(() => [...events].sort((a, b) => a.timeSec - b.timeSec), [events])
  const displayEvents = useMemo(() => {
    if (!dragPreview) return sorted
    return sorted
      .map(ev => ev.id === dragPreview.id ? { ...ev, timeSec: dragPreview.timeSec } : ev)
      .sort((a, b) => a.timeSec - b.timeSec)
  }, [dragPreview, sorted])
  const firstEvent = sorted[0]
  const inferredCondition = firstEvent ? conditionByMediaId.get(firstEvent.mediaId) || 'basal' : 'basal'
  const rawStr = buildEventString(events)
  const presetModified = !!loadedPreset && rawStr !== loadedPreset.definition
  const selectedRecipe = recipeById.get(selectedMediaId)
  const commonRecipes = useMemo(() => {
    const byId = new Map(mediaRecipes.map(r => [r.media_id, r]))
    return COMMON_MEDIA_IDS.flatMap(id => byId.get(id) ? [byId.get(id)!] : [])
  }, [mediaRecipes])
  const filteredRecipes = useMemo(() => {
    const query = vialSearch.trim().toLowerCase()
    if (!query) return mediaRecipes
    return mediaRecipes.filter(r => {
      const haystack = [
        r.media_id,
        humanize(r.media_id),
        r.base_media,
        r.added_media,
        recipeSummary(r),
      ].join(' ').toLowerCase()
      return haystack.includes(query)
    })
  }, [mediaRecipes, vialSearch])

  const colorIdx = useCallback((mediaId: string) => {
    const i = mediaRecipes.findIndex(r => r.media_id === mediaId)
    return (i < 0 ? 0 : i) % HEX_COLORS.length
  }, [mediaRecipes])

  const mutate = useCallback((nextEvents: TLEvent[]) => {
    const next = [...nextEvents].sort((a, b) => a.timeSec - b.timeSec)
    setEvents(next)
    onChange(buildEventString(next))
  }, [onChange])

  useEffect(() => {
    getTimelines().then(setPreconfTimelines).catch(() => {})
    getUserTimelines().then(setUserTimelines).catch(() => {})
  }, [])

  useEffect(() => {
    if (mediaRecipes.length > 0 && events.length === 0) {
      const initialMediaId = mediaRecipes.find(r => r.media_id === 'minimal')?.media_id || mediaRecipes[0].media_id
      setSelectedMediaId(initialMediaId)
      mutate([{ id: uid(), timeSec: 0, mediaId: initialMediaId }])
    }
  }, [mediaRecipes, events.length, mutate])

  const timeFromPointer = (clientX: number) => {
    if (!barRef.current) return 0
    const rect = barRef.current.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    return clampTime(pct * maxSec, maxSec)
  }

  const rawTimeFromPointer = (clientX: number) => {
    if (!barRef.current) return 0
    const rect = barRef.current.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    return Math.max(0, Math.min(maxSec, pct * maxSec))
  }

  const addOrReplaceEvent = (timeSec: number, mediaId: string) => {
    const clamped = clampTime(timeSec, maxSec)
    if (clamped === 0) {
      mutate(events.map(ev => ev.timeSec === 0 ? { ...ev, mediaId } : ev))
      return
    }
    const existing = events.find(ev => ev.timeSec === clamped)
    mutate(existing
      ? events.map(ev => ev.id === existing.id ? { ...ev, mediaId } : ev)
      : [...events, { id: uid(), timeSec: clamped, mediaId }]
    )
  }

  const moveEvent = (id: string, timeSec: number) => {
    const event = events.find(ev => ev.id === id)
    if (!event || event.timeSec === 0) return
    const occupiedTimes = new Set(events.filter(ev => ev.id !== id).map(ev => ev.timeSec))
    const nextTime = nearestOpenTime(timeSec, event.timeSec, occupiedTimes, maxSec)
    if (nextTime === null) return
    mutate(events.map(ev => ev.id === id ? { ...ev, timeSec: nextTime } : ev))
  }

  const startMarkerDrag = (e: React.PointerEvent<HTMLButtonElement>, ev: TLEvent) => {
    if (ev.timeSec === 0) return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    setDraggingEventId(ev.id)
    setDragPreview({ id: ev.id, timeSec: ev.timeSec })
  }

  const updateMarkerDrag = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragPreview) return
    e.preventDefault()
    e.stopPropagation()
    setDragPreview({
      id: dragPreview.id,
      timeSec: Math.max(1, rawTimeFromPointer(e.clientX)),
    })
  }

  const finishMarkerDrag = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragPreview) return
    e.preventDefault()
    e.stopPropagation()
    const event = events.find(ev => ev.id === dragPreview.id)
    if (event) {
      const occupiedTimes = new Set(events.filter(ev => ev.id !== event.id).map(ev => ev.timeSec))
      const nextTime = nearestOpenTime(dragPreview.timeSec, event.timeSec, occupiedTimes, maxSec)
      if (nextTime !== null) {
        mutate(events.map(ev => ev.id === event.id ? { ...ev, timeSec: nextTime } : ev))
      }
    }
    setDragPreview(null)
    setDraggingEventId(null)
  }

  const updateEventMedia = (id: string, mediaId: string) => {
    mutate(events.map(ev => ev.id === id ? { ...ev, mediaId } : ev))
  }

  const removeEvent = (id: string) => {
    const event = events.find(ev => ev.id === id)
    if (!event || event.timeSec === 0) return
    mutate(events.filter(ev => ev.id !== id))
  }

  const handleBarClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!selectedMediaId) return
    addOrReplaceEvent(timeFromPointer(e.clientX), selectedMediaId)
  }

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    const timeSec = timeFromPointer(e.clientX)
    const eventId = e.dataTransfer.getData('event-id') || draggingEventId
    const mediaId = e.dataTransfer.getData('media-id') || draggingMediaId
    if (eventId) moveEvent(eventId, timeSec)
    else if (mediaId) addOrReplaceEvent(timeSec, mediaId)
    setDraggingEventId(null)
    setDraggingMediaId(null)
  }

  const handleLoadPreset = () => {
    if (!selectedPreset) return
    const combined = [
      ...preconfTimelines.map(t => ({ name: t.name, label: humanizePreset(t.name), definition: t.definition })),
      ...userTimelines.map(t => ({ name: t.name, label: t.name, definition: t.definition })),
    ]
    const found = combined.find(t => t.name === selectedPreset)
    if (!found) return
    const parsed = parseDefinition(found.definition, knownMediaIds, maxSec)
    if (!parsed.length) {
      setPresetWarning('No valid events could be parsed from this preset.')
      return
    }
    if (!parsed.some(ev => ev.timeSec === 0)) {
      setPresetWarning('Preset must include a starting vial at 0 seconds.')
      return
    }
    setPresetWarning('')
    setLoadedPreset({ label: found.label, definition: buildEventString(parsed) })
    mutate(parsed)
    setPresetOpen(false)
  }

  const handleResetPreset = () => {
    if (!loadedPreset) return
    const parsed = parseDefinition(loadedPreset.definition, knownMediaIds, maxSec)
    if (!parsed.length) return
    mutate(parsed)
  }

  const handleSave = async () => {
    if (!timelineName.trim() || !rawStr) return
    setSaveStatus('saving')
    setSaveError('')
    try {
      await saveUserTimeline(timelineName.trim(), rawStr)
      setTimelineName('')
      setUserTimelines(await getUserTimelines())
      setSaveStatus('saved')
      setTimeout(() => setSaveStatus('idle'), 3000)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setSaveError(msg.includes('409') ? `A timeline named "${timelineName.trim()}" already exists.` : msg)
      setSaveStatus('error')
    }
  }

  if (!mediaRecipes.length) {
    return <div className="flex h-24 items-center justify-center text-sm text-gray-400">Loading media vials...</div>
  }

  const segments = displayEvents.map((ev, i) => {
    const startPct = (ev.timeSec / maxSec) * 100
    const endPct = i < displayEvents.length - 1 ? (displayEvents[i + 1].timeSec / maxSec) * 100 : 100
    return { ev, startPct, widthPct: Math.max(endPct - startPct, 0.1), color: HEX_COLORS[colorIdx(ev.mediaId)] }
  })

  const ticks = Array.from({ length: Math.floor(maxSec / TICK_INTERVAL_SEC) + 1 }, (_, i) => i * TICK_INTERVAL_SEC)

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-[1fr_1fr]">
        <div className="rounded-lg border border-gray-200">
          <button
            type="button"
            onClick={() => setPresetOpen(o => !o)}
            className="flex w-full items-center justify-between gap-3 bg-gray-50 px-4 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-100"
          >
            <span>Load preset timeline</span>
            <span className={`shrink-0 transition-transform ${presetOpen ? 'rotate-180' : ''}`}>⌄</span>
          </button>
          {loadedPreset && (
            <div className="border-t border-gray-200 bg-white px-4 py-3">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="max-w-[180px] truncate rounded-full bg-gray-50 px-2.5 py-1 text-xs font-medium text-gray-700">
                  {loadedPreset.label}
                </span>
                {presetModified ? (
                  <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-700">
                    modified
                  </span>
                ) : (
                  <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-700">
                    unchanged
                  </span>
                )}
                {presetModified && (
                  <button
                    type="button"
                    onClick={handleResetPreset}
                    className="rounded px-2.5 py-1 text-xs font-medium text-brand-700 hover:bg-brand-50"
                  >
                    Reset preset
                  </button>
                )}
              </div>
            </div>
          )}
          {presetOpen && (
            <div className="space-y-2 border-t border-gray-200 px-4 py-3">
              <select
                value={selectedPreset}
                onChange={e => { setSelectedPreset(e.target.value); setPresetWarning('') }}
                className="w-full rounded border border-gray-200 bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-brand-400"
              >
                <option value="">Choose a preset...</option>
                {!!preconfTimelines.length && (
                  <optgroup label="Preconfigured">
                    {preconfTimelines.map(t => <option key={t.name} value={t.name}>{humanizePreset(t.name)}</option>)}
                  </optgroup>
                )}
                {!!userTimelines.length && (
                  <optgroup label="My saved timelines">
                    {userTimelines.map(t => <option key={t.name} value={t.name}>{t.name}</option>)}
                  </optgroup>
                )}
              </select>
              {presetWarning && <p className="text-xs text-amber-600">{presetWarning}</p>}
              <button
                type="button"
                onClick={handleLoadPreset}
                disabled={!selectedPreset}
                className="rounded bg-brand-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Load
              </button>
            </div>
          )}
        </div>

        <div className="rounded-lg border border-gray-200 px-4 py-3">
          <p className="mb-2 text-xs font-medium text-gray-600">Save this timeline for later</p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={timelineName}
              onChange={e => { setTimelineName(e.target.value); setSaveStatus('idle'); setSaveError('') }}
              placeholder="e.g. carbon shift test"
              className="min-w-0 flex-1 rounded border border-gray-200 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-brand-400"
            />
            <button
              type="button"
              onClick={handleSave}
              disabled={!timelineName.trim() || saveStatus === 'saving'}
              className="whitespace-nowrap rounded bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {saveStatus === 'saving' ? 'Saving...' : 'Save timeline'}
            </button>
          </div>
          {saveStatus === 'saved' && <p className="mt-2 text-xs text-emerald-600">Saved. It is now available in presets.</p>}
          {saveStatus === 'error' && <p className="mt-2 text-xs text-red-500">{saveError}</p>}
        </div>
      </div>

      <div className="rounded-lg border border-gray-200 px-4 py-3">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-medium text-gray-600">Media vials</p>
            <p className="text-xs text-gray-400">Search or pick a common vial, then drag it onto the timeline or click the bar.</p>
          </div>
          <span className="rounded-full bg-gray-100 px-2 py-1 text-xs text-gray-500">
            {mediaRecipes.length} vials
          </span>
        </div>

        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
          <input
            type="search"
            value={vialSearch}
            onChange={e => {
              setVialSearch(e.target.value)
              if (e.target.value.trim()) setBrowseVialsOpen(true)
            }}
            placeholder="Search media vial by name, media ID, base, supplement, or ingredient..."
            className="min-w-0 rounded border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-brand-400"
          />
          {selectedRecipe && (
            <button
              type="button"
              draggable
              onClick={() => setSelectedMediaId(selectedRecipe.media_id)}
              onDragStart={e => {
                setDraggingMediaId(selectedRecipe.media_id)
                e.dataTransfer.setData('media-id', selectedRecipe.media_id)
              }}
              title={recipeSummary(selectedRecipe)}
              className="flex min-w-[190px] items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium text-white shadow"
              style={{
                backgroundColor: HEX_COLORS[colorIdx(selectedRecipe.media_id)],
                borderColor: HEX_COLORS[colorIdx(selectedRecipe.media_id)],
              }}
            >
              <span className="h-2.5 w-2.5 rounded-full bg-white" />
              <span className="truncate">{humanize(selectedRecipe.media_id)}</span>
            </button>
          )}
        </div>

        {!!commonRecipes.length && (
          <div className="mt-3">
            <p className="mb-2 text-xs font-medium text-gray-500">Common vials</p>
            <div className="flex flex-wrap gap-2">
              {commonRecipes.map(r => {
                const selected = selectedMediaId === r.media_id
                return (
                  <button
                    key={r.media_id}
                    type="button"
                    draggable
                    onClick={() => setSelectedMediaId(r.media_id)}
                    onDragStart={e => {
                      setDraggingMediaId(r.media_id)
                      e.dataTransfer.setData('media-id', r.media_id)
                    }}
                    title={recipeSummary(r)}
                    className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition ${
                      selected ? 'scale-105 text-white shadow' : 'bg-gray-50 text-gray-600 hover:bg-gray-100'
                    }`}
                    style={selected ? {
                      backgroundColor: HEX_COLORS[colorIdx(r.media_id)],
                      borderColor: HEX_COLORS[colorIdx(r.media_id)],
                    } : {}}
                  >
                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: selected ? '#fff' : HEX_COLORS[colorIdx(r.media_id)] }} />
                    <span>{humanize(r.media_id)}</span>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        <div className="mt-3 rounded-lg border border-gray-100">
          <button
            type="button"
            onClick={() => setBrowseVialsOpen(o => !o)}
            className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50"
          >
            <span>{vialSearch.trim() ? `Matching vials (${filteredRecipes.length})` : 'Browse all vials'}</span>
            <span className={`transition-transform ${browseVialsOpen ? 'rotate-180' : ''}`}>⌄</span>
          </button>
          {browseVialsOpen && (
            <div className="max-h-56 overflow-y-auto border-t border-gray-100 p-2">
              {filteredRecipes.length === 0 && (
                <p className="px-2 py-3 text-xs text-gray-400">No media vials match your search.</p>
              )}
              <div className="grid gap-1 sm:grid-cols-2">
                {filteredRecipes.map(r => {
                  const selected = selectedMediaId === r.media_id
                  return (
                    <button
                      key={r.media_id}
                      type="button"
                      draggable
                      onClick={() => setSelectedMediaId(r.media_id)}
                      onDragStart={e => {
                        setDraggingMediaId(r.media_id)
                        e.dataTransfer.setData('media-id', r.media_id)
                      }}
                      title={recipeSummary(r)}
                      className={`flex min-w-0 items-center justify-between gap-2 rounded px-2 py-2 text-left text-xs transition ${
                        selected ? 'bg-brand-50 text-brand-700' : 'text-gray-600 hover:bg-gray-50'
                      }`}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: HEX_COLORS[colorIdx(r.media_id)] }} />
                        <span className="truncate font-medium">{humanize(r.media_id)}</span>
                      </span>
                      <code className="hidden max-w-[150px] truncate text-[11px] text-gray-400 md:inline">{r.media_id}</code>
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>
        {selectedRecipe && (
          <p className="mt-2 truncate text-xs text-gray-400">
            Selected <span className="font-mono text-gray-500">{selectedRecipe.media_id}</span>
            {' · '}{recipeSummary(selectedRecipe)}
          </p>
        )}
      </div>

      <div>
        <div
          ref={barRef}
          onClick={handleBarClick}
          onDragOver={e => e.preventDefault()}
          onDrop={handleDrop}
          onMouseMove={e => {
            if (!barRef.current) return
            const rect = barRef.current.getBoundingClientRect()
            setHoverPct(Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100)))
          }}
          onMouseLeave={() => setHoverPct(null)}
          className="relative h-14 cursor-crosshair select-none overflow-hidden rounded-lg border border-gray-200 bg-gray-100"
        >
          {segments.map(({ ev, startPct, widthPct, color }) => (
            <div key={ev.id} className="absolute top-0 h-full" style={{ left: `${startPct}%`, width: `${widthPct}%`, backgroundColor: color, opacity: 0.86 }} />
          ))}
          {displayEvents.map(ev => {
            const isDragging = dragPreview?.id === ev.id
            const markerTime = isDragging ? clampTime(ev.timeSec, maxSec) : ev.timeSec
            return (
            <button
              key={ev.id}
              type="button"
              onClick={e => e.stopPropagation()}
              onPointerDown={e => startMarkerDrag(e, ev)}
              onPointerMove={updateMarkerDrag}
              onPointerUp={finishMarkerDrag}
              onPointerCancel={finishMarkerDrag}
              className={`absolute top-2 z-10 flex max-w-[150px] -translate-x-1/2 touch-none items-center gap-1 rounded-full border-2 border-white px-2 py-1 text-[11px] font-medium text-white shadow transition-transform ${ev.timeSec === 0 ? 'cursor-not-allowed opacity-90' : isDragging ? 'scale-110 cursor-grabbing ring-2 ring-white/70' : 'cursor-grab hover:scale-105 active:cursor-grabbing'}`}
              title={ev.timeSec === 0 ? 'Starting vial is fixed at 0s' : 'Drag left or right to adjust shift time. Crossing another shift will reorder the timeline.'}
              style={{ left: `${(ev.timeSec / maxSec) * 100}%`, backgroundColor: HEX_COLORS[colorIdx(ev.mediaId)] }}
            >
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-white" />
              <span className="truncate">{fmtSec(markerTime)}</span>
            </button>
          )})}
          {hoverPct !== null && (
            <div className="absolute top-0 h-full w-px bg-white opacity-80" style={{ left: `${hoverPct}%` }}>
              <span className="absolute left-1.5 top-1 whitespace-nowrap font-mono text-xs text-white drop-shadow">
                {fmtSec(clampTime((hoverPct / 100) * maxSec, maxSec))}
              </span>
            </div>
          )}
        </div>
        <div className="relative mt-1 h-4 select-none">
          {ticks.map(t => (
            t === 0 ? null : (
            <span
              key={t}
              className={`absolute text-xs text-gray-400 ${t === 0 ? 'translate-x-0' : '-translate-x-1/2'}`}
              style={{ left: `${(t / maxSec) * 100}%` }}
            >
              {fmtSec(t)}
            </span>
            )
          ))}
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-gray-200">
        <div className="grid grid-cols-[90px_1fr_160px_80px] bg-gray-50 px-3 py-2 text-xs font-medium text-gray-500">
          <span>Time</span><span>Vial</span><span>Media ID</span><span />
        </div>
        {sorted.map(ev => (
          <div key={ev.id} className="grid grid-cols-[90px_1fr_160px_80px] items-center gap-2 border-t border-gray-100 px-3 py-2">
            <div className="flex items-center gap-1 text-xs text-gray-500">
              <input
                type="number"
                value={Math.round(ev.timeSec / 60)}
                min={0}
                max={Math.floor(maxSec / 60)}
                disabled={ev.timeSec === 0}
                onChange={e => moveEvent(ev.id, Number(e.target.value) * 60)}
                className="w-14 rounded border border-gray-200 px-2 py-1 font-mono disabled:bg-gray-50 disabled:text-gray-400"
              />
              <span>min</span>
            </div>
            <select
              value={ev.mediaId}
              onChange={e => updateEventMedia(ev.id, e.target.value)}
              className="min-w-0 rounded border border-gray-200 bg-white px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-gray-300"
            >
              {mediaRecipes.map(r => <option key={r.media_id} value={r.media_id}>{humanize(r.media_id)}</option>)}
            </select>
            <code className="truncate text-xs text-gray-500">{ev.mediaId}</code>
            <button
              type="button"
              onClick={() => removeEvent(ev.id)}
              disabled={ev.timeSec === 0}
              className="rounded px-2 py-1 text-xs text-gray-400 hover:bg-red-50 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Remove
            </button>
          </div>
        ))}
      </div>

      <details className="rounded-lg border border-gray-200 px-4 py-3">
        <summary className="cursor-pointer text-xs font-medium text-gray-600">Advanced</summary>
        <div className="mt-3 space-y-2">
          <p className="text-xs text-gray-500">
            Initial model state: <span className="font-mono text-gray-700">{inferredCondition}</span>
          </p>
          <div className="rounded bg-gray-50 px-3 py-2">
            <p className="mb-1 text-xs text-gray-400">Event string passed to simulation</p>
            <code className="break-all text-xs text-gray-600">{rawStr}</code>
          </div>
        </div>
      </details>
    </div>
  )
}
