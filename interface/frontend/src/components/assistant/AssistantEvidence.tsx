import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { AssistantToolPreview, AssistantToolExecution } from '../../types'
import type { ToolResultEntry } from './AssistantProvider'


import { asRecord } from './assistantPresentation'
import { StatusPill } from './AssistantPrimitives'

export function numericField(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function stringField(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function numberListField(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === 'number') : []
}

export function ReviewRow({
  label,
  value,
  mono = false,
  darkMode = false,
}: {
  label: string
  value: ReactNode
  mono?: boolean
  darkMode?: boolean
}) {
  return (
    <div className={`flex items-start justify-between gap-3 border-b py-2 last:border-b-0 ${
      darkMode ? 'border-slate-700' : 'border-gray-100'
    }`}>
      <dt className={`shrink-0 ${darkMode ? 'text-slate-400' : 'text-gray-500'}`}>{label}</dt>
      <dd className={`min-w-0 break-words [overflow-wrap:anywhere] text-right font-medium ${
        darkMode ? 'text-slate-100' : 'text-gray-900'
      } ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </div>
  )
}

export function ToolReviewPanel({
  title,
  preview,
  execution,
  embedded = false,
  darkMode: darkModeOverride,
}: {
  title: string
  preview: AssistantToolPreview | null
  execution: AssistantToolExecution | null
  embedded?: boolean
  darkMode?: boolean
}) {
  const darkMode = darkModeOverride ?? false
  if (!preview && !execution) return null
  const previewData = asRecord(preview?.preview)
  const experiment = asRecord(execution?.result.experiment)
  const jobIds = numberListField(execution?.result.job_ids)
  const isCreate = preview?.tool_name === 'create_experiment' || execution?.tool_name === 'create_experiment'
  const isRun = preview?.tool_name === 'run_simulation' || execution?.tool_name === 'run_simulation'
  const isInspect = preview?.tool_name === 'inspect_result' || execution?.tool_name === 'inspect_result'
  const isInspectGene = preview?.tool_name === 'inspect_gene' || execution?.tool_name === 'inspect_gene'
  const previewGene = asRecord(previewData.gene)
  const executionGene = asRecord(execution?.result.gene)
  const resultLinks = Array.isArray(execution?.result.links)
    ? execution.result.links
        .map((item) => asRecord(item))
        .filter((item) => typeof item.label === 'string' && typeof item.path === 'string' && /^\/(?!\/)/.test(item.path))
    : []
  const actionLinkClasses = `rounded-md border px-3 py-1.5 text-xs font-medium ${
    darkMode ? 'border-slate-600 bg-slate-900 text-slate-200 hover:bg-slate-800' : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
  }`

  return (
    <div className={embedded
      ? 'text-sm'
      : `overflow-hidden rounded-md border p-4 text-sm ${
        darkMode ? 'border-slate-700 bg-slate-900 text-slate-200' : 'border-gray-200 bg-white text-gray-800'
      }`}
    >
      {!embedded && (
        <div className="flex items-center justify-between gap-3">
          <div className={`font-semibold ${darkMode ? 'text-slate-100' : 'text-gray-900'}`}>{title}</div>
          {preview && (
            <StatusPill tone={preview.valid ? 'ready' : 'blocked'}>
              {preview.valid ? 'valid preview' : 'needs attention'}
            </StatusPill>
          )}
        </div>
      )}
      {preview && (
        <div className="mt-3">
          <p className={`text-sm leading-6 ${darkMode ? 'text-slate-300' : 'text-gray-600'}`}>
            {stringField(previewData.summary) || stringField(previewData.action)}
          </p>
          {preview.warnings.map((warning) => (
            <div key={warning} className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">{warning}</div>
          ))}
          {preview.errors.map((error) => (
            <div key={error} className="mt-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">{error}</div>
          ))}
          <dl className={`mt-3 rounded-md border px-3 text-xs ${
            darkMode ? 'border-slate-700 bg-slate-950/40' : 'border-gray-100 bg-gray-50'
          }`}>
            {isCreate && (
              <>
                <ReviewRow label="Gene" value={stringField(previewData.gene_symbol) || 'Not selected'} mono darkMode={darkMode} />
                <ReviewRow label="Experiment type" value={stringField(previewData.variant_type) || 'Not selected'} darkMode={darkMode} />
                <ReviewRow label="Condition" value={stringField(previewData.condition) || 'Not selected'} mono darkMode={darkMode} />
                <ReviewRow label="Time-varying protocol" value={stringField(previewData.timeline) || 'No time-varying protocol'} mono darkMode={darkMode} />
                <ReviewRow label="Wildtype control" value={previewData.include_wildtype ? 'Create or reuse' : 'Not requested'} darkMode={darkMode} />
              </>
            )}
            {isRun && (
              <>
                <ReviewRow label="Action" value={stringField(previewData.action) || 'Run simulation'} darkMode={darkMode} />
                <ReviewRow label="Experiment" value={stringField(previewData.experiment_name) || 'Selected draft'} darkMode={darkMode} />
                <ReviewRow label="Condition" value={stringField(previewData.condition) || 'From experiment'} mono darkMode={darkMode} />
              </>
            )}
            {isInspect && (
              <>
                <ReviewRow label="Action" value="Inspect result without mutating data" darkMode={darkMode} />
                <ReviewRow label="Job status" value={stringField(previewData.status) || 'Selected result'} mono darkMode={darkMode} />
                <ReviewRow label="Side effect" value={stringField(previewData.side_effect_if_executed) || 'None'} darkMode={darkMode} />
              </>
            )}
            {isInspectGene && (
              <>
                <ReviewRow label="Action" value="Read Genes Table metadata" darkMode={darkMode} />
                <ReviewRow label="Gene" value={stringField(previewGene.symbol) || stringField(executionGene.symbol) || 'Selected gene'} mono darkMode={darkMode} />
                <ReviewRow label="Category" value={stringField(previewGene.category) || stringField(executionGene.category) || 'Not cataloged'} darkMode={darkMode} />
                <ReviewRow label="KO index" value={String(previewGene.ko_index ?? executionGene.ko_index ?? 'n/a')} mono darkMode={darkMode} />
                <ReviewRow label="Protein" value={stringField(previewGene.monomer_id) || stringField(executionGene.monomer_id) || 'No linked protein'} mono darkMode={darkMode} />
                <ReviewRow label="Side effect" value={stringField(previewData.side_effect_if_executed) || 'None'} darkMode={darkMode} />
              </>
            )}
          </dl>
        </div>
      )}
      {preview && <details className="mt-3 text-xs"><summary className="cursor-pointer text-gray-500">Reviewed arguments and preview details</summary><pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-gray-50 p-3 font-mono">{JSON.stringify({ arguments: preview.normalized_arguments, preview: preview.preview }, null, 2)}</pre></details>}
      {execution && (
        <div className={`mt-3 rounded-md border p-3 ${
          darkMode ? 'border-slate-700 bg-slate-950/40' : 'border-gray-100 bg-gray-50'
        }`}>
          <div className={execution.executed ? 'font-medium text-emerald-700' : 'font-medium text-amber-700'}>
            {execution.executed ? 'Completed' : 'Not executed'}: {execution.status.replace(/_/g, ' ')}
          </div>
          <details className="mt-2 text-xs"><summary className="cursor-pointer">Recorded execution details</summary><pre className="mt-2 max-h-80 overflow-auto font-mono">{JSON.stringify(execution, null, 2)}</pre></details>
          {execution.warnings.map(warning => <p key={warning} className="mt-2 text-xs text-amber-700">{warning}</p>)}
          {execution.errors.map((error) => (
            <div key={error} className="mt-2 text-xs text-red-700">{error}</div>
          ))}
          {execution.executed && isCreate && (
            <div className="mt-3 flex flex-wrap gap-2">
              <Link
                to={`/experiments?experiment=${numericField(experiment.id) ?? ''}`}
                className={actionLinkClasses}
              >
                Open experiment
              </Link>
              <Link
                to={`/experiments/new?variant=${encodeURIComponent(stringField(experiment.variant_type) || 'gene_knockout')}`}
                className={actionLinkClasses}
              >
                Edit similar
              </Link>
            </div>
          )}
          {execution.executed && isRun && jobIds.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {jobIds.map((jobId) => (
                <Link
                  key={jobId}
                  to={`/results/${jobId}`}
                  className={actionLinkClasses}
                >
                  Open job #{jobId}
                </Link>
              ))}
              <Link
                to="/experiments"
                className={actionLinkClasses}
              >
                Monitor queue
              </Link>
            </div>
          )}
          {execution.executed && resultLinks.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {resultLinks.map((link) => (
                <Link
                  key={String(link.path)}
                  to={String(link.path)}
                  className={actionLinkClasses}
                >
                  {String(link.label)}
                </Link>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

type GroundedColumn = { key: string; label: string; mono?: boolean }
type GroundedField = { key: string; label: string }
type GroundedSection = { label: string; arrayKey: string; columns: GroundedColumn[] }
type GroundedSpec =
  | { label: string; mode: 'table'; arrayKey: string; columns: GroundedColumn[] }
  | { label: string; mode: 'totals'; totalsKey: string }
  | { label: string; mode: 'fields'; objectKey: string; fields: GroundedField[] }
  | { label: string; mode: 'multi'; sections: GroundedSection[] }

const M = (k: string, l: string) => ({ key: k, label: l, mono: true })

// Every read-only DATA adapter renders an authoritative card. Prose tools (platform_guide,
// explain_modeling) intentionally stay as the model's narration — they have no tabular ground truth.
const GROUNDED_TOOLS: Record<string, GroundedSpec> = {
  list_results: {
    label: 'Completed results', mode: 'table', arrayKey: 'results',
    columns: [M('job_id', 'Job'), { key: 'experiment_name', label: 'Experiment' }, M('condition', 'Condition'),
      M('gene_symbol', 'Gene'), M('metrics.growth_rate.mean', 'Growth rate (1/s)'), M('metrics.doubling_time_min.mean', 'Doubling (min)')],
  },
  compare_results: {
    label: 'Result comparison', mode: 'table', arrayKey: 'comparison',
    columns: [M('job_id', 'Job'), { key: 'experiment_name', label: 'Experiment' }, M('condition', 'Condition'),
      M('metrics.growth_rate.mean', 'Growth rate (1/s)'), M('metrics.doubling_time_min.mean', 'Doubling (min)'), M('metrics.final_mass_fg.mean', 'Final mass (fg)')],
  },
  list_conditions: {
    label: 'Conditions', mode: 'table', arrayKey: 'conditions',
    columns: [M('name', 'Condition'), M('nutrients', 'Nutrients'), M('doubling_time', 'Doubling (min)'), M('active_tfs', 'Active TFs'), M('inactive_tfs', 'Inactive TFs')],
  },
  list_experiments: {
    label: 'Experiments', mode: 'table', arrayKey: 'experiments',
    columns: [M('id', 'ID'), { key: 'name', label: 'Name' }, { key: 'variant_type', label: 'Type' }, M('gene_symbol', 'Gene'), M('condition', 'Condition'), { key: 'status', label: 'Status' }],
  },
  inspect_experiment: {
    label: 'Experiment jobs', mode: 'table', arrayKey: 'jobs',
    columns: [M('id', 'Job'), { key: 'status', label: 'Status' }, M('seed', 'Seed'), M('generations', 'Gens'), M('condition', 'Condition')],
  },
  inspect_result: {
    label: 'Result metrics (per cell)', mode: 'table', arrayKey: 'summary.rows',
    columns: [M('seed', 'Seed'), M('generation', 'Gen'), M('division_time_sec', 'Division (s)'), M('final_mass_fg', 'Final mass (fg)'), M('growth_rate', 'Growth rate (1/s)'), M('doubling_time_min', 'Doubling (min)'), { key: 'divided', label: 'Divided' }],
  },
  model_structure: {
    label: 'Metabolic reactions', mode: 'table', arrayKey: 'reactions',
    columns: [M('id', 'Reaction'), { key: 'direction', label: 'Direction' }, { key: 'reversible', label: 'Reversible' }, M('catalysts', 'Catalysts')],
  },
  inspect_tf_network: {
    label: 'TF regulation network', mode: 'multi',
    sections: [
      { label: 'Regulators', arrayKey: 'regulators', columns: [M('regulator', 'Regulator'), M('log2fc', 'log2FC'), { key: 'regulation', label: 'Dir' }] },
      { label: 'Targets', arrayKey: 'targets', columns: [M('target', 'Target'), M('log2fc', 'log2FC'), { key: 'regulation', label: 'Dir' }] },
    ],
  },
  inspect_gene: {
    label: 'Gene', mode: 'fields', objectKey: 'gene',
    fields: [{ key: 'symbol', label: 'Symbol' }, { key: 'ecoli_id', label: 'ECOLI id' }, { key: 'category', label: 'Category' },
      { key: 'ko_index', label: 'KO index' }, { key: 'monomer_id', label: 'Monomer' }, { key: 'position', label: 'Position' }, { key: 'strand', label: 'Strand' }],
  },
  inspect_molecule_trajectories: {
    label: 'Trajectory scope (this job)', mode: 'fields', objectKey: 'trajectory_scope',
    fields: [{ key: 'result_rows_for_this_job', label: 'Lineage trajectories' }, { key: 'seeds', label: 'Seeds' }, { key: 'generation_indices', label: 'Generations' }],
  },
  read_result_series: {
    label: 'Time-series stats', mode: 'fields', objectKey: 'series.stats',
    fields: [{ key: 'n_points', label: 'Points' }, { key: 't_start', label: 't start (s)' }, { key: 't_end', label: 't end (s)' },
      { key: 'min', label: 'Min' }, { key: 'max', label: 'Max' }, { key: 'mean', label: 'Mean' }, { key: 'first', label: 'First' }, { key: 'last', label: 'Last' }],
  },
  gene_catalog: { label: 'Gene catalog', mode: 'totals', totalsKey: 'totals' },
}

export function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), obj)
}

export function fmtGrounded(value: unknown): string {
  if (value == null || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (Array.isArray(value)) return value.length ? value.map((v) => fmtGrounded(v)).join(', ') : '—'
  if (typeof value === 'number') {
    if (value !== 0 && Math.abs(value) < 0.001) return value.toExponential(2)
    return value.toLocaleString(undefined, { maximumFractionDigits: 3 })
  }
  return String(value)
}

export function GroundedTable({ rows, columns }: { rows: unknown[]; columns: GroundedColumn[] }) {
  if (!Array.isArray(rows) || rows.length === 0) return <div className="px-2 py-1 text-xs text-gray-500">No rows.</div>
  return (
    <table className="w-full border-collapse text-xs">
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c.key} className="border-b border-gray-200 px-2 py-1.5 text-left font-semibold text-gray-600 dark:border-slate-700 dark:text-slate-300">{c.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, ri) => (
          <tr key={ri} className="border-b border-transparent even:bg-gray-50/60 last:border-b-0 dark:border-slate-800 dark:even:bg-transparent dark:hover:bg-slate-800/40">
            {columns.map((c) => (
              <td key={c.key} className={`px-2 py-1.5 align-top text-gray-800 dark:text-slate-300 ${c.mono ? 'font-mono' : ''}`}>{c.key === 'job_id' || c.key === 'id' && columns.some(col => col.label === 'Job') ? <Link className="text-brand-700 underline" to={`/results/${getPath(row, c.key)}`}>{fmtGrounded(getPath(row, c.key))}</Link> : c.key === 'gene_symbol' && typeof getPath(row, c.key) === 'string' ? <Link className="text-brand-700 underline" to={`/explore?gene=${encodeURIComponent(String(getPath(row, c.key)))}`}>{fmtGrounded(getPath(row, c.key))}</Link> : fmtGrounded(getPath(row, c.key))}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function GroundedToolResults({ entries }: { entries: ToolResultEntry[] }) {
  const cards = entries
  if (cards.length === 0) return null
  return (
    <div className="space-y-2" data-testid="grounded-results">
      {cards.map((entry, idx) => {
        const spec = GROUNDED_TOOLS[entry.tool_name] ?? { label: entry.tool_name.replace(/_/g, ' '), mode: 'raw' as const }
        return (
          <div key={`${entry.tool_name}-${idx}`} className="rounded-xl border border-gray-200 bg-white dark:border-slate-700 dark:bg-white">
            <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-2 dark:border-slate-700">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-600 dark:text-slate-200">{spec.label}</span>
              <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300 dark:ring-1 dark:ring-emerald-400/20">from platform data</span>
            </div>
            <div className="overflow-x-auto p-2">
              {spec.mode === 'totals' && (
                <div className="flex flex-wrap gap-1.5 px-1 py-1">
                  {Object.entries((getPath(entry.result, spec.totalsKey) as Record<string, unknown>) ?? {}).map(([k, v]) => (
                    <span key={k} className="rounded-md border border-gray-200 bg-gray-50 px-2 py-1 text-[11px] text-gray-700 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-300">
                      <span className="text-gray-500 dark:text-slate-500">{k.replace(/_/g, ' ')}:</span> <span className="font-mono font-medium">{fmtGrounded(v)}</span>
                    </span>
                  ))}
                </div>
              )}
              {spec.mode === 'fields' && (
                <div className="grid gap-1.5 px-1 py-1 sm:grid-cols-2">
                  {spec.fields.map((f) => (
                    <div key={f.key} className="flex items-baseline justify-between gap-2 rounded-md border border-gray-100 bg-gray-50 px-2 py-1 text-[11px] dark:border-slate-700 dark:bg-slate-900/60">
                      <span className="text-gray-500 dark:text-slate-500">{f.label}</span>
                      <span className="font-mono font-medium text-gray-800 dark:text-slate-300">{fmtGrounded(getPath(getPath(entry.result, spec.objectKey), f.key))}</span>
                    </div>
                  ))}
                </div>
              )}
              {spec.mode === 'table' && (
                <GroundedTable rows={(getPath(entry.result, spec.arrayKey) as unknown[]) ?? []} columns={spec.columns} />
              )}
              {spec.mode === 'multi' && (
                <div className="space-y-2">
                  {spec.sections.map((sec) => (
                    <div key={sec.label}>
                      <div className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">{sec.label}</div>
                      <GroundedTable rows={(getPath(entry.result, sec.arrayKey) as unknown[]) ?? []} columns={sec.columns} />
                    </div>
                  ))}
                </div>
              )}
              <details className="px-1 py-2 text-xs text-gray-500"><summary className="cursor-pointer">Raw tool result</summary><pre className="mt-2 max-h-80 overflow-auto font-mono whitespace-pre">{JSON.stringify(entry.result, null, 2)}</pre></details>
            </div>
          </div>
        )
      })}
    </div>
  )
}
