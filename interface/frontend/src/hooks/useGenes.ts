import { useState, useEffect, useCallback } from 'react'
import type { Gene, GeneDetail, GeneSearchResult, CategoryCount } from '../types'
import { getGenes, getGene, getCategories, searchGenes } from '../api/client'

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
  const [gene, setGene] = useState<GeneDetail | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!symbol) { setGene(null); return }
    setLoading(true)
    getGene(symbol)
      .then(setGene)
      .catch(() => setGene(null))
      .finally(() => setLoading(false))
  }, [symbol])

  return { gene, loading }
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
