import { Routes, Route } from 'react-router-dom'
import { Shell } from './components/layout/Shell'
import { GeneCatalogPage } from './components/genes/GeneCatalogPage'
import { TFNetworkPage } from './components/network/TFNetworkPage'
import { ExperimentListPage } from './components/experiments/ExperimentListPage'
import { ExperimentDesigner } from './components/experiments/ExperimentDesigner'
import { ExperimentGuidePage } from './components/experiments/ExperimentGuidePage'
import { ResultsPage } from './components/results/ResultsPage'
import { ResultsBrowserPage } from './components/results/ResultsBrowserPage'
import { MLPage } from './components/ml/MLPage'
import { DesignPage } from './components/design/DesignPage'

export default function App() {
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<GeneCatalogPage />} />
        <Route path="/network" element={<TFNetworkPage />} />
        <Route path="/experiments" element={<ExperimentListPage />} />
        <Route path="/experiments/new" element={<ExperimentDesigner />} />
        <Route path="/guide" element={<ExperimentGuidePage />} />
        <Route path="/results" element={<ResultsBrowserPage />} />
        <Route path="/results/:jobId" element={<ResultsPage />} />
        <Route path="/ml" element={<MLPage />} />
        <Route path="/design" element={<DesignPage />} />
      </Routes>
    </Shell>
  )
}
