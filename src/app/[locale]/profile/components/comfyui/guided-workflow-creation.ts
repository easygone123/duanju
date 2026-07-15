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

export const deriveWorkflowName = (filename: string) => filename.trim().replace(/\.json$/i, '').trim()

export function guidedCompatibleRoles(proposal: WorkflowMappingProposal): CanonicalWorkflowInput[] {
  if (proposal.valueType === 'video_ref') return ['sourceVideo']
  if (proposal.valueType === 'image_ref' || proposal.valueType === 'image_ref_list') return ['sourceImage', 'referenceImages', 'firstFrame', 'lastFrame']
  if (proposal.canonicalName === 'prompt' || proposal.canonicalName === 'negativePrompt') return ['prompt', 'negativePrompt']
  return [proposal.canonicalName]
}

export function buildGuidedWorkflowReview(
  kind: WorkflowImportKind,
  analysis: WorkflowAutoMappingResult,
  roles: Record<string, CanonicalWorkflowInput | 'preserve_original'>,
  selectedPrimaryOutput: string,
): GuidedWorkflowReview {
  const questions = analysis.proposals.filter((proposal) => proposal.required && proposal.confidence === 'ambiguous' && !roles[proposal.id])
  const resolvedInputs = [...new Set(analysis.proposals
    .filter((proposal) => proposal.confidence === 'high' || Boolean(roles[proposal.id] && roles[proposal.id] !== 'preserve_original'))
    .map((proposal) => roles[proposal.id] || proposal.canonicalName)
    .filter((value): value is CanonicalWorkflowInput => value !== 'preserve_original'))]
  const automaticPrimary = analysis.outputs.find((output) => output.primary)?.nodeId || (analysis.outputs.length === 1 ? analysis.outputs[0]?.nodeId : '')
  const primaryOutputNodeId = selectedPrimaryOutput || automaticPrimary || ''
  const mappedInputs = new Set<CanonicalWorkflowInput>([
    ...resolvedInputs,
    ...analysis.proposals.filter((proposal) => proposal.required).map((proposal) => proposal.canonicalName),
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
  return Boolean(input.name.trim()) && !input.busy && input.review.questions.length === 0
    && !input.review.needsPrimaryOutput && input.review.missingRequiredInputs.length === 0
    && input.review.blockingIssueCodes.length === 0
}

export function createWorkflowAnalysisCoordinator() {
  let generation = 0
  let disposed = false
  return {
    begin: () => ({ generation: ++generation }),
    isCurrent: (ticket: { generation: number }) => !disposed && ticket.generation === generation,
    dispose: () => { disposed = true; generation += 1 },
  }
}
