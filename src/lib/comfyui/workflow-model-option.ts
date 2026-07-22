import { composeModelKey } from '@/lib/model-config-contract'
import type { ComfyWorkflowPurpose } from './types'
import { hasLtxDirectorNode } from './ltx-director-contract'

export interface ComfyWorkflowModelInput {
  id: string
  name: string
  mediaType: string
  currentVersion: {
    id: string
    purpose: string
    variableDefinitions?: unknown
    bindingSpec?: unknown
    apiFormatJson?: unknown
  } | null
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
  const firstLastFrame = workflow.mediaType === 'video'
    && purpose === 'generation'
    && supportsComfyFirstLastFrameContract(
      workflow.currentVersion.variableDefinitions,
      workflow.currentVersion.bindingSpec,
    )
  const ltxDirector = workflow.mediaType === 'video'
    && purpose === 'generation'
    && hasLtxDirectorNode(workflow.currentVersion.apiFormatJson)
  return {
    value: composeModelKey('comfyui', workflow.id),
    label: workflow.name,
    provider: 'comfyui' as const,
    providerName: 'ComfyUI',
    workflowPurpose: purpose,
    workflowVersionId: workflow.currentVersion.id,
    ...(firstLastFrame ? { capabilities: { video: { firstlastframe: true } } } : {}),
    ...(ltxDirector ? { workflowFeatures: { ltxDirector: true } } : {}),
  }
}

function records(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is Record<string, unknown> => (
    !!entry && typeof entry === 'object' && !Array.isArray(entry)
  ))
}

function resolveSystemFrameVariable(input: {
  declaredNames: Set<string>
  canonical: string
  legacy: string
  fallback?: string
}): string | null {
  const declaresCanonical = input.declaredNames.has(input.canonical)
  const declaresLegacy = input.declaredNames.has(input.legacy)
  if (declaresCanonical && declaresLegacy) return null
  if (declaresCanonical) return input.canonical
  if (declaresLegacy) return input.legacy
  if (input.fallback && input.declaredNames.has(input.fallback)) return input.fallback
  return null
}

export function supportsComfyFirstLastFrameContract(
  rawDefinitions: unknown,
  rawBindings: unknown,
): boolean {
  const definitions = records(rawDefinitions)
  const bindings = records(rawBindings)
  const declaredNames = new Set(
    definitions
      .filter((definition) => typeof definition.name === 'string')
      .map((definition) => definition.name as string),
  )
  const firstFrameVariable = resolveSystemFrameVariable({
    declaredNames,
    canonical: 'firstFrame',
    legacy: 'first_frame',
    fallback: 'sourceImage',
  })
  const lastFrameVariable = resolveSystemFrameVariable({
    declaredNames,
    canonical: 'lastFrame',
    legacy: 'last_frame',
  })
  if (!firstFrameVariable || !lastFrameVariable) return false

  const isBoundImageVariable = (variable: string) => {
    const hasImageDefinition = definitions.some((definition) => (
      definition.name === variable && definition.type === 'image_ref'
    ))
    const hasImageBinding = bindings.some((binding) => (
      binding.variable === variable && binding.valueType === 'image_ref'
    ))
    return hasImageDefinition && hasImageBinding
  }

  return isBoundImageVariable(firstFrameVariable) && isBoundImageVariable(lastFrameVariable)
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
