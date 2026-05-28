import { useEffect, useMemo, useState } from 'react'
import { getGeneNeighbors } from '../../api/client'
import type { Gene } from '../../types'
import { categoryLabel } from '../../utils/labels'

interface Props {
  symbol: string
  window?: number
  onSelectGene?: (symbol: string) => void
}

const CATEGORY_COLORS: Record<string, string> = {
  'Amino acid biosynthesis': 'bg-emerald-500',
  'Membrane transport': 'bg-sky-500',
  'Cofactor biosynthesis': 'bg-amber-500',
  'Transcriptional regulation': 'bg-violet-500',
  'Transfer RNA': 'bg-rose-500',
  Other: 'bg-slate-400',
}

function geneColor(category: string) {
  return CATEGORY_COLORS[category] ?? 'bg-slate-400'
}

export function GenomeContextRail({ symbol, window = 5000, onSelectGene }: Props) {
  const [neighbors, setNeighbors] = useState<Gene[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let active = true
    setLoading(true)
    getGeneNeighbors(symbol, window)
      .then((genes) => {
        if (active) setNeighbors(genes)
      })
      .catch(() => {
        if (active) setNeighbors([])
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [symbol, window])

  const positionedGenes = useMemo(
    () => neighbors.filter((gene) => gene.left_end_pos != null && gene.right_end_pos != null),
    [neighbors]
  )

  const bounds = useMemo(() => {
    if (positionedGenes.length === 0) return null
    const min = Math.min(...positionedGenes.map((gene) => gene.left_end_pos ?? 0))
    const max = Math.max(...positionedGenes.map((gene) => gene.right_end_pos ?? 0))
    return { min, max, span: Math.max(1, max - min) }
  }, [positionedGenes])

  const scale = (position: number) => {
    if (!bounds) return 0
    return ((position - bounds.min) / bounds.span) * 100
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
            Genome context
          </p>
          <p className="text-xs text-gray-500">Nearby genes within {window.toLocaleString()} bp</p>
        </div>
        {loading && <span className="text-xs text-gray-400">Loading</span>}
      </div>

      {bounds && positionedGenes.length > 0 ? (
        <>
          <div className="relative h-16 rounded-md border border-gray-200 bg-white">
            <div className="absolute left-3 right-3 top-1/2 h-px bg-gray-200" />
            {positionedGenes.map((gene) => {
              const left = scale(gene.left_end_pos ?? 0)
              const right = scale(gene.right_end_pos ?? 0)
              const width = Math.max(2, right - left)
              const selected = gene.symbol === symbol

              return (
                <button
                  key={gene.symbol}
                  type="button"
                  title={`${gene.symbol} - ${categoryLabel(gene.category)}`}
                  onClick={() => onSelectGene?.(gene.symbol)}
                  className={`absolute top-6 h-4 rounded-sm transition ${
                    selected ? 'ring-2 ring-brand-600 ring-offset-2' : 'hover:ring-2 hover:ring-gray-300'
                  } ${geneColor(gene.category)}`}
                  style={{
                    left: `${left}%`,
                    width: `max(${width}%, 0.5rem)`,
                  }}
                  aria-label={`Select ${gene.symbol}`}
                />
              )
            })}
          </div>
          <div className="mt-2 max-h-32 space-y-1 overflow-y-auto">
            {positionedGenes.map((gene) => (
              <button
                key={gene.symbol}
                type="button"
                onClick={() => onSelectGene?.(gene.symbol)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-white ${
                  gene.symbol === symbol ? 'bg-white text-brand-700 shadow-sm' : 'text-gray-600'
                }`}
              >
                <span className={`h-2 w-2 rounded-full ${geneColor(gene.category)}`} />
                <span className="w-16 flex-shrink-0 font-mono font-medium">{gene.symbol}</span>
                <span className="truncate text-gray-400">{categoryLabel(gene.category)}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="rounded-md border border-dashed border-gray-200 bg-white px-3 py-4 text-xs text-gray-400">
          No neighboring genes with genomic coordinates found.
        </div>
      )}
    </div>
  )
}
