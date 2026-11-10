/** Explorer-only editorial content. Parameter values come from the publication, not this file.
 * Reviewed against the local guide, designer groups and frozen variant implementations.
 * Legacy runtime instructions and unverified phenotype claims are deliberately not copied.
 */
import type {GuideTopicId,GuideSection} from './guideLinks'
export type {GuideSection} from './guideLinks'
export const GUIDE_SECTIONS = [
  ['overview','Overview'],['variants','Experiment types'],['conditions','Growth conditions'],
  ['timelines','Timelines'],['parameters','Design parameters'],['workflows','Design workflows'],
  ['results','Reading results'],['shortcuts','Keyboard shortcuts'],
] as const
export type GuideBlock = {heading:string;paragraphs:string[];topic?:GuideTopicId}
export type GuideArticle = {intro:string;blocks:GuideBlock[];links?:{to:string;label:string}[]}

export const GUIDE_ARTICLES: Record<GuideSection,GuideArticle> = {
  overview:{
    intro:'Explore published whole-cell model results, understand the reference catalogs, and turn a question into a personal experiment plan.',
    blocks:[
      {topic:'model-coverage',heading:'Model coverage and gene context',paragraphs:[
        'A catalog entry describes what this model represents about a gene: its reference identity, chromosome position where recorded, expression products and connections to modeled processes. It does not mean that every biological role of the gene is represented.',
        'Mechanistic and expression-only labels describe model coverage. Neither label is an experimental essentiality classification. Use the gene workspace and genome map to inspect reference context, then evaluate published evidence and its limitations separately.',
      ]},
      {topic:'mechanistic',heading:'Mechanistic genes',paragraphs:[
        'Mechanistic genes are connected to downstream processes represented in this model, such as metabolism, replication or regulation. Their modeled products can contribute to processes beyond RNA and protein expression.',
        'This classification does not establish that a gene is essential, that its perturbation prevents division, or that the model includes every biological interaction. Interpret an observed response with the actual transcription-unit target, co-targeted genes, environment and available controls.',
      ]},
      {topic:'expression-only',heading:'Expression-only genes',paragraphs:[
        'Expression-only genes have RNA and protein expression represented without a mechanistic connection to downstream processes in this model. Their expression trajectories can be inspected even where downstream biological functions are outside the model’s coverage.',
        'A missing modeled growth effect is not evidence of biological dispensability. Distinguish a coverage limitation from a measured absence of an effect, and do not treat an expression-only label as a negative essentiality result.',
      ]},
      {topic:'model-state-ids',heading:'Model state identifiers',paragraphs:[
        'Gene identifiers, RNA/transcription-unit identifiers, protein monomer IDs, complex IDs and metabolite IDs refer to different model entities. Use the recorded relationships to follow a gene into its expression products, enzymes and associated molecular output.',
        'Keep the molecule or reaction identifier, compartment and units with each series. A transcription unit can contain several genes; a protein may be part of a complex. Missing mappings or unsupported molecular channels remain unavailable rather than being inferred from similar names.',
      ]},
      {heading:'Published results and personal plans',paragraphs:[
        'Published experiments have recorded model output. Personal drafts are unrun configurations you create in the single, batch or environment builders. Saving or downloading a draft does not create a job or scientific result.',
        'The published campaign contains twelve designs, seed 0 for each, and 47 saved generation trajectories. These are model simulations, not experimental measurements of living cells. Other catalog options can be explored as plans; their presence does not mean they were run in this campaign.',
      ]},
      {heading:'Choose a starting point',paragraphs:[
        'Open Published results to inspect a real trajectory, or use Design from this experiment to copy its configuration into a personal draft. Use the gene workspace, genome map, TF network and pathways to inspect reference context.',
        'Experiment types, Growth conditions and Timelines explain the inputs. Design parameters and Design workflows explain how to assemble and keep a plan. Reading results explains what the published evidence can support.',
      ]},
      {heading:'What this explorer can establish',paragraphs:[
        'Catalog checks validate identifiers, dependencies and configuration structure. They do not establish runtime readiness or predict rescue, inhibition, essentiality or viability. New simulations cannot be run here; assistant and training features are unavailable.',
        'Published data stays read-only. Drafts are saved only when you choose Save in this browser. Browser storage belongs to this browser profile and site origin; it is not a shared account or a backup.',
      ]},
    ],links:[{to:'/results',label:'Explore published results'},{to:'/experiments/new',label:'Design an experiment'},{to:'/explore',label:'Open gene workspace'}],
  },
  variants:{intro:'Choose a model change that matches your question. The cards cover the same core and advanced options as the explorer designers.',blocks:[
    {heading:'Read the parameter and environment together',paragraphs:[
      'A variant index is a model-specific selector, not a gene identifier or a common dose scale. Use the published parameter hints below and the designer’s semantic selectors. Do not transfer integer indices between models.',
      'Some variants manage their own condition or timeline; others expose the Timeline Composer. The cards show current catalog restrictions. Composer availability is a planning interface, not proof that an arbitrary design is runtime-ready. Advanced studies may have additional model-specific assumptions.',
    ]},
  ],links:[{to:'/experiments/new',label:'Open single designer'},{to:'/experiments/batch',label:'Open batch builder'}]},
  conditions:{intro:'A growth condition selects a nutrient recipe and may also specify transcription-factor states or expression perturbations. Inspect the underlying stock and recipe rather than inferring composition from its name.',blocks:[
    {heading:'Stocks, recipes and conditions',paragraphs:[
      'A media stock lists extracellular molecule IDs and concentrations in mmol/L. Finite concentrations constrain nutrient availability; Infinity represents unconstrained supply in the model, not a measured concentration.',
      'A recipe combines base and supplemental stocks. The builder labels stock and ingredient volumes in L, ingredient weights in g, and ingredient amounts in mmol; do not interpret these fields as concentrations. A condition points to a recipe and can include active/inactive TF definitions and genotype perturbations.',
      'The tables below come from the published reference catalog. Personal environment overlays appear only in your drafts and do not change these shared references. Use the Environment Builder to inspect or create a personal alternative.',
    ]},
    {heading:'Reference doubling time is not a result',paragraphs:[
      'Catalog doubling times are reference values in minutes used by the model configuration. They are not measured division durations from a published run, a guarantee of growth, or the runtime needed to compute a simulation.',
      'Compare perturbations with a matched wild-type environment where a published control exists. A condition appearing here does not imply that this campaign contains a result for it.',
    ]},
  ],links:[{to:'/environment-builder',label:'Inspect the Environment Builder'},{to:'/guide?section=timelines',label:'Understand media changes'}]},
  timelines:{intro:'A timeline records when the model environment changes. Keep the starting condition distinct from later nutrient events.',blocks:[
    {heading:'Starting state and time-zero medium',paragraphs:[
      'The initial condition describes initialization, while a time-zero media event describes the external environment at the start. They are related but are not interchangeable. The published campaign records explicit initialization separately from its timeline.',
      'In a composed timeline, the first event starts at 0 seconds; subsequent event times must increase and reference known media recipes or resolved personal overlays. Enter seconds in the timeline controls: 1,200 seconds is 20 minutes. The tables show both units without rounding away the original seconds.',
    ]},
    {heading:'Elapsed lineage time and generation-relative time',paragraphs:[
      'Published timed shifts use elapsed lineage time, so their schedule does not restart when a cell divides. For example, a change at 1,200 seconds occurs once at that lineage time if the lineage reaches it.',
      'Default result plots use elapsed lineage time. An explicit generation-relative view subtracts the recorded start of the selected generation. A point at 0 seconds on that view can therefore occur well after the start of the lineage.',
    ]},
    {heading:'Variant-managed schedules',paragraphs:[
      'Some experiment types define an internal shift, oscillation or environment branch. Check the Experiment types card and the designer’s media-protocol notice: locked controls cannot be treated as a freely composed timeline.',
      'A reference schedule is a design input, not evidence that a shift occurred in a saved result. For published shifts, use recorded execution provenance and actual saved clocks. Unrun drafts have no event-execution evidence.',
    ]},
  ],links:[{to:'/guide?section=variants',label:'Check variant timeline restrictions'},{to:'/environment-builder',label:'Design a personal timeline'}]},
  parameters:{intro:'These fields describe a proposed simulation. They remain planning metadata in the explorer and never authorize computation.',blocks:[
    {heading:'Seed',paragraphs:[
      'The random seed identifies a stochastic realization. The published release uses seed 0 for each experiment, with no additional seed replicates. Changing a draft’s seed or seed count does not generate another realization.',
      'For a future study, distinct seeds can be planned as replicates. Sequential generations from the same seed are a lineage, not independent replicates and not a basis for a confidence interval across seeds.',
    ]},
    {heading:'Requested generations',paragraphs:[
      'Generations follow one daughter lineage after successive divisions; they do not form a population of independent cells. A request is an upper bound, not evidence that every requested generation exists.',
      'The published campaign requested four generations per experiment. hisG-basal has three recorded generations; its final cell reached its simulated time limit without division. Preserve those actual generation IDs instead of filling missing generations with curves or zero values.',
    ]},
    {heading:'Maximum simulated duration',paragraphs:[
      'This limit is simulated seconds per generation, not wall-clock compute time. A cell that reaches its limit without dividing is recorded as no division. That outcome alone does not establish death or lethality.',
      'Infrastructure errors, memory failures, missing output and timeouts are distinct from scientific outcomes. A draft has none of these outcomes because it has not been executed.',
    ]},
    {topic:'knockout-index',heading:'Knockout indices and transcription-unit targets',paragraphs:[
      'Use each experiment type’s published index metadata. Hidden or derived index controls should be handled through the matching gene, condition, TF or timeline selector rather than guessed integers.',
      'Expression perturbations target prepared RNA/transcription units. One selected gene can therefore co-target other genes; multiple selected genes may resolve to a shared target. Inspect the recorded mappings and co-targets. Catalog validation does not create a runtime-readiness receipt.',
      'A knockout index is a prepared-model expression-target selector, not a gene identifier, essentiality score or portable index across models. An unavailable index or missing target mapping must not be replaced with a guessed integer. Use the gene picker and review the prepared target examples in Experiment types.',
    ]},
  ],links:[{to:'/guide?section=variants',label:'Read type-specific parameters'},{to:'/experiments/new',label:'Review a personal design'}]},
  workflows:{intro:'Use the existing design tools to keep a question and its configuration together. All designs stay personal and unrun.',blocks:[
    {heading:'Single experiment',paragraphs:[
      'Open Design an experiment, name the draft, choose a type, and review its parameters. Select genes through the gene picker when applicable, then inspect the growth condition, media protocol and planning checks.',
      'Choose Save in this browser to retain the draft, or Download current draft to keep a JSON copy even before saving. Design from this experiment copies a published configuration; it does not copy a result into the new draft.',
    ]},
    {heading:'Batch designs',paragraphs:[
      'Open the Batch builder, choose the experiment types and parameter dimensions, and review the expanded combinations and total planned count. Use matched controls to frame comparisons without assuming that any generated design already has a result.',
      'At most 1,000 expanded designs are shown in the preview. The stored batch recipe and total planned count are retained; the preview limit does not silently delete designs. Saving or exporting a batch does not submit a queue.',
    ]},
    {heading:'Personal environments',paragraphs:[
      'Work through media stocks, media recipes, conditions, TF conditions and timelines in the Environment Builder. Review the molecule IDs, concentrations, ingredient units and dependent references.',
      'Save the section in this browser, then choose Use in my drafts and review the overlay when you want it available to your designs. This does not publish or modify the shared catalog. Dependent drafts must retain their custom media, recipes, conditions, TF conditions and timelines.',
    ]},
    {heading:'Reopen and organize drafts',paragraphs:[
      'Open Experiments → My drafts to reopen, rename, duplicate or delete a saved design. Duplicate makes a separate personal copy. Deleting a draft does not delete a published experiment.',
      'Save changes explicitly. Leaving a dirty design prompts you to stay or leave without saving. Do not assume navigation, closing a tab or downloading also saves the browser copy.',
    ]},
    {heading:'JSON export and import',paragraphs:[
      'Download the current design, selected drafts or all drafts. Exports include required custom dependencies and source/reference fingerprints. Share the JSON file, then import it through My drafts in another explorer browser.',
      'Imports are limited to 5 MiB and add new copies, remapping dependency IDs without overwriting existing drafts or published references. Invalid or unsupported files are rejected atomically. Changed reference fingerprints or unresolved dependencies require review; genes and indices are not silently retargeted.',
      'Browser storage is specific to the browser profile and site origin, may be cleared, and does not synchronize between local preview and Hugging Face. If storage fails, saving must not be assumed successful; download the current design instead. Import into the full local simulation platform is not supported.',
    ]},
  ],links:[{to:'/experiments/new',label:'Single designer'},{to:'/experiments/batch',label:'Batch builder'},{to:'/environment-builder',label:'Environment Builder'},{to:'/experiments?view=drafts',label:'My drafts'}]},
  results:{intro:'Read model output with its seed, actual generation, clock, units and recorded outcome. Keep reference assumptions separate from observations.',blocks:[
    {heading:'Find and compare a result',paragraphs:[
      'Published results lists the twelve campaign experiments. Open a result for its configuration, lineage outcome, charts and molecular series. Unsupported views have explicit unavailable states rather than synthetic curves.',
      'Comparisons use an actual selected generation and default to generation 0. If one experiment has no output for that generation, its comparison is unavailable. Controls come from the manifest: a timed shift has an initial-environment reference and an endpoint-environment reference, with distinct roles.',
    ]},
    {heading:'Charts and molecular families',paragraphs:[
      'Scalar charts retain all saved samples and recorded units. Time is elapsed lineage time by default. An explicit generation-relative axis starts at that generation’s recorded start; it does not change when the lineage’s media shift occurred.',
      'The four available matrices are mRNA, protein, reaction flux and exchange flux. Use each series’ molecule or reaction identifier and recorded units; flux and abundance are different quantities. A positive or negative flux follows that recorded reaction/exchange convention, not an automatic label of good or bad growth.',
      'Unavailable channels show a reason. Undefined initial growth can appear as a gap. Missing data, missing generations and unsupported molecular views must not be interpreted as zero abundance or zero flux.',
    ]},
    {heading:'Metrics and uncertainty',paragraphs:[
      'Final saved mass and final saved growth rate describe the last saved sample of the selected generation. They are not means. Recorded division duration is available only when supported by division metadata; a no-division time limit is not a doubling time.',
      'Relative comparisons are unavailable when a control value is missing or its denominator is zero. One seed per design does not support independent-replicate confidence intervals. Sequential generations share lineage history.',
    ]},
    {heading:'Outcomes and biological interpretation',paragraphs:[
      'Distinguish recorded division, no division, biological termination, missing output and execution errors. In this campaign, hisG-basal ended with no division at its per-generation model time limit. This does not by itself demonstrate biological death.',
      'Expression perturbations can co-target genes within a transcription unit. Compare the actual target set, environment and controls before attributing an effect to one gene. This limited campaign cannot establish genome-wide essentiality; unmeasured genes remain unclassified.',
      'For nutrient-rescue or environment-dependent hypotheses, inspect the published matched references and trajectories. A design’s name or intended comparison does not guarantee rescue, growth inhibition or any particular phenotype.',
    ]},
  ],links:[{to:'/results',label:'Browse published results'},{to:'/results/compare',label:'Compare published references'},{to:'/design',label:'Inspect published perturbation evidence'}]},
  shortcuts:{intro:'These shortcuts are available in the explorer workspace. They do not open assistant features or execute designs.',blocks:[
    {heading:'Keyboard and touch access',paragraphs:[
      'Use Tab and Shift+Tab to move between links and controls, and Enter to activate a focused link. Section links are bookmarkable. Expand experiment descriptions with Enter or Space on their summary.',
      'The ? shortcut applies outside text-entry fields in the workspace. Ctrl/Cmd+K opens command search; Escape closes the command palette. Ctrl/Cmd+B changes the desktop sidebar’s collapsed state. On a mobile guide page, use Navigate to open site links.',
      'Theme controls support light, dark and system settings. Help and expandable descriptions work through focus or activation as well as pointer interaction.',
    ]},
  ]},
}

export const GUIDE_GROUPS = [
  ['core','Core experiments'],['amino_acid','Amino-acid studies'],['ppgpp','ppGpp regulation'],
  ['ribosome','Ribosome architecture'],['metabolism','Metabolic parameters'],['advanced','Advanced model studies'],
] as const
type Group = typeof GUIDE_GROUPS[number][0]
type VariantDoc = {group:Group;summary:string;question:string;limitation?:string}
const doc=(group:Group,summary:string,question:string,limitation?:string):VariantDoc=>({group,summary,question,limitation})
export const GUIDE_VARIANTS: Record<string,VariantDoc> = {
  wildtype:doc('core','Uses the prepared wild-type model without an expression or parameter perturbation. The selected environment still matters.','What baseline trajectory provides an appropriate reference for the proposed perturbation?'),
  gene_knockout:doc('core','Sets expression for a prepared RNA/transcription-unit target to zero. Existing molecules can remain and change through degradation, dilution and downstream model processes.','How does a recorded expression-target perturbation compare with a matched wild-type environment?','The target is not necessarily a single gene. Review the actual TU and all co-targeted genes; do not infer essentiality from a model index.'),
  multi_gene_knockout:doc('core','Combines expression targets selected through the multi-gene picker. The parameter index is derived rather than a list of gene numbers.','How might a combined target set differ from the corresponding individual perturbations?','Selected genes can share transcription-unit targets. Inspect co-targets and overlap; catalog checks do not establish a viable or executable combined model.'),
  condition:doc('core','Selects a static growth condition through the catalog’s condition index and its associated nutrient environment.','How do trajectories differ between specified environments?','Use the published condition ordering, not the old source docstring’s abbreviated example ordering.'),
  timelines:doc('core','Uses the Timeline Composer to describe scheduled changes between media recipes.','What response would a defined nutrient shift test?','Timeline selection is through the composer; legacy preset timeline indices are not the interface contract.'),
  add_one_aa:doc('amino_acid','Adds the selected amino acid to the model-managed minimal medium.','Does external availability of one amino acid change a trajectory relative to a matched reference?'),
  remove_one_aa:doc('amino_acid','Removes a selected amino acid from the model-managed supplemented environment.','How does loss of one supplemented amino acid affect the model’s supply and synthesis balance?'),
  add_one_aa_shift:doc('amino_acid','Uses a variant-managed amino-acid addition after its internal ten-minute shift.','What dynamics follow a defined single-amino-acid addition?','This internal schedule is different from the campaign’s composed 1,200-second shifts; check the selected branch and its control.'),
  remove_one_aa_shift:doc('amino_acid','Uses a variant-managed removal of one amino acid after its internal ten-minute shift.','What dynamics follow loss of one supplied amino acid?','Check the branch and control; do not substitute the campaign’s 1,200-second timing for this type’s internal schedule.'),
  remove_aas_shift:doc('amino_acid','Selects a predefined branch that retains or removes subsets of supplemented amino acids.','How could a specified supplementation change alter amino-acid supply?','Some branches are static controls rather than shifts. Read the exact parameter options and environment notice.'),
  aa_synthesis_ko:doc('amino_acid','Perturbs expression of a selected mechanistic amino-acid synthesis enzyme in a rich-medium study.','Can the model’s nutrient supply compensate for the selected synthesis perturbation?','Compensation is a hypothesis, not a promised rescue; inspect target mapping and the intended rich environment.'),
  aa_synthesis_ko_shift:doc('amino_acid','Combines a selected amino-acid synthesis expression perturbation with a rich-to-minimal study, with branch-specific supplementation.','How does nutrient withdrawal change the effect of the selected synthesis perturbation?','This study has model-specific branch and schedule assumptions. A composer control does not certify that an arbitrary replacement schedule is runtime-ready.'),
  aa_synthesis_sensitivity:doc('amino_acid','Changes amino-acid synthesis network parameters across encoded amino-acid and media combinations.','Which modeled synthesis assumptions influence growth or elongation dynamics?','The encoded parameter grid is model-specific; read the published index options instead of treating the index as a concentration.'),
  aa_uptake_sensitivity:doc('amino_acid','Adds an amino acid and scales its uptake rate across the selected parameter branch.','How sensitive is a trajectory to the assumed uptake capacity?'),
  remove_aa_inhibition:doc('amino_acid','Removes modeled allosteric feedback inhibition for a selected amino-acid pathway.','How does feedback inhibition constrain the modeled pathway and amino-acid pool?','This is a model regulation change, not direct evidence of an experimental mutant’s phenotype.'),
  ppgpp_conc:doc('ppgpp','Holds modeled ppGpp concentration at a selected factor within a condition block.','How do resource-allocation dynamics differ under a fixed ppGpp setting?','A clamped concentration is a model probe; it is not the same as observing normal ppGpp regulation.'),
  ppgpp_limitations:doc('ppgpp','Changes amino-acid synthesis parameters, enzyme levels or ribosome settings under fixed ppGpp concentrations.','Which modeled supply or translation constraint limits the response under the chosen setting?','Review the encoded study branches and assumptions rather than interpreting the parameter as a single biological dose.'),
  ppgpp_limitations_ribosome:doc('ppgpp','Changes rRNA and ribosomal-protein expression under fixed ppGpp settings.','How does ribosome synthesis capacity interact with a clamped regulatory state?'),
  rrna_operon_knockout:doc('ribosome','Changes the expressed subset of rRNA operons within model-specific environmental branches.','How does the selected rRNA operon perturbation affect modeled ribosome supply?','Encoded branches can manage their own media schedule; the index is not simply a count of deleted genes.'),
  rrna_location:doc('ribosome','Changes chromosomal locations of rRNA genes in selected study branches.','How might replication-associated gene dosage change modeled rRNA supply?'),
  rrna_orientation:doc('ribosome','Reverses selected rRNA gene orientations in model-specific study branches.','What does the model predict for the selected orientation perturbation?','Do not infer an experimental replication–transcription conflict phenotype solely from a draft.'),
  metabolism_kinetic_objective_weight:doc('metabolism','Changes the weighting of kinetic targets in the metabolism optimization objective.','How sensitive is the model to the balance between its metabolic objective terms?','An index selects a weighting branch; it is not itself a measured enzyme activity.'),
  metabolism_secretion_penalty:doc('metabolism','Changes the penalty applied to secretion in the metabolism objective.','How does the assumed secretion cost influence modeled exchange and growth?','Read the branch metadata rather than treating the integer index as the penalty coefficient.'),
  mene_params:doc('advanced','Varies menE expression in a study of subgenerational expression dynamics.','How does a selected expression setting alter the modeled menE trajectory?'),
  new_gene_internal_shift:doc('advanced','Encodes a condition, new-gene expression factor and translation-efficiency branch with generation-dependent internal changes.','How could the specified new-gene expression program affect model resource allocation?','Requires model-specific new-gene preparation assumptions; catalog availability does not establish that a chosen design is runtime-ready.'),
  param_sensitivity:doc('advanced','Perturbs subsets of fitted degradation, translation and expression parameters in a sensitivity study.','Which fitted parameter assumptions most influence the modeled response?','The published catalog does not provide a detailed index mapping for this type. Do not guess parameter targets from its index.'),
  time_step:doc('advanced','Changes the maximum numerical simulation time step.','How sensitive are numerical trajectories to the selected integration setting?','This is a numerical setting, not the saved sample interval, biological duration or compute-time estimate.'),
  tf_activity:doc('advanced','Selects a transcription factor’s active or inactive state together with the nutrient and expression settings recorded for that branch.','How does a specified regulatory-state probe compare with an appropriate matched environment?','Active and inactive branches can differ in nutrient recipes and co-perturbations. The selected TF state is not an isolated gene-expression change; inspect the TF-condition definitions and internal timeline notice.'),
  sinusoidal_media:doc('advanced','Uses a variant-managed oscillating mixture of two media; the index represents a period in minutes.','How would a specified periodic environment test adaptation dynamics?','Check the locked environment metadata and positive-period requirement; a drawn plan is not evidence that an oscillatory run occurred.'),
}

export const GUIDE_SHORTCUTS = [
  ['Ctrl / ⌘ + K','Open command search in the workspace'],
  ['Ctrl / ⌘ + B','Collapse or expand the desktop workspace sidebar'],
  ['?','Open Keyboard shortcuts when not typing in a field'],
  ['Escape','Close command search; dismiss supported dialogs or help'],
  ['Tab / Shift + Tab','Move between interactive controls'],
  ['Enter / Space','Activate a focused button or expandable description'],
] as const
