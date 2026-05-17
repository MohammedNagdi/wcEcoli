import { ReactNode, useMemo } from 'react'
import { Link, useLocation } from 'react-router-dom'

interface NavItem {
  path: string
  label: string
  icon: string   // SVG path for a 20×20 viewBox
}

interface NavGroup {
  id: string
  label: string
  items: NavItem[]
}

const ICON_GENES = 'M10 2v2m0 12v2M4 10h2m8 0h2m-1.5-5.5L13 6m-5.5 8.5L6 16m9.5.5L14 15M7.5 4.5L6 6m8 8l-1.5 1.5'
const ICON_NETWORK = 'M5 5h2v2H5zm6 6h2v2h-2zm6-6h2v2h-2zM7 6h4m2 0h4M6 7v4m8 0v-4m-3 4l-2 2'
const ICON_EXPERIMENTS = 'M9 3h2v5l3 4v4a1 1 0 01-1 1H7a1 1 0 01-1-1v-4l3-4V3zm-2 5h6m-5 4h4'
const ICON_RESULTS = 'M4 18h16M4 14l4-4 3 2 5-6 4 4'
const ICON_ML = 'M12 4a3 3 0 100 6 3 3 0 000-6zm-5 9a5 5 0 0110 0M4 17h16M8 13v4m8-4v4'
const ICON_DESIGN = 'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5'
const ICON_GUIDE = 'M12 3a7 7 0 00-7 7c0 2.5 1.5 4.5 3.5 5.5V17h7v-1.5c2-1 3.5-3 3.5-5.5a7 7 0 00-7-7zm-2 14h4m-3 3h2'

const NAV_GROUPS: NavGroup[] = [
  {
    id: 'explore',
    label: 'Explore',
    items: [
      { path: '/', label: 'Genes', icon: ICON_GENES },
      { path: '/network', label: 'Network', icon: ICON_NETWORK },
    ],
  },
  {
    id: 'simulate',
    label: 'Simulate',
    items: [
      { path: '/experiments', label: 'Experiments', icon: ICON_EXPERIMENTS },
    ],
  },
  {
    id: 'analyze',
    label: 'Analyze',
    items: [
      { path: '/results', label: 'Results', icon: ICON_RESULTS },
      { path: '/ml', label: 'ML', icon: ICON_ML },
      { path: '/design', label: 'Design', icon: ICON_DESIGN },
    ],
  },
]

function NavIcon({ d }: { d: string }) {
  return (
    <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  )
}

export function Shell({ children }: { children: ReactNode }) {
  const location = useLocation()

  const activeGroup = useMemo(() => {
    for (const group of NAV_GROUPS) {
      for (const item of group.items) {
        if (item.path === '/' ? location.pathname === '/' : location.pathname.startsWith(item.path)) {
          return group.id
        }
      }
    }
    return 'explore'
  }, [location.pathname])

  const activeGroupItems = NAV_GROUPS.find(g => g.id === activeGroup)?.items ?? []

  const isActive = (path: string) =>
    path === '/' ? location.pathname === '/' : location.pathname.startsWith(path)

  return (
    <div className="min-h-screen flex flex-col">
      {/* Primary navigation — workflow stages */}
      <header className="border-b border-gray-200 bg-white px-6">
        <div className="flex items-center gap-6 h-12">
          <Link to="/" className="flex items-center gap-2 flex-shrink-0">
            <div className="w-7 h-7 rounded-lg bg-brand-600 flex items-center justify-center">
              <span className="text-white text-xs font-semibold">wc</span>
            </div>
            <span className="font-semibold text-base">wcEcoli</span>
          </Link>

          <nav className="flex items-center h-full gap-0">
            {NAV_GROUPS.map((group) => (
              <Link
                key={group.id}
                to={group.items[0].path}
                className={`relative px-4 h-full flex items-center text-sm font-medium transition-colors ${
                  activeGroup === group.id
                    ? 'text-brand-700'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {group.label}
                {activeGroup === group.id && (
                  <span className="absolute bottom-0 left-4 right-4 h-0.5 bg-brand-600 rounded-full" />
                )}
              </Link>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-4">
            <span className="text-xs text-gray-400 hidden lg:block">
              E. coli K-12 MG1655
            </span>
            <Link
              to="/guide"
              className={`p-1.5 rounded-md transition-colors ${
                location.pathname === '/guide'
                  ? 'bg-brand-50 text-brand-700'
                  : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'
              }`}
              title="Guide"
            >
              <svg className="w-4.5 h-4.5" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d={ICON_GUIDE} />
              </svg>
            </Link>
          </div>
        </div>

        {/* Secondary navigation — items within active stage */}
        {activeGroupItems.length > 1 && (
          <div className="flex items-center gap-1 -mb-px pl-0">
            {activeGroupItems.map((item) => (
              <Link
                key={item.path}
                to={item.path}
                className={`flex items-center gap-1.5 px-3 py-1.5 mb-1 rounded-md text-xs font-medium transition-colors ${
                  isActive(item.path)
                    ? 'bg-brand-50 text-brand-700 border border-brand-200'
                    : 'text-gray-500 hover:bg-gray-50 hover:text-gray-700 border border-transparent'
                }`}
              >
                <NavIcon d={item.icon} />
                {item.label}
              </Link>
            ))}
          </div>
        )}
      </header>

      <main className="flex-1 p-6">
        {children}
      </main>
    </div>
  )
}
