import { ReactNode, useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { CommandSearch } from '../common/CommandSearch'
import { AssistantDock } from '../assistant/AssistantDock'
import { ThemeToggle } from '../theme/ThemeToggle'
import { useMediaQuery } from '../workspace/useMediaQuery'
import '../../styles/workspace.css'

interface NavItem {
  path: string
  label: string
  icon: string
}

interface NavGroup {
  id: string
  /** Section header; omit for a standalone, category-less item. */
  label?: string
  items: NavItem[]
}

const ICON_EXPLORE =
  'M10 2v2m0 12v2M4 10h2m8 0h2m-1.5-5.5L13 6m-5.5 8.5L6 16m9.5.5L14 15M7.5 4.5L6 6m8 8l-1.5 1.5'
const ICON_NETWORK = 'M5 5h2v2H5zm6 6h2v2h-2zm6-6h2v2h-2zM7 6h4m2 0h4M6 7v4m8 0v-4m-3 4l-2 2'
const ICON_GENOME = 'M12 2a10 10 0 100 20 10 10 0 000-20zm0 3v2m0 10v2m7-7h-2M5 12H3'
const ICON_EXPERIMENTS = 'M9 3h2v5l3 4v4a1 1 0 01-1 1H7a1 1 0 01-1-1v-4l3-4V3zm-2 5h6m-5 4h4'
const ICON_ENVIRONMENT = 'M4 6h12M4 10h8m-8 4h12m2-8l2 2-2 2m0 4l2 2-2 2'
const ICON_RESULTS = 'M4 18h16M4 14l4-4 3 2 5-6 4 4'
const ICON_ASSISTANT = 'M4 5h12v8H7l-3 3V5zm4 3h4m-4 3h6'
const ICON_ML = 'M12 4a3 3 0 100 6 3 3 0 000-6zm-5 9a5 5 0 0110 0M4 17h16M8 13v4m8-4v4'
const ICON_DESIGN = 'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5'
const ICON_GUIDE =
  'M12 3a7 7 0 00-7 7c0 2.5 1.5 4.5 3.5 5.5V17h7v-1.5c2-1 3.5-3 3.5-5.5a7 7 0 00-7-7zm-2 14h4m-3 3h2'
const ICON_COLLAPSE = 'M15 5l-5 5 5 5M5 5v10'
const ICON_EXPAND = 'M5 5l5 5-5 5m10-10v10'
const NAV_GROUPS: NavGroup[] = [
  { id: 'home', items: [{ path: '/', label: 'Home', icon: 'M3 9l7-6 7 6v8H3V9zm5 8v-6h4v6' }] },
  {
    id: 'explore',
    label: 'Explore',
    items: [
      { path: '/explore', label: 'Workspace', icon: ICON_EXPLORE },
      { path: '/genome', label: 'Genome Map', icon: ICON_GENOME },
      { path: '/network', label: 'Network', icon: ICON_NETWORK },
    ],
  },
  {
    id: 'simulate',
    label: 'Simulate',
    items: [
      { path: '/environment-builder', label: 'Conditions Builder', icon: ICON_ENVIRONMENT },
      { path: '/experiments', label: 'Experiments', icon: ICON_EXPERIMENTS },
    ],
  },
  {
    id: 'analyze',
    label: 'Analyze',
    items: [{ path: '/results', label: 'Results', icon: ICON_RESULTS }],
  },
  {
    id: 'applications',
    label: 'Applications',
    items: [
      { path: '/design', label: 'Genome Design', icon: ICON_DESIGN },
      { path: '/ml', label: 'ML', icon: ICON_ML },
    ],
  },
  {
    // Standalone, category-less — the Assistant is a cross-cutting tool, not an Analyze page.
    id: 'assistant',
    items: [{ path: '/assistant', label: 'Assistant', icon: ICON_ASSISTANT }],
  },
]

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

export function Shell({ children }: { children: ReactNode }) {
  const location = useLocation()
  const navigate = useNavigate()
  const [collapsed, setCollapsed] = useState(false)
  const workspaceRoute = location.pathname === '/explore'
  const compactViewport = useMediaQuery('(max-width: 1099px)')
  const mobileViewport = useMediaQuery('(max-width: 639px)')
  const mobileWorkspace = workspaceRoute && mobileViewport
  const compactWorkspace = workspaceRoute && compactViewport && !mobileViewport
  const [drawerOpen, setDrawerOpen] = useState(false)
  const navigationButton = useRef<HTMLButtonElement>(null)
  const sidebarRef = useRef<HTMLElement>(null)
  const labelsHidden = !mobileWorkspace && (compactWorkspace || collapsed)
  const [commandSearchOpen, setCommandSearchOpen] = useState(false)

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const tag = target?.tagName
      const editable =
        tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable
      // '?' (no modifiers, not while typing) -> the keyboard-shortcuts reference in the Guide.
      if (event.key === '?' && !editable && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault()
        navigate('/guide?section=shortcuts')
        return
      }
      if (!(event.metaKey || event.ctrlKey)) return
      const key = event.key.toLowerCase()
      if (key === 'k') {
        event.preventDefault()
        setCommandSearchOpen(true)
      } else if (key === 'b') {
        event.preventDefault()
        setCollapsed((current) => !current)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [navigate])

  useEffect(() => {
    setDrawerOpen(false)
  }, [location.pathname, location.search, mobileWorkspace])

  useEffect(() => {
    if (!drawerOpen || !mobileWorkspace) return
    const sidebar = sidebarRef.current
    const previousFocus = document.activeElement as HTMLElement | null
    const focusable = () =>
      Array.from(
        sidebar?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])') ?? [],
      ).filter((element) => element.getClientRects().length > 0)
    focusable()[0]?.focus()
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setDrawerOpen(false)
      }
      if (event.key === 'Tab') {
        const elements = focusable()
        const first = elements[0]
        const last = elements[elements.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last?.focus()
        }
        if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first?.focus()
        }
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('keydown', handleKey)
      if (navigationButton.current?.isConnected) navigationButton.current.focus()
      else if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [drawerOpen, mobileWorkspace])
  const isActive = (path: string) => {
    if (path === '/') return location.pathname === '/'
    if (path === '/explore')
      return location.pathname === '/explore' || location.pathname === '/genes'
    if (path === '/experiments') {
      return (
        location.pathname === '/experiments' ||
        location.pathname === '/experiments/new' ||
        location.pathname === '/experiments/batch'
      )
    }
    return location.pathname.startsWith(path)
  }

  return (
    <div
      className={`app-shell flex h-screen min-h-screen overflow-hidden bg-gray-50 ${workspaceRoute ? 'workspace-shell' : ''}`}
    >
      {mobileWorkspace && (
        <button
          ref={navigationButton}
          type="button"
          className="workspace-navigation-toggle"
          aria-label="Open workspace navigation"
          aria-controls="workspace-navigation"
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen(true)}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M3 5h14M3 10h14M3 15h14" />
          </svg>
          Navigation
        </button>
      )}
      {mobileWorkspace && drawerOpen && (
        <div
          className="workspace-navigation-backdrop"
          aria-hidden="true"
          onClick={() => setDrawerOpen(false)}
        />
      )}
      <aside
        ref={sidebarRef}
        id={workspaceRoute ? 'workspace-navigation' : undefined}
        role={mobileWorkspace && drawerOpen ? 'dialog' : undefined}
        aria-modal={mobileWorkspace && drawerOpen ? true : undefined}
        aria-label={mobileWorkspace && drawerOpen ? 'Workspace navigation' : undefined}
        aria-hidden={mobileWorkspace && !drawerOpen ? true : undefined}
        {...(mobileWorkspace && !drawerOpen ? { inert: '' } : {})}
        data-drawer-open={drawerOpen}
        className={`flex h-screen flex-shrink-0 flex-col border-r border-gray-200 bg-white transition-[width] duration-200 ${
          labelsHidden ? 'w-16' : 'w-60'
        }`}
      >
        <div className="flex h-14 items-center gap-2 border-b border-gray-100 px-3">
          <Link to="/" className="flex min-w-0 flex-1 items-center gap-2">
            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-brand-600">
              <span className="text-xs font-semibold text-white">wc</span>
            </div>
            {!labelsHidden && <span className="truncate font-semibold text-gray-900">wcEcoli</span>}
          </Link>
          <button
            type="button"
            onClick={() =>
              mobileWorkspace ? setDrawerOpen(false) : setCollapsed((current) => !current)
            }
            className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
            title={
              mobileWorkspace
                ? 'Close navigation'
                : compactWorkspace
                  ? 'Navigation labels appear on wider screens'
                  : labelsHidden
                    ? 'Show navigation labels'
                    : 'Hide navigation labels'
            }
            disabled={compactWorkspace}
            aria-label={
              mobileWorkspace
                ? 'Close navigation'
                : labelsHidden
                  ? 'Show navigation labels'
                  : 'Hide navigation labels'
            }
          >
            <NavIcon d={labelsHidden ? ICON_EXPAND : ICON_COLLAPSE} className="h-4 w-4" />
          </button>
          {/* Command search lives on Ctrl/Cmd-K (documented in Guide → Keyboard shortcuts);
              the always-visible button was removed to declutter the header. */}
        </div>

        <nav aria-label="Platform navigation" className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
          {NAV_GROUPS.map((group) => (
            <div key={group.id} className="mb-4">
              {!labelsHidden && group.label && (
                <div className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                  {group.label}
                </div>
              )}
              <div className="space-y-1">
                {group.items.map((item) => {
                  const active = isActive(item.path)
                  return (
                    <Link
                      key={item.path}
                      to={item.path}
                      aria-label={labelsHidden ? item.label : undefined}
                      aria-current={active ? 'page' : undefined}
                      title={labelsHidden ? item.label : undefined}
                      className={`flex items-center gap-2 rounded-md px-2 py-2 text-sm font-medium transition-colors ${
                        active
                          ? 'bg-brand-50 text-brand-700'
                          : 'text-gray-500 hover:bg-gray-50 hover:text-gray-800'
                      } ${labelsHidden ? 'justify-center' : ''}`}
                    >
                      <NavIcon d={item.icon} />
                      {!labelsHidden && <span className="truncate">{item.label}</span>}
                    </Link>
                  )
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="border-t border-gray-100 p-2">
          <ThemeToggle collapsed={labelsHidden} />
          <Link
            to="/guide"
            title={labelsHidden ? 'Guide' : undefined}
            className={`flex items-center gap-2 rounded-md px-2 py-2 text-sm font-medium transition-colors ${
              location.pathname === '/guide'
                ? 'bg-brand-50 text-brand-700'
                : 'text-gray-500 hover:bg-gray-50 hover:text-gray-800'
            } ${labelsHidden ? 'justify-center' : ''}`}
          >
            <NavIcon d={ICON_GUIDE} />
            {!labelsHidden && <span>Guide</span>}
          </Link>
          {!labelsHidden && (
            <div className="mt-2 px-2 pb-1 text-xs text-gray-400">E. coli K-12 MG1655</div>
          )}
        </div>
      </aside>

      <main
        className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-4"
        {...(mobileWorkspace && drawerOpen ? { inert: '' } : {})}
      >
        {children}
      </main>
      <CommandSearch open={commandSearchOpen} onClose={() => setCommandSearchOpen(false)} />
      <AssistantDock />
    </div>
  )
}
