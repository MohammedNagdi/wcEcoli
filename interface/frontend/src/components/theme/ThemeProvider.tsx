import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

export type ThemeMode = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

interface ThemeContextValue {
  mode: ThemeMode
  resolvedTheme: ResolvedTheme
  setMode: (mode: ThemeMode) => void
}

const STORAGE_KEY = 'wcecoli.theme'
const ThemeContext = createContext<ThemeContextValue | null>(null)

function applyResolvedTheme(resolvedTheme: ResolvedTheme) {
  const root = document.documentElement
  root.classList.toggle('dark', resolvedTheme === 'dark')
  root.dataset.theme = resolvedTheme
  root.style.colorScheme = resolvedTheme
}

function prefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}

function validMode(value: string | null): ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system'
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    if (typeof window === 'undefined') return 'system'
    return validMode(window.localStorage.getItem(STORAGE_KEY))
  })
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() => {
    if (typeof window === 'undefined') return 'light'
    return prefersDark() ? 'dark' : 'light'
  })

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!media) return
    const handleChange = () => setSystemTheme(media.matches ? 'dark' : 'light')
    handleChange()
    media.addEventListener?.('change', handleChange)
    return () => media.removeEventListener?.('change', handleChange)
  }, [])

  const resolvedTheme: ResolvedTheme = mode === 'system' ? systemTheme : mode

  useLayoutEffect(() => {
    applyResolvedTheme(resolvedTheme)
  }, [resolvedTheme])

  const setMode = (nextMode: ThemeMode) => {
    const nextResolvedTheme = nextMode === 'system' ? systemTheme : nextMode
    applyResolvedTheme(nextResolvedTheme)
    setModeState(nextMode)
    window.localStorage.setItem(STORAGE_KEY, nextMode)
  }

  const value = useMemo(() => ({ mode, resolvedTheme, setMode }), [mode, resolvedTheme])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) throw new Error('useTheme must be used within ThemeProvider')
  return context
}
