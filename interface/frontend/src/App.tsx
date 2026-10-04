import { Navigate, Outlet, Routes, Route, useLocation } from 'react-router-dom'
import { HomePage } from './components/home/HomePage'
import { Shell } from './components/layout/Shell'
import { ExploreWorkspacePage } from './components/explore/ExploreWorkspacePage'
import { GeneCatalogPage } from './components/genes/GeneCatalogPage'
import { TFNetworkPage } from './components/network/TFNetworkPage'
import { ExperimentListPage } from './components/experiments/ExperimentListPage'
import { ExperimentDesigner } from './components/experiments/ExperimentDesigner'
import { TypedBatchBuilder } from './components/experiments/TypedBatchBuilder'
import { EnvironmentBuilderPage } from './components/experiments/EnvironmentBuilderPage'
import { ExperimentGuidePage } from './components/experiments/ExperimentGuidePage'
import { ResultsPage } from './components/results/ResultsPage'
import { ResultsBrowserPage } from './components/results/ResultsBrowserPage'
import { ComparisonDashboard } from './components/results/ComparisonDashboard'
import { AssistantPage } from './components/assistant/AssistantPage'
import { MLPage } from './components/ml/MLPage'
import { DesignPage } from './components/design/DesignPage'
import { GenomeViewerPage } from './components/genome/GenomeViewerPage'
import { PathwaysPage } from './components/pathways/PathwaysPage'
import { WorkspaceUrlSync } from './hooks/useUrlWorkspaceState'
import { NavigationGuardProvider } from './components/common/NavigationGuard'
import { AssistantProvider } from './components/assistant/AssistantProvider'

function HomeEntry() {
  const location = useLocation()
  const params = new URLSearchParams(location.search)
  const legacyWorkspace = ['gene', 'q', 'category', 'condition', 'view'].some((key) =>
    params.has(key),
  )
  return legacyWorkspace ? (
    <Navigate replace to={{ pathname: '/explore', search: location.search, hash: location.hash }} />
  ) : (
    <HomePage />
  )
}

export default function App() {
  return (
    <NavigationGuardProvider><AssistantProvider>
      <WorkspaceUrlSync />
      <Routes>
        <Route path="/" element={<HomeEntry />} />
        <Route
          element={
            <Shell>
              <Outlet />
            </Shell>
          }
        >
          <Route path="/explore" element={<ExploreWorkspacePage />} />
          <Route path="/genes" element={<GeneCatalogPage />} />
          <Route path="/network" element={<TFNetworkPage />} />
          <Route path="/genome" element={<GenomeViewerPage />} />
          <Route path="/pathways" element={<PathwaysPage />} />
          <Route path="/experiments" element={<ExperimentListPage />} />
          <Route path="/experiments/new" element={<ExperimentDesigner />} />
          <Route path="/experiments/batch" element={<TypedBatchBuilder />} />
          <Route path="/environment-builder" element={<EnvironmentBuilderPage />} />
          <Route path="/experiments/environment-builder" element={<EnvironmentBuilderPage />} />
          <Route path="/guide" element={<ExperimentGuidePage />} />
          <Route path="/results" element={<ResultsBrowserPage />} />
          <Route path="/results/compare" element={<ComparisonDashboard />} />
          <Route path="/results/:jobId" element={<ResultsPage />} />
          <Route path="/assistant" element={<AssistantPage />} />
          <Route path="/ml" element={<MLPage />} />
          <Route path="/design" element={<DesignPage />} />
        </Route>
      </Routes>
    </AssistantProvider></NavigationGuardProvider>
  )
}
