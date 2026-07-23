import type { ComfyUploadedFile } from './types'
import { unwrapDirectorConfig } from './director-config-envelope'

export const BERNINI_DIRECTOR_SPEC_VERSION = 4
export const BERNINI_DIRECTOR_TASK_TYPES = [
  'default', 't2i', 't2v', 'i2i', 'r2i', 'i2v', 'v2v',
  'r2v', 'vi2v', 'rv2v', 'ads2v', 'vrc2v', 'mv2v',
] as const

export type BerniniDirectorTaskType = typeof BERNINI_DIRECTOR_TASK_TYPES[number]
export type BerniniDirectorTimelineMode = 'video' | 'prompt_batch'
export type BerniniDirectorEditMode = 'global' | 'segment'

export interface BerniniDirectorSegmentSpec {
  id: string
  startFrame: number
  frameCount: number
  prompt: string
  negativePrompt?: string
  taskType?: BerniniDirectorTaskType
  sourcePanelId?: string
  sourceMediaId?: string
  referenceMediaIds?: string[]
  referenceVideoMediaId?: string
}

export interface BerniniDirectorSpec {
  kind: 'bernini-director'
  version: number
  videoModel?: string
  taskType: BerniniDirectorTaskType
  timelineMode: BerniniDirectorTimelineMode
  editMode: BerniniDirectorEditMode
  globalPrompt: string
  negativePrompt: string
  sourceVideoMediaId?: string
  globalReferenceMediaIds: string[]
  globalReferenceVideoMediaId?: string
  continuousReference: boolean
  frameRate: number
  width: number
  height: number
  refMaxSize: number
  outputMode: 'long_edge' | 'fixed'
  maxExportFrames: number
  exportMode: 'all' | 'segments'
  continuityEnabled: boolean
  continuityOverlapFrames: number
  runSelectEnabled: boolean
  runSelection: number[]
  steps: number
  splitStep: number
  sampler: string
  scheduler: string
  highNoiseCfg: number
  highNoiseSeed: number
  lowNoiseCfg: number
  lowNoiseSeed: number
  clearVramBetweenSegments: boolean
  exportSourceImages: boolean
  llmAutoEnhance: boolean
  llmApiFormat: 'Ollama' | '智谱 GLM' | 'OpenAI Compatible'
  llmOpenaiCompatMode: '标准' | 'llama-swap'
  llmUrl: string
  llmApiKey: string
  llmModel: string
  llmOutputLanguage: 'English' | '中文'
  llmCharacterFeatureEnhance: boolean
  llmUnloadAfter: boolean
  llmCustomTemplate: string
  segments: BerniniDirectorSegmentSpec[]
}

export interface BerniniDirectorMediaOrders {
  imageKeys: string[]
  videoMediaIds: string[]
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function string(value: unknown, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback
}

function number(value: unknown, fallback: number, min: number, max: number) {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback
}

function integer(value: unknown, fallback: number, min: number, max: number) {
  return Math.round(number(value, fallback, min, max))
}

function boolean(value: unknown, fallback: boolean) {
  return typeof value === 'boolean' ? value : fallback
}

function mediaIds(value: unknown, max = 5) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => (
    typeof item === 'string' && item.trim().length > 0
  )).map((item) => item.trim()))].slice(0, max)
}

function taskType(value: unknown, fallback: BerniniDirectorTaskType = 'rv2v') {
  const key = string(value).split(/\s+[—–-]\s+/, 1)[0] as BerniniDirectorTaskType
  return BERNINI_DIRECTOR_TASK_TYPES.includes(key) ? key : fallback
}

function parseSegment(value: unknown, index: number): BerniniDirectorSegmentSpec | null {
  const raw = record(value)
  if (!raw) return null
  const sourcePanelId = string(raw.sourcePanelId)
  const sourceMediaId = string(raw.sourceMediaId)
  const referenceVideoMediaId = string(raw.referenceVideoMediaId)
  return {
    id: string(raw.id, `segment-${index + 1}`),
    startFrame: integer(raw.startFrame, 0, 0, 100_000),
    frameCount: integer(raw.frameCount, 81, 1, 8192),
    prompt: string(raw.prompt),
    ...(string(raw.negativePrompt) ? { negativePrompt: string(raw.negativePrompt) } : {}),
    ...(raw.taskType ? { taskType: taskType(raw.taskType) } : {}),
    ...(sourcePanelId ? { sourcePanelId } : {}),
    ...(sourceMediaId ? { sourceMediaId } : {}),
    ...(mediaIds(raw.referenceMediaIds).length
      ? { referenceMediaIds: mediaIds(raw.referenceMediaIds) }
      : {}),
    ...(referenceVideoMediaId ? { referenceVideoMediaId } : {}),
  }
}

export function parseBerniniDirectorSpec(value: unknown): BerniniDirectorSpec | null {
  let parsed = unwrapDirectorConfig(value, 'bernini')
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return null
    }
  }
  const raw = record(parsed)
  if (!raw || raw.kind !== 'bernini-director') return null
  const rawSegments = Array.isArray(raw.segments) ? raw.segments : []
  const segments = rawSegments.map(parseSegment).filter((item): item is BerniniDirectorSegmentSpec => !!item)
  if (segments.length === 0) return null
  const sourceVideoMediaId = string(raw.sourceVideoMediaId)
  const globalReferenceVideoMediaId = string(raw.globalReferenceVideoMediaId)
  const timelineMode: BerniniDirectorTimelineMode = raw.timelineMode === 'video' ? 'video' : 'prompt_batch'
  return {
    kind: 'bernini-director',
    version: BERNINI_DIRECTOR_SPEC_VERSION,
    ...(string(raw.videoModel) ? { videoModel: string(raw.videoModel) } : {}),
    taskType: taskType(raw.taskType),
    timelineMode,
    editMode: raw.editMode === 'global' ? 'global' : 'segment',
    globalPrompt: string(raw.globalPrompt),
    negativePrompt: string(raw.negativePrompt, 'bad video'),
    ...(sourceVideoMediaId ? { sourceVideoMediaId } : {}),
    globalReferenceMediaIds: mediaIds(raw.globalReferenceMediaIds),
    ...(globalReferenceVideoMediaId ? { globalReferenceVideoMediaId } : {}),
    continuousReference: boolean(raw.continuousReference, false),
    frameRate: number(raw.frameRate, 24, 1, 240),
    width: integer(raw.width, 832, 16, 8192),
    height: integer(raw.height, 480, 16, 8192),
    refMaxSize: integer(raw.refMaxSize, 848, 16, 8192),
    outputMode: raw.outputMode === 'fixed' ? 'fixed' : 'long_edge',
    maxExportFrames: integer(raw.maxExportFrames, 0, 0, 8192),
    exportMode: raw.exportMode === 'segments' ? 'segments' : 'all',
    continuityEnabled: boolean(raw.continuityEnabled, false),
    continuityOverlapFrames: integer(raw.continuityOverlapFrames, 9, 1, 81),
    runSelectEnabled: boolean(raw.runSelectEnabled, false),
    runSelection: Array.isArray(raw.runSelection)
      ? [...new Set(raw.runSelection.map((item) => Number(item)).filter(Number.isInteger))]
        .filter((item) => item >= 0 && item < segments.length)
      : [],
    steps: integer(raw.steps, 6, 1, 200),
    splitStep: integer(raw.splitStep, 3, 1, 199),
    sampler: string(raw.sampler, 'euler'),
    scheduler: string(raw.scheduler, 'simple'),
    highNoiseCfg: number(raw.highNoiseCfg, 1, 0, 30),
    highNoiseSeed: integer(raw.highNoiseSeed, 0, 0, Number.MAX_SAFE_INTEGER),
    lowNoiseCfg: number(raw.lowNoiseCfg, 1, 0, 30),
    lowNoiseSeed: integer(raw.lowNoiseSeed, 0, 0, Number.MAX_SAFE_INTEGER),
    clearVramBetweenSegments: boolean(raw.clearVramBetweenSegments, true),
    exportSourceImages: boolean(raw.exportSourceImages, false),
    llmAutoEnhance: boolean(raw.llmAutoEnhance, false),
    llmApiFormat: raw.llmApiFormat === '智谱 GLM' || raw.llmApiFormat === 'OpenAI Compatible'
      ? raw.llmApiFormat
      : 'Ollama',
    llmOpenaiCompatMode: raw.llmOpenaiCompatMode === 'llama-swap' ? 'llama-swap' : '标准',
    llmUrl: string(raw.llmUrl, 'http://127.0.0.1:11434/v1'),
    llmApiKey: string(raw.llmApiKey),
    llmModel: string(raw.llmModel, 'qwen3.5'),
    llmOutputLanguage: raw.llmOutputLanguage === 'English' ? 'English' : '中文',
    llmCharacterFeatureEnhance: boolean(raw.llmCharacterFeatureEnhance, false),
    llmUnloadAfter: boolean(raw.llmUnloadAfter, false),
    llmCustomTemplate: string(raw.llmCustomTemplate),
    segments,
  }
}

export function collectBerniniDirectorMediaOrders(spec: BerniniDirectorSpec): BerniniDirectorMediaOrders {
  const imageKeys: string[] = []
  const videoMediaIds: string[] = []
  const add = (target: string[], value?: string) => {
    if (value && !target.includes(value)) target.push(value)
  }
  spec.globalReferenceMediaIds.forEach((id) => add(imageKeys, `media:${id}`))
  add(videoMediaIds, spec.sourceVideoMediaId)
  add(videoMediaIds, spec.globalReferenceVideoMediaId)
  for (const segment of spec.segments) {
    if (segment.sourcePanelId) add(imageKeys, `panel:${segment.sourcePanelId}`)
    if (segment.sourceMediaId) add(imageKeys, `media:${segment.sourceMediaId}`)
    segment.referenceMediaIds?.forEach((id) => add(imageKeys, `media:${id}`))
    add(videoMediaIds, segment.referenceVideoMediaId)
  }
  return { imageKeys, videoMediaIds }
}

function uploadedPath(file: ComfyUploadedFile) {
  return [file.subfolder, file.name].filter(Boolean).join('/')
}

function taskLabel(key: BerniniDirectorTaskType) {
  const labels: Record<BerniniDirectorTaskType, string> = {
    default: '默认通用', t2i: '文生图(Text to Image)', t2v: '文生视频(Text to Video)',
    i2i: '图生图(Image to Image)', r2i: '参考主体生图(Reference to Image)',
    i2v: '图生视频(Image to Video) [实验性]', v2v: '视频转视频(Video to Video)',
    r2v: '参考主体生视频(Reference to Video)', vi2v: '内容延展改视频',
    rv2v: '参考素材改视频', ads2v: '广告植入视频', vrc2v: '主体位置动作微调',
    mv2v: '全参数精细化改视频',
  }
  return `${key} — ${labels[key]}`
}

export function renderBerniniDirectorNode(input: {
  spec: BerniniDirectorSpec
  imageFiles: ComfyUploadedFile[]
  videoFiles: ComfyUploadedFile[]
  baseTimelineData?: unknown
}) {
  const { spec } = input
  const orders = collectBerniniDirectorMediaOrders(spec)
  if (orders.imageKeys.length !== input.imageFiles.length
    || orders.videoMediaIds.length !== input.videoFiles.length) {
    throw new Error('BERNINI_DIRECTOR_MEDIA_MISMATCH')
  }
  const imageByKey = new Map(orders.imageKeys.map((key, index) => [key, uploadedPath(input.imageFiles[index]!)]))
  const videoById = new Map(orders.videoMediaIds.map((id, index) => [id, uploadedPath(input.videoFiles[index]!)]))
  const reference = (id: string, index: number) => ({
    index,
    imageFile: imageByKey.get(`media:${id}`) || '',
    imageB64: '',
  })
  const videoRecord = (id?: string) => id && videoById.get(id)
    ? { fileName: videoById.get(id), videoFile: videoById.get(id), subfolder: '', type: 'input' }
    : {}
  const totalFrames = spec.segments.reduce((latest, segment) => (
    Math.max(latest, segment.startFrame + segment.frameCount)
  ), 1)
  let base: Record<string, unknown> = {}
  if (typeof input.baseTimelineData === 'string' && input.baseTimelineData.trim()) {
    try {
      const parsed = JSON.parse(input.baseTimelineData)
      if (record(parsed)) base = parsed
    } catch {
      base = {}
    }
  }
  const sourceVideo = videoRecord(spec.sourceVideoMediaId)
  const timeline = {
    ...base,
    version: BERNINI_DIRECTOR_SPEC_VERSION,
    editMode: spec.editMode,
    timelineMode: spec.timelineMode,
    totalFrames,
    frameRate: spec.frameRate,
    width: spec.width,
    height: spec.height,
    refMaxSize: spec.refMaxSize,
    output: {
      mode: spec.outputMode,
      longEdge: spec.refMaxSize,
      width: spec.width,
      height: spec.height,
      maxExportFrames: spec.maxExportFrames,
      exportMode: spec.exportMode,
      continuityEnabled: spec.continuityEnabled,
      continuityOverlapFrames: spec.continuityOverlapFrames,
    },
    videoClips: Object.keys(sourceVideo).length ? [{ id: 'source', ...sourceVideo }] : [],
    video: {
      id: 'source', ...sourceVideo, frames: [], frameMap: [], deletedSourceRanges: [],
    },
    global: {
      taskType: taskLabel(spec.taskType),
      prompt: spec.globalPrompt,
      refs: spec.globalReferenceMediaIds.map(reference).filter((item) => item.imageFile),
      referenceVideo: videoRecord(spec.globalReferenceVideoMediaId),
      continuousReference: spec.continuousReference,
      genImage: { imageFile: '' },
    },
    segments: spec.segments.map((segment) => {
      const sourceKey = segment.sourcePanelId
        ? `panel:${segment.sourcePanelId}`
        : segment.sourceMediaId ? `media:${segment.sourceMediaId}` : ''
      return {
        id: segment.id,
        start: segment.startFrame,
        length: segment.frameCount,
        frameCount: segment.frameCount,
        prompt: segment.prompt,
        negativePrompt: segment.negativePrompt || '',
        taskType: segment.taskType ? taskLabel(segment.taskType) : '',
        refs: (segment.referenceMediaIds || []).map(reference).filter((item) => item.imageFile),
        referenceVideo: videoRecord(segment.referenceVideoMediaId),
        genImage: { imageFile: imageByKey.get(sourceKey) || '' },
      }
    }),
    gen: { defaultFrameCount: 81 },
    runSelectEnabled: spec.runSelectEnabled,
    runSelection: spec.runSelectEnabled ? spec.runSelection : [],
  }
  return {
    timelineData: JSON.stringify(timeline),
    inputs: {
      task_type: taskLabel(spec.taskType),
      global_prompt: spec.globalPrompt,
      negative_prompt: spec.negativePrompt,
      high_noise_cfg: spec.highNoiseCfg,
      high_noise_seed: spec.highNoiseSeed,
      low_noise_cfg: spec.lowNoiseCfg,
      low_noise_seed: spec.lowNoiseSeed,
      frame_rate: spec.frameRate,
      width: spec.width,
      height: spec.height,
      ref_max_size: spec.refMaxSize,
      total_frames: totalFrames,
      steps: spec.steps,
      split_step: spec.splitStep,
      sampler: spec.sampler,
      scheduler: spec.scheduler,
      clear_vram_between_segments: spec.clearVramBetweenSegments,
      export_source_images: spec.exportSourceImages,
      llm_auto_enhance: spec.llmAutoEnhance,
      llm_api_format: spec.llmApiFormat,
      llm_openai_compat_mode: spec.llmOpenaiCompatMode,
      llm_url: spec.llmUrl,
      llm_api_key: spec.llmApiKey,
      llm_model: spec.llmModel,
      llm_output_language: spec.llmOutputLanguage,
      llm_character_feature_enhance: spec.llmCharacterFeatureEnhance,
      llm_unload_after: spec.llmUnloadAfter,
      llm_custom_template: spec.llmCustomTemplate,
    },
  }
}
