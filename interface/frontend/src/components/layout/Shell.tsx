import { ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'

const NAV_ITEMS = [
  { path: '/', label: 'Gene catalog' },
  { path: '/network', label: 'TF network' },
  { path: '/experiments', label: 'Experiments' },
  { path: '/results', label: 'Results' },
  { path: '/ml', label: 'ML' },
  { path: '/design', label: 'Design' },
  { path: '/guide', label: 'Guide' },
]

export function Shell({ children }: { children: ReactNode }) {
  const location = useLocation()

  return (
    <div className="min-h-screen flex flex-col">
      {/* Top navigation */}
      <header className="border-b border-gray-200 bg-white px-6 py-3 flex items-center gap-8">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-brand-600 flex items-center justify-center">
            <span className="text-white text-sm font-semibold">wc</span>
          </div>
          <span className="font-semibold text-lg">wcEcoli</span>
          <span className="text-gray-400 text-sm ml-1">Platform</span>
        </div>

        <nav className="flex gap-1">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.path}
              to={item.path}
              className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
                (item.path === '/' ? location.pathname === '/' : location.pathname.startsWith(item.path))
                  ? 'bg-brand-50 text-brand-700 font-medium'
                  : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto text-xs text-gray-400">
          E. coli K-12 MG1655 &middot; EcoCyc v30.0
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 p-6">
        {children}
      </main>
    </div>
  )
}
