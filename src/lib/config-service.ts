/**
 * 统一配置服务
 *
 * 所有 API 通过此服务获取模型配置，确保数据源一致性。
 *
 * 优先级：项目配置 > 用户偏好 > null
 */

import { prisma } from '@/lib/prisma'
import {
  type CapabilitySelections,
  type CapabilityValue,
  type ImageTaskCapabilityOverrides,
  composeModelKey as composeStrictModelKey,
  parseModelKeyStrict,
} from '@/lib/model-config-contract'
import { findBuiltinCapabilities } from '@/lib/model-capabilities/catalog'
import { resolveGenerationOptionsForModel } from '@/lib/model-capabilities/lookup'
import {
  type WorkflowConcurrencyConfig,
  normalizeWorkflowConcurrencyConfig,
} from '@/lib/workflow-concurrency'
import {
  isStoryboardGenerationMode,
  type SixGridCellAspectRatio,
  type SixGridProcessingOrder,
  type StoryboardGenerationMode,
} from '@/lib/novel-promotion/six-grid/contracts'
import { validateComfyDefaultModels } from '@/lib/comfyui/workflow-default-model'
import { readComfyAspectRatioOptions } from '@/lib/comfyui/aspect-ratio'

export { readComfyAspectRatioOptions } from '@/lib/comfyui/aspect-ratio'

export type ParsedModelKey = { provider: string, modelId: string }

/**
 * 解析模型复合 Key（严格模式，仅接受 provider::modelId）
 */
export function parseModelKey(key: string | null | undefined): ParsedModelKey | null {
  const parsed = parseModelKeyStrict(key)
  if (!parsed) return null
  return {
    provider: parsed.provider,
    modelId: parsed.modelId,
  }
}

/**
 * 组合 provider 与 modelId 为标准复合主键。
 */
export function composeModelKey(provider: string, modelId: string): string {
  return composeStrictModelKey(provider, modelId)
}

/**
 * 从复合 Key 中提取真正的 modelId（用于 API 调用）
 */
export function extractModelId(key: string | null | undefined): string | null {
  const parsed = parseModelKey(key)
  return parsed?.modelId || null
}

/**
 * 从模型字段中提取标准 modelKey（provider::modelId）
 */
export function extractModelKey(key: string | null | undefined): string | null {
  const parsed = parseModelKey(key)
  if (!parsed?.provider || !parsed?.modelId) return null
  return composeModelKey(parsed.provider, parsed.modelId)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isCapabilityValue(value: unknown): value is CapabilityValue {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function normalizeCapabilitySelections(raw: unknown): CapabilitySelections {
  if (!isRecord(raw)) return {}

  const normalized: CapabilitySelections = {}
  for (const [modelKey, rawSelection] of Object.entries(raw)) {
    if (!isRecord(rawSelection)) continue

    const selection: Record<string, CapabilityValue> = {}
    for (const [field, value] of Object.entries(rawSelection)) {
      if (field === 'aspectRatio') continue
      if (!isCapabilityValue(value)) continue
      selection[field] = value
    }

    if (Object.keys(selection).length > 0) {
      normalized[modelKey] = selection
    }
  }

  return normalized
}

function parseCapabilitySelections(raw: string | null | undefined): CapabilitySelections {
  if (!raw) return {}
  try {
    return normalizeCapabilitySelections(JSON.parse(raw) as unknown)
  } catch {
    return {}
  }
}

export interface ProjectModelConfig {
  analysisModel: string | null
  characterModel: string | null
  locationModel: string | null
  storyboardModel: string | null
  editModel: string | null
  videoModel: string | null
  audioModel: string | null
  comfyImageWorkflowVersionIdsByModelKey: Record<string, string>
  comfyVideoWorkflowVersionIdsByModelKey: Record<string, string>
  comfyImageBindingInvalid: boolean
  comfyVideoBindingInvalid: boolean
  comfyImageWorkflowVersionId: string | null
  comfyVideoWorkflowVersionId: string | null
  videoRatio: string | null
  artStyle: string | null
  storyboardGenerationMode: StoryboardGenerationMode
  sixGridCellAspectRatio: SixGridCellAspectRatio | null
  sixGridProcessingOrder: SixGridProcessingOrder
  storyboardUpscaleModel: string | null
  dialogueVideoModel: string | null
  capabilityDefaults: CapabilitySelections
  capabilityOverrides: CapabilitySelections
}

export interface UserModelConfig {
  analysisModel: string | null
  characterModel: string | null
  locationModel: string | null
  storyboardModel: string | null
  editModel: string | null
  videoModel: string | null
  audioModel: string | null
  capabilityDefaults: CapabilitySelections
}

export interface TaskModelOverrides {
  imageModel?: string | null
  videoModel?: string | null
}

const UNTRUSTED_COMFY_VERSION_FIELDS = [
  'comfyWorkflowVersionId',
  'comfyImageWorkflowVersionId',
  'comfyVideoWorkflowVersionId',
  'workflowVersionId',
  'workflow_version_id',
  'comfyWorkflowVersion',
  'comfyVersionId',
  'comfyModelSnapshotVersion',
] as const

export function applyTrustedComfyVersionSnapshot(
  payload: Record<string, unknown>,
  trustedWorkflowVersionId?: string | null,
): Record<string, unknown> {
  for (const field of UNTRUSTED_COMFY_VERSION_FIELDS) delete payload[field]
  if (trustedWorkflowVersionId) payload.comfyWorkflowVersionId = trustedWorkflowVersionId
  return payload
}

export async function getUserWorkflowConcurrencyConfig(
  userId: string,
): Promise<WorkflowConcurrencyConfig> {
  const userPref = await prisma.userPreference.findUnique({
    where: { userId },
    select: {
      analysisConcurrency: true,
      imageConcurrency: true,
      videoConcurrency: true,
    },
  })

  return normalizeWorkflowConcurrencyConfig({
    analysis: userPref?.analysisConcurrency,
    image: userPref?.imageConcurrency,
    video: userPref?.videoConcurrency,
  })
}

/**
 * 获取项目级模型配置
 */
export async function getProjectModelConfig(
  projectId: string,
  userId: string,
  taskOverrides: TaskModelOverrides = {},
): Promise<ProjectModelConfig> {
  const [projectData, userPref, comfyBinding] = await Promise.all([
    prisma.novelPromotionProject.findUnique({ where: { projectId } }),
    prisma.userPreference.findUnique({ where: { userId } }),
    prisma.projectComfyBinding.findUnique({
      where: { projectId_userId: { projectId, userId } },
      select: {
        imageWorkflowId: true, imageWorkflowVersionId: true,
        videoWorkflowId: true, videoWorkflowVersionId: true,
      },
    }),
  ])

  const taskImageModel = strictTaskOverride(taskOverrides.imageModel, 'imageModel')
  const taskVideoModel = strictTaskOverride(taskOverrides.videoModel, 'videoModel')
  const comfyImageBindingInvalid = !taskImageModel
    && Boolean(comfyBinding?.imageWorkflowId) !== Boolean(comfyBinding?.imageWorkflowVersionId)
  const comfyVideoBindingInvalid = !taskVideoModel
    && Boolean(comfyBinding?.videoWorkflowId) !== Boolean(comfyBinding?.videoWorkflowVersionId)
  const comfyImageModel = workflowModelKey(
    comfyBinding?.imageWorkflowId, comfyBinding?.imageWorkflowVersionId,
  )
  const comfyVideoModel = workflowModelKey(
    comfyBinding?.videoWorkflowId, comfyBinding?.videoWorkflowVersionId,
  )

  const [pinnedImageWorkflowVersionId, pinnedVideoWorkflowVersionId] = await Promise.all([
    !taskImageModel && comfyImageModel
      ? resolveTrustedPinnedComfyWorkflowVersion({
          userId,
          workflowId: comfyBinding!.imageWorkflowId!,
          workflowVersionId: comfyBinding!.imageWorkflowVersionId!,
          mediaType: 'image',
        })
      : null,
    !taskVideoModel && comfyVideoModel
      ? resolveTrustedPinnedComfyWorkflowVersion({
          userId,
          workflowId: comfyBinding!.videoWorkflowId!,
          workflowVersionId: comfyBinding!.videoWorkflowVersionId!,
          mediaType: 'video',
        })
      : null,
  ])

  const effectiveModels = {
    analysisModel: extractModelKey(projectData?.analysisModel) || extractModelKey(userPref?.analysisModel) || null,
    characterModel: taskImageModel || comfyImageModel || extractModelKey(projectData?.characterModel) || extractModelKey(userPref?.characterModel) || null,
    locationModel: taskImageModel || comfyImageModel || extractModelKey(projectData?.locationModel) || extractModelKey(userPref?.locationModel) || null,
    storyboardModel: taskImageModel || comfyImageModel || extractModelKey(projectData?.storyboardModel) || extractModelKey(userPref?.storyboardModel) || null,
    editModel: taskImageModel || comfyImageModel || extractModelKey(projectData?.editModel) || extractModelKey(userPref?.editModel) || null,
    videoModel: taskVideoModel || comfyVideoModel || extractModelKey(projectData?.videoModel) || extractModelKey(userPref?.videoModel) || null,
    audioModel: extractModelKey(projectData?.audioModel) || extractModelKey(userPref?.audioModel) || null,
  }
  const modelsRequiringCurrentVersion = {
    ...effectiveModels,
    ...(!taskImageModel && comfyImageModel
      ? { characterModel: null, locationModel: null, storyboardModel: null, editModel: null }
      : {}),
    ...(!taskVideoModel && comfyVideoModel ? { videoModel: null } : {}),
  }
  const comfyValidation = await validateComfyDefaultModels(userId, modelsRequiringCurrentVersion)
  const invalidComfyFields = new Set(comfyValidation.invalidEntries.map((entry) => entry.field))
  const currentImageWorkflowVersionIdsByModelKey: Record<string, string> = {}
  for (const field of ['characterModel', 'locationModel', 'storyboardModel', 'editModel'] as const) {
    const modelKey = effectiveModels[field]
    const workflowVersionId = modelKey
      ? comfyValidation.workflowVersionIdsByModelKey[modelKey]
      : null
    if (modelKey && workflowVersionId && !invalidComfyFields.has(field)) {
      currentImageWorkflowVersionIdsByModelKey[modelKey] = workflowVersionId
    }
  }
  const currentVideoWorkflowVersionIdsByModelKey: Record<string, string> = {}
  if (effectiveModels.videoModel && !invalidComfyFields.has('videoModel')) {
    const workflowVersionId = comfyValidation.workflowVersionIdsByModelKey[effectiveModels.videoModel]
    if (workflowVersionId) {
      currentVideoWorkflowVersionIdsByModelKey[effectiveModels.videoModel] = workflowVersionId
    }
  }
  if (taskImageModel
    && parseModelKeyStrict(taskImageModel)?.provider === 'comfyui'
    && !currentImageWorkflowVersionIdsByModelKey[taskImageModel]) {
    throw new Error(`COMFY_WORKFLOW_NOT_AVAILABLE: ${taskImageModel}`)
  }
  if (taskVideoModel
    && parseModelKeyStrict(taskVideoModel)?.provider === 'comfyui'
    && !currentVideoWorkflowVersionIdsByModelKey[taskVideoModel]) {
    throw new Error(`COMFY_WORKFLOW_NOT_AVAILABLE: ${taskVideoModel}`)
  }
  const imageWorkflowVersionIdsByModelKey = {
    ...currentImageWorkflowVersionIdsByModelKey,
    ...(comfyImageModel && pinnedImageWorkflowVersionId
      ? { [comfyImageModel]: pinnedImageWorkflowVersionId }
      : {}),
  }
  const videoWorkflowVersionIdsByModelKey = {
    ...currentVideoWorkflowVersionIdsByModelKey,
    ...(comfyVideoModel && pinnedVideoWorkflowVersionId
      ? { [comfyVideoModel]: pinnedVideoWorkflowVersionId }
      : {}),
  }
  const imageWorkflowVersionIds = [
    effectiveModels.characterModel,
    effectiveModels.locationModel,
    effectiveModels.storyboardModel,
    effectiveModels.editModel,
  ].flatMap((modelKey) => {
    if (!modelKey) return []
    const workflowVersionId = imageWorkflowVersionIdsByModelKey[modelKey]
    return workflowVersionId ? [workflowVersionId] : []
  })
  const uniqueImageWorkflowVersionIds = [...new Set(imageWorkflowVersionIds)]

  return {
    ...effectiveModels,
    comfyImageWorkflowVersionIdsByModelKey: imageWorkflowVersionIdsByModelKey,
    comfyVideoWorkflowVersionIdsByModelKey: videoWorkflowVersionIdsByModelKey,
    comfyImageBindingInvalid,
    comfyVideoBindingInvalid,
    comfyImageWorkflowVersionId: uniqueImageWorkflowVersionIds.length === 1
      ? uniqueImageWorkflowVersionIds[0]
      : null,
    comfyVideoWorkflowVersionId: effectiveModels.videoModel
      ? videoWorkflowVersionIdsByModelKey[effectiveModels.videoModel] ?? null
      : null,
    videoRatio: projectData?.videoRatio || '16:9',
    artStyle: projectData?.artStyle || null,
    storyboardGenerationMode: isStoryboardGenerationMode(projectData?.storyboardGenerationMode)
      ? projectData.storyboardGenerationMode
      : 'individual',
    sixGridCellAspectRatio: projectData?.sixGridCellAspectRatio === '16:9'
      || projectData?.sixGridCellAspectRatio === '9:16'
      ? projectData.sixGridCellAspectRatio
      : null,
    sixGridProcessingOrder: projectData?.sixGridProcessingOrder === 'sheet_upscale_then_crop'
      ? 'sheet_upscale_then_crop'
      : 'crop_then_panel_upscale',
    storyboardUpscaleModel: extractModelKey(projectData?.storyboardUpscaleModel) || null,
    dialogueVideoModel: extractModelKey(projectData?.dialogueVideoModel) || null,
    capabilityDefaults: parseCapabilitySelections(userPref?.capabilityDefaults),
    capabilityOverrides: parseCapabilitySelections(projectData?.capabilityOverrides),
  }
}

export async function resolveTrustedComfyWorkflowVersion(
  userId: string,
  modelKey: string | null,
  mediaType: 'image' | 'video',
): Promise<string | null> {
  if (!modelKey) return null
  const parsed = parseModelKeyStrict(modelKey)
  if (!parsed || parsed.provider !== 'comfyui') return null
  const field = mediaType === 'image' ? 'storyboardModel' : 'videoModel'
  const validation = await validateComfyDefaultModels(userId, { [field]: parsed.modelKey })
  const workflowVersionId = validation.workflowVersionIdsByModelKey[parsed.modelKey]
  if (!workflowVersionId || validation.invalidEntries.length > 0) {
    throw new Error(`COMFY_WORKFLOW_NOT_AVAILABLE: ${modelKey}`)
  }
  return workflowVersionId
}

function strictTaskOverride(value: string | null | undefined, field: keyof TaskModelOverrides): string | null {
  if (value === undefined || value === null || value === '') return null
  const modelKey = extractModelKey(value)
  if (!modelKey) throw new Error(`MODEL_KEY_INVALID: ${field}`)
  return modelKey
}

function workflowModelKey(
  workflowId: string | null | undefined,
  workflowVersionId: string | null | undefined,
): string | null {
  if (!workflowId || !workflowVersionId) return null
  return extractModelKey(composeModelKey('comfyui', workflowId))
}

async function resolveTrustedPinnedComfyWorkflowVersion(input: {
  userId: string
  workflowId: string
  workflowVersionId: string
  mediaType: 'image' | 'video'
}): Promise<string | null> {
  const version = await prisma.comfyWorkflowVersion.findFirst({
    where: {
      id: input.workflowVersionId,
      workflowId: input.workflowId,
      purpose: 'generation',
      publishedAt: { not: null },
      lastSuccessfulTestAt: { not: null },
      lastTestConnection: { userId: input.userId },
      workflow: {
        userId: input.userId,
        mediaType: input.mediaType,
        status: 'published',
      },
    },
    select: { id: true, contentHash: true },
  })
  return version?.contentHash.trim() ? version.id : null
}

export function resolveProjectComfyWorkflowVersion(
  projectModelConfig: Pick<
    ProjectModelConfig,
    | 'comfyImageWorkflowVersionIdsByModelKey'
    | 'comfyVideoWorkflowVersionIdsByModelKey'
    | 'comfyImageBindingInvalid'
    | 'comfyVideoBindingInvalid'
  >,
  modelKey: string | null | undefined,
  mediaType: 'image' | 'video',
): string | null {
  const bindingInvalid = mediaType === 'image'
    ? projectModelConfig.comfyImageBindingInvalid
    : projectModelConfig.comfyVideoBindingInvalid
  if (bindingInvalid) {
    throw new Error(`COMFY_WORKFLOW_NOT_AVAILABLE: ${mediaType}`)
  }
  const parsed = parseModelKeyStrict(modelKey)
  if (!parsed || parsed.provider !== 'comfyui') return null
  const canonicalModelKey = composeModelKey(parsed.provider, parsed.modelId)
  const workflowVersionIdsByModelKey = mediaType === 'image'
    ? projectModelConfig.comfyImageWorkflowVersionIdsByModelKey
    : projectModelConfig.comfyVideoWorkflowVersionIdsByModelKey
  const workflowVersionId = workflowVersionIdsByModelKey[canonicalModelKey]
  if (!workflowVersionId) {
    throw new Error(`COMFY_WORKFLOW_NOT_AVAILABLE: ${canonicalModelKey}`)
  }
  return workflowVersionId
}

/**
 * 获取用户级模型配置（无项目时使用）
 */
export async function getUserModelConfig(userId: string): Promise<UserModelConfig> {
  const userPref = await prisma.userPreference.findUnique({
    where: { userId },
  })

  return {
    analysisModel: extractModelKey(userPref?.analysisModel) || null,
    characterModel: extractModelKey(userPref?.characterModel) || null,
    locationModel: extractModelKey(userPref?.locationModel) || null,
    storyboardModel: extractModelKey(userPref?.storyboardModel) || null,
    editModel: extractModelKey(userPref?.editModel) || null,
    videoModel: extractModelKey(userPref?.videoModel) || null,
    audioModel: extractModelKey(userPref?.audioModel) || null,
    capabilityDefaults: parseCapabilitySelections(userPref?.capabilityDefaults),
  }
}

export function resolveModelCapabilityGenerationOptions(input: {
  modelType: 'llm' | 'image' | 'video'
  modelKey: string
  capabilityDefaults?: CapabilitySelections
  capabilityOverrides?: CapabilitySelections
  runtimeSelections?: Record<string, CapabilityValue>
}): Record<string, CapabilityValue> {
  const parsed = parseModelKeyStrict(input.modelKey)
  if (!parsed) {
    throw new Error(`MODEL_KEY_INVALID: ${input.modelKey}`)
  }

  const capabilities = findBuiltinCapabilities(input.modelType, parsed.provider, parsed.modelId)
  // Image aspect ratio is project/layout driven in the shared capability resolver.
  // Task-level overrides are validated separately against the same catalog below.
  const resolverCapabilities = input.modelType === 'image' && capabilities?.image
    ? {
      ...capabilities,
      image: { ...capabilities.image, aspectRatioOptions: undefined },
    }
    : capabilities
  const resolved = resolveGenerationOptionsForModel({
    modelType: input.modelType,
    modelKey: input.modelKey,
    capabilities: resolverCapabilities,
    capabilityDefaults: input.capabilityDefaults,
    capabilityOverrides: input.capabilityOverrides,
    runtimeSelections: input.runtimeSelections,
    requireAllFields: input.modelType !== 'llm',
  })

  if (resolved.issues.length > 0) {
    const first = resolved.issues[0]
    throw new Error(`${first.code}: ${first.field} ${first.message}`)
  }

  return resolved.options
}

export async function resolveProjectModelCapabilityGenerationOptions(input: {
  projectId: string
  userId: string
  modelType: 'llm' | 'image' | 'video'
  modelKey: string
  runtimeSelections?: Record<string, CapabilityValue>
}): Promise<Record<string, CapabilityValue>> {
  const config = await getProjectModelConfig(input.projectId, input.userId)
  return resolveModelCapabilityGenerationOptions({
    modelType: input.modelType,
    modelKey: input.modelKey,
    capabilityDefaults: config.capabilityDefaults,
    capabilityOverrides: config.capabilityOverrides,
    runtimeSelections: input.runtimeSelections,
  })
}

export function resolveImageTaskGenerationOptions(input: {
  imageModel: string
  projectModelConfig: Pick<ProjectModelConfig, 'capabilityDefaults' | 'capabilityOverrides'>
  taskSelections?: ImageTaskCapabilityOverrides
  comfyAspectRatioOptions?: readonly string[]
}): Record<string, CapabilityValue> {
  const taskSelections = input.taskSelections ?? {}
  for (const key of Object.keys(taskSelections)) {
    if (key !== 'resolution' && key !== 'aspectRatio') {
      throw new Error(`CAPABILITY_FIELD_INVALID: ${key}`)
    }
  }
  const aspectRatio = taskSelections.aspectRatio
  if (aspectRatio !== undefined && (typeof aspectRatio !== 'string' || !/^[1-9]\d{0,2}:[1-9]\d{0,2}$/.test(aspectRatio))) {
    throw new Error('CAPABILITY_VALUE_NOT_ALLOWED: aspectRatio')
  }
  if (aspectRatio !== undefined) {
    const parsed = parseModelKeyStrict(input.imageModel)
    const allowed = parsed?.provider === 'comfyui'
      ? input.comfyAspectRatioOptions
      : parsed && findBuiltinCapabilities('image', parsed.provider, parsed.modelId)?.image?.aspectRatioOptions
    if (!allowed?.includes(aspectRatio)) {
      throw new Error('CAPABILITY_VALUE_NOT_ALLOWED: aspectRatio')
    }
  }
  const runtimeSelections: Record<string, CapabilityValue> = {}
  if (taskSelections.resolution !== undefined) runtimeSelections.resolution = taskSelections.resolution
  const capabilityOptions = resolveModelCapabilityGenerationOptions({
    modelType: 'image',
    modelKey: input.imageModel,
    capabilityDefaults: input.projectModelConfig.capabilityDefaults,
    capabilityOverrides: input.projectModelConfig.capabilityOverrides,
    runtimeSelections,
  })
  return {
    ...capabilityOptions,
    ...(aspectRatio !== undefined ? { aspectRatio } : {}),
  }
}

async function loadOwnedPublishedComfyAspectRatioOptions(input: {
  userId: string
  workflowVersionId: string | null
}): Promise<string[]> {
  if (!input.workflowVersionId) return []
  const version = await prisma.comfyWorkflowVersion.findFirst({
    where: {
      id: input.workflowVersionId,
      purpose: 'generation',
      publishedAt: { not: null },
      lastSuccessfulTestAt: { not: null },
      lastTestConnection: { userId: input.userId },
      workflow: {
        userId: input.userId,
        mediaType: 'image',
        status: 'published',
      },
    },
    select: { variableDefinitions: true, contentHash: true },
  })
  return version?.contentHash.trim()
    ? readComfyAspectRatioOptions(version.variableDefinitions)
    : []
}

export async function resolveProjectImageTaskGenerationOptions(input: {
  projectId: string
  userId: string
  imageModel: string
  taskSelections: ImageTaskCapabilityOverrides
  comfyWorkflowVersionId?: string
  projectModelConfig?: ProjectModelConfig
}) {
  const projectModelConfig = input.projectModelConfig
    ?? await getProjectModelConfig(input.projectId, input.userId)
  const parsed = parseModelKeyStrict(input.imageModel)
  const comfyAspectRatioOptions = parsed?.provider === 'comfyui'
    ? await loadOwnedPublishedComfyAspectRatioOptions({
      userId: input.userId,
      workflowVersionId: input.comfyWorkflowVersionId ?? null,
    })
    : undefined
  return resolveImageTaskGenerationOptions({
    imageModel: input.imageModel,
    projectModelConfig,
    taskSelections: input.taskSelections,
    comfyAspectRatioOptions,
  })
}

/**
 * 检查必需的模型配置是否存在
 */
export function checkRequiredModels(
  config: Partial<ProjectModelConfig | UserModelConfig>,
  requiredFields: (keyof ProjectModelConfig | keyof UserModelConfig)[],
): string[] {
  const missing: string[] = []
  const configValues = config as Record<string, unknown>

  const fieldNames: Record<string, string> = {
    analysisModel: 'AI分析模型',
    characterModel: '角色图像模型',
    locationModel: '场景图像模型',
    storyboardModel: '分镜图像模型',
    editModel: '修图/编辑模型',
    videoModel: '视频模型',
    audioModel: '语音合成模型',
  }

  for (const field of requiredFields) {
    if (!configValues[field]) {
      missing.push(fieldNames[field] || field)
    }
  }

  return missing
}

/**
 * 生成缺失配置的错误消息
 */
export function getMissingConfigError(missingFields: string[]): string {
  if (missingFields.length === 0) return ''
  if (missingFields.length === 1) {
    return `请先在项目设置中配置"${missingFields[0]}"`
  }
  return `请先在项目设置中配置以下模型：${missingFields.join('、')}`
}

/**
 * 为图片类任务统一构建 billingPayload（项目级，async）
 *
 * 生图和修图统一使用严格模式：用户必须已在项目设置中配置好 resolution。
 * resolution 会同时注入到 billingPayload.generationOptions（计费用）
 * 和 task payload（worker 读取后传给 API 的 imageSize 参数）。
 */
export async function buildImageBillingPayload(input: {
  projectId: string
  userId: string
  imageModel: string | null
  projectModelConfig?: ProjectModelConfig
  taskSelections?: ImageTaskCapabilityOverrides
  basePayload: Record<string, unknown>
}): Promise<Record<string, unknown>> {
  const { projectId, userId, imageModel, basePayload } = input
  if (!imageModel) return basePayload

  let capabilityOptions: Record<string, CapabilityValue> = {}
  let comfyWorkflowVersionId: string | null = null
  const projectModelConfig = input.projectModelConfig
    ?? await getProjectModelConfig(projectId, userId)
  try {
    comfyWorkflowVersionId = resolveProjectComfyWorkflowVersion(projectModelConfig, imageModel, 'image')
    const parsedImageModel = parseModelKeyStrict(imageModel)
    const comfyAspectRatioOptions = input.taskSelections?.aspectRatio !== undefined
      && parsedImageModel?.provider === 'comfyui'
      ? await loadOwnedPublishedComfyAspectRatioOptions({
        userId,
        workflowVersionId: comfyWorkflowVersionId,
      })
      : undefined
    capabilityOptions = resolveImageTaskGenerationOptions({
      imageModel,
      projectModelConfig,
      taskSelections: input.taskSelections,
      comfyAspectRatioOptions,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Image model capability not configured'
    throw Object.assign(new Error(message), { code: 'IMAGE_MODEL_CAPABILITY_NOT_CONFIGURED', message })
  }

  return {
    ...applyTrustedComfyVersionSnapshot(
      { ...basePayload },
      comfyWorkflowVersionId,
    ),
    imageModel,
    comfyModelSnapshotVersion: 1,
    ...(Object.keys(capabilityOptions).length > 0 ? { generationOptions: capabilityOptions } : {}),
  }
}

/**
 * 为图片类任务统一构建 billingPayload（用户级，sync）
 *
 * 适用于 asset-hub 等无 projectId 场景，使用已取出的 userModelConfig。
 */
export async function buildImageBillingPayloadFromUserConfig(input: {
  userId: string
  userModelConfig: UserModelConfig
  imageModel: string | null
  basePayload: Record<string, unknown>
}): Promise<Record<string, unknown>> {
  const { userId, userModelConfig, imageModel, basePayload } = input
  if (!imageModel) return basePayload

  let capabilityOptions: Record<string, CapabilityValue> = {}
  try {
    capabilityOptions = resolveModelCapabilityGenerationOptions({
      modelType: 'image',
      modelKey: imageModel,
      capabilityDefaults: userModelConfig.capabilityDefaults,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Image model capability not configured'
    throw Object.assign(new Error(message), { code: 'IMAGE_MODEL_CAPABILITY_NOT_CONFIGURED', message })
  }

  const comfyWorkflowVersionId = await resolveTrustedComfyWorkflowVersion(
    userId,
    imageModel,
    'image',
  )
  return {
    ...applyTrustedComfyVersionSnapshot({ ...basePayload }, comfyWorkflowVersionId),
    imageModel,
    comfyModelSnapshotVersion: 1,
    ...(Object.keys(capabilityOptions).length > 0 ? { generationOptions: capabilityOptions } : {}),
  }
}
