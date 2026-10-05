import type { RefObject } from 'react'
import type { EssentialityStats, GeneKOSummary } from '../../types'
import { categoryLabel } from '../../utils/labels'
import { evidenceLabels, evidenceStatus, metric, phenotypes, phenotypeLabels, type DesignState, type SortKey } from './designState'

export function PhenotypeBadge({ phenotype }: { phenotype: GeneKOSummary['phenotype'] }) {
  return <span className={`design-phenotype design-${phenotype}`}><span aria-hidden="true" />{phenotypeLabels[phenotype]}</span>
}

export function DesignTable({ genes, state, selected, sort, inspect, scrollRef }: {
  genes: GeneKOSummary[]; state: DesignState; selected: string; sort: (key: SortKey) => void;
  inspect: (symbol: string) => void; scrollRef: RefObject<HTMLDivElement>
}) {
  const columns: [SortKey, string][] = [['gene_symbol', 'Gene'], ['category', 'Category'], ['evidence_status', 'Evidence status'], ['phenotype', 'Phenotype'],
    ['n_completed', 'Completed / total jobs'], ['mean_growth_rate', 'Growth rate (s⁻¹)'], ['mean_doubling_time_min', 'Doubling time (min)'], ['division_fraction', 'Division fraction']]
  return <div ref={scrollRef} className="design-table-scroll" tabIndex={0} role="region" aria-label="Gene evidence table">
    <table className="design-table">
      <caption className="sr-only">Mechanistic knockout evidence for {state.condition}. Missing values are shown as a dash.</caption>
      <thead><tr>{columns.map(([key, label]) => <th key={key} scope="col" aria-sort={state.sort === key ? state.direction === 'asc' ? 'ascending' : 'descending' : 'none'}>
        <button onClick={() => sort(key)}>{label}<span aria-hidden="true">{state.sort === key ? state.direction === 'asc' ? '↑' : '↓' : '↕'}</span></button>
      </th>)}</tr></thead>
      <tbody>{genes.map(g => <tr key={g.gene_symbol} data-selected={selected === g.gene_symbol}>
        <th scope="row"><button className="design-gene" aria-label={`Inspect ${g.gene_symbol}`} aria-pressed={selected === g.gene_symbol} onClick={() => inspect(g.gene_symbol)}>{g.gene_symbol}</button></th>
        <td>{categoryLabel(g.category)}</td>
        <td><span className="design-evidence" title={g.evidence_reason}>{evidenceLabels[evidenceStatus(g)]}</span></td>
        <td><PhenotypeBadge phenotype={g.phenotype} /></td>
        <td className="design-number">{g.n_completed} / {g.n_seeds}</td>
        <td className="design-number">{metric(g.mean_growth_rate, 6)}</td>
        <td className="design-number">{metric(g.mean_doubling_time_min)}</td>
        <td className="design-number">{g.division_sample_count > 0 ? `${g.divided_count} / ${g.division_sample_count}` : g.division_rate ?? '—'}</td>
      </tr>)}</tbody>
    </table>
    {!genes.length && <div className="design-empty"><p>No genes match these filters.</p><p>Clear filters to return to the condition catalog.</p></div>}
  </div>
}

export function DesignCategories({ data, select }: { data: EssentialityStats[]; select: (category: string) => void }) {
  return <div className="design-categories">
    <p className="design-muted">Each bar represents 100% of the matching genes in that category. The denominator includes the current search and filters.</p>
    <div className="design-legend">{phenotypes.map(p => <PhenotypeBadge key={p} phenotype={p} />)}</div>
    {!data.length && <p className="design-empty">No categories match these filters.</p>}
    {data.map(row => <section key={row.category} className="design-category-row">
      <div className="design-category-title"><button onClick={() => select(row.category)} aria-label={`Show ${categoryLabel(row.category)} genes`}>{categoryLabel(row.category)}</button><span>{row.total} matching gene{row.total === 1 ? '' : 's'}</span></div>
      <div className="design-composition" aria-hidden="true">{phenotypes.filter(p => row[p] > 0).map(p => <span key={p} data-phenotype={p} className={`design-segment design-${p}`} style={{ width: `${100 * row[p] / row.total}%` }} />)}</div>
      <p className="design-category-counts">{phenotypes.map(p => `${phenotypeLabels[p]}: ${row[p]}`).join(' · ')}</p>
    </section>)}
  </div>
}
