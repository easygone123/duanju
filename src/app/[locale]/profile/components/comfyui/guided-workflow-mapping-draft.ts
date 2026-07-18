import type {
  CanonicalWorkflowInput,
  WorkflowAutoMappingResult,
  WorkflowMappingProposal,
} from '@/lib/comfyui/workflow-auto-mapping-types'
import { isSafeDottedPath } from '@/lib/comfyui/workflow-schema'
import type {
  ComfyBindingTransform,
  ComfyOutputBinding,
  ComfyVariableType,
} from '@/lib/comfyui/types'
import { guidedCompatibleRoles } from './guided-workflow-creation'

export interface GuidedInputCandidate {
  id: string
  nodeId: string
  inputPath: string
  nodeTitle?: string
  roles: CanonicalWorkflowInput[]
  valueTypeByRole: Partial<Record<CanonicalWorkflowInput, ComfyVariableType>>
  transformByRole: Partial<Record<CanonicalWorkflowInput, ComfyBindingTransform>>
}

export interface GuidedWorkflowMappingDraft {
  analysis: WorkflowAutoMappingResult
  inputs: WorkflowMappingProposal[]
  outputs: ComfyOutputBinding[]
}

export type GuidedMappingDraftIssue =
  | 'outputRequired'
  | 'primaryRequired'
  | 'unsafeField'
  | 'duplicateTarget'

const NUMBER_ROLE_BY_INPUT = new Map<string, CanonicalWorkflowInput>([
  ['width', 'width'],
  ['height', 'height'],
  ['seed', 'seed'],
  ['duration', 'duration'],
  ['fps', 'fps'],
])

const IMAGE_ROLES: CanonicalWorkflowInput[] = [
  'sourceImage', 'referenceImages', 'firstFrame', 'lastFrame',
]

function invalidDraft(): never {
  throw new Error('workflowGuidedMappingInvalid')
}

function compareNames(left: string, right: string) {
  return left.localeCompare(right, 'en', { numeric: true, sensitivity: 'base' })
}

function normalize(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function pair(nodeId: string, inputPath: string) {
  return JSON.stringify([nodeId, inputPath])
}

function candidateId(nodeId: string, inputPath: string) {
  return `guided:${encodeURIComponent(pair(nodeId, inputPath))}`
}

function nodeTitle(node: WorkflowAutoMappingResult['graph'][string]) {
  const title = node._meta?.title
  return typeof title === 'string' && title.trim() ? title.trim() : undefined
}

function isImageInput(classType: string, inputPath: string, value: unknown) {
  if (typeof value !== 'string') return false
  const className = normalize(classType)
  const inputName = normalize(inputPath)
  return (className.includes('loadimage') || (className.includes('image') && className.includes('input')))
    && /(image|filename|path)/.test(inputName)
}

function isVideoInput(classType: string, inputPath: string, value: unknown) {
  if (typeof value !== 'string') return false
  const className = normalize(classType)
  const inputName = normalize(inputPath)
  return (className.includes('loadvideo') || (className.includes('video') && className.includes('input')))
    && /(video|filename|path)/.test(inputName)
}

function candidateFor(
  nodeId: string,
  inputPath: string,
  node: WorkflowAutoMappingResult['graph'][string],
  value: unknown,
): GuidedInputCandidate | null {
  if (!isSafeDottedPath(inputPath) || inputPath.includes('.')) return null
  const title = nodeTitle(node)
  const common = {
    id: candidateId(nodeId, inputPath),
    nodeId,
    inputPath,
    ...(title ? { nodeTitle: title } : {}),
  }

  if (isImageInput(node.class_type, inputPath, value)) {
    return {
      ...common,
      roles: IMAGE_ROLES,
      valueTypeByRole: {
        sourceImage: 'image_ref',
        referenceImages: 'image_ref_list',
        firstFrame: 'image_ref',
        lastFrame: 'image_ref',
      },
      transformByRole: {
        sourceImage: 'filename',
        referenceImages: 'filename_at',
        firstFrame: 'filename',
        lastFrame: 'filename',
      },
    }
  }

  if (isVideoInput(node.class_type, inputPath, value)) {
    return {
      ...common,
      roles: ['sourceVideo'],
      valueTypeByRole: { sourceVideo: 'video_ref' },
      transformByRole: { sourceVideo: 'filename' },
    }
  }

  if (typeof value === 'string') {
    return {
      ...common,
      roles: ['prompt', 'negativePrompt'],
      valueTypeByRole: { prompt: 'string', negativePrompt: 'string' },
      transformByRole: {},
    }
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const role = NUMBER_ROLE_BY_INPUT.get(normalize(inputPath))
    if (!role) return null
    return {
      ...common,
      roles: [role],
      valueTypeByRole: { [role]: 'number' },
      transformByRole: {},
    }
  }

  return null
}

export function createGuidedMappingDraft(
  analysis: WorkflowAutoMappingResult,
): GuidedWorkflowMappingDraft {
  return {
    analysis,
    inputs: analysis.proposals.map((proposal) => ({ ...proposal })),
    outputs: analysis.outputs.map((output) => ({ ...output })),
  }
}

export function guidedInputCandidates(
  analysis: WorkflowAutoMappingResult,
  inputs: WorkflowMappingProposal[],
): GuidedInputCandidate[] {
  const occupied = new Set(inputs.map((input) => pair(input.nodeId, input.inputPath)))
  const candidates: GuidedInputCandidate[] = []
  for (const [nodeId, node] of Object.entries(analysis.graph)
    .sort(([left], [right]) => compareNames(left, right))) {
    for (const [inputPath, value] of Object.entries(node.inputs)
      .sort(([left], [right]) => compareNames(left, right))) {
      if (occupied.has(pair(nodeId, inputPath))) continue
      const candidate = candidateFor(nodeId, inputPath, node, value)
      if (candidate) candidates.push(candidate)
    }
  }
  return candidates
}

function nextReferenceIndex(inputs: WorkflowMappingProposal[]) {
  return inputs.reduce((next, proposal) => proposal.canonicalName === 'referenceImages'
    ? Math.max(next, (proposal.referenceIndex ?? -1) + 1)
    : next, 0)
}

export function addGuidedInput(
  draft: GuidedWorkflowMappingDraft,
  candidateIdValue: string,
  role: CanonicalWorkflowInput,
): GuidedWorkflowMappingDraft {
  const candidate = guidedInputCandidates(draft.analysis, draft.inputs)
    .find((item) => item.id === candidateIdValue)
  if (!candidate || !candidate.roles.includes(role)) invalidDraft()
  const valueType = candidate.valueTypeByRole[role]
  if (!valueType) invalidDraft()
  const transform = candidate.transformByRole[role]
  const referenceIndex = role === 'referenceImages' ? nextReferenceIndex(draft.inputs) : undefined
  const proposal: WorkflowMappingProposal = {
    id: candidate.id,
    canonicalName: role,
    nodeId: candidate.nodeId,
    inputPath: candidate.inputPath,
    valueType,
    ...(transform ? { transform } : {}),
    confidence: 'high',
    reasonCode: 'COMFY_MAPPING_MANUAL',
    required: true,
    ...(referenceIndex === undefined ? {} : { referenceIndex }),
    ...(candidate.nodeTitle ? { nodeTitle: candidate.nodeTitle } : {}),
  }
  return { ...draft, inputs: [...draft.inputs, proposal] }
}

export function updateGuidedInputRole(
  draft: GuidedWorkflowMappingDraft,
  proposalId: string,
  role: CanonicalWorkflowInput,
): GuidedWorkflowMappingDraft {
  const index = draft.inputs.findIndex((proposal) => proposal.id === proposalId)
  if (index < 0) invalidDraft()
  const current = draft.inputs[index]!
  if (!guidedCompatibleRoles(current).includes(role)) invalidDraft()
  const inputs = draft.inputs.map((proposal, proposalIndex) => proposalIndex === index
    ? {
      ...proposal,
      canonicalName: role,
      confidence: 'high' as const,
      reasonCode: 'COMFY_MAPPING_MANUAL',
    }
    : proposal)
  return { ...draft, inputs }
}

export function removeGuidedInput(
  draft: GuidedWorkflowMappingDraft,
  proposalId: string,
): GuidedWorkflowMappingDraft {
  if (!draft.inputs.some((proposal) => proposal.id === proposalId)) invalidDraft()
  return { ...draft, inputs: draft.inputs.filter((proposal) => proposal.id !== proposalId) }
}

function suggestedOutputField(classType: string, mediaType: 'image' | 'video') {
  if (mediaType === 'image') return 'images'
  return normalize(classType) === 'vhsvideocombine' ? 'gifs' : ''
}

export function guidedOutputNodeCandidates(analysis: WorkflowAutoMappingResult) {
  return Object.entries(analysis.graph)
    .sort(([left], [right]) => compareNames(left, right))
    .map(([nodeId, node]) => ({
      nodeId,
      classType: node.class_type,
      ...(nodeTitle(node) ? { nodeTitle: nodeTitle(node) } : {}),
      suggestedField: suggestedOutputField(node.class_type, analysis.mediaType),
    }))
}

function uniqueOutputName(outputs: ComfyOutputBinding[], nodeId: string) {
  const base = `output_${nodeId}`
  const names = new Set(outputs.map((output) => output.name))
  if (!names.has(base)) return base
  let suffix = 2
  while (names.has(`${base}_${suffix}`)) suffix += 1
  return `${base}_${suffix}`
}

export function addGuidedOutput(
  draft: GuidedWorkflowMappingDraft,
  nodeId: string,
): GuidedWorkflowMappingDraft {
  const candidate = guidedOutputNodeCandidates(draft.analysis)
    .find((item) => item.nodeId === nodeId)
  if (!candidate) invalidDraft()
  return {
    ...draft,
    outputs: [...draft.outputs, {
      name: uniqueOutputName(draft.outputs, nodeId),
      nodeId,
      fieldPath: candidate.suggestedField,
      mediaType: draft.analysis.mediaType,
      primary: draft.outputs.length === 0,
    }],
  }
}

export function updateGuidedOutput(
  draft: GuidedWorkflowMappingDraft,
  index: number,
  patch: Partial<Pick<ComfyOutputBinding, 'nodeId' | 'fieldPath' | 'name'>>,
): GuidedWorkflowMappingDraft {
  if (!draft.outputs[index]) invalidDraft()
  if (patch.nodeId !== undefined && !draft.analysis.graph[patch.nodeId]) invalidDraft()
  return {
    ...draft,
    outputs: draft.outputs.map((output, outputIndex) => outputIndex === index
      ? { ...output, ...patch, mediaType: draft.analysis.mediaType }
      : output),
  }
}

export function removeGuidedOutput(
  draft: GuidedWorkflowMappingDraft,
  index: number,
): GuidedWorkflowMappingDraft {
  if (!draft.outputs[index]) invalidDraft()
  const outputs = draft.outputs.filter((_, outputIndex) => outputIndex !== index)
  if (outputs.length > 0 && !outputs.some((output) => output.primary)) {
    outputs[0] = { ...outputs[0]!, primary: true }
  }
  return { ...draft, outputs }
}

export function setGuidedPrimaryOutput(
  draft: GuidedWorkflowMappingDraft,
  index: number,
): GuidedWorkflowMappingDraft {
  if (!draft.outputs[index]) invalidDraft()
  return {
    ...draft,
    outputs: draft.outputs.map((output, outputIndex) => ({
      ...output,
      primary: outputIndex === index,
    })),
  }
}

export function guidedMappingDraftIssues(
  draft: GuidedWorkflowMappingDraft,
): GuidedMappingDraftIssue[] {
  const issues = new Set<GuidedMappingDraftIssue>()
  if (draft.outputs.length === 0) issues.add('outputRequired')
  if (draft.outputs.length > 0 && draft.outputs.filter((output) => output.primary).length !== 1) {
    issues.add('primaryRequired')
  }
  const targets = new Set<string>()
  const names = new Set<string>()
  for (const output of draft.outputs) {
    if (!output.fieldPath.trim() || !isSafeDottedPath(output.fieldPath)) issues.add('unsafeField')
    const target = pair(output.nodeId, output.fieldPath)
    if (targets.has(target) || names.has(output.name)) issues.add('duplicateTarget')
    targets.add(target)
    names.add(output.name)
  }
  return [...issues]
}

export function effectiveGuidedAnalysis(
  draft: GuidedWorkflowMappingDraft,
): WorkflowAutoMappingResult {
  return {
    ...draft.analysis,
    proposals: draft.inputs.map((proposal) => ({ ...proposal })),
    outputs: draft.outputs.map((output) => ({ ...output })),
    issues: draft.analysis.issues.filter((issue) => (
      issue.code !== 'COMFY_WORKFLOW_OUTPUT_REQUIRED'
      && issue.code !== 'COMFY_WORKFLOW_OUTPUT_AMBIGUOUS'
    )),
    referenceCapacity: Math.max(
      draft.analysis.referenceCapacity,
      nextReferenceIndex(draft.inputs),
    ),
  }
}
