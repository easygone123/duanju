import type {
  ComfyApiWorkflow,
  ComfyBindingTransform,
  ComfyMediaType,
  ComfyNumericBindingTransform,
  ComfyOutputBinding,
  ComfyVariableType,
  ComfyWorkflowPurpose,
  WorkflowValidationIssue,
} from './types'

export type WorkflowImportKind =
  | 'image_generation'
  | 'image_edit'
  | 'image_upscale'
  | 'video_generation'
  | 'video_to_video'

export type CanonicalWorkflowInput =
  | 'prompt'
  | 'negativePrompt'
  | 'width'
  | 'height'
  | 'seed'
  | 'sourceImage'
  | 'referenceImages'
  | 'duration'
  | 'fps'
  | 'firstFrame'
  | 'lastFrame'
  | 'sourceVideo'

export const WORKFLOW_IMPORT_KIND_META: Record<WorkflowImportKind, {
  mediaType: ComfyMediaType
  purpose: ComfyWorkflowPurpose
  requiredInputs: readonly CanonicalWorkflowInput[]
}> = {
  image_generation: {
    mediaType: 'image', purpose: 'generation', requiredInputs: ['prompt'],
  },
  image_edit: {
    mediaType: 'image', purpose: 'generation', requiredInputs: ['prompt'],
  },
  image_upscale: {
    mediaType: 'image', purpose: 'upscale', requiredInputs: ['sourceImage'],
  },
  video_generation: {
    mediaType: 'video', purpose: 'generation', requiredInputs: ['prompt'],
  },
  video_to_video: {
    mediaType: 'video', purpose: 'generation', requiredInputs: ['prompt', 'sourceVideo'],
  },
}

export type MappingConfidence = 'high' | 'ambiguous' | 'preserve_original' | 'blocking'

export interface WorkflowMappingProposal {
  id: string
  canonicalName: CanonicalWorkflowInput
  nodeId: string
  inputPath: string
  valueType: ComfyVariableType
  transform?: ComfyBindingTransform
  numericTransform?: ComfyNumericBindingTransform
  confidence: MappingConfidence
  reasonCode: string
  required: boolean
  referenceIndex?: number
  nodeTitle?: string
}

export interface WorkflowAutoMappingResult {
  graph: ComfyApiWorkflow
  mediaType: ComfyMediaType
  purpose: ComfyWorkflowPurpose
  proposals: WorkflowMappingProposal[]
  outputs: ComfyOutputBinding[]
  issues: WorkflowValidationIssue[]
  referenceCapacity: number
}
