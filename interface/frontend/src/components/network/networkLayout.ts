import type { ElementDefinition } from 'cytoscape'
import { getTFNetwork } from '../../api/client'
import type { TFNetwork } from '../../types'

export type NetworkPositions = Record<string, { x: number; y: number }>
export interface LayoutRequest {
  key: string
  elements: ElementDefinition[]
  viewport: { width: number; height: number }
}
export type LayoutResult =
  | { key: string; positions: NetworkPositions }
  | { key: string; error: string }
let data: Promise<TFNetwork> | null = null
const layouts = new Map<string, Promise<NetworkPositions>>()

// A rejected request is never retained. Concurrent mounts share successful/in-flight work.
export function loadNetwork(): Promise<TFNetwork> {
  if (!data)
    data = getTFNetwork().catch((error) => {
      data = null
      throw error
    })
  return data
}

export function networkLayoutKey(elements: ElementDefinition[]): string {
  // Keep the content itself as the key: no hash collision can return another dataset's positions.
  return JSON.stringify(elements.map((element) => element.data))
}

export function arrangeNetwork(
  elements: ElementDefinition[],
  viewport: { width: number; height: number },
): Promise<NetworkPositions> {
  const key = networkLayoutKey(elements)
  const cached = layouts.get(key)
  if (cached) return cached
  const promise = new Promise<NetworkPositions>((resolve, reject) => {
    const worker = new Worker(new URL('./networkLayout.worker.ts', import.meta.url), {
      type: 'module',
    })
    const timeout = window.setTimeout(() => finish(new Error('Network layout timed out.')), 20000)
    function finish(error?: Error, positions?: NetworkPositions) {
      window.clearTimeout(timeout)
      worker.terminate()
      if (error) reject(error)
      else resolve(positions!)
    }
    worker.onerror = () => finish(new Error('Could not arrange the network.'))
    worker.onmessage = (event: MessageEvent<LayoutResult>) => {
      const result = event.data
      if (result.key !== key) return
      if ('error' in result) return finish(new Error(result.error))
      const valid = elements
        .filter((element) => !element.data.source)
        .every((node) => {
          const position = result.positions[node.data.id!]
          return position && Number.isFinite(position.x) && Number.isFinite(position.y)
        })
      finish(
        valid ? undefined : new Error('Network layout returned incomplete positions.'),
        result.positions,
      )
    }
    worker.postMessage({ key, elements, viewport } satisfies LayoutRequest)
  }).catch((error) => {
    layouts.delete(key)
    throw error
  })
  layouts.set(key, promise)
  return promise
}
