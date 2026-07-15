import type {
  CanonicalWorkflowInput,
  WorkflowAutoMappingResult,
  WorkflowMappingProposal,
} from '@/lib/comfyui/workflow-auto-mapping-types'
import { isSafeDottedPath } from '@/lib/comfyui/workflow-schema'
import type { ComfyVariableType } from '@/lib/comfyui/types'
import { effectiveProposalRole } from './guided-workflow-creation'

export interface ManualWorkflowMapping {
  id: string
  canonicalName: CanonicalWorkflowInput
  nodeId: string
  inputPath: string
  valueType: ComfyVariableType
  nodeTitle?: string
}

export type ManualWorkflowMappings = Partial<
  Record<CanonicalWorkflowInput, ManualWorkflowMapping>
>

interface ManualScalarRole {
  canonicalName: CanonicalWorkflowInput
  valueType: ComfyVariableType
  accepts(value: unknown): boolean
}

const MANUAL_SCALAR_ROLES: readonly ManualScalarRole[] = [
  { canonicalName: 'prompt', valueType: 'string', accepts: (value) => typeof value === 'string' },
  { canonicalName: 'negativePrompt', valueType: 'string', accepts: (value) => typeof value === 'string' },
]

const MANUAL_SCALAR_ROLE_BY_NAME = new Map(
  MANUAL_SCALAR_ROLES.map((role) => [role.canonicalName, role]),
)

function compareNames(left: string, right: string) {
  return left.localeCompare(right, 'en', { numeric: true, sensitivity: 'base' })
}

function mappingPair(nodeId: string, inputPath: string) {
  return JSON.stringify([nodeId, inputPath])
}

function manualMappingId(nodeId: string, inputPath: string) {
  return `manual:${encodeURIComponent(mappingPair(nodeId, inputPath))}`
}

function nodeTitle(node: WorkflowAutoMappingResult['graph'][string]) {
  return typeof node._meta?.title === 'string' ? node._meta.title.trim() : ''
}

export function manualWorkflowMappingCandidates(
  analysis: WorkflowAutoMappingResult,
  canonicalName: CanonicalWorkflowInput,
  selected: ManualWorkflowMappings,
): ManualWorkflowMapping[] {
  const role = MANUAL_SCALAR_ROLE_BY_NAME.get(canonicalName)
  if (!role) return []

  const currentId = selected[canonicalName]?.id
  const analyzerPairs = new Set(
    analysis.proposals.map((proposal) => mappingPair(proposal.nodeId, proposal.inputPath)),
  )
  const otherManualIds = new Set(Object.entries(selected)
    .filter(([name, mapping]) => name !== canonicalName && mapping)
    .map(([, mapping]) => mapping?.id)
    .filter((id): id is string => typeof id === 'string'))
  const candidates: ManualWorkflowMapping[] = []

  const nodes = Object.entries(analysis.graph).sort(([left], [right]) => compareNames(left, right))
  for (const [nodeId, node] of nodes) {
    const title = nodeTitle(node)
    const inputs = Object.entries(node.inputs).sort(([left], [right]) => compareNames(left, right))
    for (const [inputPath, value] of inputs) {
      // A dotted top-level key cannot be represented unambiguously by the binding contract.
      if (!isSafeDottedPath(inputPath) || inputPath.includes('.') || !role.accepts(value)) continue
      const id = manualMappingId(nodeId, inputPath)
      const occupied = analyzerPairs.has(mappingPair(nodeId, inputPath)) || otherManualIds.has(id)
      if (occupied && id !== currentId) continue
      candidates.push({
        id,
        canonicalName,
        nodeId,
        inputPath,
        valueType: role.valueType,
        ...(title ? { nodeTitle: title } : {}),
      })
    }
  }

  return candidates
}

function invalidManualMapping(): never {
  throw new Error('workflowManualMappingInvalid')
}

export function withManualWorkflowMappings(
  analysis: WorkflowAutoMappingResult,
  selected: ManualWorkflowMappings,
  roles: Record<string, CanonicalWorkflowInput | 'preserve_original'>,
): WorkflowAutoMappingResult {
  const selectedEntries = Object.entries(selected).filter((entry) => entry[1] !== undefined)
  const analyzerPairs = new Set(
    analysis.proposals.map((proposal) => mappingPair(proposal.nodeId, proposal.inputPath)),
  )
  const proposalIds = new Set(analysis.proposals.map((proposal) => proposal.id))
  const analyzerScalarRoles = new Set<CanonicalWorkflowInput>()
  for (const proposal of analysis.proposals) {
    const role = effectiveProposalRole(proposal, roles)
    if (!role || role === 'preserve_original' || !MANUAL_SCALAR_ROLE_BY_NAME.has(role)) continue
    if (analyzerScalarRoles.has(role)) invalidManualMapping()
    analyzerScalarRoles.add(role)
  }
  const manualPairs = new Set<string>()
  const manualRoles = new Set<CanonicalWorkflowInput>()
  const proposals: WorkflowMappingProposal[] = []

  for (const [rawCanonicalName, unverified] of selectedEntries) {
    const canonicalName = rawCanonicalName as CanonicalWorkflowInput
    if (!MANUAL_SCALAR_ROLE_BY_NAME.has(canonicalName)
      || !unverified
      || typeof unverified !== 'object'
      || typeof unverified.id !== 'string') invalidManualMapping()
    if (analyzerScalarRoles.has(canonicalName) || manualRoles.has(canonicalName)) {
      invalidManualMapping()
    }

    const verified = manualWorkflowMappingCandidates(analysis, canonicalName, selected)
      .find((candidate) => candidate.id === unverified.id)
    if (!verified) invalidManualMapping()

    const pair = mappingPair(verified.nodeId, verified.inputPath)
    if (analyzerPairs.has(pair) || manualPairs.has(pair)) invalidManualMapping()
    if (proposalIds.has(verified.id)) invalidManualMapping()

    manualPairs.add(pair)
    manualRoles.add(canonicalName)
    proposalIds.add(verified.id)
    proposals.push({
      ...verified,
      confidence: 'high',
      reasonCode: 'COMFY_MAPPING_MANUAL',
      required: true,
    })
  }

  return proposals.length === 0
    ? analysis
    : { ...analysis, proposals: [...analysis.proposals, ...proposals] }
}
