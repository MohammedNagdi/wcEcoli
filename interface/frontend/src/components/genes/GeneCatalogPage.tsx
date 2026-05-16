import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { useGeneDetail, useCategories } from '../../hooks/useGenes'
import { getGenes } from '../../api/client'
import { SearchInput } from '../common/SearchInput'
import { SkeletonTableRows } from '../common/Skeleton'
import { CategoryBadge, DirectionBadge } from '../common/Badge'
import { GeneDetailPanel } from './GeneDetailPanel'
import { HelpTip } from '../common/HelpTip'
import { categoryLabel } from '../../utils/labels'
import type { Gene } from '../../types'

type SortKey = 'symbol' | 'ecoli_id' | 'category' | 'direction' | 'left_end_pos' | 'ko_index' | 'is_mechanistic'
type SortDir = 'asc' | 'desc'

const PAGE_SIZE = 100

export function GeneCatalogPage() {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<string | undefined>()
  const [mechanisticFilter, setMechanisticFilter] = useState<boolean | undefined>()
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('symbol')
  const [sortDir, setSortDir] = useState<SortDir>('asc')

  // Infinite scroll state
  const [allGenes, setAllGenes] = useState<Gene[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const { gene: selectedGene, loading: detailLoading } = useGeneDetail(selectedSymbol)
  const categories = useCategories()

  // Reset and fetch page 1 when filters change
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

  // Load more pages
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

  // Infinite scroll handler
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
    setSelectedSymbol(gene.symbol === selectedSymbol ? null : gene.symbol)
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
        case 'ecoli_id':
          cmp = (a.ecoli_id || '').localeCompare(b.ecoli_id || '')
          break
        case 'category':
          cmp = (a.category || '').localeCompare(b.category || '')
          break
        case 'direction':
          cmp = (a.direction || '').localeCompare(b.direction || '')
          break
        case 'left_end_pos':
          cmp = (a.left_end_pos ?? 0) - (b.left_end_pos ?? 0)
          break
        case 'ko_index':
          cmp = (a.ko_index ?? 0) - (b.ko_index ?? 0)
          break
        case 'is_mechanistic':
          cmp = (a.is_mechanistic ? 1 : 0) - (b.is_mechanistic ? 1 : 0)
          break
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [allGenes, sortKey, sortDir])

  const mechCount = useMemo(() => {
    // Use sidebar categories to compute mechanistic count
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
    <div className="flex gap-6 h-[calc(100vh-65px)]">
      {/* Sidebar */}
      <aside className="w-56 flex-shrink-0 space-y-1 overflow-y-auto">
        <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wide px-2 mb-2 flex items-center gap-1">
          Categories
          <HelpTip text="Functional categories from the wcEcoli model. Categories like 'Metabolism' and 'Transcription regulation' contain genes with full mechanistic roles — their knockout directly alters simulated cell behavior. Other categories may contain genes that are tracked (transcribed and translated) but lack downstream mechanistic effects." position="right" />
        </h3>
        <button
          onClick={() => { setCategory(undefined); setMechanisticFilter(undefined) }}
          className={'w-full text-left px-3 py-1.5 rounded-md text-sm transition-colors ' + (
            !category && mechanisticFilter === undefined
              ? 'bg-brand-50 text-brand-700 font-medium'
              : 'text-gray-600 hover:bg-gray-50'
          )}
        >
          All genes
          <span className="float-right text-xs text-gray-400">{totalCount.toLocaleString()}</span>
        </button>

        {/* Mechanistic filter */}
        <button
          onClick={() => {
            setCategory(undefined)
            setMechanisticFilter(mechanisticFilter === true ? undefined : true)
          }}
          className={'w-full flex items-center justify-between px-3 py-1.5 rounded-md text-sm transition-colors ' + (
            mechanisticFilter === true
              ? 'bg-emerald-50 text-emerald-700 font-medium'
              : 'text-gray-600 hover:bg-gray-50'
          )}
        >
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-400 inline-block"></span>
            Mechanistic
          </span>
          <span className="text-xs text-gray-400">{mechCount.toLocaleString()}</span>
        </button>
        <button
          onClick={() => {
            setCategory(undefined)
            setMechanisticFilter(mechanisticFilter === false ? undefined : false)
          }}
          className={'w-full flex items-center justify-between px-3 py-1.5 rounded-md text-sm transition-colors ' + (
            mechanisticFilter === false
              ? 'bg-gray-100 text-gray-700 font-medium'
              : 'text-gray-600 hover:bg-gray-50'
          )}
        >
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-gray-300 inline-block"></span>
            Expression only
          </span>
          <span className="text-xs text-gray-400">{(totalCount - mechCount).toLocaleString()}</span>
        </button>

        <div className="border-t border-gray-100 my-2"></div>

        {categories.map((cat) => (
          <button
            key={cat.category}
            onClick={() => {
              setCategory(cat.category === category ? undefined : cat.category)
              setMechanisticFilter(undefined)
            }}
            className={'w-full text-left px-3 py-1.5 rounded-md text-sm transition-colors ' + (
              category === cat.category
                ? 'bg-brand-50 text-brand-700 font-medium'
                : 'text-gray-600 hover:bg-gray-50'
            )}
          >
            {categoryLabel(cat.category)}
            <span className="float-right text-xs text-gray-400">{cat.count}</span>
          </button>
        ))}
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Search + stats bar */}
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

        {/* Error state */}
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm mb-4">
            {'Failed to load genes: ' + error}
          </div>
        )}

        {/* Gene table with infinite scroll */}
        <div ref={scrollRef} className="flex-1 overflow-auto rounded-lg border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-gray-50 border-b border-gray-200 z-10">
              <tr>
                {([
                  ['symbol', 'Symbol', 'text-left w-28'],
                  ['is_mechanistic', 'Modeled', 'text-center w-20'],
                  ['ecoli_id', 'EcoCyc ID', 'text-left w-32'],
                  ['category', 'Category', 'text-left'],
                  ['direction', 'Strand', 'text-left w-20'],
                  ['left_end_pos', 'Position', 'text-right w-32'],
                  ['ko_index', 'KO #', 'text-right w-20'],
                ] as [SortKey, string, string][]).map(([key, label, cls]) => (
                  <th
                    key={key}
                    onClick={() => toggleSort(key)}
                    className={'px-4 py-2.5 font-medium text-gray-500 select-none cursor-pointer hover:text-gray-700 transition-colors ' + cls}
                  >
                    {label}
                    {key === 'is_mechanistic' && (
                      <HelpTip text="Whether this gene has mechanistic downstream effects in the wcEcoli model. 'Mechanistic' genes participate in metabolism, regulation, replication, etc. 'Expression-only' genes are transcribed and translated but their products don't feed into modeled processes." position="bottom" />
                    )}
                    <span className="ml-1 text-xs">
                      {sortKey === key ? (sortDir === 'asc' ? '▲' : '▼') : ''}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <SkeletonTableRows rows={20} cols={7} />
              ) : sortedGenes.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-center py-12 text-gray-400">
                    No genes match your search.
                  </td>
                </tr>
              ) : (
                sortedGenes.map((gene) => (
                  <tr
                    key={gene.id}
                    onClick={() => handleSelectGene(gene)}
                    className={'cursor-pointer transition-colors ' + (
                      gene.symbol === selectedSymbol
                        ? 'bg-brand-50'
                        : 'hover:bg-gray-50'
                    )}
                  >
                    <td className="px-4 py-2 font-mono font-medium text-bio-gene">
                      {gene.symbol}
                    </td>
                    <td className="px-4 py-2 text-center">
                      {gene.is_mechanistic ? (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                          yes
                        </span>
                      ) : (
                        <span className="text-gray-300 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">
                      <a
                        href={'https://ecocyc.org/gene?orgid=ECOLI&id=' + gene.ecoli_id}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="text-gray-500 hover:text-brand-600 hover:underline transition-colors"
                      >
                        {gene.ecoli_id}
                      </a>
                    </td>
                    <td className="px-4 py-2">
                      <CategoryBadge label={gene.category} />
                    </td>
                    <td className="px-4 py-2">
                      <DirectionBadge direction={gene.direction} />
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-xs text-gray-500">
                      {gene.left_end_pos && gene.right_end_pos
                        ? gene.left_end_pos.toLocaleString() + '–' + gene.right_end_pos.toLocaleString()
                        : '—'}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-xs text-gray-500">
                      {gene.ko_index}
                    </td>
                  </tr>
                ))
              )}
              {loadingMore && (
                <tr>
                  <td colSpan={7} className="text-center py-4">
                    <div className="inline-flex items-center gap-2 text-sm text-gray-400">
                      <div className="w-4 h-4 border-2 border-brand-500 border-t-transparent rounded-full animate-spin"></div>
                      Loading more...
                    </div>
                  </td>
                </tr>
              )}
              {!loading && !loadingMore && allGenes.length < total && (
                <tr>
                  <td colSpan={7} className="text-center py-3 text-xs text-gray-400">
                    {'Showing ' + allGenes.length.toLocaleString() + ' of ' + total.toLocaleString() + ' — scroll for more'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Detail panel */}
      {selectedGene && (
        <GeneDetailPanel
          gene={selectedGene}
          onClose={() => setSelectedSymbol(null)}
        />
      )}
      {detailLoading && selectedSymbol && (
        <div className="border-l border-gray-200 bg-white w-[420px] flex-shrink-0 flex items-center justify-center">
          <div className="w-6 h-6 border-2 border-brand-500 border-t-transparent rounded-full animate-spin"></div>
        </div>
      )}
    </div>
  )
}
