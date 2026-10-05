import { useEffect, useMemo, useRef } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { useRegisterAssistantContext } from '../assistant/AssistantProvider'
import { useMediaQuery } from '../workspace/useMediaQuery'
import { categoryLabel } from '../../utils/labels'
import { ASSISTANT_GENE_SAMPLE_LIMIT, summarizeKOSummary, truncateText } from '../../utils/assistantContext'
import { DesignCategories, DesignTable } from './DesignCatalog'
import { DesignInspector } from './DesignInspector'
import { categoryStats, matchingGenes, phenotypeLabels, phenotypes, readDesignState, sortGenes, type SortKey } from './designState'
import { useDesignConditions, useDesignInspector, useDesignOverview } from './useDesignEvidence'
import { useDesignScroll } from './useDesignScroll'
import '../../styles/design.css'

export function DesignPage() {
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const state = readDesignState(params)
  const overview = useDesignOverview(state.condition)
  const conditions = useDesignConditions()
  const inspector = useDesignInspector(state.gene, state.condition, state.experimentId)
  const wide = useMediaQuery('(min-width: 1160px)')
  const pageRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const positionKey = JSON.stringify({ ...state, gene: undefined, experimentId: undefined })
  const position = useDesignScroll(positionKey, !!overview.data, !!state.gene, pageRef, scrollRef)
  const capturedAt = useRef(new Date().toISOString()).current
  const conditionNames = useMemo(() => [...new Set([state.condition, ...(conditions.data ?? []).map(c => c.name)])].sort(), [state.condition, conditions.data])
  const categories = useMemo(() => [...new Set((overview.data?.genes ?? []).map(g => g.category))].sort(), [overview.data])
  const matching = useMemo(() => matchingGenes(overview.data?.genes ?? [], state), [overview.data, state.search, state.category, state.phenotype, state.evidence])
  const sorted = useMemo(() => sortGenes(matching, state.sort, state.direction), [matching, state.sort, state.direction])
  const compositions = useMemo(() => categoryStats(matching), [matching])
  const pages = Math.max(1, Math.ceil(sorted.length / state.pageSize))
  const currentPage = Math.min(pages, state.page)
  const pageGenes = sorted.slice((currentPage - 1) * state.pageSize, currentPage * state.pageSize)

  function update(changes: Record<string, string | number | null>, replace = false) {
    const next = new URLSearchParams(params)
    for (const [key, value] of Object.entries(changes)) {
      if (value == null || value === '') next.delete(key); else next.set(key, String(value))
    }
    setParams(next, { replace, preventScrollReset: true })
  }
  function filter(key: string, value: string) { update({ [key]: value, page: null }, key === 'q') }
  function sort(key: SortKey) { update({ sort: key, dir: state.sort === key && state.direction === 'asc' ? 'desc' : 'asc', page: null }) }
  function inspect(symbol: string) {
    position.current = { table: scrollRef.current?.scrollTop ?? 0, main: pageRef.current?.closest('main')?.scrollTop ?? 0 }
    update({ gene: symbol, experiment: null })
  }
  function closeInspector() { update({ gene: null, experiment: null }) }
  const previousGene = useRef(state.gene)
  useEffect(() => {
    const closedGene = previousGene.current
    previousGene.current = state.gene
    if (closedGene && !state.gene) {
      const frame = requestAnimationFrame(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = position.current.table
        const main = pageRef.current?.closest('main')
        if (main) main.scrollTop = position.current.main
        const buttons = pageRef.current?.querySelectorAll<HTMLButtonElement>('.design-gene')
        Array.from(buttons ?? []).find(button => button.textContent === closedGene)?.focus({ preventScroll: true })
      })
      return () => cancelAnimationFrame(frame)
    }
  }, [state.gene, position])

  const data = overview.data
  const usable = data?.genes_with_usable_results ?? data?.simulated_genes ?? 0
  const exactSelectedGene = state.gene || matching.find(g => g.gene_symbol.toLowerCase() === state.search.trim().toLowerCase())?.gene_symbol || null
  const sample = matching.slice(0, ASSISTANT_GENE_SAMPLE_LIMIT).map(summarizeKOSummary)
  const assistantPageState = {
    kind: 'genome_design_summary', surface: 'design', dirty: false, captured_at: capturedAt,
    summary: `Genome Design ${state.view} view: ${matching.length} matching mechanistic genes; ${usable} genes with usable knockout results in ${state.condition}.`,
    route: `${location.pathname}${location.search}`, loading: overview.loading, error: truncateText(overview.error), view: state.view,
    condition: state.condition, selected_gene: state.gene || null, inspected_experiment: inspector.data?.summary.experiment_id ?? state.experimentId ?? null,
    evidence_gaps: inspector.data?.summary.evidence_gaps ?? [],
    overview: data ? { total_genes: data.total_genes, mechanistic_genes: data.mechanistic_genes, simulated_genes: data.simulated_genes,
      essential_genes: data.essential_genes, growth_defect_genes: data.growth_defect_genes, neutral_genes: data.neutral_genes, unknown_genes: data.unknown_genes,
      genes_with_usable_results: usable, genes_with_experiments: data.genes_with_experiments, simulated_percent: data.total_genes ? Math.round(usable / data.total_genes * 100) : 0 } : null,
    filters: { search: state.search, category: state.category || null, phenotype: state.phenotype || null, evidence: state.evidence || null, exact_selected_gene: exactSelectedGene },
    sort: { key: state.sort, direction: state.direction }, pagination: { page: currentPage, page_size: state.pageSize, total_pages: pages },
    visible_gene_count: matching.length, visible_gene_sample: sample, visible_gene_sample_truncated: matching.length > sample.length,
    category_options_sample: categories.slice(0, ASSISTANT_GENE_SAMPLE_LIMIT), category_options_truncated: categories.length > ASSISTANT_GENE_SAMPLE_LIMIT,
    phenotype_counts: Object.fromEntries(phenotypes.map(p => [p, matching.filter(g => g.phenotype === p).length])),
    table: state.view === 'table' ? { visible_gene_count: matching.length, sample, sample_truncated: matching.length > sample.length } : null,
    essentiality_view: state.view === 'essentiality' ? { category_count: compositions.length, category_sample: compositions.slice(0, ASSISTANT_GENE_SAMPLE_LIMIT), category_sample_truncated: compositions.length > ASSISTANT_GENE_SAMPLE_LIMIT } : null,
  }
  useRegisterAssistantContext({
    contextKey: JSON.stringify(assistantPageState),
    context: { assistant_surface: 'design', route: `${location.pathname}${location.search}`, selected_gene: exactSelectedGene, selected_condition: state.condition,
      selected_experiment: inspector.data?.summary.experiment_id ?? null, page_state: assistantPageState },
    suggestedPrompt: 'Help me review this mechanistic knockout evidence, its source measurements, and the gaps in this condition. Explain the limits of the observed outcomes.',
  })

  return <div className="design-page" ref={pageRef}>
    <header className="design-header"><div><h1>Genome Design</h1><p>Review mechanistic knockout evidence.</p></div><span className="design-condition">Condition <strong>{state.condition}</strong></span></header>
    <details className="design-disclosure design-scope"><summary>Scope and interpretation</summary><p>Mechanistic genes only. Expression-only genes are excluded because their knockout effects are not mechanistically represented. Outcomes summarize recorded runs, rather than biological essentiality or minimal-genome predictions. <Link to="/explore">Open the full gene workspace.</Link></p></details>
    <section className="design-coverage" aria-label="Evidence coverage">
      {([['Eligible genes', data?.total_genes], ['With knockout experiments', data?.genes_with_experiments ?? (data ? data.genes.filter(g => g.experiment_id != null).length : undefined)], ['With usable results', data ? usable : undefined], ['Unclassified', data?.unclassified_genes ?? data?.unknown_genes]] as const).map(([label, value]) => <div key={label}><span>{label}</span><strong>{value?.toLocaleString() ?? '—'}</strong></div>)}
      <p>{data ? `${usable.toLocaleString()} / ${data.total_genes.toLocaleString()} eligible genes have usable results (${data.total_genes ? (100 * usable / data.total_genes).toFixed(1) : '0.0'}%).` : overview.error ? `Coverage unavailable for ${state.condition}.` : `Loading coverage for ${state.condition}…`}</p>
    </section>
    <div className="design-tabs" role="group" aria-label="Evidence views"><button aria-pressed={state.view === 'table'} onClick={() => update({ view: 'table' })}>Gene evidence</button><button aria-pressed={state.view === 'essentiality'} onClick={() => update({ view: 'essentiality' })}>Category summary</button></div>
    <div className="design-toolbar">
      <label className="design-field design-search">Search genes<input placeholder="Search gene…" value={state.search} onChange={e => filter('q', e.target.value)} type="search" /></label>
      <label className="design-field">Condition<select aria-label="Condition" value={state.condition} onChange={e => update({ condition: e.target.value, experiment: null, page: null })}>{conditionNames.map(name => <option key={name}>{name}</option>)}</select></label>
      <label className="design-field">Category<select aria-label="Category" value={state.category} onChange={e => filter('category', e.target.value)}><option value="">All categories</option>{state.category && !categories.includes(state.category) && <option value={state.category}>{categoryLabel(state.category)}</option>}{categories.map(category => <option value={category} key={category}>{categoryLabel(category)}</option>)}</select></label>
      <label className="design-field">Phenotype<select aria-label="Phenotype" value={state.phenotype} onChange={e => filter('phenotype', e.target.value)}><option value="">All phenotypes</option>{phenotypes.map(p => <option key={p} value={p}>{phenotypeLabels[p]}</option>)}</select></label>
      <label className="design-field">Evidence availability<select aria-label="Evidence availability" value={state.evidence} onChange={e => filter('evidence', e.target.value)}><option value="">All evidence</option><option value="usable">With usable results</option><option value="none">Without usable results</option><option value="partial">Partial results</option><option value="missing_results">Missing result records</option></select></label>
      <button className="design-button" onClick={() => update({ q: null, category: null, phenotype: null, evidence: null, page: null })}>Clear filters</button>
    </div>
    {conditions.error && <div className="design-error" role="alert">Condition choices could not be loaded. <button className="design-button" onClick={conditions.retry}>Retry conditions</button></div>}
    <div className="design-workbench" data-inspecting={!!state.gene} data-wide={wide}>
      <section className="design-catalog" aria-label="Knockout evidence catalog" aria-busy={overview.loading}>
        <div className="design-catalog-header"><span>{data ? `${matching.length.toLocaleString()} matching genes` : 'Evidence catalog'}</span><button className="design-button" disabled={overview.loading} onClick={overview.retry}>Refresh evidence</button></div>
        {overview.loading && <p className="design-notice" role="status">{data ? 'Refreshing evidence…' : `Loading evidence for ${state.condition}…`}</p>}
        {overview.error && <div className="design-error" role="alert"><p>Could not load knockout evidence for {state.condition}.</p><p>{overview.error}</p>{data && <p>Showing the last loaded evidence for this condition.</p>}<button className="design-button" onClick={overview.retry}>Retry evidence</button></div>}
        {data && <>
          {!usable && <div className="design-notice"><strong>No usable mechanistic knockout results for {state.condition}.</strong><p>Genes remain available for inspection. {data.genes_with_experiments ? 'Existing experiments have no usable completed results.' : 'No eligible knockout experiments have usable completed results.'} Select a gene to inspect the evidence gap or prepare an experiment.</p></div>}
          {state.view === 'table' ? <><DesignTable genes={pageGenes} state={state} selected={state.gene} sort={sort} inspect={inspect} scrollRef={scrollRef} />
            <div className="design-pagination"><label className="design-field">Rows per page<select aria-label="Rows per page" value={state.pageSize} onChange={e => update({ pageSize: e.target.value, page: null })}>{[25, 50, 100].map(n => <option key={n}>{n}</option>)}</select></label>
              <span>Page {currentPage} of {pages} · {sorted.length ? (currentPage - 1) * state.pageSize + 1 : 0}–{Math.min(currentPage * state.pageSize, sorted.length)} of {sorted.length}</span>
              <div><button className="design-button" disabled={currentPage <= 1} onClick={() => update({ page: currentPage - 1 })}>Previous page</button><button className="design-button" disabled={currentPage >= pages} onClick={() => update({ page: currentPage + 1 })}>Next page</button></div></div>
          </> : <DesignCategories data={compositions} select={category => update({ category, view: 'table', page: null })} />}
        </>}
      </section>
      {state.gene && <DesignInspector gene={state.gene} condition={state.condition} data={inspector.data} loading={inspector.loading} error={inspector.error} retry={inspector.retry} close={closeInspector} selectExperiment={id => update({ experiment: id })} wide={wide} />}
    </div>
  </div>
}
