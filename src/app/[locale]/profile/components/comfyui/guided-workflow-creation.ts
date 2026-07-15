import {
  WORKFLOW_IMPORT_KIND_META,
  type CanonicalWorkflowInput,
  type WorkflowAutoMappingResult,
  type WorkflowImportKind,
  type WorkflowMappingProposal,
} from '@/lib/comfyui/workflow-auto-mapping-types'

export interface GuidedWorkflowReview {
  resolvedInputs: CanonicalWorkflowInput[]
  preservedCount: number
  questions: WorkflowMappingProposal[]
  primaryOutputNodeId: string
  needsPrimaryOutput: boolean
  missingRequiredInputs: CanonicalWorkflowInput[]
  blockingIssueCodes: string[]
}

const GUIDED_MAPPING_REASON_KEYS = [
  'COMFY_MAPPING_PROMPT_POSITIVE_LABEL',
  'COMFY_MAPPING_PROMPT_NEGATIVE_LABEL',
  'COMFY_MAPPING_PROMPT_POLARITY_AMBIGUOUS',
  'COMFY_MAPPING_WIDTH_INPUT',
  'COMFY_MAPPING_HEIGHT_INPUT',
  'COMFY_MAPPING_SEED_INPUT',
  'COMFY_MAPPING_DURATION_INPUT',
  'COMFY_MAPPING_FPS_INPUT',
  'COMFY_MAPPING_SOURCE_IMAGE_LABEL',
  'COMFY_MAPPING_REFERENCE_IMAGE_LABEL',
  'COMFY_MAPPING_REFERENCE_LIST_LABEL',
  'COMFY_MAPPING_FIRST_FRAME_LABEL',
  'COMFY_MAPPING_LAST_FRAME_LABEL',
  'COMFY_MAPPING_SOURCE_VIDEO_LABEL',
  'COMFY_MAPPING_IMAGE_ROLE_AMBIGUOUS',
  'COMFY_MAPPING_VIDEO_ROLE_AMBIGUOUS',
] as const

export type GuidedMappingReasonKey = typeof GUIDED_MAPPING_REASON_KEYS[number] | 'unknown'

const guidedMappingReasonKeys = new Set<string>(GUIDED_MAPPING_REASON_KEYS)

export function guidedMappingReasonKey(reasonCode: string): GuidedMappingReasonKey {
  return guidedMappingReasonKeys.has(reasonCode)
    ? reasonCode as Exclude<GuidedMappingReasonKey, 'unknown'>
    : 'unknown'
}

export const deriveWorkflowName = (filename: string) => filename.trim().replace(/\.json$/i, '').trim()

export function guidedCompatibleRoles(proposal: WorkflowMappingProposal): CanonicalWorkflowInput[] {
  if (proposal.valueType === 'video_ref') return ['sourceVideo']
  if (proposal.valueType === 'image_ref' || proposal.valueType === 'image_ref_list') return ['sourceImage', 'referenceImages', 'firstFrame', 'lastFrame']
  if (proposal.canonicalName === 'prompt' || proposal.canonicalName === 'negativePrompt') return ['prompt', 'negativePrompt']
  return [proposal.canonicalName]
}

function effectiveProposalRole(
  proposal: WorkflowMappingProposal,
  roles: Record<string, CanonicalWorkflowInput | 'preserve_original'>,
): CanonicalWorkflowInput | 'preserve_original' | null {
  const selectedRole = roles[proposal.id]
  if (selectedRole) return selectedRole
  if (proposal.confidence === 'high') return proposal.canonicalName
  if (proposal.confidence === 'preserve_original' || (proposal.confidence === 'ambiguous' && !proposal.required)) {
    return 'preserve_original'
  }
  return null
}

export function buildGuidedWorkflowReview(
  kind: WorkflowImportKind,
  analysis: WorkflowAutoMappingResult,
  roles: Record<string, CanonicalWorkflowInput | 'preserve_original'>,
  selectedPrimaryOutput: string,
): GuidedWorkflowReview {
  const dispositions = analysis.proposals.map((proposal) => ({
    proposal,
    role: effectiveProposalRole(proposal, roles),
  }))
  const questions = dispositions
    .filter(({ proposal, role }) => proposal.required && proposal.confidence === 'ambiguous' && (!role || role === 'preserve_original'))
    .map(({ proposal }) => proposal)
  const resolvedInputs = [...new Set(dispositions
    .map(({ role }) => role)
    .filter((role): role is CanonicalWorkflowInput => Boolean(role && role !== 'preserve_original')))]
  const selectedPrimary = analysis.outputs.some((output) => output.nodeId === selectedPrimaryOutput)
    ? selectedPrimaryOutput
    : ''
  const automaticPrimary = analysis.outputs.find((output) => output.primary)?.nodeId
    || (analysis.outputs.length === 1 ? analysis.outputs[0]?.nodeId : '')
  const primaryOutputNodeId = selectedPrimary || automaticPrimary || ''
  const mappedInputs = new Set<CanonicalWorkflowInput>([
    ...resolvedInputs,
    ...analysis.proposals
      .filter((proposal) => proposal.required && proposal.confidence === 'ambiguous' && !roles[proposal.id])
      .map((proposal) => proposal.canonicalName),
  ])
  const missingRequiredInputs = WORKFLOW_IMPORT_KIND_META[kind].requiredInputs
    .filter((name) => !mappedInputs.has(name))
  return {
    resolvedInputs,
    preservedCount: analysis.proposals.filter((proposal) => !proposal.required && (!roles[proposal.id] || roles[proposal.id] === 'preserve_original')).length,
    questions,
    primaryOutputNodeId,
    needsPrimaryOutput: analysis.outputs.length > 1 && !primaryOutputNodeId,
    missingRequiredInputs,
    blockingIssueCodes: analysis.issues
      .filter((issue) => issue.code !== 'COMFY_WORKFLOW_OUTPUT_AMBIGUOUS')
      .map((issue) => issue.code),
  }
}

export function isGuidedWorkflowReady(input: { name: string; review: GuidedWorkflowReview; busy: boolean }) {
  return Boolean(input.name.trim()) && Boolean(input.review.primaryOutputNodeId)
    && !input.busy && input.review.questions.length === 0
    && !input.review.needsPrimaryOutput && input.review.missingRequiredInputs.length === 0
    && input.review.blockingIssueCodes.length === 0
}

export function createWorkflowAnalysisCoordinator() {
  let generation = 0
  let disposed = false
  return {
    begin: () => ({ generation: ++generation }),
    isCurrent: (ticket: { generation: number }) => !disposed && ticket.generation === generation,
    reset: () => { disposed = false; generation += 1 },
    dispose: () => { disposed = true; generation += 1 },
  }
}
