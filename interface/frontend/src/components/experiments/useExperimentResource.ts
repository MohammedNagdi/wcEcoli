import { useCallback, useEffect, useRef, useState } from 'react'

const inFlight = new Map<string, Promise<unknown>>()

function sharedLoad<T>(key: string, load: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key)
  if (existing) return existing as Promise<T>
  const request = Promise.resolve().then(load)
  inFlight.set(key, request)
  const clear = () => { if (inFlight.get(key) === request) inFlight.delete(key) }
  void request.then(clear, clear)
  return request
}

/** One request at a time; old selections and unmounted consumers cannot publish results. */
export function useExperimentResource<T>(key: string, load: () => Promise<T>, active: (data: T) => boolean = () => false, enabled = true) {
  const [publishedKey, setPublishedKey] = useState(key)
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const latest = useRef({ load, active, enabled, data })
  latest.current = { load, active, enabled, data }
  const generation = useRef(0)
  const pending = useRef<Promise<void> | null>(null)
  const refresh = useCallback((afterPending = false): Promise<void> => {
    const token = generation.current
    if (pending.current) return afterPending ? pending.current.then(() => generation.current === token ? refresh() : undefined) : pending.current
    const promise = sharedLoad(key, latest.current.load).then((result) => {
      if (generation.current !== token) return
      setData(result)
      setError(null)
    }).catch((reason: unknown) => {
      if (generation.current === token) setError(reason instanceof Error ? reason.message : 'Request failed')
    }).finally(() => {
      if (generation.current === token) { pending.current = null; setLoading(false) }
    })
    pending.current = promise
    return promise
  }, [key])
  useEffect(() => {
    generation.current++
    pending.current = null
    setPublishedKey(key)
    setData(null)
    setLoading(true)
    setError(null)
    void refresh()
    const timer = window.setInterval(() => {
      const current = latest.current
      if (current.enabled && current.data != null && current.active(current.data)) void refresh()
    }, 5000)
    return () => { generation.current++; pending.current = null; window.clearInterval(timer) }
  }, [refresh])
  return { data: publishedKey === key ? data : null, setData, loading: publishedKey !== key || loading, error: publishedKey === key ? error : null, refresh }
}
