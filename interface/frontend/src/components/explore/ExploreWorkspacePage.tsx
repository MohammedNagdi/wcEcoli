import { Link, useLocation } from 'react-router-dom'
import {IS_EXPLORER} from '../../explorer/mode'
import {guideTopicHref} from '../../explorer/guideLinks'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent, ReactNode } from 'react'
import { GeneCatalogPage } from '../genes/GeneCatalogPage'
import { GenomeContextRail } from '../genes/GenomeContextRail'
import { TFNetworkMini } from '../genes/TFNetworkMini'
import { CategoryBadge, DirectionBadge } from '../common/Badge'
import { getAAPathways } from '../../api/client'
import { useGeneDetail } from '../../hooks/useGenes'
import { useUrlWorkspaceState } from '../../hooks/useUrlWorkspaceState'
import { useRegisterAssistantContext } from '@deployment/assistant'
import {
  ASSISTANT_PATHWAY_SAMPLE_LIMIT,
  makeAssistantContextKey,
  summarizeAAPathway,
  summarizeGeneDetail,
} from '../../utils/assistantContext'
import { WorkspaceHelp, WORKSPACE_HELP } from '../workspace/WorkspaceHelp'
import { WorkspaceDisclosure } from '../workspace/WorkspaceDisclosure'
import { useMediaQuery } from '../workspace/useMediaQuery'
import type { AAPathway, GeneDetail } from '../../types'

export function ExploreWorkspacePage() {
  const location = useLocation()
  const {
    selectedGene,
    selectedCategory,
    selectedCondition,
    setSelectedGene,
    setSelectedCategory,
    setSelectedCondition,
  } = useUrlWorkspaceState()
  const {
    gene: selectedGeneDetail,
    loading: detailLoading,
    error: detailError,
    notFound,
    retry,
  } = useGeneDetail(selectedGene)
  const [aaPathways, setAAPathways] = useState<AAPathway[]>([])
  const [pathwaysLoading, setPathwaysLoading] = useState(true)
  const [pathwaysError, setPathwaysError] = useState(false)
  const [pathwaysAttempt, setPathwaysAttempt] = useState(0)
  const [catalogAssistantSnapshot, setCatalogAssistantSnapshot] = useState<Record<
    string,
    unknown
  > | null>(null)
  const [leftPct, setLeftPct] = useState(55)
  const [isDragging, setIsDragging] = useState(false)
  const narrow = useMediaQuery('(max-width: 1099px)')
  const [activePane, setActivePane] = useState<'browse' | 'detail'>('browse')
  const [bounds, setBounds] = useState({ min: 30, max: 75 })
  const dragging = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const inspectorRef = useRef<HTMLElement>(null)
  const assistantCapturedAt = useRef(new Date().toISOString()).current

  const workspacePageState = useMemo(() => {
    const pathwayMatches = selectedGeneDetail
      ? pathwayMatchesForGene(selectedGeneDetail, aaPathways)
      : []
    return {
      kind: 'workspace_gene_explorer',
      surface: 'workspace',
      summary: selectedGene
        ? `Workspace focused on ${selectedGene} with gene catalog, model-state IDs, pathway context, genome context, and TF regulation context.`
        : 'Workspace gene explorer with catalog filters and linked biological context panels.',
      dirty: false,
      captured_at: assistantCapturedAt,
      route: `${location.pathname}${location.search}`,
      selected_gene: selectedGene,
      selected_category: selectedCategory,
      selected_condition: selectedCondition,
      split_pane: {
        left_percent: Math.round(leftPct),
        dragging: isDragging,
      },
      selected_gene_detail_loading: detailLoading,
      selected_gene_detail: summarizeGeneDetail(selectedGeneDetail),
      pathway_context: {
        loading: pathwaysLoading,
        unavailable: pathwaysError,
        loaded_pathways: aaPathways.length,
        selected_gene_match_count: pathwaysLoading || pathwaysError ? null : pathwayMatches.length,
        selected_gene_matches: pathwayMatches
          .slice(0, ASSISTANT_PATHWAY_SAMPLE_LIMIT)
          .map((match) => ({
            role: match.role,
            evidence: match.evidence.slice(0, 8),
            evidence_truncated: match.evidence.length > 8,
            pathway: summarizeAAPathway(match.pathway),
          })),
        selected_gene_matches_truncated: pathwayMatches.length > ASSISTANT_PATHWAY_SAMPLE_LIMIT,
      },
      embedded_gene_catalog: catalogAssistantSnapshot,
    }
  }, [
    aaPathways,
    pathwaysLoading,
    pathwaysError,
    assistantCapturedAt,
    catalogAssistantSnapshot,
    detailLoading,
    isDragging,
    leftPct,
    location.pathname,
    location.search,
    selectedCategory,
    selectedCondition,
    selectedGene,
    selectedGeneDetail,
  ])

  useRegisterAssistantContext({
    contextKey: makeAssistantContextKey([
      'workspace_gene_explorer',
      location.pathname,
      location.search,
      selectedGene,
      selectedCategory,
      selectedCondition,
      Boolean(selectedGeneDetail),
      Boolean(catalogAssistantSnapshot),
      Math.round(leftPct),
      isDragging,
    ]),
    context: {
      assistant_surface: 'workspace',
      route: `${location.pathname}${location.search}`,
      selected_gene: selectedGene,
      selected_condition: selectedCondition,
      page_state: workspacePageState,
    },
    suggestedPrompt:
      'Help me inspect this selected gene. Summarize its model state IDs, pathway context, regulation, and which experiment or result views would be useful next.',
  })

  useEffect(() => {
    let mounted = true
    setPathwaysLoading(true)
    setPathwaysError(false)
    getAAPathways()
      .then((pathways) => {
        if (mounted) setAAPathways(pathways)
      })
      .catch(() => {
        if (mounted) setPathwaysError(true)
      })
      .finally(() => {
        if (mounted) setPathwaysLoading(false)
      })
    return () => {
      mounted = false
    }
  }, [pathwaysAttempt])

  useEffect(() => {
    if (selectedGene) setActivePane('detail')
  }, [selectedGene])

  useEffect(() => {
    if (narrow && activePane === 'detail' && selectedGene) {
      inspectorRef.current?.focus({ preventScroll: true })
    }
  }, [narrow, activePane, selectedGene])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const update = () => {
      if (narrow) return
      const width = container.clientWidth
      if (!width) return
      const min = (440 / width) * 100
      const max = ((width - 372) / width) * 100
      setBounds({ min, max })
      setLeftPct((value) => Math.max(min, Math.min(max, value)))
    }
    const observer = new ResizeObserver(update)
    observer.observe(container)
    update()
    return () => observer.disconnect()
  }, [narrow])

  const resize = (value: number) => setLeftPct(Math.max(bounds.min, Math.min(bounds.max, value)))
  const stopDragging = () => {
    dragging.current = false
    setIsDragging(false)
  }
  const handleDividerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current || !containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    resize(((event.clientX - rect.left) / rect.width) * 100)
  }

  return (
    <div className="gene-workspace" data-pane={activePane}>
      <header className="workspace-page-header">
        <div>
          <h1>Gene workspace</h1>
          <p>Find a gene, inspect its biological context, then design an experiment.</p>
        </div>
        <Link to={IS_EXPLORER?guideTopicHref('model-coverage'):'/guide'} className="workspace-guide-link">
          Guide <span aria-hidden="true">↗</span>
        </Link>
      </header>
      {(selectedCategory || selectedCondition) && (
        <div className="workspace-context" aria-label="Workspace context">
          <ContextChip
            label="Category"
            value={selectedCategory}
            onClear={() => setSelectedCategory(null)}
          />
          <ContextChip
            label="Experiment context"
            value={selectedCondition}
            onClear={() => setSelectedCondition(null)}
          />
        </div>
      )}
      {narrow && (
        <div className="workspace-pane-switch" role="group" aria-label="Workspace views">
          <button
            type="button"
            aria-pressed={activePane === 'browse'}
            onClick={() => setActivePane('browse')}
          >
            Browse genes
          </button>
          <button
            type="button"
            aria-pressed={activePane === 'detail'}
            onClick={() => setActivePane('detail')}
          >
            Selected gene{selectedGene && <span className="font-mono"> · {selectedGene}</span>}
          </button>
        </div>
      )}
      <div ref={containerRef} className="workspace-panels" data-dragging={isDragging}>
        <section
          aria-label="Gene catalog"
          className="workspace-catalog-panel"
          style={{ '--catalog-share': `${leftPct}%` } as CSSProperties}
          {...(narrow && activePane !== 'browse' ? { inert: '' } : {})}
        >
          <div className="workspace-catalog-heading">
            <h2>Gene catalog</h2>
            <span>E. coli K-12 MG1655</span>
          </div>
          <div className="workspace-catalog-body">
            <GeneCatalogPage
              embedded
              workspaceLayout
              visible={!narrow || activePane === 'browse'}
              hideDetailPanel
              heightClass="h-full min-h-0"
              showEssentiality={false}
              onAssistantSnapshot={setCatalogAssistantSnapshot}
            />
          </div>
        </section>
        {!narrow && (
          <div
            className="workspace-divider"
            role="separator"
            tabIndex={0}
            aria-label="Resize gene catalog"
            aria-orientation="vertical"
            aria-valuemin={Math.ceil(bounds.min)}
            aria-valuemax={Math.floor(bounds.max)}
            aria-valuenow={Math.round(leftPct)}
            aria-valuetext={`Gene catalog ${Math.round(leftPct)} percent`}
            onPointerDown={(event) => {
              event.preventDefault()
              event.currentTarget.focus()
              event.currentTarget.setPointerCapture(event.pointerId)
              dragging.current = true
              setIsDragging(true)
            }}
            onPointerMove={handleDividerMove}
            onPointerUp={stopDragging}
            onPointerCancel={stopDragging}
            onLostPointerCapture={stopDragging}
            onDoubleClick={() => resize(55)}
            onKeyDown={(event) => {
              if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                event.preventDefault()
                resize(
                  event.key === 'Home'
                    ? bounds.min
                    : event.key === 'End'
                      ? bounds.max
                      : leftPct + (event.key === 'ArrowRight' ? 2 : -2),
                )
              }
            }}
          >
            <span aria-hidden="true" />
          </div>
        )}
        <section
          ref={inspectorRef}
          tabIndex={-1}
          aria-label="Selected gene inspector"
          className="workspace-inspector-panel"
          {...(narrow && activePane !== 'detail' ? { inert: '' } : {})}
        >
          <SelectedGeneSummary
            gene={selectedGeneDetail}
            aaPathways={aaPathways}
            pathwaysLoading={pathwaysLoading}
            pathwaysError={pathwaysError}
            onRetryPathways={() => setPathwaysAttempt((value) => value + 1)}
            loading={detailLoading}
            error={detailError}
            notFound={notFound}
            onRetry={retry}
            selectedGene={selectedGene}
            onClear={() => setSelectedGene(null)}
            onSelectGene={(symbol) => setSelectedGene(symbol, { replace: false })}
          />
        </section>
      </div>
    </div>
  )
}

function SelectedGeneSummary({
  gene,
  aaPathways,
  pathwaysLoading,
  pathwaysError,
  onRetryPathways,
  loading,
  error,
  notFound,
  onRetry,
  selectedGene,
  onSelectGene,
  onClear,
}: {
  gene: GeneDetail | null
  aaPathways: AAPathway[]
  pathwaysLoading: boolean
  pathwaysError: boolean
  onRetryPathways: () => void
  loading: boolean
  error: string | null
  notFound: boolean
  onRetry: () => void
  selectedGene: string | null
  onSelectGene: (symbol: string) => void
  onClear: () => void
}) {
  const [sections, setSections] = useState({
    state: false,
    pathways: false,
    genome: true,
    regulation: false,
  })
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0, behavior: 'instant' })
  }, [selectedGene])
  const toggle = (key: keyof typeof sections) =>
    setSections((current) => ({ ...current, [key]: !current[key] }))

  if (loading && selectedGene)
    return (
      <div className="workspace-empty" role="status">
        <span className="workspace-state-eyebrow">Selected gene</span>
        <h2 className="font-mono">{selectedGene}</h2>
        <p>Loading gene details…</p>
        <div className="workspace-loading-placeholder" aria-hidden="true" />
      </div>
    )
  if (error)
    return (
      <div className="workspace-empty" role="alert">
        <span className="workspace-state-eyebrow">Request failed</span>
        <h2>Unable to load {selectedGene}</h2>
        <p>{error} Your catalog and filters are still available.</p>
        <button type="button" className="workspace-primary-button" onClick={onRetry}>
          Retry gene details
        </button>
      </div>
    )
  if (notFound)
    return (
      <div className="workspace-empty">
        <span className="workspace-state-eyebrow">Gene unavailable</span>
        <h2>No gene found for {selectedGene}</h2>
        <p>Check the symbol or identifier, or return to the catalog to choose a gene.</p>
        <button type="button" className="workspace-secondary-button" onClick={onClear}>
          Clear gene selection
        </button>
      </div>
    )
  if (!gene)
    return (
      <div className="workspace-empty">
        <span className="workspace-state-eyebrow">Start exploring</span>
        <h2>Every gene has a context.</h2>
        <p>
          Select a gene to inspect its products, model identifiers, neighboring genes, and
          regulation.
        </p>
        <button
          type="button"
          className="workspace-primary-button"
          onClick={() => onSelectGene('dnaA')}
        >
          Inspect dnaA <span aria-hidden="true">→</span>
        </button>
        <Link to={IS_EXPLORER?guideTopicHref('model-coverage'):'/guide'} className="workspace-guide-link">
          Learn how the model works
        </Link>
      </div>
    )

  const length =
    gene.left_end_pos != null && gene.right_end_pos != null
      ? Math.abs(gene.right_end_pos - gene.left_end_pos) + 1
      : null
  const matches = pathwayMatchesForGene(gene, aaPathways)
  const stateCount =
    parseJsonList(gene.rna_ids).length +
    Number(Boolean(gene.monomer_id)) +
    parseJsonList(gene.complex_ids).length +
    pathwayMetaboliteIds(gene, aaPathways).length
  const regulationCount = gene.regulated_by.length + gene.regulates.length
  return (
    <div className="workspace-inspector">
      <header className="workspace-inspector-header">
        <div className="workspace-gene-title">
          <span className="workspace-state-eyebrow">Selected gene</span>
          <h2 className="font-mono">{gene.symbol}</h2>
          <span className="font-mono workspace-gene-id">{gene.ecoli_id}</span>
        </div>
        {gene.monomer_name && <p className="workspace-product-description">{gene.monomer_name}</p>}
        <div className="workspace-inspector-actions">
          <Link
            to={'/experiments/new?variant=gene_knockout&gene=' + encodeURIComponent(gene.symbol)}
            className="workspace-primary-button"
          >
            Design knockout
          </Link>
          <Link
            to={'/genome?gene=' + encodeURIComponent(gene.symbol)}
            className="workspace-secondary-button"
          >
            Genome Map
          </Link>
        </div>
      </header>
      <div ref={scrollRef} className="workspace-inspector-scroll">
        <div className="workspace-inspector-content" key={gene.symbol}>
          <section className="workspace-overview" aria-label="Gene overview">
            <h3>Overview</h3>
            <div className="workspace-facts">
              <Fact label="Category">
                <CategoryBadge label={gene.category} />
              </Fact>
              <Fact
                label="Knockout index"
                help={
                  <WorkspaceHelp label="Knockout index" guideTopic="knockout-index">{WORKSPACE_HELP.knockout}</WorkspaceHelp>
                }
              >
                <span className="font-mono">
                  {gene.ko_index != null && gene.ko_index >= 0 ? gene.ko_index : '—'}
                </span>
              </Fact>
              <Fact label="Strand">
                <DirectionBadge direction={gene.direction} />
                {!gene.direction && '—'}
              </Fact>
              <Fact label="Length">{length != null ? `${length.toLocaleString()} bp` : '—'}</Fact>
              <Fact label="Position">
                <span className="font-mono">
                  {gene.left_end_pos != null && gene.right_end_pos != null
                    ? `${gene.left_end_pos.toLocaleString()}–${gene.right_end_pos.toLocaleString()} bp`
                    : '—'}
                </span>
              </Fact>
            </div>
          </section>
          <WorkspaceDisclosure
            title="Model state IDs"
            summary={`${stateCount} identifier${stateCount === 1 ? '' : 's'}`}
            open={sections.state}
            onToggle={() => toggle('state')}
            help={<WorkspaceHelp label="Model state IDs" guideTopic="model-state-ids">{WORKSPACE_HELP.state}</WorkspaceHelp>}
          >
            {stateCount ? (
              <ModelStateSection gene={gene} pathways={aaPathways} />
            ) : (
              <p className="workspace-section-empty">
                No model state identifiers are available for this gene.
              </p>
            )}
          </WorkspaceDisclosure>
          <WorkspaceDisclosure
            title="Pathways"
            summary={pathwaysLoading ? 'Loading pathways…' : pathwaysError ? 'Pathways unavailable' : `${matches.length} match${matches.length === 1 ? '' : 'es'}`}
            open={sections.pathways}
            onToggle={() => toggle('pathways')}
          >
            {pathwaysLoading ? (
              <p className="workspace-section-empty" role="status">Loading pathways…</p>
            ) : pathwaysError ? (
              <div className="workspace-pathway-error" role="alert">
                <p>Unable to load pathway annotations.</p>
                <button type="button" className="workspace-secondary-button" onClick={onRetryPathways}>
                  Retry pathways
                </button>
              </div>
            ) : matches.length ? (
              <PathwayContext gene={gene} pathways={aaPathways} />
            ) : (
              <p className="workspace-section-empty">
                No matching amino acid pathways were found in the loaded annotations.
              </p>
            )}
          </WorkspaceDisclosure>
          <WorkspaceDisclosure
            title="Genomic context"
            summary="Nearby genes · ±5,000 bp"
            open={sections.genome}
            onToggle={() => toggle('genome')}
          >
            {gene.left_end_pos != null ? (
              <div className="workspace-genome-context">
                <GenomeContextRail symbol={gene.symbol} window={5000} onSelectGene={onSelectGene} />
              </div>
            ) : (
              <p className="workspace-section-empty">
                Genomic coordinates are unavailable for this gene.
              </p>
            )}
          </WorkspaceDisclosure>
          <WorkspaceDisclosure
            title="Regulation"
            summary={`${gene.regulated_by.length} regulator${gene.regulated_by.length === 1 ? '' : 's'} · ${gene.regulates.length} target${gene.regulates.length === 1 ? '' : 's'}`}
            open={sections.regulation}
            onToggle={() => toggle('regulation')}
          >
            {regulationCount ? (
              <TFNetworkMini
                symbol={gene.symbol}
                focalCategory={gene.category}
                regulatedBy={gene.regulated_by.flatMap((edge) =>
                  edge.tf ? [{ symbol: edge.tf, log2fc: edge.log2fc, type: edge.type }] : [],
                )}
                regulates={gene.regulates.flatMap((edge) =>
                  edge.target
                    ? [{ symbol: edge.target, log2fc: edge.log2fc, type: edge.type }]
                    : [],
                )}
                onSelectGene={onSelectGene}
              />
            ) : (
              <p className="workspace-section-empty">
                No regulatory relationships are recorded for this gene.
              </p>
            )}
          </WorkspaceDisclosure>
        </div>
      </div>
    </div>
  )
}

interface PathwayMatch {
  pathway: AAPathway
  role: 'Forward' | 'Reverse' | 'Forward/reverse' | 'Annotated'
  evidence: string[]
}

function PathwayContext({ gene, pathways }: { gene: GeneDetail; pathways: AAPathway[] }) {
  const matches = useMemo(() => pathwayMatchesForGene(gene, pathways), [gene, pathways])

  if (matches.length === 0) return null

  return (
    <section className="mt-3 rounded-lg border border-amber-100 bg-amber-50/50 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-amber-900">
          Pathway context
        </h3>
        <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-amber-700">
          {matches.length} match{matches.length === 1 ? '' : 'es'}
        </span>
      </div>
      <div className="grid gap-2">
        {matches.slice(0, 4).map(({ pathway, role, evidence }) => (
          <div
            key={pathway.amino_acid + role}
            className="rounded-md border border-amber-100 bg-white px-2.5 py-2"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm font-semibold text-gray-900">
                {pathway.amino_acid}
              </span>
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                {role}
              </span>
            </div>
            {evidence.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {evidence.slice(0, 3).map((item) => (
                  <span
                    key={item}
                    className="rounded-full border border-amber-100 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800"
                  >
                    {item}
                  </span>
                ))}
              </div>
            )}
            <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-gray-500">
              <span>
                kcat{' '}
                <span className="font-mono text-gray-700">
                  {formatKineticValue(pathway.kcat, 's^-1')}
                </span>
              </span>
              <span>
                Ki <span className="font-mono text-gray-700">{formatKiRange(pathway)}</span>
              </span>
            </div>
            {pathway.notes && (
              <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-gray-500">
                {pathway.notes}
              </p>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

function pathwayMetaboliteIds(gene: GeneDetail, pathways: AAPathway[]) {
  return uniqueList(
    pathwayMatchesForGene(gene, pathways).flatMap(({ pathway }) => [
      pathway.amino_acid,
      ...parseObjectKeys(pathway.upstream_aas),
      ...parseObjectKeys(pathway.downstream_aas),
    ]),
  ).slice(0, 8)
}

function ModelStateSection({ gene, pathways }: { gene: GeneDetail; pathways: AAPathway[] }) {
  const rnaIds = parseJsonList(gene.rna_ids)
  const complexIds = parseJsonList(gene.complex_ids)
  const pathwayMetabolites = pathwayMetaboliteIds(gene, pathways)

  const hasAny =
    rnaIds.length > 0 || gene.monomer_id || complexIds.length > 0 || pathwayMetabolites.length > 0
  if (!hasAny) return null

  return (
    <section className="mt-3 rounded-lg border border-gray-100 bg-gray-50 p-3">
      <div className="grid gap-2 text-xs">
        {rnaIds.length > 0 && <StateIdRow label="mRNA" ids={rnaIds} tone="blue" />}
        {gene.monomer_id && (
          <StateIdRow
            label="Protein"
            ids={[gene.monomer_id]}
            tone="emerald"
            detail={gene.monomer_name ?? undefined}
          />
        )}
        {complexIds.length > 0 && <StateIdRow label="Complex" ids={complexIds} tone="amber" />}
        {pathwayMetabolites.length > 0 && (
          <StateIdRow label="Pathway metabolites" ids={pathwayMetabolites} tone="violet" />
        )}
      </div>
    </section>
  )
}

function StateIdRow({
  label,
  ids,
  tone,
  detail,
}: {
  label: string
  ids: string[]
  tone: 'blue' | 'emerald' | 'amber' | 'violet'
  detail?: string
}) {
  const toneClass = {
    blue: 'bg-blue-50 text-blue-700 border-blue-100',
    emerald: 'bg-emerald-50 text-emerald-700 border-emerald-100',
    amber: 'bg-amber-50 text-amber-700 border-amber-100',
    violet: 'bg-violet-50 text-violet-700 border-violet-100',
  }[tone]

  return (
    <div className="grid grid-cols-[88px_1fr] gap-2">
      <span className="text-gray-400">{label}</span>
      <div className="min-w-0">
        <div className="flex flex-wrap gap-1">
          {ids.map((id) => (
            <span key={id} className={'rounded border px-1.5 py-0.5 font-mono ' + toneClass}>
              {id}
            </span>
          ))}
        </div>
        {detail && <p className="mt-0.5 text-gray-400">{detail}</p>}
      </div>
    </div>
  )
}

function pathwayMatchesForGene(gene: GeneDetail, pathways: AAPathway[]): PathwayMatch[] {
  const identifiers = geneIdentifiers(gene)
  if (identifiers.size === 0) return []

  return pathways.flatMap((pathway): PathwayMatch[] => {
    const forwardHits = parseList(pathway.enzymes).filter((enzyme) =>
      identifiers.has(normalizeId(enzyme)),
    )
    const reverseHits = parseList(pathway.reverse_enzymes).filter((enzyme) =>
      identifiers.has(normalizeId(enzyme)),
    )
    const annotatedHits = parseAnnotatedGenes(pathway.notes).filter(
      (symbol) => normalizeId(symbol) === normalizeId(gene.symbol),
    )
    const forward = forwardHits.length > 0
    const reverse = reverseHits.length > 0
    const annotated = annotatedHits.length > 0

    if (!forward && !reverse && !annotated) return []
    return [
      {
        pathway,
        role:
          forward && reverse
            ? 'Forward/reverse'
            : forward
              ? 'Forward'
              : reverse
                ? 'Reverse'
                : 'Annotated',
        evidence: [
          ...forwardHits.map((enzyme) => `enzyme: ${enzyme}`),
          ...reverseHits.map((enzyme) => `reverse: ${enzyme}`),
          ...annotatedHits.map((symbol) => `note: ${symbol}`),
        ],
      },
    ]
  })
}

function geneIdentifiers(gene: GeneDetail): Set<string> {
  const identifiers = new Set<string>([normalizeId(gene.symbol)])
  if (gene.monomer_id) identifiers.add(normalizeId(gene.monomer_id))

  for (const complexId of parseJsonList(gene.complex_ids)) {
    identifiers.add(normalizeId(complexId))
  }

  return identifiers
}

function parseJsonList(value: string): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed)) {
      return parsed.flatMap((item) => (typeof item === 'string' ? [item] : []))
    }
  } catch {
    // Fall through to tolerant parsing for legacy flat-file values.
  }
  return parseList(value)
}

function parseList(value: string): string[] {
  return value
    .replace(/[\[\]"']/g, '')
    .split(/[,;]/)
    .map((item) => item.trim())
    .filter(
      (item) => item.length > 0 && !['none', 'nan', 'null', '{}'].includes(item.toLowerCase()),
    )
}

function parseObjectKeys(value: string): string[] {
  if (!value || value.trim() === '{}') return []
  try {
    const parsed = JSON.parse(value)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.keys(parsed)
    }
  } catch {
    return []
  }
  return []
}

function uniqueList(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b),
  )
}

function parseAnnotatedGenes(notes: string): string[] {
  return Array.from(notes.matchAll(/\(([^)]+)\)/g)).flatMap((match) =>
    match[1]
      .split(/[,;]/)
      .map((item) => item.trim())
      .filter(Boolean),
  )
}

function normalizeId(value: string): string {
  return value.trim().toLowerCase()
}

function formatKineticValue(value: number | null, unit: string): string {
  if (value == null) return 'n/a'
  return `${value.toLocaleString()} ${unit}`
}

function formatKiRange(pathway: AAPathway): string {
  if (pathway.ki_lower == null && pathway.ki_upper == null) return 'n/a'
  if (pathway.ki_lower === pathway.ki_upper) return `${pathway.ki_lower} mM`
  return `${pathway.ki_lower ?? 'n/a'}-${pathway.ki_upper ?? 'n/a'} mM`
}

function ContextChip({
  label,
  value,
  onClear,
}: {
  label: string
  value: string | null
  onClear: () => void
}) {
  if (!value) return null

  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-brand-200 bg-brand-50 px-2.5 py-1 text-xs text-brand-700">
      <span className="text-brand-700">{label}:</span>
      <span className="font-medium">{value}</span>
      <button
        type="button"
        onClick={onClear}
        className="ml-0.5 rounded-full px-1 text-brand-700 hover:bg-brand-100 hover:text-brand-800"
        aria-label={'Clear ' + label.toLowerCase() + ' context'}
      >
        x
      </button>
    </span>
  )
}

function Fact({ label, children, help }: { label: string; children: ReactNode; help?: ReactNode }) {
  return (
    <div>
      <div className="workspace-fact-label">
        {label}
        {help}
      </div>
      {children}
    </div>
  )
}
