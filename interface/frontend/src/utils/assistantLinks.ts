type AssistantSurface =
  | 'central'
  | 'workspace'
  | 'conditions_builder'
  | 'experiments'
  | 'results'
  | 'network'
  | 'genome'
  | 'ml'
  | 'design'

interface AssistantHrefOptions {
  surface: AssistantSurface
  route: string
  prompt: string
  gene?: string | null
  experiment?: number | string | null
  job?: number | string | null
  result?: number | string | null
  condition?: string | null
  variantType?: string | null
  builderSection?: string | null
}

function setOptional(params: URLSearchParams, key: string, value: string | number | null | undefined) {
  if (value == null || value === '') return
  params.set(key, String(value))
}

export function assistantHref({
  surface,
  route,
  prompt,
  gene,
  experiment,
  job,
  result,
  condition,
  variantType,
  builderSection,
}: AssistantHrefOptions): string {
  const params = new URLSearchParams({
    surface,
    route,
    prompt,
  })
  setOptional(params, 'gene', gene)
  setOptional(params, 'experiment', experiment)
  setOptional(params, 'job', job)
  setOptional(params, 'result', result)
  setOptional(params, 'condition', condition)
  setOptional(params, 'variant_type', variantType)
  setOptional(params, 'builder_section', builderSection)
  return `/assistant?${params.toString()}`
}
