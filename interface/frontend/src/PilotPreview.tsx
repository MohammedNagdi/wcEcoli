import { useEffect, useState } from 'react'
import { TimeseriesChart } from './components/results/ResultsPage'
import type { TimeseriesData } from './types'
import './components/results/result-detail.css'

type PilotExperiment = {key: string; job_id: number; question: string; outcome: string; reason: string;
  transcription_unit_id: string | null; co_targeted_genes: string[] | null;
  controls: {key: string; available: boolean; reason: string}[]}
async function get<T>(path: string): Promise<T> {
  const response = await fetch('/api' + path)
  const data = await response.json()
  if (!response.ok) throw new Error(data.detail || 'Published artifact unavailable')
  return data
}
export default function PilotPreview() {
  const [experiments, setExperiments] = useState<PilotExperiment[]>([])
  const [job, setJob] = useState<number>(0)
  const [series, setSeries] = useState<Record<string, TimeseriesData[]>>({})
  const [types, setTypes] = useState<{molecule_type: string; count: number}[]>([])
  const [kind, setKind] = useState('')
  const [ids, setIds] = useState<string[]>([])
  const [idsFor, setIdsFor] = useState('')
  const [molecule, setMolecule] = useState('')
  const [molecular, setMolecular] = useState<TimeseriesData[]>([])
  const [error, setError] = useState('')
  const [scope, setScope] = useState('pilot')
  useEffect(() => { get<{experiments: PilotExperiment[]; scope: string}>('/pilot').then(data => {
    setScope(data.scope); setExperiments(data.experiments); setJob(data.experiments[0]?.job_id || 0)
  }).catch(e => setError(String(e))) }, [])
  useEffect(() => {
    if (!job) return
    let active = true
    setSeries({}); setMolecular([]); setTypes([]); setIds([]); setIdsFor(''); setMolecule(''); setError('')
    Promise.all([get<{timeseries: Record<string, TimeseriesData[]>}>(`/jobs/${job}/timeseries`),
      get<{available_types: {molecule_type: string; count: number}[]}>(`/jobs/${job}/molecules`)]).then(([data, channels]) => {
      if (active) { setSeries(Object.fromEntries(Object.entries(data.timeseries).map(([name, values]) => [name, values.map(s => ({...s, points: s.points.filter(p => p.value !== null && Number.isFinite(p.value))}))]))); setTypes(channels.available_types); setKind(channels.available_types[0]?.molecule_type || '') }
    }).catch(e => { if (active) setError(String(e)) })
    return () => { active = false }
  }, [job])
  useEffect(() => {
    if (!job || !kind) return
    let active = true
    setIds([]); setIdsFor(''); setMolecule(''); setMolecular([])
    get<{ids: string[]}>(`/jobs/${job}/molecules/${kind}/ids?limit=10000`).then(data => {
      if (active) { setIds(data.ids); setIdsFor(`${job}:${kind}`); setMolecule(data.ids[0] || '') }
    }).catch(e => { if (active) setError(String(e)) })
    return () => { active = false }
  }, [job, kind])
  useEffect(() => {
    if (!job || !molecule || idsFor !== `${job}:${kind}` || !ids.includes(molecule)) return
    let active = true
    setMolecular([])
    get<{molecules: TimeseriesData[]}>(`/jobs/${job}/molecules/${kind}/timeseries?ids=${encodeURIComponent(molecule)}`)
      .then(data => { if (active) setMolecular(data.molecules) }).catch(e => { if (active) setError(String(e)) })
    return () => { active = false }
  }, [job, kind, molecule, idsFor, ids])
  const selected = experiments.find(e => e.job_id === job)
  return <main className="max-w-7xl mx-auto p-8 space-y-6">
    <div><p className="text-sm text-gray-500">wcEcoli · {scope === 'full' ? 'HF-05 demo campaign' : 'HF-04 pilot'} · Read only</p>
      <h1 className="text-2xl font-semibold">{scope === 'full' ? 'Published campaign results' : 'Published pilot results'}</h1>
      <p>Real simulation artifacts. Seed 0; generations are sequential, not independent replicates.</p></div>
    {error && <p role="alert" className="text-red-700">{error}</p>}
    <label>Experiment <select aria-label="Experiment" className="border rounded p-2" value={job} onChange={e => setJob(Number(e.target.value))}>
      {experiments.map(e => <option key={e.key} value={e.job_id}>{e.key}</option>)}
    </select></label>
    {selected && <section className="space-y-2"><h2 className="font-semibold">{selected.question}</h2>
      <p>Outcome: {selected.outcome}. {selected.reason}</p>
      <p>Controls: {selected.controls.map(c => `${c.key}: ${c.available ? 'published' : c.reason}`).join('; ') || 'Reference experiment'}</p>
      {selected.transcription_unit_id && <p>Model expression perturbation targets {selected.transcription_unit_id}.
        {' '}Co-targeted genes: {selected.co_targeted_genes?.join(', ') || 'none'}.</p>}
      <p>An initial growth-rate value may be undefined: it is preserved in the artifact and returned as null by the API, and omitted from the chart. All charts use elapsed lineage time in minutes. Generation identities appear in the legend; the clock continues after division.</p></section>}
    <div className="grid md:grid-cols-2 gap-4" data-testid="pilot-scalar-charts">
      {['cell_mass','growth_rate'].map(channel => series[channel]?.length
        ? <TimeseriesChart key={channel} channel={channel} series={series[channel]} />
        : <p key={channel}>{channel}: no published samples available</p>)}
    </div>
    <section className="space-y-4"><h2 className="text-xl font-semibold">Molecular series</h2>
      <label>Channel <select aria-label="Molecular channel" className="border rounded p-2" value={kind} onChange={e => setKind(e.target.value)}>
        {types.map(t => <option key={t.molecule_type}>{t.molecule_type}</option>)}</select></label>{' '}
      <label>Molecule <select aria-label="Molecule" className="border rounded p-2 max-w-lg" value={molecule} onChange={e => setMolecule(e.target.value)}>
        {ids.map(id => <option key={id}>{id}</option>)}</select></label>
      <div data-testid="pilot-molecule-chart">{molecular.length
        ? <TimeseriesChart channel={molecule} series={molecular} /> : <p>No selected molecular samples available</p>}</div>
      <p className="text-sm text-gray-500">Only the four exported matrix families are available. Other molecular views and unrun results remain unavailable.</p>
    </section>
  </main>
}
