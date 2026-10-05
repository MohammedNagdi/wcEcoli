import { useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import type { DesignGeneEvidence, DesignJobEvidence, DesignSource } from '../../types'
import { categoryLabel, statusLabel } from '../../utils/labels'
import { evidenceLabels, evidenceStatus, geneLink, metric } from './designState'
import { PhenotypeBadge } from './DesignCatalog'

function ids(raw: string | null | undefined) {
  if (!raw) return 'Not recorded'
  try { const value = JSON.parse(raw); return Array.isArray(value) ? value.join(', ') || 'Not recorded' : raw } catch { return raw }
}
function Source({ source }: { source: DesignSource }) {
  return <dl className="design-details">
    <dt>Experiment</dt><dd><Link to={source.experiment_url}>{source.name} (#{source.experiment_id})</Link></dd>
    <dt>Status</dt><dd>{statusLabel(source.status)}</dd>
    <dt>Condition</dt><dd>{source.condition}</dd>
    <dt>Media protocol</dt><dd>{source.resolved_protocol == null ? 'Unavailable: protocol could not be resolved' : source.resolved_protocol || 'Condition default (no timeline)'}</dd>
    <dt>Duration</dt><dd>{source.duration_sec == null ? 'Unavailable' : `${metric(source.duration_sec, 0)} s`}</dd>
    <dt>Generations</dt><dd>{source.generations ?? 'Unavailable'}</dd>
    <dt>Configured seeds</dt><dd>{source.configured_seed_count ?? 'Unavailable'}</dd>
    <dt>Jobs</dt><dd>{source.completed_jobs} completed / {source.total_jobs} total</dd>
    <dt>Usable results</dt><dd>{source.usable_results}</dd>
  </dl>
}
function Jobs({ jobs, label }: { jobs: DesignJobEvidence[]; label: string }) {
  return <details className="design-disclosure"><summary>{label} ({jobs.length})</summary>
    {!jobs.length && <p>No jobs recorded.</p>}
    {jobs.map(job => <div key={job.job_id} className="design-job">
      <Link to={job.result_url}>Job #{job.job_id} · seed {job.seed}</Link><span>{statusLabel(job.status)}</span>
      {job.lineage_terminated && <p>Lineage terminated: {job.termination_reason || 'Reason not recorded'}</p>}
      {!job.results.length && <p>No stored result records.</p>}
      {!!job.results.length && <details><summary>Recorded generations ({job.results.length})</summary>{job.results.map(result => <div className="design-record" key={result.id}>
        <p>Generation {result.generation} · result #{result.id}{result.id === job.earliest_result_id ? ' · aggregation source' : ''}</p>
        <dl className="design-details"><dt>Division time</dt><dd>{result.division_time_sec == null ? 'Not recorded' : `${metric(result.division_time_sec)} s`}</dd>
          <dt>Divided</dt><dd>{result.divided ? 'Yes' : 'No'}</dd><dt>Growth rate</dt><dd>{metric(result.growth_rate, 6)} s⁻¹</dd>
          <dt>Doubling time</dt><dd>{metric(result.doubling_time_min)} min</dd><dt>Final mass</dt><dd>{metric(result.final_mass_fg)} fg</dd></dl>
        {result.terminated && <p>Terminated: {result.termination_reason || 'Reason not recorded'}</p>}
      </div>)}</details>}
    </div>)}
  </details>
}

export function DesignInspector({ gene, condition, data, loading, error, retry, close, selectExperiment, wide }: {
  gene: string; condition: string; data: DesignGeneEvidence | null; loading: boolean; error: string | null;
  retry: () => void; close: () => void; selectExperiment: (id: string) => void; wide: boolean
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus({ preventScroll: true }) }, [gene, wide])
  const summary = data?.summary
  const g = data?.gene
  return <aside className="design-inspector" aria-labelledby="design-inspector-title" aria-busy={loading}>
    <div className="design-inspector-header"><div><span className="design-eyebrow">Gene evidence · {condition}</span><h2 id="design-inspector-title" ref={heading} tabIndex={-1}>{gene}</h2></div>
      <button className="design-button" onClick={close}>{wide ? 'Close inspector' : 'Back to evidence'}</button></div>
    <div className="design-inspector-body">
      {loading && <p role="status">Loading gene evidence…</p>}
      {error && <div className="design-error" role="alert"><p>Could not load gene evidence.</p><p>{error}</p><button className="design-button" onClick={retry}>Retry gene evidence</button></div>}
      {data && g && summary && <>
        <p>{g.description || g.monomer_name || 'Gene description not recorded.'}</p>
        <p className="design-muted">{categoryLabel(g.category)} · Mechanistic model support</p>
        <div className="design-inspector-links"><Link to={geneLink('/explore', g.symbol, condition)}>Gene workspace ↗</Link><Link to={geneLink('/genome', g.symbol, condition)}>Genome Map ↗</Link></div>
        <details className="design-disclosure"><summary>Identifiers and chromosome position</summary><dl className="design-details">
          <dt>EcoCyc ID</dt><dd>{g.ecoli_id}</dd><dt>Knockout index</dt><dd>{g.ko_index}</dd><dt>Aliases</dt><dd>{ids(g.synonyms)}</dd>
          <dt>Coordinates</dt><dd>{g.left_end_pos == null || g.right_end_pos == null ? 'Not recorded' : `${g.left_end_pos.toLocaleString()}–${g.right_end_pos.toLocaleString()} bp (${g.direction || 'strand unavailable'})`}</dd>
          <dt>RNA IDs</dt><dd>{ids(g.rna_ids)}</dd><dt>Monomer ID</dt><dd>{g.monomer_id || 'Not recorded'}</dd><dt>Complex IDs</dt><dd>{ids(g.complex_ids)}</dd>
        </dl></details>
        {!!data.experiments.length && <label className="design-field">Source experiment<select aria-label="Source experiment" value={summary.experiment_id ?? ''} onChange={e => selectExperiment(e.target.value)}>
          {data.experiments.map(exp => <option value={exp.experiment_id} key={exp.experiment_id}>{exp.name} (#{exp.experiment_id}) · {exp.usable_results} usable</option>)}
        </select></label>}
        <section className="design-inspector-section"><h3>Observed outcome</h3><PhenotypeBadge phenotype={summary.phenotype} />
          <p className="design-muted">{evidenceLabels[evidenceStatus(summary)]}</p>
          {summary.evidence_gaps?.length ? <ul className="design-gaps">{summary.evidence_gaps.map(gap => <li key={gap}>{gap}</li>)}</ul> : <p>{summary.evidence_reason}</p>}
          <dl className="design-metrics">
            {([
              ['Growth rate', summary.mean_growth_rate, 's⁻¹', 'growth_rate', 6],
              ['Doubling time', summary.mean_doubling_time_min, 'min', 'doubling_time_min', 1],
              ['Division time', summary.mean_division_time_min, 'min', 'division_time_min', 1],
              ['Final mass', summary.mean_final_mass_fg, 'fg', 'final_mass_fg', 1],
            ] as const).map(([label, value, unit, key, digits]) => <div key={key}><dt>{label}</dt><dd>{metric(value, digits)} <span>{unit}</span><small>n = {summary.metric_sample_counts?.[key] ?? 0}</small></dd></div>)}
          </dl>
          <p>{summary.division_sample_count > 0 ? `${summary.divided_count} / ${summary.division_sample_count} recorded jobs divided.` : 'No usable division observations.'}</p>
          <p className="design-muted">{summary.n_completed} completed / {summary.n_seeds} total jobs; {summary.usable_result_count} with usable results.</p>
          <details className="design-disclosure"><summary>How these outcomes are summarized</summary><p>{summary.aggregation_scope}</p><p>“No division observed” describes these runs and does not establish biological essentiality. Growth maintained requires a valid wildtype comparison; reduced growth is below 80% of its mean growth rate.</p></details>
        </section>
        {summary.source && <section className="design-inspector-section"><h3>Source and run scope</h3><Source source={summary.source} /><Jobs jobs={data.jobs} label="Inspect knockout jobs and results" /></section>}
        <section className="design-inspector-section"><h3>Wildtype comparison</h3><p>{summary.baseline?.reason}</p>
          {summary.baseline?.source && <><p>Reference growth: {metric(summary.baseline.mean_growth_rate, 6)} s⁻¹ · n = {summary.baseline.growth_rate_samples}</p><Source source={summary.baseline.source} /><Jobs jobs={data.baseline_jobs} label="Inspect wildtype jobs and results" /></>}
        </section>
        <Link className="design-primary" to={`${geneLink('/experiments/new', g.symbol, condition)}&variant=gene_knockout`}>Design knockout experiment</Link>
        <p className="design-muted">Opens the existing designer for review with this gene and condition.</p>
        <details className="design-disclosure"><summary>Inspect raw evidence</summary><pre>{JSON.stringify(data, null, 2)}</pre></details>
      </>}
    </div>
  </aside>
}
