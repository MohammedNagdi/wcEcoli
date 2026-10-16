import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useLocation } from 'react-router-dom'
import { useRegisterAssistantContext } from '../assistant/AssistantProvider'
import { getAllGenes } from '../../api/client'
import type { Gene } from '../../types'
import { CATEGORY_FILL, GENOME_LENGTH, hasGenomePosition } from '../../utils/genome'
import { categoryLabel } from '../../utils/labels'
import { SearchInput } from '../common/SearchInput'
import { CategoryBadge, DirectionBadge } from '../common/Badge'
import { GenomeContextRail } from '../genes/GenomeContextRail'
import { useGeneDetail } from '../../hooks/useGenes'
import { useUrlWorkspaceState } from '../../hooks/useUrlWorkspaceState'
import {
  CircularGenomeMap,
  matchesGenomeSearch,
  type GenomeFocusRequest,
} from './CircularGenomeMap'
import {
  ASSISTANT_GENE_SAMPLE_LIMIT,
  makeAssistantContextKey,
  summarizeGene,
  truncateText,
} from '../../utils/assistantContext'
import { useTheme } from '../theme/ThemeProvider'
import { WorkspaceHelp, WORKSPACE_HELP } from '../workspace/WorkspaceHelp'
import { WorkspaceDisclosure } from '../workspace/WorkspaceDisclosure'
import { useMediaQuery } from '../workspace/useMediaQuery'
import '../../styles/genome.css'

interface CategorySummary {
  category: string
  count: number
}
interface GenomeViewerPageProps {
  embedded?: boolean
  compact?: boolean
  onAssistantSnapshot?: (snapshot: Record<string, unknown>) => void
}

export function GenomeViewerPage({
  embedded = false,
  compact = false,
  onAssistantSnapshot,
}: GenomeViewerPageProps) {
  const location = useLocation()
  const { resolvedTheme } = useTheme()
  const {
    selectedGene,
    setSelectedGene,
    genomeSearch,
    setGenomeSearch,
    genomeHighlight,
    setGenomeHighlight,
  } = useUrlWorkspaceState()
  const {
    gene: detail,
    loading: detailLoading,
    error: detailError,
    notFound,
    retry: retryDetail,
  } = useGeneDetail(selectedGene)
  const [genes, setGenes] = useState<Gene[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [tab, setTab] = useState<'details' | 'legend'>('details')
  const [categoriesOpen, setCategoriesOpen] = useState(false)
  const narrow = useMediaQuery('(max-width: 1099px)')
  const categoryTriggerRef = useRef<HTMLButtonElement>(null)
  const categoryPopoverRef = useRef<HTMLDivElement>(null)
  const inspectorRef = useRef<HTMLElement>(null)
  const mapPanelRef = useRef<HTMLElement>(null)
  const [categoryPosition, setCategoryPosition] = useState({ left: 12, top: 12, width: 0, maxHeight: 0 })
  useLayoutEffect(() => {
    if (!categoriesOpen) return
    const position = () => {
      const rect = categoryTriggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(520, window.innerWidth - 24)
      const below = window.innerHeight - rect.bottom - 20
      const above = rect.top - 20
      const openBelow = below >= 160 || below >= above
      const maxHeight = Math.min(320, window.innerHeight - 24, Math.max(80, openBelow ? below : above))
      const contentHeight = categoryPopoverRef.current?.firstElementChild?.scrollHeight
      const height = Math.min(maxHeight, contentHeight != null ? contentHeight + 2 : maxHeight)
      setCategoryPosition({
        left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)),
        top: Math.max(12, Math.min(openBelow ? rect.bottom + 8 : rect.top - 8 - height, window.innerHeight - height - 12)),
        width,
        maxHeight,
      })
    }
    const dismiss = (event: PointerEvent) => {
      if (!categoryPopoverRef.current?.contains(event.target as Node) &&
          !categoryTriggerRef.current?.contains(event.target as Node)) setCategoriesOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      event.stopPropagation()
      setCategoriesOpen(false)
      categoryTriggerRef.current?.focus({ preventScroll: true })
    }
    position()
    const observer = new ResizeObserver(position)
    if (categoryPopoverRef.current?.firstElementChild) observer.observe(categoryPopoverRef.current.firstElementChild)
    const focusFrame = requestAnimationFrame(() => {
      categoryPopoverRef.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
    })
    window.addEventListener('resize', position)
    document.addEventListener('scroll', position, true)
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape, true)
    return () => {
      cancelAnimationFrame(focusFrame)
      observer.disconnect()
      window.removeEventListener('resize', position)
      document.removeEventListener('scroll', position, true)
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', escape, true)
    }
  }, [categoriesOpen])
  const initialGene = useRef(
    new URLSearchParams(location.search).get('gene') ??
      new URLSearchParams(location.search).get('q'),
  ).current
  const [focusRequest, setFocusRequest] = useState<GenomeFocusRequest | null>(() =>
    initialGene ? { symbol: initialGene, sequence: 0 } : null,
  )
  const darkMode = resolvedTheme === 'dark'
  const showStats = tab === 'legend'
  const assistantCapturedAt = useRef(new Date().toISOString()).current
  const highlightedCategories = useMemo(() => new Set(genomeHighlight ?? []), [genomeHighlight])
  const mapSearchTerm = genomeSearch ?? ''
  const mappedGenes = useMemo(() => genes.filter(hasGenomePosition), [genes])
  const forwardCount = useMemo(
    () => mappedGenes.filter((gene) => gene.direction === '+').length,
    [mappedGenes],
  )
  const reverseCount = useMemo(
    () => mappedGenes.filter((gene) => gene.direction === '-').length,
    [mappedGenes],
  )
  const matches = useMemo(
    () =>
      genes
        .filter((gene) => matchesGenomeSearch(gene, mapSearchTerm))
        .sort((a, b) => a.symbol.localeCompare(b.symbol)),
    [genes, mapSearchTerm],
  )
  const categorySummary = useMemo<CategorySummary[]>(() => {
    const counts = new Map<string, number>()
    for (const gene of mappedGenes) counts.set(gene.category, (counts.get(gene.category) ?? 0) + 1)
    return Array.from(counts, ([category, count]) => ({ category, count })).sort(
      (a, b) => b.count - a.count,
    )
  }, [mappedGenes])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    setGenes([])
    getAllGenes((batch) => {
      if (!controller.signal.aborted) setGenes((current) => [...current, ...batch])
    }, controller.signal)
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [attempt])
  useEffect(() => {
    if (selectedGene) setTab('details')
  }, [selectedGene])
  const assistantPageState = useMemo(() => {
    const normalizedSearch = mapSearchTerm.trim().toLowerCase()
    const selectedGeneSummary = selectedGene
      ? (genes.find((gene) => gene.symbol.toLowerCase() === selectedGene.toLowerCase()) ?? null)
      : null
    const sortedMappedGenes = [...mappedGenes].sort(
      (a, b) => (a.left_end_pos ?? 0) - (b.left_end_pos ?? 0),
    )
    const selectedIndex = selectedGeneSummary
      ? sortedMappedGenes.findIndex(
          (gene) => gene.symbol.toLowerCase() === selectedGeneSummary.symbol.toLowerCase(),
        )
      : -1
    const nearbySample =
      selectedIndex >= 0
        ? sortedMappedGenes
            .slice(Math.max(0, selectedIndex - 12), selectedIndex + 13)
            .map(summarizeGene)
        : []
    const searchMatches = normalizedSearch
      ? genes
          .filter(
            (gene) =>
              gene.symbol.toLowerCase().includes(normalizedSearch) ||
              gene.ecoli_id.toLowerCase().includes(normalizedSearch) ||
              gene.synonyms.toLowerCase().includes(normalizedSearch),
          )
          .slice(0, ASSISTANT_GENE_SAMPLE_LIMIT)
          .map(summarizeGene)
      : []
    return {
      kind: 'genome_map',
      surface: 'genome',
      summary: `Genome map with ${mappedGenes.length} mapped genes, ${highlightedCategories.size} highlighted category${highlightedCategories.size === 1 ? '' : 'ies'}, and ${selectedGene || mapSearchTerm ? 'a selected/search focus' : 'no active focus'}.`,
      dirty: false,
      captured_at: assistantCapturedAt,
      route: `${location.pathname}${location.search}`,
      embedded,
      compact,
      selected_gene: selectedGene,
      search_term: genomeSearch ?? '',
      map_search_term: mapSearchTerm,
      highlighted_categories: Array.from(highlightedCategories),
      controls: {
        dark_mode: darkMode,
        stats_visible: showStats && !embedded,
      },
      loading,
      error: truncateText(error),
      counts: {
        genes: genes.length,
        mapped: mappedGenes.length,
        unmapped: genes.length - mappedGenes.length,
        forward_strand: forwardCount,
        reverse_strand: reverseCount,
      },
      selected_gene_summary: summarizeGene(selectedGeneSummary),
      nearby_gene_sample: nearbySample,
      nearby_gene_sample_truncated:
        selectedIndex >= 0 && sortedMappedGenes.length > nearbySample.length,
      search_match_sample: searchMatches,
      search_match_sample_truncated: normalizedSearch
        ? genes.filter(
            (gene) =>
              gene.symbol.toLowerCase().includes(normalizedSearch) ||
              gene.ecoli_id.toLowerCase().includes(normalizedSearch) ||
              gene.synonyms.toLowerCase().includes(normalizedSearch),
          ).length > searchMatches.length
        : false,
      category_summary_sample: categorySummary
        .slice(0, ASSISTANT_GENE_SAMPLE_LIMIT)
        .map((item) => ({
          category: item.category,
          label: categoryLabel(item.category),
          count: item.count,
        })),
      category_summary_truncated: categorySummary.length > ASSISTANT_GENE_SAMPLE_LIMIT,
    }
  }, [
    categorySummary,
    assistantCapturedAt,
    compact,
    darkMode,
    embedded,
    error,
    forwardCount,
    genes,
    genomeSearch,
    highlightedCategories,
    loading,
    location.pathname,
    location.search,
    mapSearchTerm,
    mappedGenes,
    reverseCount,
    selectedGene,
    showStats,
  ])

  useEffect(() => {
    onAssistantSnapshot?.(assistantPageState)
  }, [assistantPageState, onAssistantSnapshot])

  useRegisterAssistantContext({
    enabled: !embedded,
    contextKey: makeAssistantContextKey([
      'genome_map',
      location.pathname,
      location.search,
      selectedGene,
      mapSearchTerm,
      Array.from(highlightedCategories).join(','),
      showStats,
      darkMode,
      mappedGenes.length,
      genes.length - mappedGenes.length,
    ]),
    context: {
      assistant_surface: 'genome',
      route: `${location.pathname}${location.search}`,
      selected_gene: selectedGene || mapSearchTerm || null,
      page_state: assistantPageState,
    },
    suggestedPrompt:
      'Help me interpret the genome map. Focus on the selected gene or search term, visible functional-category highlights, genomic position, and what linked Workspace or Network views would clarify next.',
  })

  const selectGene = (symbol: string) => {
    setTab('details')
    setSelectedGene(symbol)
  }
  const focusSelected = () => {
    if (selectedGene)
      setFocusRequest((current) => ({
        symbol: detail?.symbol ?? selectedGene,
        sequence: (current?.sequence ?? 0) + 1,
      }))
  }
  const selectedMapped = detail
    ? hasGenomePosition(detail)
    : mappedGenes.some((gene) => gene.symbol.toLowerCase() === selectedGene?.toLowerCase())
  const coordinate = (value: number | null) => (value == null ? '—' : value.toLocaleString())
  return (
    <div
      className={`genome-page ${embedded ? 'genome-embedded' : ''} ${compact ? 'genome-compact' : ''}`}
    >
      {!embedded && (
        <header className="workspace-page-header">
          <div>
            <h1>Genome Map</h1>
            <p>Explore chromosome positions, functional categories, and neighboring genes.</p>
          </div>
          <Link to="/guide" className="workspace-guide-link">
            Guide <span aria-hidden="true">↗</span>
          </Link>
        </header>
      )}
      <div className="genome-toolbar">
        <div className="genome-search">
          <label htmlFor="genome-search">
            Search genes{' '}
            <span className="workspace-search-shortcut">
              Press <kbd>/</kbd> to search
            </span>
          </label>
          <SearchInput
            id="genome-search"
            label="Search genome genes"
            value={mapSearchTerm}
            onChange={setGenomeSearch}
            placeholder="Symbol, synonym, or identifier"
          />
        </div>
        <div className="genome-category-actions">
          <button
            ref={categoryTriggerRef}
            type="button"
            className="workspace-secondary-button"
            aria-expanded={categoriesOpen}
            aria-controls="genome-category-options"
            onClick={() => setCategoriesOpen((current) => !current)}
          >
            Highlight categories
            {highlightedCategories.size > 0 && ` (${highlightedCategories.size})`}
          </button>
          {highlightedCategories.size > 0 && (
            <button
              type="button"
              className="genome-quiet-button"
              onClick={() => setGenomeHighlight([])}
            >
              Clear highlights
            </button>
          )}
        </div>
        <p>Highlights emphasize genes; all genes remain on the map.</p>
      </div>
      {categoriesOpen && createPortal(
        <div ref={categoryPopoverRef} className="genome-page genome-popover-root" style={{
          left: categoryPosition.left, top: categoryPosition.top, width: categoryPosition.width,
          visibility: categoryPosition.width ? 'visible' : 'hidden',
        }}>
        <div
          id="genome-category-options"
          className="genome-category-options"
          role="group"
          aria-label="Category highlights"
          tabIndex={0}
          style={{ maxHeight: categoryPosition.maxHeight }}
        >
          {categorySummary.map(({ category, count }) => (
            <button
              type="button"
              key={category}
              aria-pressed={highlightedCategories.has(category)}
              onClick={() => {
                const next = new Set(highlightedCategories)
                if (next.has(category)) next.delete(category)
                else next.add(category)
                setGenomeHighlight([...next])
              }}
            >
              <span
                style={{ background: CATEGORY_FILL[category] ?? CATEGORY_FILL.other }}
                aria-hidden="true"
              />
              {categoryLabel(category)} <span className="font-mono">{count}</span>
            </button>
          ))}
          {!categorySummary.length && <p>Categories will appear as genome data loads.</p>}
        </div>
        </div>, document.body,
      )}
      {mapSearchTerm && (
        <section className="genome-search-results" aria-label="Gene search results">
          <div className="genome-results-heading">
            <p role="status">
              {matches.length} {loading || error ? 'provisional ' : ''}match
              {matches.length === 1 ? '' : 'es'}
              {loading && ' · Loading remaining genes…'}
            </p>
            <button
              type="button"
              className="genome-quiet-button"
              onClick={() => setGenomeSearch(null)}
            >
              Clear search
            </button>
          </div>
          <div className="genome-results-list" role="region" aria-label="Matching genome genes" tabIndex={0}>
            {matches.map((gene) => (
              <button
                type="button"
                key={gene.id}
                aria-label={`Inspect ${gene.symbol} on map`}
                aria-pressed={gene.symbol === selectedGene}
                onClick={() => selectGene(gene.symbol)}
              >
                <strong className="font-mono">{gene.symbol}</strong>
                <span className="font-mono">{gene.ecoli_id}</span>
                <span>
                  {hasGenomePosition(gene)
                    ? `${coordinate(gene.left_end_pos)}–${coordinate(gene.right_end_pos)} bp`
                    : 'No mapped coordinates'}
                </span>
              </button>
            ))}
            {!matches.length && (
              <p>
                {loading
                  ? 'Searching loaded genes while the genome loads…'
                  : error
                    ? 'No matches in the loaded data. Retry to complete the search.'
                    : 'No matching genes. Try a symbol, synonym, or identifier.'}
              </p>
            )}
          </div>
        </section>
      )}
      <div className="genome-load-status">
        {loading && (
          <p role="status">
            {genes.length
              ? `Loading genome… ${genes.length.toLocaleString()} genes loaded; counts are provisional.`
              : 'Loading genome data…'}
          </p>
        )}
        {!loading && !error && (
          <p>
            {mappedGenes.length.toLocaleString()} mapped genes ·{' '}
            {(GENOME_LENGTH / 1_000_000).toFixed(2)} Mbp · E. coli K-12 MG1655
          </p>
        )}
        {error && (
          <div role="alert">
            <p>
              {genes.length ? 'Only part of the genome loaded.' : 'Unable to load genome data.'}{' '}
              Counts and search results may be incomplete.
            </p>
            <button
              type="button"
              className="workspace-secondary-button"
              onClick={() => setAttempt((current) => current + 1)}
            >
              Retry genome data
            </button>
          </div>
        )}
        {!loading && !error && !genes.length && <p>No genome genes are available.</p>}
      </div>
      <div className="genome-layout">
        <section ref={mapPanelRef} className="genome-canvas-panel" aria-label="Chromosome visualization">
          <CircularGenomeMap
            genes={mappedGenes}
            searchTerm={mapSearchTerm}
            highlightedCategories={highlightedCategories}
            selectedGene={detail?.symbol ?? selectedGene}
            focusRequest={focusRequest}
            onSelectGene={selectGene}
            compact={compact}
            darkMode={darkMode}
            onViewDetails={narrow && selectedGene ? () => {
              setTab('details')
              inspectorRef.current?.focus({ preventScroll: true })
              inspectorRef.current?.scrollIntoView({ block: 'start', behavior: 'instant' })
            } : undefined}
          />
        </section>
        <aside ref={inspectorRef} tabIndex={-1} className="genome-inspector" aria-label="Genome inspector">
          {narrow && selectedGene && (
            <div className="genome-inspector-navigation">
              <button type="button" className="workspace-secondary-button" onClick={() => {
                const frame = mapPanelRef.current?.querySelector<HTMLElement>('.genome-map-frame')
                frame?.focus({ preventScroll: true })
                mapPanelRef.current?.scrollIntoView({ block: 'start', behavior: 'instant' })
              }}>Back to map</button>
            </div>
          )}
          <div className="genome-inspector-tabs" role="tablist" aria-label="Genome information">
            {(['details', 'legend'] as const).map((value, index) => (
              <button
                type="button"
                key={value}
                id={`genome-tab-${value}`}
                role="tab"
                aria-selected={tab === value}
                aria-controls={`genome-panel-${value}`}
                tabIndex={tab === value ? 0 : -1}
                onClick={() => setTab(value)}
                onKeyDown={(event) => {
                  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                    event.preventDefault()
                    const next =
                      event.key === 'Home'
                        ? 'details'
                        : event.key === 'End'
                          ? 'legend'
                          : index === 0
                            ? 'legend'
                            : 'details'
                    setTab(next)
                    document.getElementById(`genome-tab-${next}`)?.focus()
                  }
                }}
              >
                {value === 'details' ? 'Gene details' : 'Legend & statistics'}
              </button>
            ))}
          </div>
          <div
            id="genome-panel-details"
            role="tabpanel"
            aria-labelledby="genome-tab-details"
            hidden={tab !== 'details'}
            className="genome-inspector-body"
            tabIndex={0}
          >
            {!selectedGene ? (
              <div className="genome-inspector-empty">
                <h2>Select a gene</h2>
                <p>
                  Click a gene on the chromosome or choose a search result to inspect its biological
                  context here.
                </p>
                <p>The map stays at your current position.</p>
              </div>
            ) : detailLoading ? (
              <div role="status">
                <h2 className="font-mono">{selectedGene}</h2>
                <p>Loading gene details…</p>
              </div>
            ) : detailError ? (
              <div role="alert">
                <h2>Unable to load {selectedGene}</h2>
                <p>Your map position is preserved.</p>
                <button type="button" className="workspace-secondary-button" onClick={retryDetail}>
                  Retry gene details
                </button>
              </div>
            ) : notFound || !detail ? (
              <div>
                <h2>Gene unavailable</h2>
                <p>No details found for {selectedGene}.</p>
                <button
                  type="button"
                  className="genome-quiet-button"
                  onClick={() => setSelectedGene(null)}
                >
                  Clear selection
                </button>
              </div>
            ) : (
              <div className="genome-gene-details" key={detail.symbol}>
                <header>
                  <span className="workspace-state-eyebrow">Selected gene</span>
                  <h2 className="font-mono">{detail.symbol}</h2>
                  <p className="font-mono">{detail.ecoli_id}</p>
                  {detail.monomer_name && <p>{detail.monomer_name}</p>}
                </header>
                <div className="genome-gene-actions">
                  <button
                    type="button"
                    className="workspace-secondary-button"
                    disabled={!selectedMapped}
                    onClick={focusSelected}
                  >
                    Focus gene
                  </button>
                  <Link
                    className="workspace-secondary-button"
                    to={`/explore?gene=${encodeURIComponent(detail.symbol)}`}
                  >
                    Open in workspace
                  </Link>
                  <Link
                    className="workspace-primary-button"
                    to={`/experiments/new?variant=gene_knockout&gene=${encodeURIComponent(detail.symbol)}`}
                  >
                    Design knockout
                  </Link>
                </div>
                {!selectedMapped && (
                  <p>This gene has no mapped coordinates. Its details are still available.</p>
                )}
                <dl className="genome-facts">
                  <div>
                    <dt>Category</dt>
                    <dd>
                      <CategoryBadge label={detail.category} />
                    </dd>
                  </div>
                  <div>
                    <dt>Strand</dt>
                    <dd>
                      {detail.direction ? <DirectionBadge direction={detail.direction} /> : '—'}
                    </dd>
                  </div>
                  <div>
                    <dt>Length</dt>
                    <dd>
                      {hasGenomePosition(detail)
                        ? `${(Math.abs(detail.right_end_pos - detail.left_end_pos) + 1).toLocaleString()} bp`
                        : '—'}
                    </dd>
                  </div>
                  <div>
                    <dt>
                      Knockout index{' '}
                      <WorkspaceHelp label="Knockout index">
                        {WORKSPACE_HELP.knockout}
                      </WorkspaceHelp>
                    </dt>
                    <dd className="font-mono">{detail.ko_index >= 0 ? detail.ko_index : '—'}</dd>
                  </div>
                  <div className="genome-position">
                    <dt>Position</dt>
                    <dd className="font-mono">
                      {hasGenomePosition(detail)
                        ? `${coordinate(detail.left_end_pos)}–${coordinate(detail.right_end_pos)} bp`
                        : '—'}
                    </dd>
                  </div>
                </dl>
                {selectedMapped && (
                  <div className="genome-neighbors"><GenomeContextRail
                    key={detail.symbol}
                    symbol={detail.symbol}
                    onSelectGene={selectGene}
                  /></div>
                )}
                <button
                  type="button"
                  className="genome-quiet-button"
                  onClick={() => setSelectedGene(null)}
                >
                  Clear selection
                </button>
              </div>
            )}
          </div>
          <div
            id="genome-panel-legend"
            role="tabpanel"
            aria-labelledby="genome-tab-legend"
            hidden={tab !== 'legend'}
            className="genome-inspector-body"
            tabIndex={0}
          >
            <GenomeLegend
              mappedCount={mappedGenes.length}
              forwardCount={forwardCount}
              reverseCount={reverseCount}
              unmappedCount={genes.length - mappedGenes.length}
              categorySummary={categorySummary}
              provisional={loading || Boolean(error)}
            />
          </div>
        </aside>
      </div>
    </div>
  )
}

function GenomeLegend({
  mappedCount,
  forwardCount,
  reverseCount,
  unmappedCount,
  categorySummary,
  provisional,
}: {
  mappedCount: number
  forwardCount: number
  reverseCount: number
  unmappedCount: number
  categorySummary: CategorySummary[]
  provisional: boolean
}) {
  const [statisticsOpen, setStatisticsOpen] = useState(true)
  return (
    <>
      <h2>Reading the chromosome</h2>
      <p>
        Outer track: forward (+) strand. Inner track: reverse (−) strand. Coordinate ticks are in
        Mbp; gene details use bp.
      </p>
      <p>
        Small gene glyphs are widened for readability. Use the inspector for exact positions and
        lengths.
      </p>
      <p>oriC marks the reference replication origin. ter is an approximate terminus marker.</p>
      <WorkspaceDisclosure
        title="Genome statistics"
        summary={
          provisional
            ? 'Provisional loaded-data counts'
            : `${mappedCount.toLocaleString()} mapped genes`
        }
        open={statisticsOpen}
        onToggle={() => setStatisticsOpen((current) => !current)}
      >
        <dl className="genome-facts">
          {[
            ['Mapped', mappedCount.toLocaleString()],
            ['Unmapped', unmappedCount.toLocaleString()],
            ['Forward', forwardCount.toLocaleString()],
            ['Reverse', reverseCount.toLocaleString()],
            ['Density', `${(mappedCount / (GENOME_LENGTH / 1_000_000)).toFixed(0)} / Mbp`],
            [
              'Forward strand share',
              `${forwardCount + reverseCount ? ((forwardCount / (forwardCount + reverseCount)) * 100).toFixed(1) : '0.0'}%`,
            ],
            ['Reference length', `${GENOME_LENGTH.toLocaleString()} bp`],
            ['Reference GC content', '50.8%'],
          ].map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd className="font-mono">{value}</dd>
            </div>
          ))}
        </dl>
      </WorkspaceDisclosure>
      <h3>Functional categories</h3>
      <p>Colours show biological categories; violet controls show selection.</p>
      <ul className="genome-category-legend">
        {categorySummary.map(({ category, count }) => (
          <li key={category}>
            <span
              className="genome-category-dot"
              style={{ background: CATEGORY_FILL[category] ?? CATEGORY_FILL.other }}
              aria-hidden="true"
            />
            <span>{categoryLabel(category)}</span>
            <span className="font-mono">{count}</span>
          </li>
        ))}
      </ul>
    </>
  )
}
