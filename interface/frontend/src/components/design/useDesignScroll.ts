import { useLayoutEffect, useRef, type RefObject } from 'react'

type Position = { table: number; main: number }
type Saved = { catalog: Position; main: number }
// Bounded, tab-local UI state. No conversation data or persistent storage.
const savedPositions = new Map<string, Saved>()

export function useDesignScroll(key: string, ready: boolean, inspecting: boolean, pageRef: RefObject<HTMLDivElement>, tableRef: RefObject<HTMLDivElement>) {
  const catalog = useRef<Position>(savedPositions.get(key)?.catalog ?? { table: 0, main: 0 })
  const latest = useRef({ key, inspecting, ready })
  latest.current = { key, inspecting, ready }
  const restored = useRef(false)
  useLayoutEffect(() => {
    if (!ready || restored.current) return
    restored.current = true
    const saved = savedPositions.get(key)
    if (!saved) return
    catalog.current = saved.catalog
    const frame = requestAnimationFrame(() => {
      if (tableRef.current) tableRef.current.scrollTop = saved.catalog.table
      const main = pageRef.current?.closest('main')
      if (main) main.scrollTop = saved.main
    })
    return () => cancelAnimationFrame(frame)
  }, [ready, key, pageRef, tableRef])
  useLayoutEffect(() => {
    const page = pageRef.current
    const main = page?.closest('main')
    return () => {
      const state = latest.current
      if (!state.ready) return
      const position = state.inspecting ? catalog.current : {
        table: page?.querySelector('.design-table-scroll')?.scrollTop ?? 0,
        main: main?.scrollTop ?? 0,
      }
      savedPositions.delete(state.key)
      savedPositions.set(state.key, { catalog: position, main: main?.scrollTop ?? 0 })
      if (savedPositions.size > 20) savedPositions.delete(savedPositions.keys().next().value!)
    }
  }, [pageRef])
  return catalog
}
