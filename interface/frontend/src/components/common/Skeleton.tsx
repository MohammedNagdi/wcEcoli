/**
 * Lightweight skeleton loading indicators.
 */

interface Props {
  className?: string
}

export function SkeletonLine({ className = 'w-full h-4' }: Props) {
  return (
    <div className={`bg-gray-100 rounded animate-pulse ${className}`} />
  )
}

export function SkeletonTableRows({ rows = 8, cols = 6 }: { rows?: number; cols?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
        <tr key={i}>
          {Array.from({ length: cols }).map((_, j) => (
            <td key={j} className="px-4 py-3">
              <div className={`bg-gray-100 rounded animate-pulse h-4 ${
                j === 0 ? 'w-24' : j === cols - 1 ? 'w-12' : 'w-20'
              }`} />
            </td>
          ))}
        </tr>
      ))}
    </>
  )
}
