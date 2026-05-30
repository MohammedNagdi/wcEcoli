import { create } from 'zustand'

export type ExploreView = 'genes' | 'network' | 'genome' | 'pathways' | 'essentiality'
export type AnalyzeView = 'results' | 'comparison' | 'molecules'

export interface WorkspaceContext {
  selectedGene: string | null
  selectedCategory: string | null
  selectedCondition: string | null
  selectedExperimentId: number | null
  selectedJobId: number | null
  exploreView: ExploreView
  analyzeView: AnalyzeView
}

interface WorkspaceStore extends WorkspaceContext {
  setWorkspaceState: (patch: Partial<WorkspaceContext>) => void
  setSelectedGene: (selectedGene: string | null) => void
  setSelectedCategory: (selectedCategory: string | null) => void
  setSelectedCondition: (selectedCondition: string | null) => void
  setSelectedExperimentId: (selectedExperimentId: number | null) => void
  setSelectedJobId: (selectedJobId: number | null) => void
  setExploreView: (exploreView: ExploreView) => void
  setAnalyzeView: (analyzeView: AnalyzeView) => void
}

export const useWorkspaceStore = create<WorkspaceStore>((set) => ({
  selectedGene: null,
  selectedCategory: null,
  selectedCondition: null,
  selectedExperimentId: null,
  selectedJobId: null,
  exploreView: 'genes',
  analyzeView: 'results',
  setWorkspaceState: (patch) => set(patch),
  setSelectedGene: (selectedGene) => set({ selectedGene }),
  setSelectedCategory: (selectedCategory) => set({ selectedCategory }),
  setSelectedCondition: (selectedCondition) => set({ selectedCondition }),
  setSelectedExperimentId: (selectedExperimentId) => set({ selectedExperimentId }),
  setSelectedJobId: (selectedJobId) => set({ selectedJobId }),
  setExploreView: (exploreView) => set({ exploreView }),
  setAnalyzeView: (analyzeView) => set({ analyzeView }),
}))
