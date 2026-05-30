import type { Gene } from '../types'

export const GENOME_LENGTH = 4_641_652

export const CATEGORY_FILL: Record<string, string> = {
  amino_acid_biosynthesis: '#d97706',
  central_carbon: '#65a30d',
  cell_envelope: '#db2777',
  dna_replication: '#7c3aed',
  transport: '#0891b2',
  transcription: '#9333ea',
  translation: '#0d9488',
  energy: '#0284c7',
  cell_division: '#e11d48',
  regulation: '#ea580c',
  other: '#9ca3af',
}

export interface Point {
  x: number
  y: number
}

export interface PositionedGene extends Gene {
  left_end_pos: number
  right_end_pos: number
}

export function hasGenomePosition(gene: Gene): gene is PositionedGene {
  return gene.left_end_pos != null && gene.right_end_pos != null
}

export function bpToAngle(bp: number): number {
  return (bp / GENOME_LENGTH) * 2 * Math.PI - Math.PI / 2
}

export function polarToCartesian(cx: number, cy: number, r: number, angle: number): Point {
  return {
    x: cx + r * Math.cos(angle),
    y: cy + r * Math.sin(angle),
  }
}

export function arcPath(
  cx: number,
  cy: number,
  innerR: number,
  outerR: number,
  startAngle: number,
  endAngle: number
): string {
  let delta = endAngle - startAngle
  if (delta < 0) delta += Math.PI * 2
  if (delta >= Math.PI * 2) delta = Math.PI * 2 - 0.0001

  const adjustedEnd = startAngle + delta
  const outerStart = polarToCartesian(cx, cy, outerR, startAngle)
  const outerEnd = polarToCartesian(cx, cy, outerR, adjustedEnd)
  const innerEnd = polarToCartesian(cx, cy, innerR, adjustedEnd)
  const innerStart = polarToCartesian(cx, cy, innerR, startAngle)
  const largeArcFlag = delta > Math.PI ? 1 : 0

  return [
    `M ${outerStart.x.toFixed(3)} ${outerStart.y.toFixed(3)}`,
    `A ${outerR} ${outerR} 0 ${largeArcFlag} 1 ${outerEnd.x.toFixed(3)} ${outerEnd.y.toFixed(3)}`,
    `L ${innerEnd.x.toFixed(3)} ${innerEnd.y.toFixed(3)}`,
    `A ${innerR} ${innerR} 0 ${largeArcFlag} 0 ${innerStart.x.toFixed(3)} ${innerStart.y.toFixed(3)}`,
    'Z',
  ].join(' ')
}
