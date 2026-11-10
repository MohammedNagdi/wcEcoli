import {IS_EXPLORER} from '../explorer/mode'
export const API_BASE = '/api'

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  if (IS_EXPLORER && init?.method && !['GET','HEAD','OPTIONS'].includes(init.method.toUpperCase())) {
    throw new Error('The public explorer cannot execute work or change shared data. Save a personal browser draft instead.')
  }
  return fetch(`${API_BASE}${path}`, init)
}

export async function fetchJSON<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init)
  if (!res.ok) {
    throw new ApiError(res.status, `API error ${res.status}: ${await res.text()}`)
  }
  return res.json()
}
