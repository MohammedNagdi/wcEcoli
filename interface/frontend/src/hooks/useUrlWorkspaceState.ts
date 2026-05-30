import { useCallback, useEffect } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import {
  type AnalyzeView,
  type ExploreView,
  type WorkspaceContext,
  useWorkspaceStore,
} from '../store/workspace'

type WorkspaceUrlPatch = Partial<WorkspaceContext>
type GenomeUrlKey = 'genomeSearch' | 'genomeHighlight'

interface WorkspaceUrlOptions {
  pathname?: string
  replace?: boolean
  syncUrl?: boolean
}

const EXPLORE_VIEWS = new Set<ExploreView>(['genes', 'network', 'genome', 'pathways', 'essentiality'])
const ANALYZE_VIEWS = new Set<AnalyzeView>(['results', 'comparison', 'molecules'])

function cleanString(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function parseId(value: string | null): number | null {
  if (!value) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function exploreViewFromPath(pathname: string, viewParam: string | null): ExploreView | null {
  if (pathname === '/') {
    return viewParam && EXPLORE_VIEWS.has(viewParam as ExploreView)
      ? viewParam as ExploreView
      : 'genes'
  }
  if (pathname.startsWith('/network')) return 'network'
  if (pathname.startsWith('/genome')) return 'genome'
  if (pathname.startsWith('/pathways')) return 'pathways'
  if (!pathname.startsWith('/explore')) return null
  return viewParam && EXPLORE_VIEWS.has(viewParam as ExploreView)
    ? viewParam as ExploreView
    : 'genes'
}

function analyzeViewFromPath(pathname: string, viewParam: string | null): AnalyzeView | null {
  if (pathname.startsWith('/results/compare')) return 'comparison'
  if (!pathname.startsWith('/results') && !pathname.startsWith('/analyze')) return null
  return viewParam && ANALYZE_VIEWS.has(viewParam as AnalyzeView)
    ? viewParam as AnalyzeView
    : 'results'
}

function pathJobId(pathname: string): number | null {
  const match = pathname.match(/^\/results\/(\d+)$/)
  return match ? parseId(match[1]) : null
}

function setParam(params: URLSearchParams, key: string, value: string | number | null | undefined) {
  if (value === null || value === undefined || value === '') {
    params.delete(key)
  } else {
    params.set(key, String(value))
  }
}

function parseListParam(value: string | null): string[] {
  return value?.split(',').map((item) => item.trim()).filter(Boolean) ?? []
}

function patchGenomeUrl(
  patch: Partial<Record<GenomeUrlKey, string | string[] | null>>,
  params: URLSearchParams
): URLSearchParams {
  const next = new URLSearchParams(params)
  if ('genomeSearch' in patch) setParam(next, 'genomeSearch', patch.genomeSearch as string | null)
  if ('genomeHighlight' in patch) {
    const value = patch.genomeHighlight
    setParam(next, 'genomeHighlight', Array.isArray(value) ? value.join(',') : value)
    next.delete('genomeDim')
  }
  return next
}

function patchForUrl(
  patch: WorkspaceUrlPatch,
  params: URLSearchParams,
  pathname: string
): URLSearchParams {
  const next = new URLSearchParams(params)

  if ('selectedGene' in patch) setParam(next, 'gene', patch.selectedGene)
  if ('selectedCategory' in patch) setParam(next, 'category', patch.selectedCategory)
  if ('selectedCondition' in patch) setParam(next, 'condition', patch.selectedCondition)
  if ('selectedExperimentId' in patch) setParam(next, 'experiment', patch.selectedExperimentId)
  if ('selectedJobId' in patch) setParam(next, 'job', patch.selectedJobId)
  if ('exploreView' in patch && (pathname === '/' || pathname.startsWith('/explore'))) {
    setParam(next, 'view', patch.exploreView)
  }
  if ('analyzeView' in patch && (pathname.startsWith('/results') || pathname.startsWith('/analyze'))) {
    setParam(next, 'view', patch.analyzeView)
  }

  return next
}

export function WorkspaceUrlSync() {
  useSyncWorkspaceFromUrl()
  return null
}

export function useSyncWorkspaceFromUrl() {
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const setWorkspaceState = useWorkspaceStore((state) => state.setWorkspaceState)

  useEffect(() => {
    const exploreView = exploreViewFromPath(location.pathname, searchParams.get('view'))
    const analyzeView = analyzeViewFromPath(location.pathname, searchParams.get('view'))
    const patch: Partial<WorkspaceContext> = {
      selectedGene: cleanString(searchParams.get('gene')) ?? cleanString(searchParams.get('q')),
      selectedCategory: cleanString(searchParams.get('category')),
      selectedCondition: cleanString(searchParams.get('condition')),
      selectedExperimentId: parseId(searchParams.get('experiment')),
      selectedJobId: parseId(searchParams.get('job')) ?? pathJobId(location.pathname),
    }
    if (exploreView) patch.exploreView = exploreView
    if (analyzeView) patch.analyzeView = analyzeView
    setWorkspaceState(patch)
  }, [location.pathname, location.search, searchParams, setWorkspaceState])
}

export function useUrlWorkspaceState() {
  const workspace = useWorkspaceStore()
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()

  const setWorkspaceUrlState = useCallback(
    (patch: WorkspaceUrlPatch, options: WorkspaceUrlOptions = {}) => {
      useWorkspaceStore.getState().setWorkspaceState(patch)
      if (options.syncUrl === false) return

      const pathname = options.pathname ?? location.pathname
      const nextParams = patchForUrl(patch, searchParams, pathname)
      const search = nextParams.toString()
      navigate(
        { pathname, search: search ? `?${search}` : '' },
        { replace: options.replace ?? true }
      )
    },
    [location.pathname, navigate, searchParams]
  )

  const setGenomeUrlState = useCallback(
    (patch: Partial<Record<GenomeUrlKey, string | string[] | null>>, options: WorkspaceUrlOptions = {}) => {
      if (options.syncUrl === false) return

      const pathname = options.pathname ?? location.pathname
      const nextParams = patchGenomeUrl(patch, searchParams)
      const search = nextParams.toString()
      navigate(
        { pathname, search: search ? `?${search}` : '' },
        { replace: options.replace ?? true }
      )
    },
    [location.pathname, navigate, searchParams]
  )

  return {
    ...workspace,
    genomeSearch: cleanString(searchParams.get('genomeSearch')),
    genomeHighlight: parseListParam(searchParams.get('genomeHighlight')),
    setWorkspaceUrlState,
    setGenomeSearch: (genomeSearch: string | null, options?: WorkspaceUrlOptions) =>
      setGenomeUrlState({ genomeSearch }, options),
    setGenomeHighlight: (genomeHighlight: string[] | null, options?: WorkspaceUrlOptions) =>
      setGenomeUrlState({ genomeHighlight }, options),
    setSelectedGene: (selectedGene: string | null, options?: WorkspaceUrlOptions) =>
      setWorkspaceUrlState({ selectedGene }, options),
    setSelectedCategory: (selectedCategory: string | null, options?: WorkspaceUrlOptions) =>
      setWorkspaceUrlState({ selectedCategory }, options),
    setSelectedCondition: (selectedCondition: string | null, options?: WorkspaceUrlOptions) =>
      setWorkspaceUrlState({ selectedCondition }, options),
    setSelectedExperimentId: (selectedExperimentId: number | null, options?: WorkspaceUrlOptions) =>
      setWorkspaceUrlState({ selectedExperimentId }, options),
    setSelectedJobId: (selectedJobId: number | null, options?: WorkspaceUrlOptions) =>
      setWorkspaceUrlState({ selectedJobId }, options),
    setExploreView: (exploreView: ExploreView, options?: WorkspaceUrlOptions) =>
      setWorkspaceUrlState({ exploreView }, options),
    setAnalyzeView: (analyzeView: AnalyzeView, options?: WorkspaceUrlOptions) =>
      setWorkspaceUrlState({ analyzeView }, options),
  }
}
