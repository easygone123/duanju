import type {
  ComfyApiWorkflow,
  ComfyInputBinding,
  ComfyVariableDefinition,
} from './types'

export function hasLtxDirectorNode(graph: unknown): graph is ComfyApiWorkflow {
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) return false
  return Object.values(graph).some((node) => (
    !!node && typeof node === 'object' && !Array.isArray(node)
      && (node as { class_type?: unknown }).class_type === 'LTXDirector'
  ))
}

export function augmentLtxDirectorContract(input: {
  graph: ComfyApiWorkflow
  variableDefinitions: ComfyVariableDefinition[]
  bindings: ComfyInputBinding[]
}) {
  if (!hasLtxDirectorNode(input.graph)) return input
  const variableDefinitions = input.variableDefinitions.map((definition) => structuredClone(definition))
  const bindings = input.bindings.map((binding) => structuredClone(binding))
  if (!variableDefinitions.some((definition) => definition.name === 'prompt')) {
    variableDefinitions.push({ name: 'prompt', type: 'string', required: true })
  }
  const referenceDefinitionIndex = variableDefinitions.findIndex(
    (definition) => definition.name === 'referenceImages',
  )
  if (referenceDefinitionIndex < 0) {
    variableDefinitions.push({
      name: 'referenceImages', type: 'image_ref_list', required: false, defaultValue: [], maxItems: 64,
    })
  } else {
    variableDefinitions[referenceDefinitionIndex] = {
      ...variableDefinitions[referenceDefinitionIndex],
      name: 'referenceImages', type: 'image_ref_list', required: false,
      defaultValue: variableDefinitions[referenceDefinitionIndex]?.defaultValue ?? [],
      maxItems: Math.max(64, variableDefinitions[referenceDefinitionIndex]?.maxItems ?? 0),
    }
  }
  const supplementalDefinitions: ComfyVariableDefinition[] = [
    { name: 'directorMainVideos', type: 'video_ref_list', required: false, defaultValue: [], maxItems: 64 },
    { name: 'directorVideos', type: 'video_ref_list', required: false, defaultValue: [], maxItems: 64 },
    { name: 'directorMotionImages', type: 'image_ref_list', required: false, defaultValue: [], maxItems: 64 },
    { name: 'directorAudios', type: 'audio_ref_list', required: false, defaultValue: [], maxItems: 64 },
    { name: 'directorRetakeVideos', type: 'video_ref_list', required: false, defaultValue: [], maxItems: 1 },
  ]
  for (const definition of supplementalDefinitions) {
    if (!variableDefinitions.some((candidate) => candidate.name === definition.name)) {
      variableDefinitions.push(definition)
    }
  }
  for (const [nodeId, node] of Object.entries(input.graph)) {
    if (node.class_type !== 'LTXDirector') continue
    const hasTimelineBinding = bindings.some((binding) => (
      binding.nodeId === nodeId
      && binding.inputPath === 'timeline_data'
      && binding.transform === 'ltx_director_timeline'
    ))
    if (!hasTimelineBinding) {
      bindings.push({
        nodeId,
        inputPath: 'timeline_data',
        variable: 'referenceImages',
        valueType: 'image_ref_list',
        transform: 'ltx_director_timeline',
      })
    }
  }
  return { graph: input.graph, variableDefinitions, bindings }
}
