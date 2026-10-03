import { useState, useEffect, useCallback } from 'react'
import type { Gene, GeneDetail, GeneSearchResult, CategoryCount } from '../types'
import { ApiError, getGenes, getGene, getCategories, searchGenes } from '../api/client'

export function useGeneList(params?: {
  q?: string
  category?: string
  mechanistic?: boolean
  page?: number
  page_size?: number
}) {
  const [data, setData] = useState<GeneSearchResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    getGenes({ ...params, page_size: params?.page_size ?? 50 })
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [params?.q, params?.category, params?.mechanistic, params?.page, params?.page_size])

  return { data, loading, error }
}

export function useGeneDetail(symbol: string | null) {
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<{
    symbol: string | null
    gene: GeneDetail | null
    status: 'loading' | 'ready' | 'missing' | 'error'
    error: string | null
  }>({ symbol: null, gene: null, status: 'ready', error: null })

  useEffect(() => {
    if (!symbol) return
    const controller = new AbortController()
    setResult({ symbol, gene: null, status: 'loading', error: null })
    getGene(symbol, controller.signal)
      .then((gene) => {
        if (controller.signal.aborted) return
        const valid = gene && typeof gene.symbol === 'string' ? gene : null
        setResult({ symbol, gene: valid, status: valid ? 'ready' : 'missing', error: null })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        const missing = error instanceof ApiError && error.status === 404
        setResult({ symbol, gene: null, status: missing ? 'missing' : 'error', error: missing ? null : 'The gene details could not be loaded.' })
      })
    return () => controller.abort()
  }, [symbol, attempt])

  const current = symbol !== null && result.symbol === symbol
  return {
    gene: current ? result.gene : null,
    loading: symbol !== null && (!current || result.status === 'loading'),
    error: current ? result.error : null,
    notFound: current && result.status === 'missing',
    retry: useCallback(() => setAttempt((value) => value + 1), []),
  }
}

export function useCategories() {
  const [categories, setCategories] = useState<CategoryCount[]>([])

  useEffect(() => {
    getCategories().then(setCategories).catch(() => {})
  }, [])

  return categories
}

export function useGeneSearch() {
  const [results, setResults] = useState<Gene[]>([])
  const [searching, setSearching] = useState(false)

  const search = useCallback(async (q: string) => {
    if (q.length < 1) { setResults([]); return }
    setSearching(true)
    try {
      const genes = await searchGenes(q, 15)
      setResults(genes)
    } catch {
      setResults([])
    } finally {
      setSearching(false)
    }
  }, [])

  return { results, searching, search }
}
