import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import type { ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useGeneDetail, useCategories } from '../../hooks/useGenes'
import { getDesignOverview, getGenes } from '../../api/client'
import { SearchInput } from '../common/SearchInput'
import { SkeletonTableRows } from '../common/Skeleton'
import { CategoryBadge } from '../common/Badge'
import { GeneDetailPanel } from './GeneDetailPanel'
import { categoryLabel } from '../../utils/labels'
import { useUrlWorkspaceState } from '../../hooks/useUrlWorkspaceState'
import type { Gene, GeneKOSummary } from '../../types'

type SortKey = 'symbol' | 'category' | 'left_end_pos' | 'ko_index'
type SortDir = 'asc' | 'desc'

const PAGE_SIZE = 100

interface GeneCatalogPageProps {
  embedded?: boolean
  hideDetailPanel?: boolean
  heightClass?: string
}

function FilterChip({ label, active, dotColor, onClick }: {
  label: string
  active: boolean
  dotColor?: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
        active
          ? 'bg-brand-600 text-white'
          : 'bg-white border border-gray-200 text-gray-600 hover:border-gray-300'
      }`}
    >
      {dotColor && !active && <span className={`w-2 h-2 rounded-full ${dotColor}`} />}
      {label}
    </button>
  )
}

function PhenotypeBadge({
  symbol,
  phenotypeMap,
}: {
  symbol: string
  phenotypeMap: Map<string, GeneKOSummary>
}) {
  const summary = phenotypeMap.get(symbol)
  if (!summary?.phenotype) {
    return <span className="text-xs text-gray-300">-</span>
  }

  const styles: Record<string, string> = {
    essential: 'bg-red-50 text-red-700 border-red-200',
    growth_defect: 'bg-amber-50 text-amber-700 border-amber-200',
    neutral: 'bg-green-50 text-green-700 border-green-200',
    unknown: 'bg-gray-50 text-gray-500 border-gray-200',
  }
  const labels: Record<string, string> = {
    essential: 'essential',
    growth_defect: 'growth defect',
    neutral: 'neutral',
    unknown: 'unknown',
  }
  const cls = styles[summary.phenotype] ?? styles.unknown

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium border ${cls}`}>
      {labels[summary.phenotype] ?? summary.phenotype}
    </span>
  )
}

export function GeneCatalogPage({
  embedded = false,
  hideDetailPanel = false,
  heightClass,
}: GeneCatalogPageProps) {
  const [searchParams] = useSearchParams()
  const {
    selectedGene: selectedGeneSymbol,
    selectedCategory,
    setSelectedGene,
    setSelectedCategory,
  } = useUrlWorkspaceState()
  const [query, setQuery] = useState(() => searchParams.get('q') ?? searchParams.get('gene') ?? '')
  const [category, setCategory] = useState<string | undefined>(() => searchParams.get('category') ?? undefined)
  const [mechanisticFilter, setMechanisticFilter] = useState<boolean | undefined>()
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(() => searchParams.get('gene') ?? searchParams.get('q') ?? null)
  const [sortKey, setSortKey] = useState<SortKey>('symbol')
  const [sortDir, setSortDir] = useState<SortDir>('asc')

  const [allGenes, setAllGenes] = useState<Gene[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [phenotypeMap, setPhenotypeMap] = useState<Map<string, GeneKOSummary>>(new Map())
  const scrollRef = useRef<HTMLDivElement>(null)

  const { gene: selectedGeneDetail, loading: detailLoading } = useGeneDetail(selectedSymbol)
  const categories = useCategories()

  useEffect(() => {
    getDesignOverview()
      .then((data) => {
        const map = new Map<string, GeneKOSummary>()
        for (const gene of data.genes) map.set(gene.gene_symbol, gene)
        setPhenotypeMap(map)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    const urlGene = searchParams.get('gene') ?? ''
    const urlQuery = searchParams.get('q') ?? ''
    const urlCategory = searchParams.get('category') ?? ''
    setQuery(urlQuery || urlGene)
    setSelectedSymbol(urlGene || urlQuery || null)
    setCategory(urlCategory || undefined)
  }, [searchParams])

  useEffect(() => {
    if (selectedGeneSymbol && selectedGeneSymbol !== selectedSymbol) {
      setSelectedSymbol(selectedGeneSymbol)
    }
  }, [selectedGeneSymbol, selectedSymbol])

  useEffect(() => {
    const nextCategory = selectedCategory ?? undefined
    if (nextCategory !== category) {
      setCategory(nextCategory)
    }
  }, [category, selectedCategory])

  useEffect(() => {
    setPage(1)
    setAllGenes([])
    setLoading(true)
    setError(null)
    getGenes({
      q: query || undefined,
      category,
      mechanistic: mechanisticFilter,
      page: 1,
      page_size: PAGE_SIZE,
    })
      .then((data) => {
        setAllGenes(data.genes)
        setTotal(data.total)
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [query, category, mechanisticFilter])

  const loadMore = useCallback(() => {
    if (loadingMore || allGenes.length >= total) return
    const nextPage = page + 1
    setLoadingMore(true)
    getGenes({
      q: query || undefined,
      category,
      mechanistic: mechanisticFilter,
      page: nextPage,
      page_size: PAGE_SIZE,
    })
      .then((data) => {
        setAllGenes((prev) => [...prev, ...data.genes])
        setPage(nextPage)
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false))
  }, [loadingMore, allGenes.length, total, page, query, category, mechanisticFilter])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const handler = () => {
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 300) {
        loadMore()
      }
    }
    el.addEventListener('scroll', handler)
    return () => el.removeEventListener('scroll', handler)
  }, [loadMore])

  const handleSelectGene = (gene: Gene) => {
    const nextGene = gene.symbol === selectedSymbol ? null : gene.symbol
    setSelectedSymbol(nextGene)
    setSelectedGene(nextGene)
  }

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  const sortedGenes = useMemo(() => {
    return [...allGenes].sort((a, b) => {
      let cmp = 0
      switch (sortKey) {
        case 'symbol':
          cmp = (a.symbol || '').localeCompare(b.symbol || '')
          break
        case 'category':
          cmp = (a.category || '').localeCompare(b.category || '')
          break
        case 'left_end_pos':
          cmp = (a.left_end_pos ?? 0) - (b.left_end_pos ?? 0)
          break
        case 'ko_index':
          cmp = (a.ko_index ?? 0) - (b.ko_index ?? 0)
          break
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [allGenes, sortKey, sortDir])

  const mechCount = useMemo(() => {
    const mechCats = new Set([
      'amino_acid_biosynthesis', 'transport', 'cofactor_biosynthesis',
      'regulation', 'trna', 'translation', 'central_carbon',
      'dna_replication', 'energy', 'lipid_metabolism', 'rrna',
      'cell_division', 'transcription', 'nucleotide_metabolism',
      'cell_envelope', 'stress_response', 'motility',
    ])
    return categories.filter((c) => mechCats.has(c.category)).reduce((s, c) => s + c.count, 0)
  }, [categories])

  const totalCount = categories.reduce((s, c) => s + c.count, 0)

  return (
    <div className={`flex gap-4 ${heightClass ?? (embedded ? 'h-[calc(100vh-215px)] min-h-[520px]' : 'h-[calc(100vh-65px)]')}`}>
      <div className="flex-1 flex flex-col min-w-0 max-w-6xl mx-auto">
        <div className="flex items-center gap-2 flex-wrap mb-3">
          <FilterChip
            label={`All ${totalCount.toLocaleString()}`}
            active={!category && mechanisticFilter === undefined}
            onClick={() => {
              setCategory(undefined)
              setMechanisticFilter(undefined)
              setSelectedCategory(null)
            }}
          />
          <FilterChip
            label={`Mechanistic ${mechCount.toLocaleString()}`}
            active={mechanisticFilter === true}
            dotColor="bg-emerald-400"
            onClick={() => {
              setCategory(undefined)
              setMechanisticFilter(mechanisticFilter === true ? undefined : true)
              setSelectedCategory(null)
            }}
          />
          <FilterChip
            label={`Expression ${(totalCount - mechCount).toLocaleString()}`}
            active={mechanisticFilter === false}
            dotColor="bg-gray-300"
            onClick={() => {
              setCategory(undefined)
              setMechanisticFilter(mechanisticFilter === false ? undefined : false)
              setSelectedCategory(null)
            }}
          />

          <div className="relative ml-2">
            <select
              value={category ?? ''}
              onChange={(e) => {
                const val = e.target.value || undefined
                setCategory(val)
                setMechanisticFilter(undefined)
                setSelectedCategory(val ?? null)
              }}
              className="appearance-none bg-white border border-gray-200 rounded-full px-3 py-1.5 pr-7 text-xs text-gray-600 cursor-pointer hover:border-gray-300 focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <option value="">Category...</option>
              {categories.map((cat) => (
                <option key={cat.category} value={cat.category}>
                  {categoryLabel(cat.category)} ({cat.count})
                </option>
              ))}
            </select>
            <span className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-gray-400 text-xs">
              v
            </span>
          </div>
        </div>

        <div className="flex items-center gap-4 mb-4">
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder="Search genes by symbol, synonym, or ID... (press /)"
            className="flex-1 max-w-lg"
          />
          <span className="text-sm text-gray-400">
            {total.toLocaleString()} result{total !== 1 ? 's' : ''}
            {category ? ' in ' : ''}
            {category ? <strong className="text-gray-600">{categoryLabel(category)}</strong> : null}
            {mechanisticFilter === true ? ' (mechanistic only)' : ''}
            {mechanisticFilter === false ? ' (expression-only)' : ''}
          </span>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm mb-4">
            {'Failed to load genes: ' + error}
          </div>
        )}

        <div ref={scrollRef} className="flex-1 overflow-auto rounded-lg border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-gray-50 border-b border-gray-200 z-10">
              <tr>
                <SortHeader sortKey="symbol" activeKey={sortKey} sortDir={sortDir} onClick={toggleSort} className="w-28 text-left">
                  Gene
                </SortHeader>
                <SortHeader sortKey="category" activeKey={sortKey} sortDir={sortDir} onClick={toggleSort} className="text-left">
                  Category
                </SortHeader>
                <SortHeader sortKey="left_end_pos" activeKey={sortKey} sortDir={sortDir} onClick={toggleSort} className="w-36 text-right">
                  Position
                </SortHeader>
                <th className="px-4 py-2.5 font-medium text-gray-500 w-24 text-left">
                  Essentiality
                </th>
                <SortHeader sortKey="ko_index" activeKey={sortKey} sortDir={sortDir} onClick={toggleSort} className="w-16 text-right">
                  KO #
                </SortHeader>
                <th className="px-4 py-2.5 w-8" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <SkeletonTableRows rows={20} cols={6} />
              ) : sortedGenes.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-12 text-gray-400">
                    No genes match your search.
                  </td>
                </tr>
              ) : (
                sortedGenes.map((gene) => {
                  const length = gene.left_end_pos && gene.right_end_pos
                    ? Math.abs(gene.right_end_pos - gene.left_end_pos) + 1
                    : null
                  return (
                    <tr
                      key={gene.id}
                      onClick={() => handleSelectGene(gene)}
                      className={'cursor-pointer transition-colors ' + (
                        gene.symbol === selectedSymbol
                          ? 'bg-brand-50'
                          : 'hover:bg-gray-50'
                      )}
                    >
                      <td className="px-4 py-2">
                        <span className="font-mono font-medium text-bio-gene">{gene.symbol}</span>
                        {gene.is_mechanistic && (
                          <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 ml-1.5 align-middle" title="Mechanistic" />
                        )}
                      </td>
                      <td className="px-4 py-2">
                        <CategoryBadge label={gene.category} />
                      </td>
                      <td className="px-4 py-2 text-right">
                        <span className="font-mono text-xs text-gray-500">
                          {gene.left_end_pos && gene.right_end_pos
                            ? `${gene.left_end_pos.toLocaleString()}-${gene.right_end_pos.toLocaleString()}`
                            : '-'}
                        </span>
                        {length && (
                          <p className="text-[10px] text-gray-400 mt-0.5">
                            {gene.direction === '+' ? '-> fwd' : '<- rev'} - {length.toLocaleString()} bp
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        <PhenotypeBadge symbol={gene.symbol} phenotypeMap={phenotypeMap} />
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-gray-500">
                        {gene.ko_index}
                      </td>
                      <td className="px-4 py-2" />
                    </tr>
                  )
                })
              )}
              {loadingMore && (
                <tr>
                  <td colSpan={6} className="text-center py-4">
                    <div className="inline-flex items-center gap-2 text-sm text-gray-400">
                      <div className="w-4 h-4 border-2 border-brand-500 border-t-transparent rounded-full animate-spin"></div>
                      Loading more...
                    </div>
                  </td>
                </tr>
              )}
              {!loading && !loadingMore && allGenes.length < total && (
                <tr>
                  <td colSpan={6} className="text-center py-3 text-xs text-gray-400">
                    {'Showing ' + allGenes.length.toLocaleString() + ' of ' + total.toLocaleString() + ' - scroll for more'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {!hideDetailPanel && selectedGeneDetail && (
        <GeneDetailPanel
          gene={selectedGeneDetail}
          koSummary={phenotypeMap.get(selectedGeneDetail.symbol)}
          onClose={() => {
            setSelectedSymbol(null)
            setSelectedGene(null)
          }}
        />
      )}
      {!hideDetailPanel && detailLoading && selectedSymbol && (
        <div className="border-l border-gray-200 bg-white w-[420px] flex-shrink-0 flex items-center justify-center">
          <div className="w-6 h-6 border-2 border-brand-500 border-t-transparent rounded-full animate-spin"></div>
        </div>
      )}
    </div>
  )
}

function SortHeader({
  sortKey,
  activeKey,
  sortDir,
  onClick,
  className,
  children,
}: {
  sortKey: SortKey
  activeKey: SortKey
  sortDir: SortDir
  onClick: (key: SortKey) => void
  className: string
  children: ReactNode
}) {
  return (
    <th
      onClick={() => onClick(sortKey)}
      className={'px-4 py-2.5 font-medium text-gray-500 select-none cursor-pointer hover:text-gray-700 transition-colors ' + className}
    >
      {children}
      <span className="ml-1 text-xs">
        {activeKey === sortKey ? (sortDir === 'asc' ? '^' : 'v') : ''}
      </span>
    </th>
  )
}
