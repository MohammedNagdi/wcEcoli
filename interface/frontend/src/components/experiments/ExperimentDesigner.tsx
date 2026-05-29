import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import {
  getVariants, getVariantDetail, getConditions, getTimelines,
  createExperiment, searchGenes,
} from '../../api/client'
import type {
  Variant, VariantDetail, Condition, Timeline, Gene, ExperimentCreate,
} from '../../types'
import { SearchInput } from '../common/SearchInput'
import { HelpTip, HelpNote } from '../common/HelpTip'
import { variantLabel } from '../../utils/labels'

export function ExperimentDesigner() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  // Pre-fill from URL params (e.g. ?variant=gene_knockout&gene=rpoB)
  const prefillVariant = searchParams.get('variant') || ''
  const prefillGene = searchParams.get('gene') || ''

  // Reference data
  const [variants, setVariants] = useState<Variant[]>([])
  const [conditions, setConditions] = useState<Condition[]>([])
  const [timelines, setTimelines] = useState<Timeline[]>([])

  // Form state
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [variantType, setVariantType] = useState(prefillVariant)
  const [variantDetail, setVariantDetail] = useState<VariantDetail | null>(null)
  const [variantIndex, setVariantIndex] = useState(0)
  const [condition, setCondition] = useState('basal')
  const [timeline, setTimeline] = useState('')
  const [geneSymbol, setGeneSymbol] = useState(prefillGene)
  const [seeds, setSeeds] = useState(1)
  const [generations, setGenerations] = useState(1)
  const [lengthSec, setLengthSec] = useState(10800)

  // Gene search
  const [geneQuery, setGeneQuery] = useState(prefillGene)
  const [geneResults, setGeneResults] = useState<Gene[]>([])
  const [showGenePicker, setShowGenePicker] = useState(false)

  // UI state
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Load reference data
  useEffect(() => {
    getVariants().then(setVariants)
    getConditions().then(setConditions)
    getTimelines().then(setTimelines)
  }, [])

  // Auto-select variant if prefilled
  useEffect(() => {
    if (prefillVariant) {
      setVariantType(prefillVariant)
    }
  }, [prefillVariant])

  // Load variant detail when type changes
  useEffect(() => {
    if (!variantType) { setVariantDetail(null); return }
    getVariantDetail(variantType)
      .then(setVariantDetail)
      .catch(() => setVariantDetail(null))
  }, [variantType])

  // Auto-generate name
  useEffect(() => {
    if (variantType === 'gene_knockout' && geneSymbol) {
      setName(`${geneSymbol} knockout`)
    } else if (variantType) {
      setName(`${variantType} experiment`)
    }
  }, [variantType, geneSymbol])

  // Auto-resolve prefilled gene -> ko_index on mount
  useEffect(() => {
    if (!prefillGene) return
    searchGenes(prefillGene, 5).then((genes) => {
      const exact = genes.find((g) => g.symbol.toLowerCase() === prefillGene.toLowerCase())
      if (exact) {
        setVariantIndex(exact.ko_index)
        setGeneSymbol(exact.symbol)
        setGeneQuery(exact.symbol)
      }
    })
  }, [prefillGene])

  // Gene search
  useEffect(() => {
    if (geneQuery.length < 1) { setGeneResults([]); return }
    const timer = setTimeout(() => {
      searchGenes(geneQuery, 8).then(setGeneResults)
    }, 200)
    return () => clearTimeout(timer)
  }, [geneQuery])

  const selectGene = (gene: Gene) => {
    setGeneSymbol(gene.symbol)
    setGeneQuery(gene.symbol)
    setVariantIndex(gene.ko_index)
    setShowGenePicker(false)
  }

  const handleSave = async () => {
    if (!name.trim()) { setError('Name is required'); return }
    if (!variantType) { setError('Select an experiment type'); return }

    setSaving(true)
    setError(null)
    try {
      const data: ExperimentCreate = {
        name: name.trim(),
        description: description.trim(),
        variant_type: variantType,
        variant_index: variantIndex,
        condition,
        timeline,
        gene_symbol: geneSymbol,
        sim_params: JSON.stringify({ seeds, generations, length_sec: lengthSec }),
      }
      const experiment = await createExperiment(data)
      navigate(`/experiments?created=${experiment.id}`)
    } catch (e: any) {
      setError(e.message || 'Failed to save experiment')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-3xl mx-auto">
      <h1 className="text-xl font-semibold text-gray-900 mb-1">Design experiment</h1>
      <p className="text-sm text-gray-400 mb-6">
        Configure an experiment type, growth condition, and simulation parameters.
        {' '}<Link to="/guide" className="text-brand-600 hover:text-brand-700 hover:underline">View full documentation &rarr;</Link>
      </p>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm mb-4">
          {error}
        </div>
      )}

      <div className="space-y-6">
        {/* --- Experiment type --- */}
        <section className="bg-white rounded-lg border border-gray-200 p-5">
          <h2 className="text-sm font-medium text-gray-700 mb-3 flex items-center gap-1.5">
            Experiment type
            <HelpTip text="Each experiment type modifies the simulation in a specific way. 'Gene knockout' sets a gene's RNA expression to zero — the cell must grow without the protein it encodes. Other variants alter media composition, kinetic parameters, or regulatory logic." />
          </h2>
          <select
            value={variantType}
            onChange={(e) => {
              setVariantType(e.target.value)
              setVariantIndex(0)
              setGeneSymbol('')
              setGeneQuery('')
            }}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm
                       focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500"
          >
            <option value="">Select experiment type...</option>
            {variants.map((v) => (
              <option key={v.name} value={v.name}>{variantLabel(v.name)}</option>
            ))}
          </select>

          {variantDetail && (
            <div className="mt-3 bg-gray-50 rounded-md p-3">
              <p className="text-xs text-gray-500 whitespace-pre-line leading-relaxed">
                {variantDetail.docstring.slice(0, 300)}
                {variantDetail.docstring.length > 300 ? '...' : ''}
              </p>
              {variantDetail.parameter_hints.index_meaning && (
                <p className="text-xs text-gray-400 mt-2 border-t border-gray-200 pt-2">
                  Index: {variantDetail.parameter_hints.index_meaning}
                </p>
              )}
            </div>
          )}
        </section>

        {/* --- Gene picker (for gene_knockout) --- */}
        {variantType === 'gene_knockout' && (
          <section className="bg-white rounded-lg border border-gray-200 p-5">
            <h2 className="text-sm font-medium text-gray-700 mb-3 flex items-center gap-1.5">
              Target gene
              <HelpTip text="The knockout sets this gene's RNA expression to zero. The model tracks all 4,749 genes, but only ~1,500 have mechanistic downstream effects (metabolic enzymes, transcription factors, ribosomal proteins). Knocking out a 'passenger' gene will show its protein declining to zero, but may not affect growth." />
            </h2>
            <div className="relative">
              <SearchInput
                value={geneQuery}
                onChange={(v) => { setGeneQuery(v); setShowGenePicker(true) }}
                placeholder="Search gene to knock out..."
              />
              {showGenePicker && geneResults.length > 0 && (
                <div className="absolute z-10 top-full mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                  {geneResults.map((g) => (
                    <button
                      key={g.id}
                      onClick={() => selectGene(g)}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-brand-50 flex items-center justify-between"
                    >
                      <span>
                        <span className="font-mono font-medium text-bio-gene">{g.symbol}</span>
                        <span className="text-gray-400 ml-2">{g.ecoli_id}</span>
                      </span>
                      <span className="text-xs text-gray-400">KO #{g.ko_index}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            {geneSymbol && (
              <p className="text-sm mt-2 text-gray-600">
                Selected: <span className="font-mono font-medium text-bio-gene">{geneSymbol}</span>
                {' '}&rarr; KO index <span className="font-mono">{variantIndex}</span>
              </p>
            )}
          </section>
        )}

        {/* --- Parameter index (for non-gene-knockout) --- */}
        {variantType && variantType !== 'gene_knockout' && variantDetail && (
          <section className="bg-white rounded-lg border border-gray-200 p-5">
            <h2 className="text-sm font-medium text-gray-700 mb-3">Parameter index</h2>
            <input
              type="number"
              value={variantIndex}
              onChange={(e) => setVariantIndex(Number(e.target.value))}
              min={variantDetail.parameter_hints.index_range?.[0] ?? 0}
              max={variantDetail.parameter_hints.index_range?.[1] ?? 9999}
              className="w-32 border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono
                         focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500"
            />
            {variantDetail.parameter_hints.index_meaning && (
              <p className="text-xs text-gray-400 mt-1">
                {variantDetail.parameter_hints.index_meaning}
              </p>
            )}
          </section>
        )}

        {/* --- Growth environment --- */}
        <section className="bg-white rounded-lg border border-gray-200 p-5">
          <h2 className="text-sm font-medium text-gray-700 mb-3 flex items-center gap-1.5">
            Growth environment
            <HelpTip text="Controls the nutrient environment. The 'Condition' sets the static media composition for the entire simulation. The 'Timeline' overrides this with dynamic media shifts at specified timepoints. If both are set, the timeline takes precedence." />
          </h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-gray-400 block mb-1">
                Condition
                <HelpTip text="The nutrient media the cell grows in. 'Basal' = glucose minimal media. Times shown are expected doubling times, not simulation durations." position="right" />
              </label>
              <select
                value={condition}
                onChange={(e) => setCondition(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm
                           focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500"
              >
                {conditions.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}{c.doubling_time ? ` — ~${c.doubling_time.toFixed(0)} min doubling` : ''}
                  </option>
                ))}
              </select>
              {condition && condition !== 'basal' && !timeline && (
                <p className="text-xs text-emerald-600 mt-1.5 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block"></span>
                  Simulation will use <strong>{condition}</strong> media
                </p>
              )}
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">
                Timeline (optional)
                <HelpTip text="Dynamic media shifts over time, e.g. switch from minimal to amino-acid-supplemented media at t=1200s. Overrides the static condition if set." position="right" />
              </label>
              <select
                value={timeline}
                onChange={(e) => setTimeline(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm
                           focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500"
              >
                <option value="">None (use condition above)</option>
                {timelines.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name.replace(/^\d+_/, '').replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
              {timeline && condition !== 'basal' && (
                <p className="text-xs text-amber-600 mt-1.5 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block"></span>
                  Timeline overrides the condition setting
                </p>
              )}
            </div>
          </div>
        </section>

        {/* --- Simulation parameters --- */}
        <section className="bg-white rounded-lg border border-gray-200 p-5">
          <h2 className="text-sm font-medium text-gray-700 mb-3 flex items-center gap-1.5">
            Simulation parameters
            <HelpTip text="Seeds are independent random replicates — each starts from a different initial state. Generations control how many cell divisions are simulated sequentially. More seeds give statistical power; more generations reveal long-term dynamics and potential lethality." />
          </h2>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="text-xs text-gray-400 block mb-1">Seeds (replicates)</label>
              <input
                type="number"
                value={seeds}
                onChange={(e) => setSeeds(Math.max(1, Number(e.target.value)))}
                min={1}
                max={64}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono
                           focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500"
              />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Generations</label>
              <input
                type="number"
                value={generations}
                onChange={(e) => setGenerations(Math.max(1, Number(e.target.value)))}
                min={1}
                max={10}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono
                           focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500"
              />
              <p className="text-xs text-gray-400 mt-1">~30 min/gen</p>
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Max duration (s)</label>
              <input
                type="number"
                value={lengthSec}
                onChange={(e) => setLengthSec(Math.max(60, Number(e.target.value)))}
                min={60}
                step={60}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono
                           focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500"
              />
              <p className="text-xs text-gray-400 mt-1">{(lengthSec / 3600).toFixed(1)} hr</p>
            </div>
          </div>
        </section>

        {/* --- Name & description --- */}
        <section className="bg-white rounded-lg border border-gray-200 p-5">
          <h2 className="text-sm font-medium text-gray-700 mb-3">Experiment details</h2>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-gray-400 block mb-1">Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. rpoB knockout in minimal media"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm
                           focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500"
              />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Description (optional)</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                placeholder="What do you expect to observe?"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm resize-none
                           focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500"
              />
            </div>
          </div>
        </section>

        {/* --- Summary + save --- */}
        <section className="bg-brand-50 rounded-lg border border-brand-200 p-5">
          <h2 className="text-sm font-medium text-brand-800 mb-2">Experiment summary</h2>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm text-brand-700">
            <span className="text-brand-500">Type:</span>
            <span>{variantType ? variantLabel(variantType) : '—'}</span>
            {geneSymbol && (
              <>
                <span className="text-brand-500">Gene:</span>
                <span className="font-mono">{geneSymbol}</span>
              </>
            )}
            <span className="text-brand-500">Condition:</span>
            <span>{condition}</span>
            {timeline && (
              <>
                <span className="text-brand-500">Timeline:</span>
                <span>{timeline}</span>
              </>
            )}
            <span className="text-brand-500">Replicates:</span>
            <span>{seeds} seed{seeds > 1 ? 's' : ''} &times; {generations} gen</span>
            <span className="text-brand-500">Max duration:</span>
            <span>{lengthSec}s ({(lengthSec / 3600).toFixed(1)} hr)</span>
          </div>
        </section>

        <div className="flex gap-3 justify-end pb-8">
          <button
            onClick={() => navigate('/experiments')}
            className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !variantType || !name.trim()}
            className="px-5 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700
                       rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving...' : 'Save experiment'}
          </button>
        </div>
      </div>
    </div>
  )
}
