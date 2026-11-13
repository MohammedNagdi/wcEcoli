import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { getAllGenes } from '../../api/client'
import { IS_EXPLORER } from '../../explorer/mode'
import { explorerReferenceFingerprint } from '../../explorer/readiness'
import type { Gene } from '../../types'

type Catalog = { genes: Gene[]; loading: boolean; error: string | null }

const empty: Catalog = { genes: [], loading: true, error: null }
const listeners = new Set<() => void>()
let explorerLoad: { reference: string; controller: AbortController; catalog: Catalog } | undefined

function startExplorerLoad(reference: string) {
  explorerLoad?.controller.abort()
  const controller = new AbortController()
  const load = { reference, controller, catalog: empty }
  explorerLoad = load

  function update(catalog: Catalog) {
    if (explorerLoad !== load) return
    load.catalog = catalog
    listeners.forEach((listener) => listener())
  }

  update(empty)
  void getAllGenes((batch) => {
    update({ ...load.catalog, genes: [...load.catalog.genes, ...batch] })
  }, controller.signal).then(() => {
    update({ ...load.catalog, loading: false })
  }).catch((error) => {
    update({ ...load.catalog, loading: false, error: error.message })
  })
}

export function useGenomeCatalog() {
  const reference = IS_EXPLORER ? explorerReferenceFingerprint() : null
  const subscribe = useCallback((listener: () => void) => {
    if (reference === null) return () => {}
    listeners.add(listener)
    if (explorerLoad?.reference !== reference) startExplorerLoad(reference)
    // Keep loading while the map is off screen so the next visit can reuse it.
    return () => { listeners.delete(listener) }
  }, [reference])
  const snapshot = useCallback(() => (
    explorerLoad && explorerLoad.reference === reference ? explorerLoad.catalog : empty
  ), [reference])
  const explorerCatalog = useSyncExternalStore(subscribe, snapshot)

  const [localCatalog, setLocalCatalog] = useState(empty)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (IS_EXPLORER) return
    const controller = new AbortController()
    setLocalCatalog(empty)
    void getAllGenes((batch) => {
      if (!controller.signal.aborted) {
        setLocalCatalog((current) => ({ ...current, genes: [...current.genes, ...batch] }))
      }
    }, controller.signal).catch((error) => {
      if (!controller.signal.aborted) setLocalCatalog((current) => ({ ...current, error: error.message }))
    }).finally(() => {
      if (!controller.signal.aborted) setLocalCatalog((current) => ({ ...current, loading: false }))
    })
    return () => controller.abort()
  }, [attempt])

  return {
    ...(IS_EXPLORER ? explorerCatalog : localCatalog),
    retry: () => {
      if (reference !== null) startExplorerLoad(reference)
      else setAttempt((current) => current + 1)
    },
  }
}
