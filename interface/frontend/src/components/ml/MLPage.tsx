import { useState, useEffect } from 'react'
import { getDataSummary, getFeatures, getFeaturesCSVUrl, trainModel } from '../../api/client'
import { HelpTip } from '../common/HelpTip'
import type {
  DataSummary, FeatureExtractionResponse, FeatureRow,
  TrainRequest, TrainResponse,
} from '../../types'

const ALGORITHMS = [
  { value: 'random_forest', label: 'Random Forest', desc: 'Ensemble of decision trees — robust, interpretable feature importances' },
  { value: 'gradient_boosting', label: 'Gradient Boosting', desc: 'Sequential boosted trees — often higher accuracy, slower training' },
  { value: 'logistic_regression', label: 'Logistic Regression / Ridge', desc: 'Linear model — fast, interpretable coefficients' },
]

const TARGETS = [
  { value: 'divided', label: 'Cell division (yes/no)', type: 'classification', desc: 'Predict whether the knockout cell completes division' },
  { value: 'growth_rate', label: 'Growth rate', type: 'regression', desc: 'Predict instantaneous growth rate (1/s)' },
  { value: 'doubling_time_min', label: 'Doubling time', type: 'regression', desc: 'Predict doubling time in minutes' },
]

function Pct({ value, decimals = 1 }: { value: number; decimals?: number }) {
  return <span className="font-mono">{(value * 100).toFixed(decimals)}%</span>
}

function MetricCard({ label, value, unit, color }: { label: string; value: string; unit?: string; color?: string }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 px-4 py-3">
      <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-0.5">{label}</p>
      <p className={'text-lg font-semibold ' + (color ?? 'text-gray-800')}>
        {value}
        {unit && <span className="text-xs text-gray-400 ml-1 font-normal">{unit}</span>}
      </p>
    </div>
  )
}

function ConfusionMatrixViz({ cm }: { cm: { tp: number; fp: number; tn: number; fn: number } }) {
  const total = cm.tp + cm.fp + cm.tn + cm.fn
  const pct = (v: number) => total > 0 ? ((v / total) * 100).toFixed(1) + '%' : '0%'
  return (
    <div className="inline-grid grid-cols-3 gap-0 text-xs text-center">
      <div />
      <div className="px-2 py-1 text-gray-400 font-medium">Pred +</div>
      <div className="px-2 py-1 text-gray-400 font-medium">Pred −</div>
      <div className="px-2 py-1 text-gray-400 font-medium text-right">Actual +</div>
      <div className="px-3 py-2 bg-green-50 border border-green-200 rounded-tl font-mono">
        <div className="text-green-700 font-semibold">{cm.tp}</div>
        <div className="text-green-500 text-[10px]">TP {pct(cm.tp)}</div>
      </div>
      <div className="px-3 py-2 bg-red-50 border border-red-200 rounded-tr font-mono">
        <div className="text-red-700 font-semibold">{cm.fn}</div>
        <div className="text-red-500 text-[10px]">FN {pct(cm.fn)}</div>
      </div>
      <div className="px-2 py-1 text-gray-400 font-medium text-right">Actual −</div>
      <div className="px-3 py-2 bg-red-50 border border-red-200 rounded-bl font-mono">
        <div className="text-red-700 font-semibold">{cm.fp}</div>
        <div className="text-red-500 text-[10px]">FP {pct(cm.fp)}</div>
      </div>
      <div className="px-3 py-2 bg-green-50 border border-green-200 rounded-br font-mono">
        <div className="text-green-700 font-semibold">{cm.tn}</div>
        <div className="text-green-500 text-[10px]">TN {pct(cm.tn)}</div>
      </div>
    </div>
  )
}

function FeatureImportanceBar({ features }: { features: { feature: string; importance: number }[] }) {
  const maxImp = Math.max(...features.map(f => f.importance), 0.001)
  return (
    <div className="space-y-1.5">
      {features.map((f) => (
        <div key={f.feature} className="flex items-center gap-2">
          <span className="text-xs text-gray-600 w-40 text-right truncate font-mono">{f.feature}</span>
          <div className="flex-1 h-5 bg-gray-100 rounded overflow-hidden">
            <div
              className="h-full bg-brand-500 rounded transition-all"
              style={{ width: `${(f.importance / maxImp) * 100}%` }}
            />
          </div>
          <span className="text-xs text-gray-500 w-14 font-mono text-right">
            {(f.importance * 100).toFixed(1)}%
          </span>
        </div>
      ))}
    </div>
  )
}


export function MLPage() {
  const [summary, setSummary] = useState<DataSummary | null>(null)
  const [features, setFeatures] = useState<FeatureExtractionResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [featuresLoading, setFeaturesLoading] = useState(false)

  // Training state
  const [algorithm, setAlgorithm] = useState('random_forest')
  const [target, setTarget] = useState('divided')
  const [filterCondition, setFilterCondition] = useState('')
  const [filterVariant, setFilterVariant] = useState('')
  const [mechanisticOnly, setMechanisticOnly] = useState(true)
  const [testFraction, setTestFraction] = useState(0.2)
  const [nEstimators, setNEstimators] = useState(100)
  const [maxDepth, setMaxDepth] = useState<number | null>(null)

  const [training, setTraining] = useState(false)
  const [result, setResult] = useState<TrainResponse | null>(null)
  const [trainError, setTrainError] = useState('')
  const [history, setHistory] = useState<TrainResponse[]>([])

  // Load data summary on mount
  useEffect(() => {
    setLoading(true)
    getDataSummary()
      .then(setSummary)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  // Load feature preview
  const loadFeatures = () => {
    setFeaturesLoading(true)
    getFeatures({
      condition: filterCondition || undefined,
      variant_type: filterVariant || undefined,
      mechanistic_only: mechanisticOnly || undefined,
    })
      .then(setFeatures)
      .catch(() => {})
      .finally(() => setFeaturesLoading(false))
  }

  useEffect(() => {
    loadFeatures()
  }, [filterCondition, filterVariant, mechanisticOnly])

  const handleTrain = async () => {
    setTraining(true)
    setTrainError('')
    setResult(null)
    try {
      const res = await trainModel({
        algorithm,
        target,
        condition: filterCondition,
        variant_type: filterVariant,
        mechanistic_only: mechanisticOnly,
        test_fraction: testFraction,
        n_estimators: nEstimators,
        max_depth: maxDepth,
        random_state: 42,
      })
      setResult(res)
      setHistory(prev => [res, ...prev])
    } catch (err: any) {
      setTrainError(err.message || 'Training failed')
    } finally {
      setTraining(false)
    }
  }

  const csvUrl = getFeaturesCSVUrl({
    condition: filterCondition || undefined,
    variant_type: filterVariant || undefined,
    mechanistic_only: mechanisticOnly || undefined,
  })

  const targetInfo = TARGETS.find(t => t.value === target)

  return (
    <div className="max-w-6xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
          Machine Learning
          <HelpTip text="Train surrogate models on simulation data. These models learn to predict simulation outcomes (division, growth rate) from gene/condition features — much faster than running full simulations." />
        </h1>
        <p className="text-sm text-gray-400 mt-1">
          Train surrogate models to predict simulation outcomes from gene knockout features
        </p>
      </div>

      {/* Data overview cards */}
      {loading ? (
        <div className="text-center py-8 text-gray-400">
          <div className="inline-block w-5 h-5 border-2 border-brand-500 border-t-transparent rounded-full animate-spin mr-2" />
          Loading data summary...
        </div>
      ) : summary ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3 mb-6">
          <MetricCard label="Experiments" value={String(summary.total_experiments)} />
          <MetricCard label="Completed jobs" value={String(summary.total_completed_jobs)} color="text-green-600" />
          <MetricCard label="Total genes" value={String(summary.total_genes)} />
          <MetricCard label="Mechanistic" value={String(summary.mechanistic_genes)} color="text-brand-600" />
          <MetricCard label="Divided" value={String(summary.divided_count)} color="text-green-600" />
          <MetricCard label="Not divided" value={String(summary.not_divided_count)} color="text-red-600" />
        </div>
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left column: Configuration */}
        <div className="lg:col-span-1 space-y-4">
          {/* Filters */}
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <h2 className="text-sm font-semibold text-gray-700 mb-3">Data filters</h2>

            <div className="space-y-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Condition</label>
                <select
                  value={filterCondition}
                  onChange={(e) => setFilterCondition(e.target.value)}
                  className="w-full text-sm border border-gray-300 rounded-md px-2 py-1.5 bg-white"
                >
                  <option value="">All conditions</option>
                  {summary?.conditions.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs text-gray-500 mb-1">Variant type</label>
                <select
                  value={filterVariant}
                  onChange={(e) => setFilterVariant(e.target.value)}
                  className="w-full text-sm border border-gray-300 rounded-md px-2 py-1.5 bg-white"
                >
                  <option value="">All variants</option>
                  {summary?.variant_types.map((v) => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
              </div>

              <label className="flex items-center gap-2 text-sm text-gray-600">
                <input
                  type="checkbox"
                  checked={mechanisticOnly}
                  onChange={(e) => setMechanisticOnly(e.target.checked)}
                  className="rounded border-gray-300"
                />
                Mechanistic genes only
              </label>

              {features && (
                <p className="text-xs text-gray-400 pt-1">
                  {features.total_rows} samples from {features.total_experiments} experiments ({features.total_genes} genes)
                </p>
              )}
            </div>
          </div>

          {/* Model config */}
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <h2 className="text-sm font-semibold text-gray-700 mb-3">Model configuration</h2>

            <div className="space-y-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Algorithm</label>
                {ALGORITHMS.map((a) => (
                  <label key={a.value} className="flex items-start gap-2 mb-2 cursor-pointer">
                    <input
                      type="radio"
                      name="algorithm"
                      value={a.value}
                      checked={algorithm === a.value}
                      onChange={() => setAlgorithm(a.value)}
                      className="mt-0.5"
                    />
                    <div>
                      <p className="text-sm text-gray-700 font-medium">{a.label}</p>
                      <p className="text-[11px] text-gray-400">{a.desc}</p>
                    </div>
                  </label>
                ))}
              </div>

              <div>
                <label className="block text-xs text-gray-500 mb-1">Target variable</label>
                <select
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  className="w-full text-sm border border-gray-300 rounded-md px-2 py-1.5 bg-white"
                >
                  {TARGETS.map((t) => (
                    <option key={t.value} value={t.value}>{t.label} ({t.type})</option>
                  ))}
                </select>
                {targetInfo && (
                  <p className="text-[11px] text-gray-400 mt-1">{targetInfo.desc}</p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Test split</label>
                  <input
                    type="number"
                    min={0.1}
                    max={0.5}
                    step={0.05}
                    value={testFraction}
                    onChange={(e) => setTestFraction(parseFloat(e.target.value))}
                    className="w-full text-sm border border-gray-300 rounded-md px-2 py-1.5"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Estimators</label>
                  <input
                    type="number"
                    min={10}
                    max={1000}
                    step={10}
                    value={nEstimators}
                    onChange={(e) => setNEstimators(parseInt(e.target.value))}
                    className="w-full text-sm border border-gray-300 rounded-md px-2 py-1.5"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs text-gray-500 mb-1">
                  Max depth
                  <span className="text-gray-300 ml-1">(empty = unlimited)</span>
                </label>
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={maxDepth ?? ''}
                  onChange={(e) => setMaxDepth(e.target.value ? parseInt(e.target.value) : null)}
                  className="w-full text-sm border border-gray-300 rounded-md px-2 py-1.5"
                  placeholder="No limit"
                />
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-2">
            <button
              onClick={handleTrain}
              disabled={training || !features || features.total_rows < 10}
              className="flex-1 px-4 py-2.5 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 disabled:bg-gray-300 rounded-lg transition-colors flex items-center justify-center gap-2"
            >
              {training ? (
                <>
                  <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Training...
                </>
              ) : (
                'Train model'
              )}
            </button>
            <a
              href={csvUrl}
              download
              className="px-4 py-2.5 text-sm font-medium text-gray-600 bg-white border border-gray-300 hover:bg-gray-50 rounded-lg transition-colors"
            >
              CSV
            </a>
          </div>

          {trainError && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
              {trainError}
            </div>
          )}
        </div>

        {/* Right column: Results */}
        <div className="lg:col-span-2 space-y-4">
          {/* Latest result */}
          {result && (
            <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
                <div>
                  <h2 className="font-semibold text-gray-900">
                    {ALGORITHMS.find(a => a.value === result.algorithm)?.label ?? result.algorithm}
                  </h2>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {result.task_type === 'classification' ? 'Classification' : 'Regression'}
                    {' · '}Target: {TARGETS.find(t => t.value === result.target)?.label ?? result.target}
                    {' · '}{result.n_train} train / {result.n_test} test
                    {' · '}{result.training_time_sec.toFixed(2)}s
                  </p>
                </div>
                <span className="text-xs font-mono text-gray-300">{result.model_id}</span>
              </div>

              <div className="p-5 space-y-5">
                {/* Classification metrics */}
                {result.classification && (
                  <div>
                    <h3 className="text-sm font-medium text-gray-700 mb-3">Performance metrics</h3>
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-4">
                      <MetricCard label="Accuracy" value={(result.classification.accuracy * 100).toFixed(1) + '%'} color="text-brand-600" />
                      <MetricCard label="Precision" value={(result.classification.precision * 100).toFixed(1) + '%'} />
                      <MetricCard label="Recall" value={(result.classification.recall * 100).toFixed(1) + '%'} />
                      <MetricCard label="F1 Score" value={(result.classification.f1 * 100).toFixed(1) + '%'} />
                      <MetricCard
                        label="AUC-ROC"
                        value={result.classification.auc_roc != null ? result.classification.auc_roc.toFixed(3) : '—'}
                      />
                    </div>

                    <div className="flex items-start gap-8">
                      <div>
                        <p className="text-xs text-gray-500 mb-2 font-medium">Confusion matrix</p>
                        <ConfusionMatrixViz cm={result.classification.confusion} />
                      </div>

                      {result.cross_val_mean != null && (
                        <div>
                          <p className="text-xs text-gray-500 mb-2 font-medium">
                            Cross-validation (5-fold)
                          </p>
                          <div className="space-y-1">
                            {result.cross_val_scores.map((s, i) => (
                              <div key={i} className="flex items-center gap-2">
                                <span className="text-[10px] text-gray-400 w-10">Fold {i + 1}</span>
                                <div className="w-24 h-3 bg-gray-100 rounded overflow-hidden">
                                  <div
                                    className="h-full bg-brand-400 rounded"
                                    style={{ width: `${s * 100}%` }}
                                  />
                                </div>
                                <span className="text-[11px] font-mono text-gray-600">{(s * 100).toFixed(1)}%</span>
                              </div>
                            ))}
                            <p className="text-xs text-gray-600 font-medium mt-1">
                              Mean: {(result.cross_val_mean * 100).toFixed(1)}%
                              <span className="text-gray-400 font-normal"> ± {((result.cross_val_std ?? 0) * 100).toFixed(1)}%</span>
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Regression metrics */}
                {result.regression && (
                  <div>
                    <h3 className="text-sm font-medium text-gray-700 mb-3">Performance metrics</h3>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                      <MetricCard label="R²" value={result.regression.r2.toFixed(3)} color="text-brand-600" />
                      <MetricCard label="RMSE" value={result.regression.rmse.toFixed(3)} />
                      <MetricCard label="MAE" value={result.regression.mae.toFixed(3)} />
                      <MetricCard
                        label="MAPE"
                        value={result.regression.mape != null ? result.regression.mape.toFixed(1) + '%' : '—'}
                      />
                    </div>

                    {result.cross_val_mean != null && (
                      <div>
                        <p className="text-xs text-gray-500 mb-2 font-medium">Cross-validation R² (5-fold)</p>
                        <div className="space-y-1">
                          {result.cross_val_scores.map((s, i) => (
                            <div key={i} className="flex items-center gap-2">
                              <span className="text-[10px] text-gray-400 w-10">Fold {i + 1}</span>
                              <div className="w-24 h-3 bg-gray-100 rounded overflow-hidden">
                                <div
                                  className="h-full bg-brand-400 rounded"
                                  style={{ width: `${Math.max(0, s) * 100}%` }}
                                />
                              </div>
                              <span className="text-[11px] font-mono text-gray-600">{s.toFixed(3)}</span>
                            </div>
                          ))}
                          <p className="text-xs text-gray-600 font-medium mt-1">
                            Mean R²: {result.cross_val_mean.toFixed(3)}
                            <span className="text-gray-400 font-normal"> ± {(result.cross_val_std ?? 0).toFixed(3)}</span>
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Feature importances */}
                {result.feature_importances.length > 0 && (
                  <div>
                    <h3 className="text-sm font-medium text-gray-700 mb-3">Feature importances</h3>
                    <FeatureImportanceBar features={result.feature_importances} />
                  </div>
                )}
              </div>
            </div>
          )}

          {/* No result yet */}
          {!result && !training && (
            <div className="bg-white rounded-lg border border-gray-200 p-8 text-center">
              <svg className="w-10 h-10 mx-auto mb-3 text-gray-200" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
              </svg>
              <p className="text-gray-500 font-medium mb-1">Configure and train a model</p>
              <p className="text-sm text-gray-400">
                Select an algorithm, target variable, and data filters, then click "Train model".
                {features && features.total_rows < 10 && (
                  <span className="text-amber-600 block mt-2">
                    Need at least 10 samples. Currently {features.total_rows}. Run more simulations first.
                  </span>
                )}
              </p>
            </div>
          )}

          {/* Feature data preview */}
          {features && features.rows.length > 0 && (
            <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
              <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
                <h3 className="text-sm font-medium text-gray-700">
                  Feature matrix preview
                  <span className="text-gray-400 font-normal ml-2">
                    (showing {Math.min(20, features.rows.length)} of {features.total_rows} rows)
                  </span>
                </h3>
                <a
                  href={csvUrl}
                  download
                  className="text-xs text-brand-600 hover:text-brand-700 font-medium"
                >
                  Download full CSV
                </a>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium text-gray-500">Gene</th>
                      <th className="text-left px-3 py-2 font-medium text-gray-500">Category</th>
                      <th className="text-left px-3 py-2 font-medium text-gray-500">Condition</th>
                      <th className="text-center px-3 py-2 font-medium text-gray-500">Seed</th>
                      <th className="text-center px-3 py-2 font-medium text-gray-500">Divided</th>
                      <th className="text-right px-3 py-2 font-medium text-gray-500">Div. time (min)</th>
                      <th className="text-right px-3 py-2 font-medium text-gray-500">Mass (fg)</th>
                      <th className="text-right px-3 py-2 font-medium text-gray-500">Growth (×10⁻³/s)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {features.rows.slice(0, 20).map((row, i) => (
                      <tr key={i} className="hover:bg-gray-50">
                        <td className="px-3 py-1.5 font-mono text-bio-gene">{row.gene_symbol || '—'}</td>
                        <td className="px-3 py-1.5 text-gray-600 truncate max-w-[120px]">{row.category || '—'}</td>
                        <td className="px-3 py-1.5 text-gray-600">{row.condition}</td>
                        <td className="px-3 py-1.5 text-center font-mono text-gray-400">{row.seed}</td>
                        <td className="px-3 py-1.5 text-center">
                          {row.divided
                            ? <span className="text-green-600 font-medium">Yes</span>
                            : <span className="text-red-500 font-medium">No</span>
                          }
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono text-gray-600">
                          {row.division_time_sec != null ? (row.division_time_sec / 60).toFixed(1) : '—'}
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono text-gray-600">
                          {row.final_mass_fg != null ? row.final_mass_fg.toFixed(1) : '—'}
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono text-gray-600">
                          {row.growth_rate != null ? (row.growth_rate * 1000).toFixed(3) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Training history */}
          {history.length > 1 && (
            <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
              <div className="px-5 py-3 border-b border-gray-100">
                <h3 className="text-sm font-medium text-gray-700">Training history</h3>
              </div>
              <table className="w-full text-xs">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium text-gray-500">Algorithm</th>
                    <th className="text-left px-4 py-2 font-medium text-gray-500">Target</th>
                    <th className="text-left px-4 py-2 font-medium text-gray-500">Type</th>
                    <th className="text-right px-4 py-2 font-medium text-gray-500">Samples</th>
                    <th className="text-right px-4 py-2 font-medium text-gray-500">Score</th>
                    <th className="text-right px-4 py-2 font-medium text-gray-500">CV Mean</th>
                    <th className="text-right px-4 py-2 font-medium text-gray-500">Time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {history.map((h, i) => (
                    <tr
                      key={h.model_id}
                      className={'hover:bg-gray-50 cursor-pointer' + (i === 0 ? ' bg-brand-50/30' : '')}
                      onClick={() => setResult(h)}
                    >
                      <td className="px-4 py-2 font-medium text-gray-700">
                        {ALGORITHMS.find(a => a.value === h.algorithm)?.label ?? h.algorithm}
                      </td>
                      <td className="px-4 py-2 text-gray-600">
                        {TARGETS.find(t => t.value === h.target)?.label ?? h.target}
                      </td>
                      <td className="px-4 py-2">
                        <span className={'px-1.5 py-0.5 rounded text-[10px] font-medium ' + (
                          h.task_type === 'classification' ? 'bg-blue-50 text-blue-700' : 'bg-purple-50 text-purple-700'
                        )}>
                          {h.task_type}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-gray-600">{h.n_samples}</td>
                      <td className="px-4 py-2 text-right font-mono font-semibold text-gray-800">
                        {h.classification
                          ? (h.classification.accuracy * 100).toFixed(1) + '%'
                          : h.regression
                            ? 'R²=' + h.regression.r2.toFixed(3)
                            : '—'
                        }
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-gray-600">
                        {h.cross_val_mean != null
                          ? h.task_type === 'classification'
                            ? (h.cross_val_mean * 100).toFixed(1) + '%'
                            : h.cross_val_mean.toFixed(3)
                          : '—'
                        }
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-gray-400">
                        {h.training_time_sec.toFixed(2)}s
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
