import type {
  CanonicalWorkflowInput,
  WorkflowAutoMappingResult,
  WorkflowImportKind,
  WorkflowMappingProposal,
} from '@/lib/comfyui/workflow-auto-mapping-types'
import { discoverComfyPlaceholders, validateComfyApiWorkflow } from '@/lib/comfyui/workflow-schema'
import type { ComfyInputBinding, ComfyVariableDefinition } from '@/lib/comfyui/types'
import {
  addGuidedInput,
  createGuidedMappingDraft,
  effectiveGuidedAnalysis,
  guidedInputCandidates,
  type GuidedWorkflowMappingDraft,
} from './guided-workflow-mapping-draft'
import {
  confirmWorkflowAnalysis,
  parseWorkflowImportText,
  type WorkflowAuthorDraft,
} from './workflow-ui'

const CANONICAL_INPUTS = new Set<CanonicalWorkflowInput>([
  'prompt', 'negativePrompt', 'width', 'height', 'seed', 'sourceImage',
  'referenceImages', 'duration', 'fps', 'firstFrame', 'lastFrame', 'sourceVideo',
])

function isCanonicalInput(value: string): value is CanonicalWorkflowInput {
  return CANONICAL_INPUTS.has(value as CanonicalWorkflowInput)
}

export function workflowImportKindForDraft(draft: WorkflowAuthorDraft): WorkflowImportKind {
  if (draft.purpose === 'upscale') return 'image_upscale'
  if (draft.mediaType === 'image') {
    return draft.bindings.some((binding) => binding.variable === 'sourceImage')
      ? 'image_edit'
      : 'image_generation'
  }
  return draft.bindings.some((binding) => binding.variable === 'sourceVideo')
    ? 'video_to_video'
    : 'video_generation'
}

function proposalFromBinding(
  binding: ComfyInputBinding,
  index: number,
  definitions: ReadonlyMap<string, ComfyVariableDefinition>,
  graph: WorkflowAutoMappingResult['graph'],
): WorkflowMappingProposal | null {
  if (!isCanonicalInput(binding.variable)) return null
  const definition = definitions.get(binding.variable)
  if (!definition) return null
  const title = graph[binding.nodeId]?._meta?.title
  return {
    id: `saved:${index}:${encodeURIComponent(binding.nodeId)}:${encodeURIComponent(binding.inputPath)}`,
    canonicalName: binding.variable,
    nodeId: binding.nodeId,
    inputPath: binding.inputPath,
    valueType: binding.valueType,
    ...(binding.transform ? { transform: binding.transform } : {}),
    ...(binding.numericTransform
      ? { numericTransform: structuredClone(binding.numericTransform) }
      : {}),
    confidence: 'high',
    reasonCode: 'COMFY_MAPPING_MANUAL',
    required: definition.required,
    ...(binding.transform === 'filename_at' && binding.valueIndex !== undefined
      ? { referenceIndex: binding.valueIndex }
      : {}),
    ...(typeof title === 'string' && title.trim() ? { nodeTitle: title.trim() } : {}),
  }
}

export function createGuidedMappingDraftFromAuthorDraft(
  draft: WorkflowAuthorDraft,
): GuidedWorkflowMappingDraft {
  const graph = validateComfyApiWorkflow(parseWorkflowImportText(draft.apiFormatJson))
  const definitions = new Map(draft.variableDefinitions.map((definition) => (
    [definition.name, definition] as const
  )))
  const proposals = draft.bindings.flatMap((binding, index) => {
    const proposal = proposalFromBinding(binding, index, definitions, graph)
    if (!proposal) return []
    if (draft.mediaType === 'image'
      && draft.purpose === 'generation'
      && proposal.canonicalName === 'sourceImage') {
      return [{ ...proposal, required: false }]
    }
    return [proposal]
  })
  const referenceDefinition = definitions.get('referenceImages')
  const analysis: WorkflowAutoMappingResult = {
    graph,
    mediaType: draft.mediaType,
    purpose: draft.purpose,
    proposals,
    outputs: draft.outputs.map((output) => ({ ...output })),
    issues: [],
    referenceCapacity: referenceDefinition?.type === 'image_ref_list'
      ? referenceDefinition.maxItems ?? Math.max(
        1,
        ...proposals
          .filter((proposal) => proposal.canonicalName === 'referenceImages')
          .map((proposal) => (proposal.referenceIndex ?? 0) + 1),
      )
      : 0,
  }
  let guidedDraft = createGuidedMappingDraft(analysis)
  if (draft.mediaType !== 'video') return guidedDraft

  for (const role of ['firstFrame', 'lastFrame'] as const) {
    if (guidedDraft.inputs.some((proposal) => proposal.canonicalName === role)) continue
    const candidates = guidedInputCandidates(guidedDraft.analysis, guidedDraft.inputs)
      .filter((candidate) => candidate.roles.includes(role))
    if (candidates.length !== 1) continue
    const candidate = candidates[0]!
    guidedDraft = addGuidedInput(guidedDraft, candidate.id, role)
    guidedDraft = {
      ...guidedDraft,
      inputs: guidedDraft.inputs.map((proposal) => proposal.id === candidate.id
        ? {
            ...proposal,
            confidence: 'ambiguous' as const,
            reasonCode: 'COMFY_MAPPING_IMAGE_ROLE_AMBIGUOUS',
          }
        : proposal),
    }
  }
  return guidedDraft
}

function mergeDefinitionMetadata(
  confirmed: ComfyVariableDefinition[],
  previous: ComfyVariableDefinition[],
) {
  const previousByName = new Map(previous.map((definition) => [definition.name, definition]))
  return confirmed.map((definition) => {
    const existing = previousByName.get(definition.name)
    return existing && existing.type === definition.type
      ? { ...structuredClone(existing), ...definition }
      : definition
  })
}

export function buildEditedWorkflowDraft(
  baseDraft: WorkflowAuthorDraft,
  name: string,
  mappingDraft: GuidedWorkflowMappingDraft,
): WorkflowAuthorDraft {
  const analysis = effectiveGuidedAnalysis(mappingDraft)
  const primaryOutputNodeId = mappingDraft.outputs.find((output) => output.primary)?.nodeId ?? ''
  const confirmed = confirmWorkflowAnalysis(analysis, {
    roles: {},
    primaryOutputNodeId,
  })
  const confirmedDefinitions = mergeDefinitionMetadata(
    confirmed.variableDefinitions,
    baseDraft.variableDefinitions,
  )
  const confirmedNames = new Set(confirmedDefinitions.map((definition) => definition.name))
  const preservedBindings = baseDraft.bindings.filter((binding) => !isCanonicalInput(binding.variable))
  const preservedNames = new Set(preservedBindings.map((binding) => binding.variable))
  const placeholders = new Set(discoverComfyPlaceholders(analysis.graph))
  const preservedDefinitions = baseDraft.variableDefinitions.filter((definition) => (
    !confirmedNames.has(definition.name)
    && (preservedNames.has(definition.name) || placeholders.has(definition.name))
  ))

  return {
    name: name.trim(),
    mediaType: baseDraft.mediaType,
    purpose: baseDraft.purpose,
    apiFormatJson: baseDraft.apiFormatJson,
    variableDefinitions: [
      ...confirmedDefinitions,
      ...preservedDefinitions.map((definition) => structuredClone(definition)),
    ],
    bindings: [
      ...confirmed.bindings,
      ...preservedBindings.map((binding) => structuredClone(binding)),
    ],
    outputs: confirmed.outputs,
  }
}
