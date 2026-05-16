import { categoryLabel } from '../../utils/labels'

// Keyed on the raw snake_case values from the API
const CATEGORY_COLORS: Record<string, string> = {
  amino_acid_biosynthesis: 'bg-amber-50 text-amber-700 border-amber-200',
  central_carbon:          'bg-lime-50 text-lime-700 border-lime-200',
  cell_envelope:           'bg-pink-50 text-pink-700 border-pink-200',
  dna_replication:         'bg-violet-50 text-violet-700 border-violet-200',
  transport:               'bg-cyan-50 text-cyan-700 border-cyan-200',
  transcription:           'bg-purple-50 text-purple-700 border-purple-200',
  translation:             'bg-teal-50 text-teal-700 border-teal-200',
  energy:                  'bg-sky-50 text-sky-700 border-sky-200',
  other:                   'bg-gray-50 text-gray-600 border-gray-200',
}

const DEFAULT_COLOR = 'bg-gray-50 text-gray-600 border-gray-200'

interface Props {
  /** Raw category value from API (snake_case) */
  label: string
  className?: string
}

export function CategoryBadge({ label, className = '' }: Props) {
  const color = CATEGORY_COLORS[label] ?? DEFAULT_COLOR
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${color} ${className}`}>
      {categoryLabel(label)}
    </span>
  )
}

export function DirectionBadge({ direction }: { direction: string | null }) {
  if (!direction) return null
  const isForward = direction === '+'
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-mono ${
      isForward ? 'bg-green-50 text-green-700' : 'bg-orange-50 text-orange-700'
    }`}>
      {isForward ? '→ fwd' : '← rev'}
    </span>
  )
}

export function RegTypeBadge({ type }: { type: string }) {
  const isAct = type.toLowerCase().includes('activat')
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${
      isAct ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
    }`}>
      {type}
    </span>
  )
}
