/**
 * 获取用户的模型列表
 *
 * 返回用户在个人中心启用的模型，供项目配置下拉框使用。
 * capabilities 仅来自系统内置目录（不信任用户提交的 model.capabilities）。
 */

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireUserAuth, isErrorResponse } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'
import {
  composeModelKey,
  parseModelKeyStrict,
  type CapabilityValue,
  type ModelCapabilities,
  type UnifiedModelType,
} from '@/lib/model-config-contract'
import { findBuiltinCapabilities } from '@/lib/model-capabilities/catalog'
import { findBuiltinPricingCatalogEntry } from '@/lib/model-pricing/catalog'
import type { VideoPricingTier } from '@/lib/model-pricing/video-tier'
import { validateWorkflowContract } from '@/lib/comfyui/workflow-schema'
import type {
  ComfyInputBinding,
  ComfyOutputBinding,
  ComfyVariableDefinition,
  ComfyWorkflowPurpose,
} from '@/lib/comfyui/types'
import {
  buildComfyWorkflowModelOption,
  isExecutableOwnedWorkflow,
  isTestedOwnedUpscaleWorkflow,
} from '@/lib/comfyui/workflow-model-option'

type StoredModelType = UnifiedModelType | string

interface StoredModel {
  modelId?: string
  modelKey?: string
  name?: string
  type?: StoredModelType
  provider?: string
}

interface StoredProvider {
  id?: string
  name?: string
  apiKey?: string
}

interface UserModelOption {
  value: string
  label: string
  provider?: string
  providerName?: string
  capabilities?: ModelCapabilities
  videoPricingTiers?: VideoPricingTier[]
  workflowPurpose?: ComfyWorkflowPurpose
  workflowVersionId?: string
}

interface UserModelsPayload {
  llm: UserModelOption[]
  image: UserModelOption[]
  video: UserModelOption[]
  audio: UserModelOption[]
  lipsync: UserModelOption[]
  upscale: UserModelOption[]
}

const AUDIO_MODEL_EXCLUDED_IDS = new Set([
  'qwen-voice-design',
])

function isUnifiedModelType(type: unknown): type is UnifiedModelType {
  return (
    type === 'llm'
    || type === 'image'
    || type === 'video'
    || type === 'audio'
    || type === 'lipsync'
  )
}

function toModelKey(model: StoredModel): string {
  const provider = typeof model.provider === 'string' ? model.provider.trim() : ''
  const modelId = typeof model.modelId === 'string' ? model.modelId.trim() : ''

  if (provider && modelId) {
    return composeModelKey(provider, modelId)
  }

  const parsed = parseModelKeyStrict(typeof model.modelKey === 'string' ? model.modelKey : '')
  return parsed?.modelKey || ''
}

function toProvider(model: StoredModel): string | undefined {
  if (typeof model.provider === 'string' && model.provider.trim()) return model.provider.trim()
  const parsed = parseModelKeyStrict(typeof model.modelKey === 'string' ? model.modelKey : '')
  return parsed?.provider || undefined
}

function toModelId(model: StoredModel): string {
  if (typeof model.modelId === 'string' && model.modelId.trim()) {
    return model.modelId.trim()
  }
  const parsed = parseModelKeyStrict(typeof model.modelKey === 'string' ? model.modelKey : '')
  return parsed?.modelId || ''
}

function toDisplayLabel(model: StoredModel, fallbackModelId: string): string {
  if (typeof model.name === 'string' && model.name.trim()) return model.name.trim()
  return fallbackModelId
}

function dedupeByModelKey(items: UserModelOption[]): UserModelOption[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    if (seen.has(item.value)) return false
    seen.add(item.value)
    return true
  })
}

function cloneVideoPricingTiers(rawTiers: Array<{ when: Record<string, CapabilityValue> }>): VideoPricingTier[] {
  return rawTiers.map((tier) => ({
    when: { ...tier.when },
  }))
}

function parseStoredModels(rawModels: string | null | undefined): StoredModel[] {
  if (!rawModels) return []
  let parsedUnknown: unknown
  try {
    parsedUnknown = JSON.parse(rawModels)
  } catch {
    throw new ApiError('INVALID_PARAMS', {
      code: 'MODEL_PAYLOAD_INVALID',
      field: 'customModels',
    })
  }
  if (!Array.isArray(parsedUnknown)) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'MODEL_PAYLOAD_INVALID',
      field: 'customModels',
    })
  }
  return parsedUnknown as StoredModel[]
}

function parseStoredProviders(rawProviders: string | null | undefined): StoredProvider[] {
  if (!rawProviders) return []
  let parsedUnknown: unknown
  try {
    parsedUnknown = JSON.parse(rawProviders)
  } catch {
    throw new ApiError('INVALID_PARAMS', {
      code: 'PROVIDER_PAYLOAD_INVALID',
      field: 'customProviders',
    })
  }
  if (!Array.isArray(parsedUnknown)) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'PROVIDER_PAYLOAD_INVALID',
      field: 'customProviders',
    })
  }
  return parsedUnknown as StoredProvider[]
}

function hasStoredProviderApiKey(provider: StoredProvider): boolean {
  return typeof provider.apiKey === 'string' && provider.apiKey.trim().length > 0
}

function isUserSelectableModel(model: StoredModel): boolean {
  if (model.type !== 'audio') return true
  const modelId = toModelId(model)
  return !AUDIO_MODEL_EXCLUDED_IDS.has(modelId)
}

export const GET = apiHandler(async () => {
  const authResult = await requireUserAuth()
  if (isErrorResponse(authResult)) return authResult
  const { session } = authResult
  const userId = session.user.id

  const [pref, comfyWorkflows] = await Promise.all([
    prisma.userPreference.findUnique({
      where: { userId },
      select: { customModels: true, customProviders: true },
    }),
    prisma.comfyWorkflow.findMany({
      where: {
        userId,
        status: 'published',
        currentVersionId: { not: null },
        currentVersion: { is: { publishedAt: { not: null } } },
      },
      select: {
        id: true, name: true, mediaType: true, currentVersionId: true,
        currentVersion: {
          select: {
            id: true, purpose: true, publishedAt: true, contentHash: true, lastSuccessfulTestAt: true,
            lastTestConnection: { select: { userId: true } },
          },
        },
      },
      orderBy: [{ mediaType: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      take: 500,
    }),
  ])

  const modelsRaw: StoredModel[] = parseStoredModels(pref?.customModels)
  const providers: StoredProvider[] = parseStoredProviders(pref?.customProviders)
  const executableWorkflows = comfyWorkflows.filter((workflow) => (
    isExecutableOwnedWorkflow(workflow, userId)
  ))
  const upscaleVersionIds = executableWorkflows.flatMap((workflow) => (
    workflow.mediaType === 'image'
    && workflow.currentVersion?.purpose === 'upscale'
    && typeof workflow.currentVersion.id === 'string'
      ? [workflow.currentVersion.id]
      : []
  ))
  const upscaleVersions = upscaleVersionIds.length > 0
    ? await prisma.comfyWorkflowVersion.findMany({
      where: { id: { in: upscaleVersionIds } },
      select: {
        id: true, workflowId: true, purpose: true, apiFormatJson: true,
        variableDefinitions: true, bindingSpec: true, outputSpec: true,
      },
    })
    : []
  const validUpscaleWorkflowIds = new Set<string>()
  for (const version of upscaleVersions) {
    try {
      if (version.purpose !== 'upscale') continue
      const workflow = executableWorkflows.find((candidate) => candidate.id === version.workflowId)
      if (!workflow || !isTestedOwnedUpscaleWorkflow(workflow, userId)) continue
      const issues = validateWorkflowContract({
        purpose: 'upscale',
        graph: version.apiFormatJson,
        variableDefinitions: version.variableDefinitions as unknown as ComfyVariableDefinition[],
        bindings: version.bindingSpec as unknown as ComfyInputBinding[],
        outputs: version.outputSpec as unknown as ComfyOutputBinding[],
      })
      if (issues.length === 0) validUpscaleWorkflowIds.add(version.workflowId)
    } catch {
      // A malformed legacy contract is omitted without breaking the model endpoint.
    }
  }

  const providerNameMap = new Map<string, string>()
  const providerIdsWithApiKey = new Set<string>()
  providers.forEach((provider) => {
    const providerId = typeof provider?.id === 'string' ? provider.id.trim() : ''
    if (!providerId) return

    if (provider?.name && typeof provider.name === 'string') {
      providerNameMap.set(providerId, provider.name)
    }
    if (hasStoredProviderApiKey(provider)) providerIdsWithApiKey.add(providerId)
  })

  const grouped: UserModelsPayload = {
    llm: [],
    image: [],
    video: [],
    audio: [],
    lipsync: [],
    upscale: [],
  }

  for (const model of modelsRaw) {
    if (!isUnifiedModelType(model.type)) continue
    if (!isUserSelectableModel(model)) continue

    const modelType = model.type
    const modelKey = toModelKey(model)
    if (!modelKey) continue

    const provider = toProvider(model)
    if (provider === 'comfyui') continue
    if (!provider || !providerIdsWithApiKey.has(provider)) continue
    const modelId = toModelId(model)
    const option: UserModelOption = {
      value: modelKey,
      label: toDisplayLabel(model, modelId || modelKey),
      provider,
      providerName: provider ? providerNameMap.get(provider) : undefined,
    }

    if (provider && modelId) {
      const capabilities = findBuiltinCapabilities(modelType, provider, modelId)
      if (capabilities) {
        option.capabilities = capabilities
      }

      if (modelType === 'video') {
        const pricingEntry = findBuiltinPricingCatalogEntry('video', provider, modelId)
        if (pricingEntry?.pricing.mode === 'capability' && Array.isArray(pricingEntry.pricing.tiers)) {
          option.videoPricingTiers = cloneVideoPricingTiers(pricingEntry.pricing.tiers)
        }
      }
    }

    grouped[modelType].push(option)
  }

  for (const workflow of executableWorkflows) {
    if (workflow.mediaType !== 'image' && workflow.mediaType !== 'video') continue
    const purpose: ComfyWorkflowPurpose = workflow.currentVersion?.purpose === 'upscale'
      ? 'upscale'
      : 'generation'
    if (purpose === 'upscale') {
      if (workflow.mediaType !== 'image' || !validUpscaleWorkflowIds.has(workflow.id)) continue
    }
    const target = purpose === 'upscale' ? grouped.upscale : grouped[workflow.mediaType]
    target.push(buildComfyWorkflowModelOption(workflow))
  }

  return NextResponse.json({
    llm: dedupeByModelKey(grouped.llm),
    image: dedupeByModelKey(grouped.image),
    video: dedupeByModelKey(grouped.video),
    audio: dedupeByModelKey(grouped.audio),
    lipsync: dedupeByModelKey(grouped.lipsync),
    upscale: dedupeByModelKey(grouped.upscale),
  } satisfies UserModelsPayload)
})
