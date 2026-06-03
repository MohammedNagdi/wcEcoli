import { Link } from 'react-router-dom'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import { GeneCatalogPage } from '../genes/GeneCatalogPage'
import { GenomeContextRail } from '../genes/GenomeContextRail'
import { TFNetworkMini } from '../genes/TFNetworkMini'
import { CategoryBadge, DirectionBadge } from '../common/Badge'
import { getAAPathways } from '../../api/client'
import { useGeneDetail } from '../../hooks/useGenes'
import { useUrlWorkspaceState } from '../../hooks/useUrlWorkspaceState'
import type { AAPathway, GeneDetail } from '../../types'

export function ExploreWorkspacePage() {
  const {
    selectedGene,
    selectedCategory,
    selectedCondition,
    setSelectedGene,
    setSelectedCategory,
    setSelectedCondition,
  } = useUrlWorkspaceState()
  const { gene: selectedGeneDetail, loading: detailLoading } = useGeneDetail(selectedGene)
  const [aaPathways, setAAPathways] = useState<AAPathway[]>([])
  const [leftPct, setLeftPct] = useState(57)
  const [isDragging, setIsDragging] = useState(false)
  const dragging = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let mounted = true
    getAAPathways()
      .then((pathways) => {
        if (mounted) setAAPathways(pathways)
      })
      .catch(() => {
        if (mounted) setAAPathways([])
      })
    return () => {
      mounted = false
    }
  }, [])

  const stopDragging = () => {
    dragging.current = false
    setIsDragging(false)
  }

  const handleDividerMove = (event: MouseEvent<HTMLDivElement>) => {
    if (!dragging.current || !containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const pct = ((event.clientX - rect.left) / rect.width) * 100
    setLeftPct(Math.min(75, Math.max(30, pct)))
  }

  return (
    <div className="flex h-[calc(100vh-32px)] min-h-[720px] flex-col gap-3 overflow-hidden">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-2 text-lg font-semibold text-gray-900">Explore</h1>
        <ContextChip label="Gene" value={selectedGene} onClear={() => setSelectedGene(null)} mono />
        <ContextChip label="Category" value={selectedCategory} onClear={() => setSelectedCategory(null)} />
        <ContextChip label="Condition" value={selectedCondition} onClear={() => setSelectedCondition(null)} />
      </div>

      <div
        ref={containerRef}
        className={'flex min-h-0 flex-1 gap-0 overflow-hidden ' + (isDragging ? 'select-none cursor-col-resize' : '')}
        onMouseMove={handleDividerMove}
        onMouseUp={stopDragging}
        onMouseLeave={stopDragging}
      >
        <section
          className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-gray-200 bg-white"
          style={{ width: leftPct + '%', flexShrink: 0 }}
        >
          <div className="flex items-center justify-between border-b border-gray-100 px-3 py-2">
            <div>
              <h2 className="text-sm font-semibold text-gray-900">Genes</h2>
              <p className="text-xs text-gray-400">Catalog, category filters, and selected gene search.</p>
            </div>
            <span className="text-xs text-gray-400">table</span>
          </div>
          <div className="min-h-0 flex-1 p-3">
            <GeneCatalogPage embedded hideDetailPanel heightClass="h-full min-h-0" showEssentiality={false} />
          </div>
        </section>

        <div
          className="group relative z-10 mx-0 flex w-3 flex-shrink-0 cursor-col-resize items-center justify-center"
          onMouseDown={(event) => {
            event.preventDefault()
            dragging.current = true
            setIsDragging(true)
          }}
        >
          <div className="h-12 w-1 rounded-full bg-gray-300 transition group-hover:bg-brand-400 group-active:bg-brand-500" />
        </div>

        <section
          className="min-h-0 overflow-hidden rounded-lg border border-gray-200 bg-white"
          style={{ flex: 1, minWidth: 0 }}
        >
          <SelectedGeneSummary
            gene={selectedGeneDetail}
            aaPathways={aaPathways}
            loading={detailLoading}
            selectedGene={selectedGene}
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
  loading,
  selectedGene,
  onSelectGene,
}: {
  gene: GeneDetail | null
  aaPathways: AAPathway[]
  loading: boolean
  selectedGene: string | null
  onSelectGene: (symbol: string) => void
}) {
  if (loading && selectedGene) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-gray-400">
        Loading selected gene...
      </div>
    )
  }

  if (!gene) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-gray-400">
        Select a gene from the table or genome map to inspect its products, regulation, and experiment actions.
      </div>
    )
  }

  const length = gene.left_end_pos && gene.right_end_pos
    ? Math.abs(gene.right_end_pos - gene.left_end_pos) + 1
    : null

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start justify-between border-b border-gray-100 px-4 py-3">
        <div>
          <h2 className="font-mono text-lg font-semibold text-gray-900">{gene.symbol}</h2>
          <p className="text-xs text-gray-400">{gene.ecoli_id}</p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <Link
            to={'/genome?gene=' + encodeURIComponent(gene.symbol)}
            className="rounded-md border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
          >
            Genome Map
          </Link>
          <Link
            to={'/experiments/new?variant=gene_knockout&gene=' + encodeURIComponent(gene.symbol)}
            className="rounded-md bg-bio-gene px-2.5 py-1.5 text-xs font-medium text-white hover:opacity-90"
          >
            Design KO
          </Link>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
          <Fact label="Category">
            <CategoryBadge label={gene.category} />
          </Fact>
          <Fact label="KO index">
            <span className="font-mono text-gray-700">
              {gene.ko_index != null && gene.ko_index >= 0 ? gene.ko_index : '—'}
            </span>
          </Fact>
          {gene.direction && (
            <Fact label="Strand">
              <DirectionBadge direction={gene.direction} />
            </Fact>
          )}
          {length && (
            <Fact label="Length">
              <span>{length.toLocaleString()} bp</span>
            </Fact>
          )}
          {gene.left_end_pos && gene.right_end_pos && (
            <Fact label="Position">
              <span className="font-mono text-[11px] text-gray-600">
                {gene.left_end_pos.toLocaleString()}-{gene.right_end_pos.toLocaleString()}
              </span>
            </Fact>
          )}
        </div>

        <ModelStateSection gene={gene} pathways={aaPathways} />

        <PathwayContext gene={gene} pathways={aaPathways} />

        {gene.left_end_pos != null && (
          <div className="mt-2">
            <GenomeContextRail
              symbol={gene.symbol}
              window={5000}
              onSelectGene={onSelectGene}
            />
          </div>
        )}

        {(gene.regulated_by.length > 0 || gene.regulates.length > 0) && (
          <div className="mt-3">
            <TFNetworkMini
              symbol={gene.symbol}
              focalCategory={gene.category}
              regulatedBy={gene.regulated_by.flatMap((edge) =>
                edge.tf ? [{ symbol: edge.tf, log2fc: edge.log2fc, type: edge.type }] : []
              )}
              regulates={gene.regulates.flatMap((edge) =>
                edge.target ? [{ symbol: edge.target, log2fc: edge.log2fc, type: edge.type }] : []
              )}
              onSelectGene={onSelectGene}
            />
          </div>
        )}
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
        <h3 className="text-xs font-semibold uppercase tracking-wide text-amber-900">Pathway context</h3>
        <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-amber-700">
          {matches.length} match{matches.length === 1 ? '' : 'es'}
        </span>
      </div>
      <div className="grid gap-2">
        {matches.slice(0, 4).map(({ pathway, role, evidence }) => (
          <div key={pathway.amino_acid + role} className="rounded-md border border-amber-100 bg-white px-2.5 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm font-semibold text-gray-900">{pathway.amino_acid}</span>
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                {role}
              </span>
            </div>
            {evidence.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {evidence.slice(0, 3).map((item) => (
                  <span key={item} className="rounded-full border border-amber-100 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
                    {item}
                  </span>
                ))}
              </div>
            )}
            <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-gray-500">
              <span>
                kcat <span className="font-mono text-gray-700">{formatKineticValue(pathway.kcat, 's^-1')}</span>
              </span>
              <span>
                Ki <span className="font-mono text-gray-700">{formatKiRange(pathway)}</span>
              </span>
            </div>
            {pathway.notes && (
              <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-gray-500">{pathway.notes}</p>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

function ModelStateSection({ gene, pathways }: { gene: GeneDetail; pathways: AAPathway[] }) {
  const rnaIds = parseJsonList(gene.rna_ids)
  const complexIds = parseJsonList(gene.complex_ids)
  const pathwayMetabolites = useMemo(() => {
    const values = pathwayMatchesForGene(gene, pathways).flatMap(({ pathway }) => [
      pathway.amino_acid,
      ...parseObjectKeys(pathway.upstream_aas),
      ...parseObjectKeys(pathway.downstream_aas),
    ])
    return uniqueList(values).slice(0, 8)
  }, [gene, pathways])

  const hasAny = rnaIds.length > 0 || gene.monomer_id || complexIds.length > 0 || pathwayMetabolites.length > 0
  if (!hasAny) return null

  return (
    <section className="mt-3 rounded-lg border border-gray-100 bg-gray-50 p-3">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Model state IDs</h3>
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
    const forwardHits = parseList(pathway.enzymes).filter((enzyme) => identifiers.has(normalizeId(enzyme)))
    const reverseHits = parseList(pathway.reverse_enzymes).filter((enzyme) => identifiers.has(normalizeId(enzyme)))
    const annotatedHits = parseAnnotatedGenes(pathway.notes).filter((symbol) => normalizeId(symbol) === normalizeId(gene.symbol))
    const forward = forwardHits.length > 0
    const reverse = reverseHits.length > 0
    const annotated = annotatedHits.length > 0

    if (!forward && !reverse && !annotated) return []
    return [{
      pathway,
      role: forward && reverse ? 'Forward/reverse' : forward ? 'Forward' : reverse ? 'Reverse' : 'Annotated',
      evidence: [
        ...forwardHits.map((enzyme) => `enzyme: ${enzyme}`),
        ...reverseHits.map((enzyme) => `reverse: ${enzyme}`),
        ...annotatedHits.map((symbol) => `note: ${symbol}`),
      ],
    }]
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
    .filter((item) => item.length > 0 && !['none', 'nan', 'null', '{}'].includes(item.toLowerCase()))
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
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b))
}

function parseAnnotatedGenes(notes: string): string[] {
  return Array.from(notes.matchAll(/\(([^)]+)\)/g)).flatMap((match) =>
    match[1]
      .split(/[,;]/)
      .map((item) => item.trim())
      .filter(Boolean)
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
  mono = false,
}: {
  label: string
  value: string | null
  onClear: () => void
  mono?: boolean
}) {
  if (!value) {
    return (
      <span className="rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs text-gray-400">
        {label}: none
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-brand-200 bg-brand-50 px-2.5 py-1 text-xs text-brand-700">
      <span className="text-brand-500">{label}:</span>
      <span className={mono ? 'font-mono font-medium' : 'font-medium'}>{value}</span>
      <button
        type="button"
        onClick={onClear}
        className="ml-0.5 rounded-full px-1 text-brand-500 hover:bg-brand-100 hover:text-brand-800"
        aria-label={'Clear ' + label.toLowerCase() + ' context'}
      >
        x
      </button>
    </span>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-0.5 text-xs uppercase tracking-wide text-gray-400">{label}</p>
      {children}
    </div>
  )
}
