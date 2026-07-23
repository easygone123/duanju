import type { ComfyApiWorkflow, ComfyInputBinding, ComfyVariableDefinition } from './types'

export function hasBerniniDirectorNode(graph: unknown): graph is ComfyApiWorkflow {
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) return false
  return Object.values(graph).some((node) => (
    !!node && typeof node === 'object' && !Array.isArray(node)
      && (node as { class_type?: unknown }).class_type === 'ComfyBerniniDirector'
  ))
}

export function augmentBerniniDirectorContract(input: {
  graph: ComfyApiWorkflow
  variableDefinitions: ComfyVariableDefinition[]
  bindings: ComfyInputBinding[]
}) {
  if (!hasBerniniDirectorNode(input.graph)) return input
  const variableDefinitions = input.variableDefinitions.map((item) => structuredClone(item))
  const bindings = input.bindings.map((item) => structuredClone(item))
  const ensure = (definition: ComfyVariableDefinition) => {
    const index = variableDefinitions.findIndex((item) => item.name === definition.name)
    if (index < 0) variableDefinitions.push(definition)
    else variableDefinitions[index] = { ...variableDefinitions[index], ...definition }
  }
  ensure({ name: 'prompt', type: 'string', required: true })
  ensure({ name: 'referenceImages', type: 'image_ref_list', required: false, defaultValue: [], maxItems: 64 })
  ensure({ name: 'berniniVideos', type: 'video_ref_list', required: false, defaultValue: [], maxItems: 16 })
  for (const [nodeId, node] of Object.entries(input.graph)) {
    if (node.class_type !== 'ComfyBerniniDirector') continue
    if (!bindings.some((binding) => binding.nodeId === nodeId
      && binding.inputPath === 'timeline_data'
      && binding.transform === 'bernini_director_timeline')) {
      bindings.push({
        nodeId,
        inputPath: 'timeline_data',
        variable: 'referenceImages',
        valueType: 'image_ref_list',
        transform: 'bernini_director_timeline',
      })
    }
  }
  return { graph: input.graph, variableDefinitions, bindings }
}
