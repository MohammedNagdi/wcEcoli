import { useCallback, useEffect, useState } from 'react'
import { getConditions, getDesignGeneEvidence, getDesignOverview } from '../../api/client'
import type { Condition, DesignGeneEvidence, DesignOverview } from '../../types'

type Resource<T> = { key: string; data: T | null; loading: boolean; error: string | null }

// Keyed state prevents a previous condition/source from appearing under a new label.
function useResource<T>(key: string, fetcher: (signal: AbortSignal) => Promise<T>) {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<Resource<T>>({ key, data: null, loading: !!key, error: null })
  useEffect(() => {
    if (!key) return
    const controller = new AbortController()
    setState(old => ({ key, data: old.key === key ? old.data : null, loading: true, error: null }))
    // Defer initiation to skip React StrictMode's immediately discarded effect.
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted) return
      const data = await fetcher(controller.signal)
      if (!controller.signal.aborted) setState({ key, data, loading: false, error: null })
    }).catch(error => {
      if (!controller.signal.aborted) setState(old => ({ ...old, loading: false, error: error instanceof Error ? error.message : 'Request failed.' }))
    })
    return () => controller.abort()
  }, [key, fetcher, attempt])
  const retry = useCallback(() => setAttempt(n => n + 1), [])
  return { ...(state.key === key && key ? state : { key, data: null, loading: !!key, error: null }), retry }
}

export function useDesignOverview(condition: string) {
  const fetcher = useCallback(async (signal: AbortSignal) => {
    const data = await getDesignOverview({ condition }, signal)
    if (!data || !Array.isArray(data.genes) || (data.condition && data.condition !== condition)) throw new Error('The evidence response is unavailable. Please retry.')
    return data
  }, [condition])
  return useResource<DesignOverview>(condition, fetcher)
}

export function useDesignInspector(symbol: string, condition: string, experimentId?: number) {
  const fetcher = useCallback(async (signal: AbortSignal) => {
    const data = await getDesignGeneEvidence(symbol, condition, experimentId, signal)
    if (!data?.gene?.symbol || data.gene.symbol.toLowerCase() !== symbol.toLowerCase() || data.condition !== condition || !data.summary || !Array.isArray(data.experiments)) throw new Error('The gene evidence response is unavailable. Please retry.')
    return data
  }, [symbol, condition, experimentId])
  return useResource<DesignGeneEvidence>(symbol ? `${symbol}|${condition}|${experimentId ?? ''}` : '', fetcher)
}

export function useDesignConditions() {
  const fetcher = useCallback((signal: AbortSignal) => getConditions(signal), [])
  return useResource<Condition[]>('conditions', fetcher)
}
