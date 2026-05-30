export type RegulationEffect = 'activation' | 'repression' | 'dual' | 'neutral'

export function regulationEffect(log2fc: number, type: string): RegulationEffect {
  const normalized = type.trim().toLowerCase()
  if (normalized.includes('activat')) return 'activation'
  if (normalized.includes('repres') || normalized.includes('inhibit')) return 'repression'
  if (normalized.includes('dual')) return 'dual'
  if (log2fc > 0) return 'activation'
  if (log2fc < 0) return 'repression'
  return 'neutral'
}
