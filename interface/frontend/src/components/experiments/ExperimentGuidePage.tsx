import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { getVariants, getConditions, getTimelines } from '../../api/client'
import type { Variant, Condition, Timeline } from '../../types'
import { variantLabel } from '../../utils/labels'

/* ------------------------------------------------------------------ */
/*  Human-readable documentation for each experiment configuration     */
/* ------------------------------------------------------------------ */

/** Extended descriptions for variant types — keyed by variant name */
const VARIANT_DOCS: Record<string, {
  summary: string
  modifies: string
  useCase: string
  paramHint?: string
  category: 'core' | 'amino_acid' | 'ppgpp' | 'ribosome' | 'metabolism' | 'advanced'
}> = {
  wildtype: {
    summary: 'Runs the default simulation with no modifications. The cell grows and divides under standard conditions, providing the baseline for comparison with any knockout or perturbation experiment.',
    modifies: 'Nothing — all parameters remain at wild-type values.',
    useCase: 'Use as a control for any perturbation experiment. Every knockout or condition experiment should be compared against a wildtype run in the same growth condition.',
    category: 'core',
  },
  gene_knockout: {
    summary: 'Sets the transcription probability of a single gene to zero, preventing its mRNA from being synthesized. Existing mRNA and protein are diluted through growth and degradation. The model tracks all 4,749 E. coli genes, but only ~1,500 are mechanistically connected to downstream processes (metabolism, replication, regulation). Knocking out a non-mechanistic gene shows its protein declining to zero without affecting growth.',
    modifies: 'sim_data.process.transcription.rna_synth_prob (gene\'s transcription probability → 0), sim_data.process.transcription.rna_expression (expression set to 0).',
    useCase: 'Test gene essentiality, identify phenotypic effects of losing a gene, or validate model predictions against experimental gene knockout libraries.',
    paramHint: 'The variant index is the gene\'s knockout index (0 = control, 1–4749 = individual gene KO). When selecting a gene through the gene picker, this is set automatically.',
    category: 'core',
  },
  condition: {
    summary: 'Overrides the growth condition for the entire simulation, changing the nutrient environment the virtual cell grows in. Each condition defines available carbon sources, nitrogen sources, amino acids, and other nutrients.',
    modifies: 'sim_data.condition, sim_data.doubling_time.',
    useCase: 'Study how the cell adapts to different media (minimal, rich, carbon-limited, etc.). Combine with gene knockouts to test conditional essentiality.',
    paramHint: 'The variant index follows the runtime order from condition_defs.tsv, not alphabetical order. The designer preserves that order in the Growth Condition dropdown and this variant internally derives its effective timeline from the selected condition.',
    category: 'core',
  },
  timelines: {
    summary: 'Defines a sequence of media shifts at specified simulation times, modeling nutrient upshift or downshift experiments. At each timepoint, the media composition changes instantaneously.',
    modifies: 'sim_data.condition (at specified timepoints), sim_data.external_state.',
    useCase: 'Model nutrient shift experiments (e.g., switching from minimal to rich medium at 20 min to observe the upshift response).',
    paramHint: 'Use the Timeline Composer in the designer to define the effective timeline. The parameter index is not used for this experiment type in the interface.',
    category: 'core',
  },
  add_one_aa: {
    summary: 'Adds a single amino acid to the minimal medium. The cell can import the added amino acid instead of synthesizing it, potentially affecting growth rate, resource allocation, and biosynthesis gene expression.',
    modifies: 'sim_data.external_state.saved_media (adds one amino acid to minimal medium).',
    useCase: 'Study how external amino acid availability affects biosynthesis pathway regulation, ppGpp signaling, and growth rate.',
    paramHint: 'Index 0-20 maps to the runtime amino-acid order. The selenocysteine entry acts as the control because it is already present in minimal media.',
    category: 'amino_acid',
  },
  remove_one_aa: {
    summary: 'Removes a single amino acid from the rich medium (minimal + all amino acids). Forces the cell to synthesize the removed amino acid, potentially causing growth rate changes if biosynthesis capacity is limiting.',
    modifies: 'sim_data.condition (adjusts the amino acid pool in the media definition).',
    useCase: 'Identify which amino acids are growth-rate-limiting when removed from rich medium, testing biosynthesis pathway sufficiency.',
    paramHint: 'Index 0-20 maps to the runtime amino-acid order. The selenocysteine entry acts as the control because that amino acid must remain available in rich media.',
    category: 'amino_acid',
  },
  add_one_aa_shift: {
    summary: 'Adds one amino acid to minimal medium after 10 minutes of growth. Models a nutrient upshift for a single amino acid, allowing observation of the dynamic response.',
    modifies: 'sim_data.external_state.saved_media (shifts at t = 600s).',
    useCase: 'Study the kinetics of amino acid import activation and biosynthesis downregulation after a single amino acid becomes available.',
    paramHint: 'Index 0-20 maps to the runtime amino-acid order. The selenocysteine entry behaves as the control branch; other indices create the internal 10-minute shift to the selected amino acid.',
    category: 'amino_acid',
  },
  remove_one_aa_shift: {
    summary: 'Removes one amino acid from rich medium after 10 minutes. Models a nutrient downshift for a single amino acid.',
    modifies: 'sim_data.condition (shifts at t = 600s).',
    useCase: 'Observe how the cell activates biosynthesis for a single amino acid after it becomes unavailable.',
    paramHint: 'Index 0-20 maps to the runtime amino-acid order. The selenocysteine entry behaves as the control branch; other indices create the internal 10-minute shift away from the selected amino acid.',
    category: 'amino_acid',
  },
  remove_aas_shift: {
    summary: 'Removes amino acids from the rich medium after 10 minutes, forcing a transition from exogenous amino acid uptake to endogenous biosynthesis.',
    modifies: 'sim_data.condition (shifts at t = 600s).',
    useCase: 'Study the global response to losing amino acid supplementation — gene expression changes, ppGpp dynamics, and growth rate adaptation.',
    paramHint: '0 = rich-media control, 1 = shift to 12 amino acids, 2 = shift to 6 amino acids, 3 = static minimal-media control branch with no internal shift timeline, 4-22 = shift to a single amino acid, 23 = shift to no amino acids.',
    category: 'amino_acid',
  },
  aa_synthesis_ko: {
    summary: 'Knocks out expression of mechanistic amino acid synthesis genes while in rich medium (with amino acids). Tests whether the cell can grow on imported amino acids when synthesis is disabled.',
    modifies: 'sim_data.process.transcription.rna_synth_prob (AA synthesis genes → 0).',
    useCase: 'Validate that amino acid import pathways can compensate for lost biosynthesis capacity in rich conditions.',
    category: 'amino_acid',
  },
  aa_synthesis_ko_shift: {
    summary: 'Knocks out amino acid synthesis genes and then shifts from rich to minimal medium. After the shift, the cell can no longer synthesize amino acids and can no longer import them — testing whether this is lethal.',
    modifies: 'sim_data.process.transcription.rna_synth_prob + media shift.',
    useCase: 'Test conditional lethality: genes dispensable in rich medium may be essential when the cell must synthesize amino acids.',
    category: 'amino_acid',
  },
  aa_synthesis_sensitivity: {
    summary: 'Varies kinetic parameters of the amino acid synthesis network (enzyme kcat, Km, etc.) to assess sensitivity of growth rate and elongation rate to these parameters.',
    modifies: 'Amino acid synthesis network kinetic parameters.',
    useCase: 'Parameter sensitivity analysis — identify which enzymatic parameters most strongly influence growth and translation elongation rate.',
    category: 'amino_acid',
  },
  aa_uptake_sensitivity: {
    summary: 'Adds one amino acid to minimal medium and scales its uptake rate. Tests the relationship between amino acid import capacity and growth rate.',
    modifies: 'sim_data.external_state.saved_media + uptake rate scaling.',
    useCase: 'Quantify how amino acid uptake kinetics affect growth, and whether import or biosynthesis is the primary supply route.',
    category: 'amino_acid',
  },
  remove_aa_inhibition: {
    summary: 'Removes allosteric inhibition feedback for a single amino acid pathway, based on data from Sander et al. Tests how feedback regulation constrains amino acid pool sizes.',
    modifies: 'Amino acid inhibition parameters.',
    useCase: 'Validate model predictions of amino acid pool dynamics against experimental data from feedback-deficient mutants.',
    category: 'amino_acid',
  },
  ppgpp_conc: {
    summary: 'Sets the intracellular ppGpp concentration to a fixed value throughout the simulation. ppGpp is the central alarmone controlling ribosome biogenesis and amino acid biosynthesis — clamping its concentration allows study of its downstream effects.',
    modifies: 'sim_data.process.transcription (ppGpp-dependent parameters held constant).',
    useCase: 'Dissect ppGpp signaling: at low ppGpp, ribosomes dominate; at high ppGpp, amino acid biosynthesis is upregulated. Compare growth rate vs. ppGpp level.',
    paramHint: 'Valid indices are 0-19. Indices 0-9 apply the ppGpp factor series in minimal media, and 10-19 apply the same factor series in minimal_plus_amino_acids.',
    category: 'ppgpp',
  },
  ppgpp_limitations: {
    summary: 'Adjusts amino acid synthesis parameters and ribosome levels at different fixed ppGpp concentrations. Explores which aspect (translation capacity vs. amino acid supply) limits growth at each ppGpp level.',
    modifies: 'Amino acid synthesis parameters, ribosome levels, ppGpp concentration.',
    useCase: 'Identify the growth-rate-limiting step as a function of ppGpp — is the cell limited by ribosome number or amino acid supply?',
    category: 'ppgpp',
  },
  ppgpp_limitations_ribosome: {
    summary: 'Adjusts expression of rRNA and ribosomal protein genes at different fixed ppGpp concentrations. Tests whether ribosome abundance or ribosome activity is the limiting factor.',
    modifies: 'sim_data.process.transcription (rRNA/rProtein expression), ppGpp concentration.',
    useCase: 'Compare the effect of varying ribosome synthesis capacity at fixed ppGpp levels to identify regulatory bottlenecks.',
    category: 'ppgpp',
  },
  rrna_operon_knockout: {
    summary: 'Knocks out a subset of the 7 rRNA operons. E. coli has 7 copies of the rRNA operon — reducing this number tests the cell\'s capacity to maintain ribosome pools and growth rate.',
    modifies: 'sim_data.process.transcription.rna_synth_prob (rRNA operon genes → 0).',
    useCase: 'Study ribosome biogenesis limits and predict the minimum number of rRNA operons needed for growth at different rates.',
    category: 'ribosome',
  },
  rrna_location: {
    summary: 'Changes the chromosomal locations of rRNA genes. Replication-coupled gene dosage means that genes near the origin are present in more copies during fast growth. Moving rRNA operons tests this effect.',
    modifies: 'rRNA gene positions on the chromosome.',
    useCase: 'Test the gene dosage hypothesis: does rRNA gene location near the origin contribute significantly to ribosome production rate?',
    category: 'ribosome',
  },
  rrna_orientation: {
    summary: 'Reverses the transcription orientation of rRNA genes relative to replication fork movement. Co-directional transcription and replication is thought to be important for highly expressed genes.',
    modifies: 'rRNA gene orientation on the chromosome.',
    useCase: 'Test replication-transcription conflict: does inverting rRNA operons reduce their expression and growth rate?',
    category: 'ribosome',
  },
  metabolism_kinetic_objective_weight: {
    summary: 'Adjusts the kinetics weighting factor in the FBA (Flux Balance Analysis) metabolism submodel. The weight balances maximizing growth versus matching kinetic enzyme targets.',
    modifies: 'Metabolism objective function kinetics weight (varies between 0 and 1).',
    useCase: 'Parameter sensitivity for the metabolism model — how much does growth rate depend on matching kinetic constraints vs. maximizing biomass production?',
    category: 'metabolism',
  },
  metabolism_secretion_penalty: {
    summary: 'Adjusts the secretion penalty in the metabolism model. The penalty discourages the cell from secreting metabolites (overflow metabolism). Varying it tests the balance between growth and byproduct secretion.',
    modifies: 'Metabolism secretion penalty coefficient (varies between 0 and 100).',
    useCase: 'Study overflow metabolism: at what penalty level does the model switch from secretion to full oxidation?',
    category: 'metabolism',
  },
  tf_activity: {
    summary: 'Forces a transcription factor to be constitutively active or inactive, overriding the model\'s regulatory logic. Useful for validating the TF\'s regulon and its effect on gene expression.',
    modifies: 'sim_data.process.transcription_regulation (TF activity state).',
    useCase: 'Validate transcription factor models: compare expression of a TF\'s regulon when it is forced active vs. inactive vs. wildtype.',
    paramHint: '0 is control. For the listed TFs, odd indices force a TF active and the following even index forces that same TF inactive, in the model\'s sorted TF order. The designer shows the exact TF names and flags invalid overflow indices.',
    category: 'advanced',
  },
  time_step: {
    summary: 'Varies the maximum simulation time step, testing numerical convergence and the effect of temporal resolution on simulation accuracy.',
    modifies: 'sim_data.process.replication and other process time step limits.',
    useCase: 'Technical validation: verify that simulation results are stable across different time step sizes.',
    category: 'advanced',
  },
  mene_params: {
    summary: 'Varies the expression level of the menE gene to study subgenerational expression dynamics. menE encodes o-succinylbenzoate-CoA ligase in menaquinone biosynthesis.',
    modifies: 'sim_data.process.transcription (menE expression level).',
    useCase: 'Study pulsatile gene expression and how transcription probability affects protein copy number variability within a single generation.',
    category: 'advanced',
  },
  new_gene_internal_shift: {
    summary: 'Introduces a new gene with varying expression levels and translational efficiencies, then performs a media shift. Tests the cell\'s response to expressing a foreign protein.',
    modifies: 'Transcription/translation parameters for the new gene, media shift.',
    useCase: 'Model heterologous gene expression and its burden on the cell under different growth conditions.',
    paramHint: 'The index is encoded as condition_block * 1000 + remainder. Valid remainders are 0-20 within each condition block; the designer decodes the selected remainder into expression and translation settings.',
    category: 'advanced',
  },
  sinusoidal_media: {
    summary: 'Exposes cells to a sinusoidal oscillation between two media compositions. At each time point, the media is a weighted mix: p(t) = (sin(2pi*t/period) + 1) / 2 between media_a and media_b.',
    modifies: 'sim_data.external_state (continuous media mixing).',
    useCase: 'Study dynamic adaptation to oscillating environments — relevant for chemostat, gut, and industrial fermentation conditions.',
    paramHint: 'The parameter index is the oscillation period in minutes and must be at least 1. media_a and media_b are configured separately by the runtime environment, not encoded in the index.',
    category: 'advanced',
  },
  param_sensitivity: {
    summary: 'General parameter sensitivity variant for systematic perturbation of model parameters.',
    modifies: 'Various model parameters depending on configuration.',
    useCase: 'Systematic sensitivity analysis — identify which model parameters most affect simulation outcomes.',
    category: 'advanced',
  },
}

/** Extended descriptions for growth conditions */
const CONDITION_DOCS: Record<string, { description: string; carbonSource: string; keyChange: string }> = {
  basal: {
    description: 'Minimal medium with glucose as sole carbon source plus essential salts. This is the default reference condition, matching M9 minimal medium.',
    carbonSource: 'Glucose (20 mM)',
    keyChange: 'Standard minimal medium — no supplements, no removals.',
  },
  with_aa: {
    description: 'Minimal medium supplemented with all 20 amino acids. The cell can import amino acids instead of synthesizing them, resulting in faster growth (shorter doubling time) and reduced biosynthesis gene expression.',
    carbonSource: 'Glucose + all amino acids',
    keyChange: 'Amino acid supplementation represses biosynthesis pathways and increases growth rate.',
  },
  acetate: {
    description: 'Minimal medium with acetate as sole carbon source. Acetate supports slower growth and requires the glyoxylate shunt for gluconeogenesis.',
    carbonSource: 'Acetate',
    keyChange: 'Shifts to gluconeogenic metabolism; growth rate decreases significantly.',
  },
  succinate: {
    description: 'Minimal medium with succinate as sole carbon source. A TCA cycle intermediate that supports moderate growth.',
    carbonSource: 'Succinate',
    keyChange: 'Uses succinate-specific transporters and gluconeogenesis.',
  },
  fumarate: {
    description: 'Minimal medium with fumarate as sole carbon source. Similar to succinate — a TCA cycle intermediate.',
    carbonSource: 'Fumarate',
    keyChange: 'Activates fumarate transport and gluconeogenic pathways.',
  },
  malate: {
    description: 'Minimal medium with malate as sole carbon source. Another TCA cycle intermediate alternative.',
    carbonSource: 'Malate',
    keyChange: 'Activates malate transport and gluconeogenic pathways.',
  },
  no_glucose: {
    description: 'Minimal medium with no carbon source. The cell must rely on any residual carbon or cannot grow. Useful for studying carbon starvation response.',
    carbonSource: 'None',
    keyChange: 'Carbon starvation — ppGpp increases, growth rate drops dramatically.',
  },
  no_oxygen: {
    description: 'Minimal medium without oxygen (anaerobic). The cell must use fermentation or anaerobic respiration (with alternative electron acceptors if available).',
    carbonSource: 'Glucose (anaerobic)',
    keyChange: 'Switches to fermentative metabolism; produces mixed acids.',
  },
  glc_20mM: {
    description: 'Minimal medium with 20 mM glucose — the standard (high) glucose concentration.',
    carbonSource: 'Glucose (20 mM)',
    keyChange: 'Same as basal at saturating glucose.',
  },
  glc_5mM: {
    description: 'Minimal medium with 5 mM glucose — intermediate glucose concentration.',
    carbonSource: 'Glucose (5 mM)',
    keyChange: 'Glucose may become partially limiting.',
  },
  glc_2mM: {
    description: 'Minimal medium with 2 mM glucose — low glucose concentration approaching starvation.',
    carbonSource: 'Glucose (2 mM)',
    keyChange: 'Low glucose activates high-affinity transport; may limit growth.',
  },
  plus_arabinose: {
    description: 'Minimal medium supplemented with arabinose. Activates the ara operon for arabinose catabolism.',
    carbonSource: 'Glucose + arabinose',
    keyChange: 'Induces araBAD operon; tests catabolite repression.',
  },
  plus_indole: {
    description: 'Minimal medium with indole added. Indole is an intercellular signaling molecule that affects gene expression and biofilm formation.',
    carbonSource: 'Glucose',
    keyChange: 'Indole stress — induces stress response genes.',
  },
  plus_gallate: {
    description: 'Minimal medium with gallate. Gallate is a plant-derived phenolic compound that may serve as a carbon source under some conditions.',
    carbonSource: 'Glucose + gallate',
    keyChange: 'Tests gallate utilization and stress response.',
  },
  plus_nitrate: {
    description: 'Minimal medium with nitrate added. Nitrate serves as an alternative electron acceptor for anaerobic respiration.',
    carbonSource: 'Glucose + nitrate',
    keyChange: 'Enables nitrate respiration; induces narGHJI and other nitrate reductases.',
  },
  plus_nitrite: {
    description: 'Minimal medium with nitrite added. Nitrite is both a respiratory electron acceptor and a toxic intermediate.',
    carbonSource: 'Glucose + nitrite',
    keyChange: 'Induces nitrite reductase and detoxification genes.',
  },
  plus_quercetin: {
    description: 'Minimal medium with quercetin, a flavonoid with potential antimicrobial properties.',
    carbonSource: 'Glucose + quercetin',
    keyChange: 'Tests response to plant flavonoids.',
  },
  plus_tungstate: {
    description: 'Minimal medium with tungstate added. Tungstate inhibits molybdenum-dependent enzymes by competing for the molybdenum cofactor.',
    carbonSource: 'Glucose + tungstate',
    keyChange: 'Inhibits molybdo-enzymes; tests metal competition stress.',
  },
  minus_calcium: {
    description: 'Minimal medium with calcium removed. Calcium is important for outer membrane stability and some enzymatic functions.',
    carbonSource: 'Glucose',
    keyChange: 'Calcium depletion may affect cell envelope integrity.',
  },
  minus_magnesium: {
    description: 'Minimal medium with magnesium removed. Magnesium is essential for ribosome stability and many enzymatic reactions.',
    carbonSource: 'Glucose',
    keyChange: 'Severe: Mg²⁺ is required for ribosome assembly and many enzymes.',
  },
  minus_phosphate: {
    description: 'Minimal medium with phosphate removed. Phosphate is essential for nucleotide synthesis, energy metabolism, and signaling.',
    carbonSource: 'Glucose',
    keyChange: 'Induces the Pho regulon; phosphate starvation response.',
  },
}

/** Parse timeline definition string into human-readable steps */
function parseTimeline(def: string): { time_sec: number; time_human: string; media: string }[] {
  // Format: "0 minimal, 1200 minimal_plus_amino_acids"
  const cleaned = def.replace(/^"|"$/g, '')
  const steps = cleaned.split(',').map(s => s.trim()).filter(Boolean)
  return steps.map(step => {
    const match = step.match(/^(\d+)\s+(.+)$/)
    if (!match) return { time_sec: 0, time_human: '0 min', media: step }
    const sec = parseInt(match[1])
    const media = match[2].replace(/_/g, ' ').replace(/\b(minimal|plus|minus|no|GLC)\b/g, s => s)
    const min = Math.round(sec / 60)
    return {
      time_sec: sec,
      time_human: min < 60 ? `${min} min` : `${(min / 60).toFixed(1)} hr`,
      media: match[2],
    }
  })
}

/** Human-readable media label */
function mediaLabel(media: string): string {
  const labels: Record<string, string> = {
    minimal: 'Minimal (glucose)',
    minimal_plus_amino_acids: 'Minimal + amino acids',
    minimal_no_glucose: 'Minimal without glucose',
    minimal_minus_oxygen: 'Minimal (anaerobic)',
    minimal_plus_indole: 'Minimal + indole',
    minimal_plus_tungstate: 'Minimal + tungstate',
    minimal_plus_quercetin: 'Minimal + quercetin',
    minimal_plus_gallate: 'Minimal + gallate',
    minimal_succinate: 'Succinate',
    minimal_acetate: 'Acetate',
    minimal_fumarate: 'Fumarate',
    minimal_malate: 'Malate',
    minimal_plus_nitrate: 'Minimal + nitrate',
    minimal_plus_nitrite: 'Minimal + nitrite',
    minimal_minus_calcium: 'Minimal (no calcium)',
    minimal_minus_magnesium: 'Minimal (no magnesium)',
    minimal_minus_phosphate: 'Minimal (no phosphate)',
    minimal_plus_arabinose: 'Minimal + arabinose',
    minimal_GLC_20mM: 'Glucose 20 mM',
    minimal_GLC_5mM: 'Glucose 5 mM',
    minimal_GLC_2mM: 'Glucose 2 mM',
  }
  return labels[media] ?? media.replace(/_/g, ' ')
}

/** Category labels for variant groups */
const CATEGORY_LABELS: Record<string, string> = {
  core: 'Core experiment types',
  amino_acid: 'Amino acid perturbations',
  ppgpp: 'ppGpp signaling',
  ribosome: 'Ribosome & rRNA variants',
  metabolism: 'Metabolism parameters',
  advanced: 'Advanced & development',
}

const CATEGORY_ORDER = ['core', 'amino_acid', 'ppgpp', 'ribosome', 'metabolism', 'advanced'] as const

const INTERNAL_VARIANTS = new Set([
  'apply_variant',
  'template',
  'template_internal_shift',
])

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function ExperimentGuidePage() {
  const [variants, setVariants] = useState<Variant[]>([])
  const [conditions, setConditions] = useState<Condition[]>([])
  const [timelines, setTimelines] = useState<Timeline[]>([])
  const [activeSection, setActiveSection] = useState<string>('variants')

  useEffect(() => {
    getVariants().then(setVariants)
    getConditions().then(setConditions)
    getTimelines().then(setTimelines)
  }, [])

  // Group variants by category
  const variantsByCategory = useMemo(() => {
    const groups: Record<string, (Variant & { docs?: typeof VARIANT_DOCS[string] })[]> = {}
    for (const cat of CATEGORY_ORDER) {
      groups[cat] = []
    }
    for (const v of variants) {
      if (INTERNAL_VARIANTS.has(v.name)) continue
      const docs = VARIANT_DOCS[v.name]
      const cat = docs?.category ?? 'advanced'
      if (!groups[cat]) groups[cat] = []
      groups[cat].push({ ...v, docs })
    }
    return groups
  }, [variants])

  const sections = [
    { id: 'variants', label: 'Experiment types' },
    { id: 'conditions', label: 'Growth conditions' },
    { id: 'timelines', label: 'Timelines' },
    { id: 'parameters', label: 'Simulation parameters' },
  ]

  return (
    <div className="max-w-5xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <h1 className="text-xl font-semibold text-gray-900">Experiment configuration guide</h1>
          <Link
            to="/experiments/new"
            className="text-xs px-2.5 py-1 rounded-md bg-brand-50 text-brand-700 hover:bg-brand-100 transition-colors"
          >
            Design experiment &rarr;
          </Link>
        </div>
        <p className="text-sm text-gray-500 max-w-3xl">
          Reference documentation for all experiment configuration options in the wcEcoli whole-cell
          simulation. Each experiment combines an experiment type (variant), a growth condition, an
          optional timeline, and simulation parameters.
        </p>
      </div>

      {/* Section nav */}
      <div className="flex gap-1 mb-6 border-b border-gray-200 pb-px">
        {sections.map(s => (
          <button
            key={s.id}
            onClick={() => setActiveSection(s.id)}
            className={`px-4 py-2 text-sm font-medium rounded-t-md transition-colors -mb-px border-b-2 ${
              activeSection === s.id
                ? 'border-brand-600 text-brand-700'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Experiment types */}
      {activeSection === 'variants' && (
        <div className="space-y-8">
          {CATEGORY_ORDER.map(cat => {
            const items = variantsByCategory[cat]
            if (!items || items.length === 0) return null
            return (
              <section key={cat}>
                <h2 className="text-sm font-semibold text-gray-800 uppercase tracking-wide mb-3">
                  {CATEGORY_LABELS[cat]}
                </h2>
                <div className="space-y-3">
                  {items.map(v => (
                    <VariantCard key={v.name} variant={v} docs={v.docs} />
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      )}

      {/* Growth conditions */}
      {activeSection === 'conditions' && (
        <div className="space-y-3">
          <p className="text-sm text-gray-500 mb-4">
            Growth conditions define the nutrient environment for the virtual cell. The
            doubling time listed is the experimentally calibrated expected value; actual
            simulation doubling time may vary depending on the variant and stochastic effects.
          </p>
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-2.5 text-left font-medium text-gray-500 w-36">Condition</th>
                  <th className="px-4 py-2.5 text-left font-medium text-gray-500 w-28">Media ID</th>
                  <th className="px-4 py-2.5 text-right font-medium text-gray-500 w-24">Doubling</th>
                  <th className="px-4 py-2.5 text-left font-medium text-gray-500">Description</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {conditions.map(c => {
                  const docs = CONDITION_DOCS[c.name]
                  return (
                    <tr key={c.name} className="hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium text-gray-900">{c.name}</td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-500">{c.nutrients}</td>
                      <td className="px-4 py-3 text-right font-mono text-sm">
                        {c.doubling_time ? `${c.doubling_time} min` : '—'}
                      </td>
                      <td className="px-4 py-3 text-gray-600 text-xs leading-relaxed">
                        {docs?.description ?? 'No detailed description available.'}
                        {docs?.keyChange && (
                          <span className="block mt-1 text-gray-400">
                            Key effect: {docs.keyChange}
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Timelines */}
      {activeSection === 'timelines' && (
        <div className="space-y-3">
          <p className="text-sm text-gray-500 mb-4">
            Timelines define sequences of media shifts during a simulation. At each specified
            time, the growth medium changes instantaneously. This models nutrient upshift,
            downshift, and oscillation experiments. Times are in seconds from simulation start.
          </p>
          <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
            <p className="font-medium">Designer behavior</p>
            <p className="mt-1 text-blue-800">
              In the interface, the <span className="font-medium">timelines</span> experiment type uses the
              Timeline Composer as its effective timeline source. Some other experiment types still
              preset timeline internally, and the designer will show a notice when that happens.
            </p>
          </div>
          <div className="space-y-3">
            {timelines.map(t => (
              <TimelineCard key={t.name} timeline={t} />
            ))}
          </div>
        </div>
      )}

      {/* Simulation parameters */}
      {activeSection === 'parameters' && (
        <div className="space-y-6">
          <div className="bg-white rounded-lg border border-gray-200 p-5">
            <h3 className="text-sm font-semibold text-gray-800 mb-3">Seeds (replicates)</h3>
            <div className="text-sm text-gray-600 space-y-2">
              <p>
                Each seed is an independent random replicate starting from a different random
                number generator state. Seeds produce statistically independent cell trajectories,
                allowing you to measure variability and compute confidence intervals.
              </p>
              <div className="bg-gray-50 rounded-md p-3 text-xs text-gray-500 space-y-1">
                <p><span className="font-medium text-gray-700">Range:</span> 1–64 seeds</p>
                <p><span className="font-medium text-gray-700">Typical use:</span> 1 seed for quick exploration, 4–8 seeds for publication-quality statistics, 16+ for high-confidence mean/variance estimates.</p>
                <p><span className="font-medium text-gray-700">Runtime:</span> Seeds are independent and can run in parallel if compute allows. Each seed takes approximately the same wall-clock time.</p>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-lg border border-gray-200 p-5">
            <h3 className="text-sm font-semibold text-gray-800 mb-3">Generations</h3>
            <div className="text-sm text-gray-600 space-y-2">
              <p>
                The number of sequential cell divisions to simulate. After each division, the
                simulation picks one daughter cell and continues. Multiple generations reveal
                long-term dynamics, accumulation effects, and potential lethality that may not
                appear in a single generation.
              </p>
              <div className="bg-gray-50 rounded-md p-3 text-xs text-gray-500 space-y-1">
                <p><span className="font-medium text-gray-700">Range:</span> 1–10 generations</p>
                <p><span className="font-medium text-gray-700">Typical use:</span> 1 generation for fast screening (~30 min compute), 2–3 generations for checking phenotype stability, 8+ for testing long-term viability.</p>
                <p><span className="font-medium text-gray-700">Runtime:</span> Each generation takes approximately 30 minutes of real compute time. Generations are sequential (each depends on the previous division state).</p>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-lg border border-gray-200 p-5">
            <h3 className="text-sm font-semibold text-gray-800 mb-3">Max duration (seconds)</h3>
            <div className="text-sm text-gray-600 space-y-2">
              <p>
                The maximum simulated time in seconds for each generation. If the cell has not
                divided by this time, the simulation stops for that generation. The default
                (10,800 s = 3 hr) is generous enough for wildtype cells (doubling time ~44 min)
                but may need to be increased for slow-growing conditions or lethal knockouts where
                division is delayed.
              </p>
              <div className="bg-gray-50 rounded-md p-3 text-xs text-gray-500 space-y-1">
                <p><span className="font-medium text-gray-700">Range:</span> 60 s minimum, typically 3,600–10,800 s</p>
                <p><span className="font-medium text-gray-700">Default:</span> 10,800 s (3 hours) — sufficient for most conditions.</p>
                <p><span className="font-medium text-gray-700">Guidance:</span> For fast conditions (with_aa, 25 min doubling), 3,600 s is ample. For slow conditions (acetate, 136 min doubling), use at least 10,800 s. For knockouts that may be lethal, 10,800–14,400 s allows time to confirm the cell cannot divide.</p>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-lg border border-gray-200 p-5">
            <h3 className="text-sm font-semibold text-gray-800 mb-3">Understanding runtime estimates</h3>
            <div className="text-sm text-gray-600 space-y-2">
              <p>
                Total compute time depends on the combination of parameters. As a rough guide:
              </p>
              <div className="bg-gray-50 rounded-md p-3 text-xs font-mono text-gray-600">
                total_time ≈ seeds × generations × ~30 min per generation
              </div>
              <p className="text-xs text-gray-500 mt-2">
                For example, 4 seeds × 2 generations = 8 generation-runs.
                If seeds run in parallel on 4 cores, wall-clock time is approximately 2 × 30 = 60 minutes.
                The first run (Parca parameter calculation) adds a one-time overhead of ~5 minutes.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

function VariantCard({ variant, docs }: {
  variant: Variant
  docs?: typeof VARIANT_DOCS[string]
}) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left px-4 py-3 flex items-center justify-between hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className="font-medium text-gray-900 text-sm">{variantLabel(variant.name)}</span>
          <span className="font-mono text-xs text-gray-400">{variant.name}</span>
        </div>
        <span className="text-gray-400 text-xs">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="border-t border-gray-100 px-4 py-3 space-y-3 text-sm">
          {docs ? (
            <>
              <p className="text-gray-700 leading-relaxed">{docs.summary}</p>
              <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
                <span className="font-medium text-gray-500">Modifies</span>
                <span className="text-gray-600 font-mono">{docs.modifies}</span>
                <span className="font-medium text-gray-500">Use case</span>
                <span className="text-gray-600">{docs.useCase}</span>
                {docs.paramHint && (
                  <>
                    <span className="font-medium text-gray-500">Parameter</span>
                    <span className="text-gray-600">{docs.paramHint}</span>
                  </>
                )}
              </div>
            </>
          ) : (
            <div>
              <p className="text-gray-600 leading-relaxed whitespace-pre-line">
                {variant.docstring || 'No documentation available for this variant.'}
              </p>
              <p className="text-xs text-gray-400 mt-2">
                Source: <span className="font-mono">{variant.filename}</span>
              </p>
            </div>
          )}
          <div className="flex gap-2 pt-1 border-t border-gray-100">
            <Link
              to={`/experiments/new?variant=${encodeURIComponent(variant.name)}`}
              className="text-xs px-2.5 py-1 rounded-md bg-brand-50 text-brand-700 hover:bg-brand-100 transition-colors"
            >
              Use this type &rarr;
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}

function TimelineCard({ timeline }: { timeline: Timeline }) {
  const steps = parseTimeline(timeline.definition)
  const isShift = steps.length >= 2

  // Derive a human-readable name
  const readableName = timeline.name
    .replace(/^\d+_/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <span className="font-medium text-gray-900 text-sm">{readableName}</span>
          <span className="font-mono text-xs text-gray-400">{timeline.name}</span>
        </div>
        {isShift && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
            {steps.length - 1} shift{steps.length > 2 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Visual timeline */}
      <div className="flex items-center gap-0 mt-3">
        {steps.map((step, i) => (
          <div key={i} className="flex items-center">
            {i > 0 && (
              <div className="flex flex-col items-center mx-1.5">
                <span className="text-xs text-gray-400">&rarr;</span>
                <span className="text-[10px] text-gray-400">{step.time_human}</span>
              </div>
            )}
            <div className="px-2.5 py-1.5 rounded-md bg-gray-50 border border-gray-200 text-xs">
              {i === 0 && <span className="text-[10px] text-gray-400 block">t=0</span>}
              <span className="text-gray-700">{mediaLabel(step.media)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
