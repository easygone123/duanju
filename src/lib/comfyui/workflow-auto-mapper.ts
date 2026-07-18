import type {
  ComfyApiWorkflow,
  ComfyApiWorkflowNode,
  ComfyOutputBinding,
  ComfyNumericBindingTransform,
  ComfyVariableType,
} from './types'
import { comfyNumericScalarOutput, isSafeDottedPath } from './workflow-schema'
import {
  WORKFLOW_IMPORT_KIND_META,
  type CanonicalWorkflowInput,
  type WorkflowAutoMappingResult,
  type WorkflowImportKind,
  type WorkflowMappingProposal,
} from './workflow-auto-mapping-types'

export const WORKFLOW_AUTO_MAPPING_ERROR = {
  API_FORMAT_REQUIRED: 'COMFY_WORKFLOW_API_FORMAT_REQUIRED',
  API_FORMAT_INVALID: 'COMFY_WORKFLOW_API_FORMAT_INVALID',
} as const

export type WorkflowAutoMappingErrorCode =
  (typeof WORKFLOW_AUTO_MAPPING_ERROR)[keyof typeof WORKFLOW_AUTO_MAPPING_ERROR]

export class WorkflowAutoMappingError extends Error {
  readonly code: WorkflowAutoMappingErrorCode

  constructor(code: WorkflowAutoMappingErrorCode) {
    super(code)
    this.name = 'WorkflowAutoMappingError'
    this.code = code
  }
}

export function analyzeComfyApiWorkflow(input: {
  graph: unknown
  kind: WorkflowImportKind
}): WorkflowAutoMappingResult {
  const meta = WORKFLOW_IMPORT_KIND_META[input.kind]
  const graph = readApiFormatGraph(input.graph)
  const scalarProposals = inferScalarProposals(graph, meta.requiredInputs, input.kind)
  const mediaAnalysis = inferMediaProposals(graph, input.kind, meta.requiredInputs)
  const proposals = [...scalarProposals, ...mediaAnalysis.proposals]
  const outputs = discoverOutputs(graph, meta.mediaType)
  const issues = []

  if (outputs.length === 0) {
    issues.push({
      code: 'COMFY_WORKFLOW_OUTPUT_REQUIRED',
      message: `A ${meta.mediaType} output is required.`,
      path: 'outputs',
    })
  } else if (outputs.length > 1) {
    issues.push({
      code: 'COMFY_WORKFLOW_OUTPUT_AMBIGUOUS',
      message: `Select one primary ${meta.mediaType} output.`,
      path: 'outputs',
    })
  } else {
    outputs[0] = { ...outputs[0], primary: true }
  }

  return {
    graph,
    mediaType: meta.mediaType,
    purpose: meta.purpose,
    proposals,
    outputs,
    issues,
    referenceCapacity: mediaAnalysis.referenceCapacity,
  }
}

export function readApiFormatGraph(raw: unknown): ComfyApiWorkflow {
  const graph = unwrapComfyApiWorkflowPayload(raw)
  if (Array.isArray(graph) || isNormalWorkflowJson(graph)) {
    throw new WorkflowAutoMappingError(WORKFLOW_AUTO_MAPPING_ERROR.API_FORMAT_REQUIRED)
  }
  if (!isRecord(graph)) {
    throw new WorkflowAutoMappingError(WORKFLOW_AUTO_MAPPING_ERROR.API_FORMAT_INVALID)
  }

  for (const node of Object.values(graph)) {
    if (!isApiWorkflowNode(node)) {
      throw new WorkflowAutoMappingError(WORKFLOW_AUTO_MAPPING_ERROR.API_FORMAT_INVALID)
    }
  }

  return structuredClone(graph) as ComfyApiWorkflow
}

export function unwrapComfyApiWorkflowPayload(raw: unknown): unknown {
  if (!isRecord(raw)) return raw
  if (isApiWorkflowGraph(raw) || isNormalWorkflowJson(raw)) return raw

  const envelopeKeys = new Set(['prompt', 'client_id', 'extra_data', 'number', 'front'])
  const keys = Object.keys(raw)
  return isApiWorkflowGraph(raw.prompt) && keys.every((key) => envelopeKeys.has(key))
    ? raw.prompt
    : raw
}

interface ScalarRule {
  canonicalName: CanonicalWorkflowInput
  inputNames: readonly string[]
  valueType: ComfyVariableType
}

const SCALAR_RULES: readonly ScalarRule[] = [
  { canonicalName: 'width', inputNames: ['width'], valueType: 'number' },
  { canonicalName: 'height', inputNames: ['height'], valueType: 'number' },
  { canonicalName: 'seed', inputNames: ['seed', 'noise_seed'], valueType: 'number' },
]

const SECOND_INPUTS = new Set(['duration', 'seconds', 'durationseconds', 'durations'])
const FRAME_INPUTS = new Set(['numframes', 'framecount', 'totalframes', 'videolength'])
const AMBIGUOUS_DURATION_INPUTS = new Set(['length', 'frames'])
const FPS_INPUTS = new Set(['fps', 'framerate'])

function numericTransform(
  targetUnit: 'seconds' | 'frames' | 'fps',
  output: 'number' | 'numeric_string',
): ComfyNumericBindingTransform {
  if (targetUnit === 'frames') {
    return {
      sourceUnit: 'seconds', targetUnit, output,
      fps: { source: 'runtime_then_fallback', variable: 'fps', fallback: 16 },
      rounding: 'round', frameOffset: 1,
    }
  }
  return {
    sourceUnit: targetUnit === 'fps' ? 'fps' : 'seconds',
    targetUnit,
    output,
  }
}

function inferVideoNumericProposal(input: {
  nodeId: string
  node: ComfyApiWorkflowNode
  inputPath: string
  value: unknown
  title: string
  requiredInputs: readonly CanonicalWorkflowInput[]
}): WorkflowMappingProposal | null {
  if (!isSafeDottedPath(input.inputPath) || input.inputPath.includes('.')) return null
  const output = comfyNumericScalarOutput(input.value)
  if (!output) return null
  const inputName = normalize(input.inputPath)
  const videoEvidence = /(video|frame|fps|duration|temporal|timing)/.test(
    normalize(`${input.node.class_type} ${input.title}`),
  )
  let canonicalName: 'duration' | 'fps'
  let targetUnit: 'seconds' | 'frames' | 'fps'
  let confidence: 'high' | 'ambiguous'
  if (SECOND_INPUTS.has(inputName)) {
    canonicalName = 'duration'
    targetUnit = 'seconds'
    confidence = 'high'
  } else if (FRAME_INPUTS.has(inputName)) {
    canonicalName = 'duration'
    targetUnit = 'frames'
    confidence = videoEvidence ? 'high' : 'ambiguous'
  } else if (AMBIGUOUS_DURATION_INPUTS.has(inputName) && videoEvidence) {
    canonicalName = 'duration'
    targetUnit = 'frames'
    confidence = 'ambiguous'
  } else if (FPS_INPUTS.has(inputName)) {
    canonicalName = 'fps'
    targetUnit = 'fps'
    confidence = 'high'
  } else {
    return null
  }
  return {
    id: `${input.nodeId}:${input.inputPath}:${canonicalName}`,
    canonicalName,
    nodeId: input.nodeId,
    inputPath: input.inputPath,
    valueType: 'number',
    numericTransform: numericTransform(targetUnit, output),
    confidence,
    reasonCode: `COMFY_MAPPING_${canonicalName.toUpperCase()}_INPUT`,
    required: input.requiredInputs.includes(canonicalName),
    ...(input.title ? { nodeTitle: input.title } : {}),
  }
}

function inferScalarProposals(
  graph: ComfyApiWorkflow,
  requiredInputs: readonly CanonicalWorkflowInput[],
  kind: WorkflowImportKind,
): WorkflowMappingProposal[] {
  const proposals: WorkflowMappingProposal[] = []
  for (const [nodeId, node] of Object.entries(graph)) {
    const title = nodeTitle(node)
    proposals.push(...inferPromptProposals(nodeId, node, title, requiredInputs))

    if (kind === 'video_generation' || kind === 'video_to_video') {
      for (const [inputPath, value] of Object.entries(node.inputs)) {
        const proposal = inferVideoNumericProposal({
          nodeId, node, inputPath, value, title, requiredInputs,
        })
        if (proposal) proposals.push(proposal)
      }
    }

    for (const rule of SCALAR_RULES) {
      const inputName = rule.inputNames.find((name) => (
        Object.hasOwn(node.inputs, name)
        && typeof node.inputs[name] === 'number'
        && Number.isFinite(node.inputs[name])
      ))
      if (!inputName) continue
      proposals.push({
        id: `${nodeId}:${inputName}:${rule.canonicalName}`,
        canonicalName: rule.canonicalName,
        nodeId,
        inputPath: inputName,
        valueType: rule.valueType,
        confidence: 'high',
        reasonCode: `COMFY_MAPPING_${rule.canonicalName.toUpperCase()}_INPUT`,
        required: requiredInputs.includes(rule.canonicalName),
        ...(title ? { nodeTitle: title } : {}),
      })
    }
  }
  return proposals
}

function inferPromptProposals(
  nodeId: string,
  node: ComfyApiWorkflowNode,
  title: string,
  requiredInputs: readonly CanonicalWorkflowInput[],
): WorkflowMappingProposal[] {
  if (node.class_type === 'BerniniStudio') {
    const proposals: WorkflowMappingProposal[] = []
    if (typeof node.inputs.prompt === 'string') {
      proposals.push(promptFieldProposal(
        nodeId, 'prompt', 'prompt', requiredInputs, title,
        'COMFY_MAPPING_PROMPT_POSITIVE_LABEL',
      ))
    }
    if (typeof node.inputs.negative_prompt === 'string') {
      proposals.push(promptFieldProposal(
        nodeId, 'negative_prompt', 'negativePrompt', requiredInputs, title,
        'COMFY_MAPPING_PROMPT_NEGATIVE_LABEL',
      ))
    }
    return proposals
  }
  if (!Object.hasOwn(node.inputs, 'text') || typeof node.inputs.text !== 'string') return []
  const evidence = normalize(`${node.class_type} ${title}`)
  const canonicalName = evidence.includes('negative') ? 'negativePrompt' : 'prompt'
  const hasPolarityEvidence = evidence.includes('negative')
    || evidence.includes('positive')
    || normalize(title).includes('prompt')
  const isTextEncoder = normalize(node.class_type).includes('textencode')
  if (!hasPolarityEvidence && !isTextEncoder) return []
  const confidence = hasPolarityEvidence ? 'high' : 'ambiguous'
  return [{
    id: `${nodeId}:text:${canonicalName}`,
    canonicalName,
    nodeId,
    inputPath: 'text',
    valueType: 'string',
    confidence,
    reasonCode: confidence === 'ambiguous'
      ? 'COMFY_MAPPING_PROMPT_POLARITY_AMBIGUOUS'
      : canonicalName === 'prompt'
        ? 'COMFY_MAPPING_PROMPT_POSITIVE_LABEL'
        : 'COMFY_MAPPING_PROMPT_NEGATIVE_LABEL',
    required: requiredInputs.includes(canonicalName),
    ...(title ? { nodeTitle: title } : {}),
  }]
}

function promptFieldProposal(
  nodeId: string,
  inputPath: string,
  canonicalName: 'prompt' | 'negativePrompt',
  requiredInputs: readonly CanonicalWorkflowInput[],
  title: string,
  reasonCode: string,
): WorkflowMappingProposal {
  return {
    id: `${nodeId}:${inputPath}:${canonicalName}`,
    canonicalName,
    nodeId,
    inputPath,
    valueType: 'string',
    confidence: 'high',
    reasonCode,
    required: requiredInputs.includes(canonicalName),
    ...(title ? { nodeTitle: title } : {}),
  }
}

function inferMediaProposals(
  graph: ComfyApiWorkflow,
  kind: WorkflowImportKind,
  requiredInputs: readonly CanonicalWorkflowInput[],
): { proposals: WorkflowMappingProposal[]; referenceCapacity: number } {
  const proposals: WorkflowMappingProposal[] = []
  const bernini = findBerniniReferenceFamilies(graph, requiredInputs)
  proposals.push(...bernini.proposals)
  const referenceCandidates: Array<{
    nodeId: string
    inputPath: string
    nodeTitle: string
    listCapacity?: number
    confidence: 'high' | 'ambiguous'
    reasonCode: string
  }> = []

  const nodes = Object.entries(graph).sort(([left], [right]) => compareNodeIds(left, right))
  for (const [nodeId, node] of nodes) {
    if (node.class_type === 'BerniniStudio' || bernini.consumedLoaderNodeIds.has(nodeId)) continue
    const title = nodeTitle(node)
    const imageInput = findImageLoaderInput(node)
    if (imageInput) {
      const role = classifyImageRole(node, imageInput.inputPath, title, kind)
      if (role.canonicalName === 'referenceImages') {
        referenceCandidates.push({
          nodeId,
          inputPath: imageInput.inputPath,
          nodeTitle: title,
          confidence: role.confidence,
          reasonCode: role.reasonCode,
          ...(imageInput.listCapacity ? { listCapacity: imageInput.listCapacity } : {}),
        })
      } else {
        proposals.push({
          id: `${nodeId}:${imageInput.inputPath}:${role.canonicalName}`,
          canonicalName: role.canonicalName,
          nodeId,
          inputPath: imageInput.inputPath,
          valueType: 'image_ref',
          transform: 'filename',
          confidence: role.confidence,
          reasonCode: role.reasonCode,
          required: requiredInputs.includes(role.canonicalName),
          ...(title ? { nodeTitle: title } : {}),
        })
      }
      continue
    }

    const videoInput = findVideoLoaderInput(node)
    if (!videoInput) continue
    const highConfidence = normalize(`${node.class_type} ${title} ${videoInput}`).includes('source')
      || normalize(title).includes('video')
    proposals.push({
      id: `${nodeId}:${videoInput}:sourceVideo`,
      canonicalName: 'sourceVideo',
      nodeId,
      inputPath: videoInput,
      valueType: 'video_ref',
      transform: 'filename',
      confidence: highConfidence ? 'high' : 'ambiguous',
      reasonCode: highConfidence
        ? 'COMFY_MAPPING_SOURCE_VIDEO_LABEL'
        : 'COMFY_MAPPING_VIDEO_ROLE_AMBIGUOUS',
      required: requiredInputs.includes('sourceVideo'),
      ...(title ? { nodeTitle: title } : {}),
    })
  }

  let referenceCapacity = bernini.referenceCapacity
  for (const candidate of referenceCandidates) {
    const listCapacity = candidate.listCapacity
    proposals.push({
      id: `${candidate.nodeId}:${candidate.inputPath}:referenceImages`,
      canonicalName: 'referenceImages',
      nodeId: candidate.nodeId,
      inputPath: candidate.inputPath,
      valueType: 'image_ref_list',
      transform: listCapacity ? 'filename_list' : 'filename_at',
      confidence: candidate.confidence,
      reasonCode: listCapacity
        ? 'COMFY_MAPPING_REFERENCE_LIST_LABEL'
        : candidate.reasonCode,
      required: requiredInputs.includes('referenceImages'),
      referenceIndex: referenceCapacity,
      ...(candidate.nodeTitle ? { nodeTitle: candidate.nodeTitle } : {}),
    })
    referenceCapacity += listCapacity || 1
  }

  return { proposals, referenceCapacity }
}

function findBerniniReferenceFamilies(
  graph: ComfyApiWorkflow,
  requiredInputs: readonly CanonicalWorkflowInput[],
): {
  proposals: WorkflowMappingProposal[]
  consumedLoaderNodeIds: Set<string>
  referenceCapacity: number
} {
  const proposals: WorkflowMappingProposal[] = []
  const consumedLoaderNodeIds = new Set<string>()
  let referenceCapacity = 0
  const nodes = Object.entries(graph).sort(([left], [right]) => compareNodeIds(left, right))
  for (const [nodeId, node] of nodes) {
    if (node.class_type !== 'BerniniStudio') continue
    const imageInputs = Object.entries(node.inputs)
      .filter(([name, value]) => /^image[0-7]$/.test(name) && isWorkflowLink(value))
      .sort(([left], [right]) => compareNodeIds(left.slice(5), right.slice(5)))
    for (const [, value] of imageInputs) consumedLoaderNodeIds.add((value as [string, number])[0])
    proposals.push({
      id: `${nodeId}:image0:referenceImages`,
      canonicalName: 'referenceImages',
      nodeId,
      inputPath: 'image0',
      valueType: 'image_ref_list',
      transform: 'bernini_image_slots',
      confidence: 'high',
      reasonCode: 'COMFY_MAPPING_BERNINI_REFERENCE_SLOTS',
      required: requiredInputs.includes('referenceImages'),
      referenceIndex: 0,
      ...(nodeTitle(node) ? { nodeTitle: nodeTitle(node) } : {}),
    })
    referenceCapacity = Math.max(referenceCapacity, 8)
  }
  return { proposals, consumedLoaderNodeIds, referenceCapacity }
}

function isWorkflowLink(value: unknown): value is [string, number] {
  return Array.isArray(value)
    && value.length === 2
    && typeof value[0] === 'string'
    && Number.isInteger(value[1])
    && value[1] >= 0
}

function findImageLoaderInput(node: ComfyApiWorkflowNode): {
  inputPath: string
  listCapacity?: number
} | null {
  const className = normalize(node.class_type)
  const isImageLoader = className.includes('loadimage')
    || (className.includes('image') && className.includes('input'))
  if (!isImageLoader) return null
  for (const [inputPath, value] of Object.entries(node.inputs)) {
    const inputName = normalize(inputPath)
    if (typeof value === 'string' && /(image|filename|path)/.test(inputName)) {
      return { inputPath }
    }
    if (
      Array.isArray(value)
      && value.length > 0
      && value.length <= 8
      && value.every((item) => typeof item === 'string')
      && /(images|filenames)/.test(inputName)
    ) {
      return { inputPath, listCapacity: value.length }
    }
  }
  return null
}

function findVideoLoaderInput(node: ComfyApiWorkflowNode): string | null {
  const className = normalize(node.class_type)
  const isVideoLoader = className.includes('loadvideo')
    || (className.includes('video') && className.includes('input'))
  if (!isVideoLoader) return null
  for (const [inputPath, value] of Object.entries(node.inputs)) {
    if (typeof value === 'string' && /(video|filename|path)/.test(normalize(inputPath))) {
      return inputPath
    }
  }
  return null
}

function classifyImageRole(
  node: ComfyApiWorkflowNode,
  inputPath: string,
  title: string,
  kind: WorkflowImportKind,
): {
  canonicalName: 'sourceImage' | 'firstFrame' | 'lastFrame' | 'referenceImages'
  confidence: 'high' | 'ambiguous'
  reasonCode: string
} {
  const evidence = normalize(`${node.class_type} ${title} ${inputPath}`)
  if (/(first|start)/.test(evidence)) {
    return {
      canonicalName: 'firstFrame', confidence: 'high',
      reasonCode: 'COMFY_MAPPING_FIRST_FRAME_LABEL',
    }
  }
  if (/(last|end)/.test(evidence)) {
    return {
      canonicalName: 'lastFrame', confidence: 'high',
      reasonCode: 'COMFY_MAPPING_LAST_FRAME_LABEL',
    }
  }
  if (/(init|source|img2img)/.test(evidence)) {
    return {
      canonicalName: 'sourceImage', confidence: 'high',
      reasonCode: 'COMFY_MAPPING_SOURCE_IMAGE_LABEL',
    }
  }
  if (/(reference|ipadapter|controlnet|character|style)/.test(evidence)) {
    return {
      canonicalName: 'referenceImages', confidence: 'high',
      reasonCode: 'COMFY_MAPPING_REFERENCE_IMAGE_LABEL',
    }
  }

  if (kind === 'image_edit' || kind === 'image_upscale') {
    return {
      canonicalName: 'sourceImage', confidence: 'ambiguous',
      reasonCode: 'COMFY_MAPPING_IMAGE_ROLE_AMBIGUOUS',
    }
  }
  if (kind === 'video_generation') {
    return {
      canonicalName: 'firstFrame', confidence: 'ambiguous',
      reasonCode: 'COMFY_MAPPING_IMAGE_ROLE_AMBIGUOUS',
    }
  }
  return {
    canonicalName: 'referenceImages', confidence: 'ambiguous',
    reasonCode: 'COMFY_MAPPING_IMAGE_ROLE_AMBIGUOUS',
  }
}

function compareNodeIds(left: string, right: string) {
  return left.localeCompare(right, 'en', { numeric: true, sensitivity: 'base' })
}

function discoverOutputs(
  graph: ComfyApiWorkflow,
  mediaType: 'image' | 'video',
): ComfyOutputBinding[] {
  const outputs: ComfyOutputBinding[] = []
  for (const [nodeId, node] of Object.entries(graph)) {
    if (!isOutputNode(node.class_type, mediaType)) continue
    const fieldPath = defaultHistoryFieldForOutput(node.class_type, mediaType)
    if (!fieldPath) continue
    outputs.push({
      name: `output_${nodeId}`,
      nodeId,
      fieldPath,
      mediaType,
      primary: false,
    })
  }
  return outputs
}

export function defaultHistoryFieldForOutput(
  classType: string,
  mediaType: 'image' | 'video',
): string | null {
  if (mediaType === 'image') return 'images'
  const normalized = normalize(classType)
  if (normalized === 'vhsvideocombine' || normalized === 'savevideo') return 'gifs'
  return null
}

function isOutputNode(classType: string, mediaType: 'image' | 'video') {
  const normalized = normalize(classType)
  if (mediaType === 'image') {
    return normalized === 'saveimage'
      || normalized === 'previewimage'
      || (normalized.includes('image') && /(save|output|preview)/.test(normalized))
  }
  return normalized === 'vhsvideocombine'
    || (normalized.includes('video') && /(save|combine|output)/.test(normalized))
}

function isApiWorkflowNode(value: unknown): value is ComfyApiWorkflowNode {
  return isRecord(value)
    && typeof value.class_type === 'string'
    && value.class_type.trim().length > 0
    && isRecord(value.inputs)
}

function isApiWorkflowGraph(value: unknown): value is ComfyApiWorkflow {
  return isRecord(value)
    && Object.keys(value).length > 0
    && Object.values(value).every(isApiWorkflowNode)
}

function isNormalWorkflowJson(value: unknown) {
  return isRecord(value) && Array.isArray(value.nodes) && Array.isArray(value.links)
}

function nodeTitle(node: ComfyApiWorkflowNode) {
  return typeof node._meta?.title === 'string' ? node._meta.title.trim() : ''
}

function normalize(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
