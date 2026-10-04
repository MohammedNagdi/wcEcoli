import { createContext, useContext, useEffect, useId, useRef, useState, useCallback } from 'react'
import type { ReactNode } from 'react'
import { useBlocker } from 'react-router-dom'
import type { BlockerFunction } from 'react-router-dom'

type GuardContext = {
  register: (id: string, predicate: BlockerFunction) => () => void
  active: string | null
  state: 'unblocked' | 'blocked' | 'proceeding'
  proceed: (id: string) => void
  reset: () => void
}
const Context = createContext<GuardContext | null>(null)

/** React Router supports one blocker. Queue independent editors behind that one blocker. */
export function NavigationGuardProvider({ children }: { children: ReactNode }) {
  const guards = useRef(new Map<string, BlockerFunction>())
  const pending = useRef<string[]>([])
  const [active, setActive] = useState<string | null>(null)
  const blocker = useBlocker(args => {
    pending.current = Array.from(guards.current).filter(([, predicate]) => predicate(args)).map(([id]) => id)
    return pending.current.length > 0
  })
  const blockerRef = useRef(blocker)
  blockerRef.current = blocker
  useEffect(() => { setActive(blocker.state === 'blocked' ? pending.current[0] ?? null : null) }, [blocker.state])
  const proceed = useCallback((id: string) => {
    if (pending.current[0] !== id) return
    pending.current.shift()
    pending.current = pending.current.filter(key => guards.current.has(key))
    if (pending.current.length) setActive(pending.current[0])
    else { setActive(null); if (blockerRef.current.state === 'blocked') blockerRef.current.proceed() }
  }, [])
  const register = useCallback((id: string, predicate: BlockerFunction) => {
    guards.current.set(id, predicate)
    return () => { guards.current.delete(id); if (pending.current[0] === id) proceed(id) }
  }, [proceed])
  const reset = () => { pending.current = []; setActive(null); if (blocker.state === 'blocked') blocker.reset() }
  return <Context.Provider value={{ register, active, state: blocker.state, proceed, reset }}>{children}</Context.Provider>
}

export function useNavigationGuard(predicate: BlockerFunction) {
  const context = useContext(Context)
  if (!context) throw new Error('Navigation guards require NavigationGuardProvider')
  const id = useId()
  const latest = useRef(predicate)
  latest.current = predicate
  useEffect(() => context.register(id, args => latest.current(args)), [context.register, id])
  return {
    state: context.active === id ? context.state : 'unblocked',
    proceed: () => context.proceed(id),
    reset: context.reset,
  }
}
