import { composeModelKey } from '@/lib/model-config-contract'
import type { ComfyWorkflowPurpose } from './types'

export interface ComfyWorkflowModelInput {
  id: string
  name: string
  mediaType: string
  currentVersion: { id: string; purpose: string } | null
}

export interface ExecutableComfyWorkflowInput {
  mediaType: string
  currentVersionId: string | null
  currentVersion: {
    id: string
    purpose: string
    publishedAt: Date | string | null
    contentHash: string | null
    lastSuccessfulTestAt: Date | string | null
    lastTestConnection: { userId: string } | null
  } | null
}

export function buildComfyWorkflowModelOption(workflow: ComfyWorkflowModelInput) {
  const purpose: ComfyWorkflowPurpose = workflow.currentVersion?.purpose === 'upscale' ? 'upscale' : 'generation'
  if (!workflow.currentVersion) throw new Error('COMFY_WORKFLOW_VERSION_REQUIRED')
  return {
    value: composeModelKey('comfyui', workflow.id),
    label: workflow.name,
    provider: 'comfyui' as const,
    providerName: 'ComfyUI',
    workflowPurpose: purpose,
    workflowVersionId: workflow.currentVersion.id,
  }
}

export function isExecutableOwnedWorkflow(workflow: ExecutableComfyWorkflowInput, userId: string) {
  const version = workflow.currentVersion
  return Boolean(version)
    && workflow.currentVersionId === version?.id
    && Boolean(version.publishedAt)
    && typeof version.contentHash === 'string'
    && version.contentHash.trim().length > 0
    && Boolean(version.lastSuccessfulTestAt)
    && version.lastTestConnection?.userId === userId
}

export function isTestedOwnedUpscaleWorkflow(workflow: ExecutableComfyWorkflowInput, userId: string) {
  return workflow.mediaType === 'image'
    && workflow.currentVersion?.purpose === 'upscale'
    && isExecutableOwnedWorkflow(workflow, userId)
}
