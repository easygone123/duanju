import type {
  CanonicalWorkflowInput,
  WorkflowAutoMappingResult,
  WorkflowMappingProposal,
} from '@/lib/comfyui/workflow-auto-mapping-types'
import { defaultHistoryFieldForOutput } from '@/lib/comfyui/workflow-auto-mapper'
import {
  comfyNumericScalarOutput,
  isComfyWorkflowLinkTuple,
  isSafeDottedPath,
} from '@/lib/comfyui/workflow-schema'
import { decimalEquals } from '@/lib/comfyui/numeric-binding'
import type {
  ComfyBindingTransform,
  ComfyNumericBindingTransform,
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
  numericTransformByRole: Partial<Record<CanonicalWorkflowInput, ComfyNumericBindingTransform>>
}

export interface GuidedWorkflowMappingDraft {
  analysis: WorkflowAutoMappingResult
  inputs: WorkflowMappingProposal[]
  outputs: ComfyOutputBinding[]
  compatibleRolesByInputId: Record<string, CanonicalWorkflowInput[]>
}

export type GuidedMappingDraftIssue =
  | 'outputRequired'
  | 'primaryRequired'
  | 'unsafeField'
  | 'duplicateTarget'
  | 'numericTransformInvalid'

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

function validAllowedTargetValues(transform: ComfyNumericBindingTransform) {
  const allowed = transform.allowedTargetValues
  if (allowed === undefined) return true
  if (allowed.length === 0) return false
  if (allowed.some((item) => !Number.isFinite(item) || item <= 0)) return false
  if (transform.targetUnit === 'frames'
    && allowed.some((item) => !Number.isSafeInteger(item))) return false
  return !allowed.some((item, index) => allowed.slice(0, index).some((previous) => (
    transform.targetUnit === 'frames' ? previous === item : decimalEquals(previous, item)
  )))
}

function validNumericTransform(
  role: CanonicalWorkflowInput,
  transform: ComfyNumericBindingTransform | undefined,
) {
  if (!transform || (transform.output !== 'number' && transform.output !== 'numeric_string')) {
    return false
  }
  if (!validAllowedTargetValues(transform)) return false
  if (role === 'fps') {
    return transform.sourceUnit === 'fps'
      && transform.targetUnit === 'fps'
      && transform.fps === undefined
      && transform.rounding === undefined
      && transform.frameOffset === undefined
  }
  if (role !== 'duration' || transform.sourceUnit !== 'seconds') return false
  if (transform.targetUnit === 'seconds') {
    return transform.fps === undefined
      && transform.rounding === undefined
      && transform.frameOffset === undefined
  }
  return transform.targetUnit === 'frames'
    && transform.fps?.source === 'runtime_then_fallback'
    && transform.fps.variable === 'fps'
    && Number.isFinite(transform.fps.fallback)
    && transform.fps.fallback > 0
    && (transform.rounding === 'round'
      || transform.rounding === 'floor'
      || transform.rounding === 'ceil')
    && (transform.frameOffset === 0 || transform.frameOffset === 1)
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

function numericTransforms(output: 'number' | 'numeric_string') {
  return {
    duration: { sourceUnit: 'seconds', targetUnit: 'seconds', output },
    fps: { sourceUnit: 'fps', targetUnit: 'fps', output },
  } satisfies Partial<Record<CanonicalWorkflowInput, ComfyNumericBindingTransform>>
}

function candidateFor(
  nodeId: string,
  inputPath: string,
  node: WorkflowAutoMappingResult['graph'][string],
  value: unknown,
  videoWorkflow: boolean,
): GuidedInputCandidate | null {
  if (!isSafeDottedPath(inputPath)) return null
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
      numericTransformByRole: {},
    }
  }

  if (isVideoInput(node.class_type, inputPath, value)) {
    return {
      ...common,
      roles: ['sourceVideo'],
      valueTypeByRole: { sourceVideo: 'video_ref' },
      transformByRole: { sourceVideo: 'filename' },
      numericTransformByRole: {},
    }
  }

  const output = comfyNumericScalarOutput(value)
  if (videoWorkflow && output) {
    const inputName = inputPath.split('.').at(-1) ?? inputPath
    const namedRole = NUMBER_ROLE_BY_INPUT.get(normalize(inputName))
    const roles = [...new Set<CanonicalWorkflowInput>([
      ...(namedRole ? [namedRole] : []), 'duration', 'fps',
    ])]
    return {
      ...common,
      roles,
      valueTypeByRole: Object.fromEntries(roles.map((role) => [role, 'number'])),
      transformByRole: {},
      numericTransformByRole: roles.includes('duration') || roles.includes('fps')
        ? numericTransforms(output)
        : {},
    }
  }

  if (typeof value === 'string') {
    return {
      ...common,
      roles: ['prompt', 'negativePrompt'],
      valueTypeByRole: { prompt: 'string', negativePrompt: 'string' },
      transformByRole: {},
      numericTransformByRole: {},
    }
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const inputName = inputPath.split('.').at(-1) ?? inputPath
    const role = NUMBER_ROLE_BY_INPUT.get(normalize(inputName))
    if (!role) return null
    return {
      ...common,
      roles: [role],
      valueTypeByRole: { [role]: 'number' },
      transformByRole: {},
      numericTransformByRole: {},
    }
  }

  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isSafeRawPathSegment(segment: string): boolean {
  return !segment.includes('.') && isSafeDottedPath(segment)
}

function inputScalarEntries(
  inputs: Record<string, unknown>,
  nodeIds: ReadonlySet<string>,
): Array<[string, unknown]> {
  const scalars: Array<[string, unknown]> = []
  const visit = (value: unknown, path: string) => {
    if (!isSafeDottedPath(path) || isComfyWorkflowLinkTuple(value, nodeIds)) return
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}.${index}`))
      return
    }
    if (isRecord(value)) {
      for (const [key, item] of Object.entries(value)
        .sort(([left], [right]) => compareNames(left, right))) {
        if (!isSafeRawPathSegment(key)) continue
        visit(item, `${path}.${key}`)
      }
      return
    }
    scalars.push([path, value])
  }
  for (const [inputPath, value] of Object.entries(inputs)
    .sort(([left], [right]) => compareNames(left, right))) {
    if (!isSafeRawPathSegment(inputPath)) continue
    visit(value, inputPath)
  }
  return scalars
}

function readInputValue(inputs: Record<string, unknown>, inputPath: string): unknown {
  let current: unknown = inputs
  for (const segment of inputPath.split('.')) {
    if ((!isRecord(current) && !Array.isArray(current)) || !Object.hasOwn(current, segment)) {
      return undefined
    }
    current = current[segment as keyof typeof current]
  }
  return current
}

export function createGuidedMappingDraft(
  analysis: WorkflowAutoMappingResult,
): GuidedWorkflowMappingDraft {
  return {
    analysis,
    inputs: analysis.proposals.map((proposal) => ({ ...proposal })),
    outputs: analysis.outputs.map((output) => ({ ...output })),
    compatibleRolesByInputId: Object.fromEntries(analysis.proposals.map((proposal) => [
      proposal.id,
      guidedCompatibleRoles(proposal),
    ])),
  }
}

export function guidedDraftCompatibleRoles(
  draft: GuidedWorkflowMappingDraft,
  proposalId: string,
): CanonicalWorkflowInput[] {
  const proposal = draft.inputs.find((item) => item.id === proposalId)
  if (!proposal) invalidDraft()
  return draft.compatibleRolesByInputId[proposalId] ?? guidedCompatibleRoles(proposal)
}

export function guidedInputCandidates(
  analysis: WorkflowAutoMappingResult,
  inputs: WorkflowMappingProposal[],
): GuidedInputCandidate[] {
  const occupied = new Set(inputs.map((input) => pair(input.nodeId, input.inputPath)))
  const candidates: GuidedInputCandidate[] = []
  const nodeIds = new Set(Object.keys(analysis.graph))
  for (const [nodeId, node] of Object.entries(analysis.graph)
    .sort(([left], [right]) => compareNames(left, right))) {
    for (const [inputPath, value] of inputScalarEntries(node.inputs, nodeIds)) {
      const occupiedByAncestor = inputPath.split('.').some((_, index, segments) => (
        occupied.has(pair(nodeId, segments.slice(0, index + 1).join('.')))
      ))
      if (occupiedByAncestor) continue
      const candidate = candidateFor(
        nodeId, inputPath, node, value, analysis.mediaType === 'video',
      )
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
  const numericTransform = candidate.numericTransformByRole[role]
  const referenceIndex = role === 'referenceImages' ? nextReferenceIndex(draft.inputs) : undefined
  const proposal: WorkflowMappingProposal = {
    id: candidate.id,
    canonicalName: role,
    nodeId: candidate.nodeId,
    inputPath: candidate.inputPath,
    valueType,
    ...(transform ? { transform } : {}),
    ...(numericTransform ? { numericTransform: structuredClone(numericTransform) } : {}),
    confidence: 'high',
    reasonCode: 'COMFY_MAPPING_MANUAL',
    required: true,
    ...(referenceIndex === undefined ? {} : { referenceIndex }),
    ...(candidate.nodeTitle ? { nodeTitle: candidate.nodeTitle } : {}),
  }
  return {
    ...draft,
    inputs: [...draft.inputs, proposal],
    compatibleRolesByInputId: {
      ...draft.compatibleRolesByInputId,
      [proposal.id]: [...candidate.roles],
    },
  }
}

export function updateGuidedInputRole(
  draft: GuidedWorkflowMappingDraft,
  proposalId: string,
  role: CanonicalWorkflowInput,
): GuidedWorkflowMappingDraft {
  const index = draft.inputs.findIndex((proposal) => proposal.id === proposalId)
  if (index < 0) invalidDraft()
  const current = draft.inputs[index]!
  if (!guidedDraftCompatibleRoles(draft, proposalId).includes(role)) invalidDraft()
  const originalInputs = draft.analysis.graph[current.nodeId]?.inputs
  const originalValue = originalInputs
    ? readInputValue(originalInputs, current.inputPath)
    : undefined
  const output = comfyNumericScalarOutput(originalValue)
  const replacementNumericTransform = output && (role === 'duration' || role === 'fps')
    ? numericTransforms(output)[role]
    : undefined
  const inputs = draft.inputs.map((proposal, proposalIndex) => proposalIndex === index
    ? {
      ...proposal,
      canonicalName: role,
      ...(replacementNumericTransform
        ? { numericTransform: structuredClone(replacementNumericTransform) }
        : { numericTransform: undefined }),
      confidence: 'high' as const,
      reasonCode: 'COMFY_MAPPING_MANUAL',
    }
    : proposal)
  return { ...draft, inputs }
}

export function updateGuidedNumericTransform(
  draft: GuidedWorkflowMappingDraft,
  proposalId: string,
  numericTransform: ComfyNumericBindingTransform,
): GuidedWorkflowMappingDraft {
  const index = draft.inputs.findIndex((proposal) => proposal.id === proposalId)
  if (index < 0) invalidDraft()
  const proposal = draft.inputs[index]!
  if (proposal.canonicalName !== 'duration' && proposal.canonicalName !== 'fps') invalidDraft()
  return {
    ...draft,
    inputs: draft.inputs.map((item, itemIndex) => itemIndex === index
      ? {
        ...item,
        numericTransform: structuredClone(numericTransform),
        confidence: 'high',
        reasonCode: 'COMFY_MAPPING_MANUAL',
      }
      : item),
  }
}

export function removeGuidedInput(
  draft: GuidedWorkflowMappingDraft,
  proposalId: string,
): GuidedWorkflowMappingDraft {
  if (!draft.inputs.some((proposal) => proposal.id === proposalId)) invalidDraft()
  const compatibleRolesByInputId = { ...draft.compatibleRolesByInputId }
  delete compatibleRolesByInputId[proposalId]
  return {
    ...draft,
    inputs: draft.inputs.filter((proposal) => proposal.id !== proposalId),
    compatibleRolesByInputId,
  }
}

export function guidedOutputNodeCandidates(analysis: WorkflowAutoMappingResult) {
  return Object.entries(analysis.graph)
    .sort(([left], [right]) => compareNames(left, right))
    .map(([nodeId, node]) => ({
      nodeId,
      classType: node.class_type,
      ...(nodeTitle(node) ? { nodeTitle: nodeTitle(node) } : {}),
      suggestedField: defaultHistoryFieldForOutput(node.class_type, analysis.mediaType) || '',
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
  for (const input of draft.inputs) {
    if ((input.canonicalName === 'duration' || input.canonicalName === 'fps')
      && !validNumericTransform(input.canonicalName, input.numericTransform)) {
      issues.add('numericTransformInvalid')
    }
  }
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
