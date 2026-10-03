import { useTheme } from './ThemeProvider'
import type { ThemeMode } from './ThemeProvider'

const ICON_SUN =
  'M10 3v1.5m0 11V17m7-7h-1.5M4.5 10H3m11.95-4.95l-1.06 1.06M6.11 13.89l-1.06 1.06m0-9.9l1.06 1.06m7.78 7.78l1.06 1.06M13 10a3 3 0 11-6 0 3 3 0 016 0z'
const ICON_MOON = 'M14.5 13.4A5.5 5.5 0 016.6 5.5 6.5 6.5 0 1014.5 13.4z'
const ICON_SYSTEM = 'M4 5h12v8H4V5zm4 11h4m-6 0h8'

function NavIcon({ d, className = 'w-4 h-4' }: { d: string; className?: string }) {
  return (
    <svg
      className={`${className} flex-shrink-0`}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  )
}

const THEME_OPTIONS: Array<{ mode: ThemeMode; label: string; icon: string }> = [
  { mode: 'light', label: 'Light theme', icon: ICON_SUN },
  { mode: 'dark', label: 'Dark theme', icon: ICON_MOON },
  { mode: 'system', label: 'System theme', icon: ICON_SYSTEM },
]

export function ThemeToggle({
  collapsed = false,
  compact = false,
}: {
  collapsed?: boolean
  compact?: boolean
}) {
  const { mode, resolvedTheme, setMode } = useTheme()

  if (collapsed) {
    const currentIndex = THEME_OPTIONS.findIndex((option) => option.mode === mode)
    const current = THEME_OPTIONS[currentIndex] ?? THEME_OPTIONS[2]
    const next = THEME_OPTIONS[(currentIndex + 1) % THEME_OPTIONS.length] ?? THEME_OPTIONS[0]
    return (
      <button
        type="button"
        data-testid="theme-toggle-collapsed"
        onClick={() => setMode(next.mode)}
        className="flex w-full items-center justify-center rounded-md p-2 text-gray-500 hover:bg-gray-50 hover:text-gray-800"
        title={`${current.label}; switch to ${next.label.toLowerCase()}`}
        aria-label={`${current.label}; switch to ${next.label.toLowerCase()}`}
      >
        <NavIcon d={current.icon} className="h-4 w-4" />
      </button>
    )
  }

  return (
    <div className={compact ? 'home-theme' : 'px-2 py-2'} data-testid="theme-control">
      {!compact && (
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
          Theme
        </div>
      )}
      <div
        className="grid grid-cols-3 rounded-lg bg-gray-100 p-0.5"
        role="group"
        aria-label={`Theme, currently ${mode}`}
      >
        {THEME_OPTIONS.map((option) => {
          const active = option.mode === mode
          const suffix = option.mode === 'system' ? ` (${resolvedTheme})` : ''
          return (
            <button
              key={option.mode}
              type="button"
              data-testid={`theme-${option.mode}`}
              onClick={() => setMode(option.mode)}
              className={`flex items-center justify-center rounded-md px-2 py-1.5 transition-colors ${
                active ? 'bg-white text-brand-700 shadow-sm' : 'text-gray-500 hover:text-gray-800'
              }`}
              aria-pressed={active}
              aria-label={`${option.label}${suffix}`}
              title={`${option.label}${suffix}`}
            >
              <NavIcon d={option.icon} className="h-4 w-4" />
            </button>
          )
        })}
      </div>
    </div>
  )
}
