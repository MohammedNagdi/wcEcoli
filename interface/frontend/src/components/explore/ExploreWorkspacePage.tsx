import { Link } from 'react-router-dom'
import { useRef, useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import { GeneCatalogPage } from '../genes/GeneCatalogPage'
import { GenomeContextRail } from '../genes/GenomeContextRail'
import { GenomeViewerPage } from '../genome/GenomeViewerPage'
import { CategoryBadge, DirectionBadge, RegTypeBadge } from '../common/Badge'
import { useGeneDetail } from '../../hooks/useGenes'
import { useUrlWorkspaceState } from '../../hooks/useUrlWorkspaceState'
import type { GeneDetail } from '../../types'

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
  const [leftPct, setLeftPct] = useState(57)
  const [isDragging, setIsDragging] = useState(false)
  const dragging = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)

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
        <div className="ml-auto flex items-center gap-2">
          <Link
            to="/network"
            className="rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:border-gray-300 hover:text-gray-900"
          >
            Network
          </Link>
          <Link
            to="/pathways"
            className="rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:border-gray-300 hover:text-gray-900"
          >
            Pathways
          </Link>
          {selectedGene && (
            <Link
              to={`/experiments/new?variant=gene_knockout&gene=${encodeURIComponent(selectedGene)}`}
              className="rounded-md bg-brand-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-brand-700"
            >
              Design KO
            </Link>
          )}
        </div>
      </div>

      <div
        ref={containerRef}
        className={`flex min-h-0 flex-1 gap-0 overflow-hidden ${isDragging ? 'select-none cursor-col-resize' : ''}`}
        onMouseMove={handleDividerMove}
        onMouseUp={stopDragging}
        onMouseLeave={stopDragging}
      >
        <section
          className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-gray-200 bg-white"
          style={{ width: `${leftPct}%`, flexShrink: 0 }}
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

        <div
          className="grid min-h-0 grid-rows-[minmax(0,1fr)_minmax(260px,340px)] gap-3"
          style={{ flex: 1, minWidth: 0 }}
        >
          <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-gray-200 bg-white p-3">
            <div className="mb-2 flex flex-shrink-0 items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-gray-900">Genome</h2>
                <p className="text-xs text-gray-400">Chromosome position and category context.</p>
              </div>
              <span className="text-xs text-gray-400">map</span>
            </div>
            <div className="min-h-0 flex-1">
              <GenomeViewerPage embedded compact />
            </div>
          </section>

          <section className="min-h-0 overflow-hidden rounded-lg border border-gray-200 bg-white">
            <SelectedGeneSummary
              gene={selectedGeneDetail}
              loading={detailLoading}
              selectedGene={selectedGene}
              onSelectGene={(symbol) => setSelectedGene(symbol, { replace: false })}
            />
          </section>
        </div>
      </div>
    </div>
  )
}

function SelectedGeneSummary({
  gene,
  loading,
  selectedGene,
  onSelectGene,
}: {
  gene: GeneDetail | null
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
        <Link
          to={`/experiments/new?variant=gene_knockout&gene=${encodeURIComponent(gene.symbol)}`}
          className="rounded-md bg-bio-gene px-2.5 py-1.5 text-xs font-medium text-white hover:opacity-90"
        >
          Design KO
        </Link>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
          <Fact label="Category">
            <CategoryBadge label={gene.category} />
          </Fact>
          <Fact label="KO index">
            <span className="font-mono text-gray-700">{gene.ko_index}</span>
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

        <div className="mt-2 grid gap-2 text-sm">
          {gene.monomer_id && (
            <ProductRow label="Protein" value={gene.monomer_id} detail={gene.monomer_name ?? undefined} />
          )}
        </div>

        {gene.left_end_pos != null && (
          <div className="mt-2">
            <GenomeContextRail
              symbol={gene.symbol}
              window={5000}
              onSelectGene={onSelectGene}
            />
          </div>
        )}

        {gene.regulated_by.length > 0 && (
          <div className="mt-2">
            <p className="text-xs uppercase tracking-wide text-gray-400">Regulated by</p>
            <div className="mt-0.5 flex flex-wrap gap-1">
              {gene.regulated_by.slice(0, 8).map((edge, index) => (
                <span key={`${edge.tf}-${index}`} className="inline-flex items-center gap-1 rounded-md bg-gray-50 px-1.5 py-0.5">
                  <span className="font-mono text-xs text-bio-tf">{edge.tf}</span>
                  <RegTypeBadge type={edge.type} />
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
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
        aria-label={`Clear ${label.toLowerCase()} context`}
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

function ProductRow({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-gray-400">{label}</p>
      <span className="rounded bg-emerald-50 px-1.5 py-0.5 font-mono text-xs text-emerald-700">
        {value}
      </span>
      {detail && <p className="mt-0.5 text-xs text-gray-400">{detail}</p>}
    </div>
  )
}
