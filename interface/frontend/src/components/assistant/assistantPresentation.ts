import type { AssistantContext, AssistantToolCall } from '../../types'



export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function messageStatusTone(status: string): 'neutral' | 'ready' | 'blocked' | 'planned' {
  if (status === 'completed') return 'ready'
  if (status.includes('failed') || status.includes('no_provider') || status.includes('not_configured')) return 'blocked'
  return 'neutral'
}

const MESSAGE_STATUS_LABELS: Record<string, string> = {
  sending: 'sending',
  failed: 'failed to send',
  provider_call_failed: 'provider error',
  no_provider_configured: 'no provider',
  selected_provider_not_configured: 'provider not configured',
  provider_not_supported: 'unsupported provider',
}

export function messageStatusLabel(status: string): string {
  return MESSAGE_STATUS_LABELS[status] ?? status.replace(/_/g, ' ')
}

export function actionStatusTone(status: string): 'neutral' | 'ready' | 'blocked' | 'planned' {
  if (['executed', 'used', 'approved', 'completed'].includes(status)) return 'ready'
  if (['pending', 'pending_confirmation', 'confirmation_required', 'proposed'].includes(status)) return 'planned'
  if (['rejected', 'cancelled', 'failed', 'validation_failed', 'adapter_not_enabled'].includes(status)) return 'blocked'
  return 'neutral'
}

export function compactJson(value: unknown, maxLength = 140): string {
  const text = JSON.stringify(value ?? {}, null, 0)
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text
}

export function formatDateTime(value: string): string {
  if (!value) return 'not recorded'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

export function parseOptionalNumber(value: string | null): number | null {
  if (!value) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function surfaceName(context: AssistantContext): string {
  const route = context.route || ''
  if (context.assistant_surface === 'results' || route.includes('/results')) return 'Results'
  if (context.assistant_surface === 'workspace' || route === '/' || route.includes('workspace')) return 'Workspace'
  if (context.assistant_surface === 'conditions_builder' || route.includes('environment-builder')) return 'Conditions Builder'
  if (context.assistant_surface === 'experiments' || route.includes('/experiments')) return 'Experiments'
  if (context.assistant_surface === 'genes' || route.includes('/genes')) return 'Genes'
  if (context.assistant_surface === 'network' || route.includes('/network')) return 'Network'
  if (context.assistant_surface === 'genome' || route.includes('/genome')) return 'Genome Map'
  if (context.assistant_surface === 'pathways' || route.includes('/pathways')) return 'Pathways'
  if (context.assistant_surface === 'ml' || route.includes('/ml')) return 'Machine Learning'
  if (context.assistant_surface === 'design' || route.includes('/design')) return 'Genome Design'
  return 'Assistant'
}

export function contextSummary(context: AssistantContext): string {
  const surface = surfaceName(context)
  if (surface === 'Results') {
    const gene = context.selected_gene ? `${context.selected_gene} ` : ''
    const condition = context.selected_condition ? ` under ${context.selected_condition}` : ''
    const job = context.selected_job != null ? `, Job #${context.selected_job}` : ''
    return `You are viewing ${gene}simulation results${condition}${job}.`
  }
  if (surface === 'Workspace' && context.selected_gene) {
    return `You are inspecting gene ${context.selected_gene} in Workspace.`
  }
  if (surface === 'Conditions Builder') {
    const section = context.selected_builder_section
      ? ` in the ${context.selected_builder_section.replace(/_/g, ' ')} section`
      : ''
    return `You are editing environment inputs${section}.`
  }
  if (surface === 'Experiments') {
    const gene = context.selected_gene ? ` for ${context.selected_gene}` : ''
    const variant = context.selected_variant_type ? ` as ${context.selected_variant_type.replace(/_/g, ' ')}` : ''
    return `You are designing or reviewing an experiment${gene}${variant}.`
  }
  if (surface === 'Genes') {
    const gene = context.selected_gene ? ` with ${context.selected_gene} selected` : ''
    return `You are browsing the gene catalog${gene}.`
  }
  if (surface === 'Network') {
    const gene = context.selected_gene ? ` focused on ${context.selected_gene}` : ''
    return `You are inspecting the transcription-factor network${gene}.`
  }
  if (surface === 'Genome Map') {
    const gene = context.selected_gene ? ` focused on ${context.selected_gene}` : ''
    return `You are inspecting the chromosome map${gene}.`
  }
  if (surface === 'Pathways') {
    return 'You are exploring knockout essentiality and amino-acid pathway context.'
  }
  if (surface === 'Machine Learning') {
    const condition = context.selected_condition ? ` for ${context.selected_condition}` : ''
    const variant = context.selected_variant_type ? ` and ${context.selected_variant_type.replace(/_/g, ' ')}` : ''
    return `You are reviewing simulation-derived ML readiness${condition}${variant}.`
  }
  if (surface === 'Genome Design') {
    return 'You are reviewing simulation-derived genome-design summaries.'
  }
  if (context.selected_gene) return `You are focused on gene ${context.selected_gene}.`
  return 'You are in the central Assistant workspace.'
}

export function suggestedActions(context: AssistantContext): Array<{
  title: string
  description: string
  kind: 'read' | 'proposal' | 'link'
  path?: string
}> {
  const surface = surfaceName(context)
  const gene = context.selected_gene
  if (surface === 'Results') {
    return [
      {
        title: 'Inspect current result',
        description: 'Ask the platform to summarize available deterministic outputs for this job.',
        kind: 'read',
      },
      {
        title: 'Compare with WT delta',
        description: 'Prioritize state variables whose final values diverge from the wildtype control.',
        kind: 'proposal',
      },
      {
        title: 'Review linked model states',
        description: 'Check mRNA, monomer, complex, reaction, and metabolite links before interpreting the phenotype.',
        kind: 'proposal',
      },
      ...(gene
        ? [{
            title: 'Open linked network',
            description: `Inspect local regulation around ${gene}.`,
            kind: 'link' as const,
            path: `/network?gene=${encodeURIComponent(gene)}`,
          }]
        : []),
    ]
  }
  if (surface === 'Workspace' && gene) {
    return [
      {
        title: 'Inspect model state IDs',
        description: `List the mRNA, protein, complex, pathway, and metabolite IDs connected to ${gene}.`,
        kind: 'proposal',
      },
      {
        title: 'Open local TF network',
        description: 'Check whether regulation provides a plausible route to downstream effects.',
        kind: 'link',
        path: `/network?gene=${encodeURIComponent(gene)}`,
      },
      {
        title: 'Draft follow-up knockout',
        description: 'Open the canonical Experiment Designer with this gene preselected.',
        kind: 'link',
        path: `/experiments/new?gene=${encodeURIComponent(gene)}`,
      },
    ]
  }
  if (surface === 'Conditions Builder') {
    return [
      {
        title: 'Review dependency chain',
        description: 'Check stock, recipe, condition, TF-state rules, and time-varying protocol consistency.',
        kind: 'proposal',
      },
      {
        title: 'Validate current draft',
        description: 'Ask for missing IDs, ambiguous fields, and publish-readiness issues.',
        kind: 'proposal',
      },
    ]
  }
  if (surface === 'Experiments') {
    return [
      {
        title: 'Check experiment meaning',
        description: 'Clarify what the selected experiment type changes in the model before saving.',
        kind: 'proposal',
      },
      {
        title: 'Review condition and timeline',
        description: 'Check whether the selected environment is static or uses a time-varying protocol.',
        kind: 'proposal',
      },
    ]
  }
  if (surface === 'Genes') {
    return [
      {
        title: 'Explain selected gene',
        description: 'Summarize model IDs, KO phenotype, category, position, and regulation context for the current selection.',
        kind: 'proposal',
      },
      ...(gene
        ? [{
            title: 'Open gene in Workspace',
            description: `Review linked biological context for ${gene}.`,
            kind: 'link' as const,
            path: `/explore?gene=${encodeURIComponent(gene)}`,
          }]
        : []),
    ]
  }
  if (surface === 'Network') {
    return [
      {
        title: 'Explain edge provenance',
        description: 'Clarify that TF edges are reconstruction-derived and not simulation-response overlays.',
        kind: 'proposal',
      },
      ...(gene
        ? [{
            title: 'Open selected gene in Workspace',
            description: `Review model state IDs and genomic context for ${gene}.`,
            kind: 'link' as const,
            path: `/explore?gene=${encodeURIComponent(gene)}`,
          }]
        : []),
    ]
  }
  if (surface === 'Genome Map') {
    return [
      {
        title: 'Interpret genomic context',
        description: 'Relate selected gene position, nearby genes, strand, and functional category to other Explore views.',
        kind: 'proposal',
      },
      ...(gene
        ? [{
            title: 'Open linked network',
            description: `Check regulation around ${gene}.`,
            kind: 'link' as const,
            path: `/network?gene=${encodeURIComponent(gene)}`,
          }]
        : []),
    ]
  }
  if (surface === 'Pathways') {
    return [
      {
        title: 'Summarize pathway patterns',
        description: 'Explain essentiality distribution, selected amino-acid pathway nodes, and likely follow-up genes.',
        kind: 'proposal',
      },
      {
        title: 'Open gene catalog',
        description: 'Inspect gene-level KO phenotype and model-state details.',
        kind: 'link',
        path: '/genes',
      },
    ]
  }
  if (surface === 'Machine Learning') {
    return [
      {
        title: 'Assess data readiness',
        description: 'Check whether completed simulations are broad enough for the selected target and filters.',
        kind: 'proposal',
      },
      {
        title: 'Open result library',
        description: 'Review source simulations before trusting surrogate-model output.',
        kind: 'link',
        path: '/results',
      },
    ]
  }
  if (surface === 'Genome Design') {
    return [
      {
        title: 'Check design evidence',
        description: 'Separate current knockout summaries from what would be needed for a dedicated minimal-genome design workflow.',
        kind: 'proposal',
      },
      {
        title: 'Open batch experiments',
        description: 'Plan condition-diverse knockout coverage before interpreting design calls.',
        kind: 'link',
        path: '/experiments/batch',
      },
    ]
  }
  return [
    {
      title: 'Start from current page',
      description: 'Ask what this page can do, what data it uses, or what to inspect next.',
      kind: 'proposal',
    },
    {
      title: 'Open Experiment Designer',
      description: 'Create or review a simulation through the canonical experiment workflow.',
      kind: 'link',
      path: '/experiments/new',
    },
  ]
}

export function starterPrompts(context: AssistantContext): string[] {
  const prompts: string[] = []
  if (context.selected_gene) {
    prompts.push(`Tell me about ${context.selected_gene} and its regulators`)
    prompts.push(`Draft a ${context.selected_gene} knockout experiment`)
  }
  if (context.selected_job != null) {
    prompts.push('Inspect the current result and summarize growth')
  }
  if (context.selected_experiment != null) {
    prompts.push('Summarize this experiment and its runs')
  }
  prompts.push('How many genes are supported?')
  prompts.push('Explain what each page does')
  return prompts.slice(0, 4)
}

const CONFIRM_BUTTON_LABELS: Record<string, string> = {
  run_simulation: 'Confirm and queue',
  save_condition: 'Save condition draft',
  save_timeline: 'Save timeline draft',
  save_recipe: 'Save recipe draft',
  save_tf_condition: 'Save TF rule draft',
}

export function confirmButtonLabel(toolName: string): string {
  return CONFIRM_BUTTON_LABELS[toolName] ?? 'Create draft experiment'
}

export function proposalText(proposal: AssistantToolCall, key: string, fallback: string): string {
  const value = proposal.result[key]
  return typeof value === 'string' && value.trim() ? value : fallback
}

export function proposalKind(proposal: AssistantToolCall): 'ready' | 'planned' {
  return proposal.result.side_effect ? 'planned' : 'ready'
}

export function proposalSourceLabel(proposal: AssistantToolCall): string {
  const source = stringField(proposal.result.source)
  if (source === 'model_gene_mention') return 'model suggestion, gene validated'
  if (source === 'contextual_assistant') return 'current page context'
  return source ? source.replace(/_/g, ' ') : 'assistant proposal'
}

export function proposalFactRows(proposal: AssistantToolCall): Array<{ label: string; value: string; mono?: boolean }> {
  if (proposal.tool_name === 'create_experiment') {
    const gene = stringField(proposal.arguments.gene_symbol)
    const condition = stringField(proposal.arguments.condition) || 'basal'
    const variant = stringField(proposal.arguments.variant_type).replace(/_/g, ' ') || 'experiment'
    const timeline = stringField(proposal.arguments.timeline) || 'No time-varying protocol'
    const includeWildtype = proposal.arguments.include_wildtype === true
    return [
      { label: 'Validated gene', value: gene || 'Not selected', mono: Boolean(gene) },
      { label: 'Draft type', value: variant },
      { label: 'Condition', value: condition, mono: true },
      { label: 'Protocol', value: timeline, mono: timeline !== 'No time-varying protocol' },
      { label: 'Wildtype control', value: includeWildtype ? 'Create or reuse if available' : 'Not requested' },
    ]
  }
  if (proposal.tool_name === 'run_simulation') {
    return [
      { label: 'Experiment', value: String(proposal.arguments.experiment_id ?? 'Not selected'), mono: true },
      { label: 'Seed', value: String(proposal.arguments.seed ?? 0), mono: true },
      { label: 'Generations', value: String(proposal.arguments.generations ?? 1), mono: true },
    ]
  }
  if (proposal.tool_name === 'save_condition') {
    const activeTfs = Array.isArray(proposal.arguments.active_tfs) ? (proposal.arguments.active_tfs as string[]) : []
    const inactiveTfs = Array.isArray(proposal.arguments.inactive_tfs) ? (proposal.arguments.inactive_tfs as string[]) : []
    return [
      { label: 'Condition name', value: stringField(proposal.arguments.name) || 'Unnamed', mono: true },
      { label: 'Media recipe', value: stringField(proposal.arguments.nutrients) || 'Not set', mono: true },
      { label: 'Doubling time', value: `${String(proposal.arguments.doubling_time ?? '?')} min` },
      { label: 'Active TFs', value: activeTfs.length ? activeTfs.join(', ') : 'None', mono: activeTfs.length > 0 },
      { label: 'Inactive TFs', value: inactiveTfs.length ? inactiveTfs.join(', ') : 'None', mono: inactiveTfs.length > 0 },
      { label: 'Cloned from', value: stringField(proposal.arguments.base_condition) || 'New condition', mono: Boolean(proposal.arguments.base_condition) },
    ]
  }
  if (proposal.tool_name === 'save_timeline') {
    return [
      { label: 'Timeline name', value: stringField(proposal.arguments.name) || 'Unnamed', mono: true },
      { label: 'Schedule', value: stringField(proposal.arguments.events) || '(empty)', mono: true },
    ]
  }
  if (proposal.tool_name === 'save_recipe') {
    const ingredients = Array.isArray(proposal.arguments.ingredients) ? (proposal.arguments.ingredients as string[]) : []
    return [
      { label: 'Recipe id', value: stringField(proposal.arguments.media_id) || 'Unnamed', mono: true },
      { label: 'Base medium', value: stringField(proposal.arguments.base_media) || 'Not set', mono: true },
      { label: 'Added medium', value: stringField(proposal.arguments.added_media) || 'None', mono: Boolean(proposal.arguments.added_media) },
      { label: 'Ingredients', value: ingredients.length ? ingredients.join(', ') : 'None', mono: ingredients.length > 0 },
    ]
  }
  if (proposal.tool_name === 'save_tf_condition') {
    return [
      { label: 'TF', value: stringField(proposal.arguments.tf) || 'Not set', mono: true },
      { label: 'Active on', value: stringField(proposal.arguments.active_nutrients) || 'Not set', mono: true },
      { label: 'Inactive on', value: stringField(proposal.arguments.inactive_nutrients) || 'Not set', mono: true },
      { label: 'TF type', value: stringField(proposal.arguments.tf_type) || 'Not set' },
    ]
  }
  if (proposal.tool_name === 'inspect_result') {
    return [
      { label: 'Job', value: String(proposal.arguments.job_id ?? 'Current result'), mono: true },
      { label: 'Gene', value: stringField(proposal.arguments.gene) || 'Current context', mono: Boolean(proposal.arguments.gene) },
      { label: 'Side effect', value: 'None' },
    ]
  }
  if (proposal.tool_name === 'inspect_gene') {
    return [
      { label: 'Gene', value: stringField(proposal.arguments.gene) || 'Current context', mono: Boolean(proposal.arguments.gene) },
      { label: 'Data source', value: 'Genes Table' },
      { label: 'Side effect', value: 'None' },
    ]
  }
  return []
}


function stringField(value: unknown): string { return typeof value === 'string' ? value : '' }
