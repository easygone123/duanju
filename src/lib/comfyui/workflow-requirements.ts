import type { ComfyApiWorkflow, ComfyWorkflowRequirements } from './types'

const PLACEHOLDER_PATTERN = /\$\{[^{}]+\}/

export function deriveComfyRequirements(
  graph: ComfyApiWorkflow,
): ComfyWorkflowRequirements {
  const nodeClasses = [...new Set(
    Object.values(graph).map((node) => node.class_type),
  )].sort()

  const candidateLoaderInputs = Object.entries(graph)
    .flatMap(([nodeId, node]) => {
      if (!/loader/i.test(node.class_type)) return []
      return Object.entries(node.inputs)
        .filter((entry): entry is [string, string] =>
          typeof entry[1] === 'string' && !PLACEHOLDER_PATTERN.test(entry[1]))
        .map(([inputName, value]) => ({ nodeId, inputName, value }))
    })
    .sort((left, right) =>
      left.nodeId.localeCompare(right.nodeId)
      || left.inputName.localeCompare(right.inputName)
      || left.value.localeCompare(right.value))

  return { nodeClasses, candidateLoaderInputs }
}
