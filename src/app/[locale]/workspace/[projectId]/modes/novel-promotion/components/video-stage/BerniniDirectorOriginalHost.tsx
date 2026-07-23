'use client'

import { useEffect, useRef } from 'react'

import { apiFetch } from '@/lib/api-fetch'
import {
  collectBerniniDirectorMediaOrders,
  renderBerniniDirectorNode,
  updateBerniniDirectorSpecFromTimeline,
  type BerniniDirectorSpec,
} from '@/lib/comfyui/bernini-director'
import { checkApiResponse } from '@/lib/error-handler'

const ORIGINAL_MODULE_SRC = '/vendor/bernini-director/web/js/bernini_timeline.js'

interface DirectorMedia {
  mediaId?: string
  panelId?: string
  url: string
  filename: string
  mimeType?: string
  width?: number
  height?: number
  durationMs?: number
}

export type BerniniDirectorOriginalSource = DirectorMedia

interface DirectorWidget {
  name: string
  type: string
  value: unknown
  callback?: (value: unknown) => void
  options?: Record<string, unknown>
  element?: HTMLElement
  hidden?: boolean
  computeSize?: (width?: number) => [number, number]
  computeLayoutSize?: () => { minHeight: number; minWidth: number }
}

interface DirectorNode {
  id: string
  comfyClass: string
  type: string
  widgets: DirectorWidget[]
  inputs: Array<Record<string, unknown>>
  outputs: Array<{ name: string; type: string }>
  properties: Record<string, unknown>
  size: [number, number]
  _berniniEditor?: {
    destroy?: () => void
    flushTimelineSync?: () => void
    scheduleRender?: () => void
  }
  _directorDomWidget?: DirectorWidget
  onNodeCreated?: () => void
  onRemoved?: () => void
  addWidget: (
    type: string,
    name: string,
    value: unknown,
    callback?: (value: unknown) => void,
    options?: Record<string, unknown>,
  ) => DirectorWidget
  addDOMWidget: (
    name: string,
    type: string,
    element: HTMLElement,
    options?: Record<string, unknown>,
  ) => DirectorWidget
  setDirtyCanvas: (foreground?: boolean, background?: boolean) => void
  setSize: (size: [number, number]) => void
  computeSize: () => [number, number]
  removeOutput: (index: number) => void
}

interface DirectorExtension {
  name: string
  setup?: () => Promise<void> | void
  beforeRegisterNodeDef?: (
    nodeType: { new (...args: never[]): DirectorNode; prototype: DirectorNode; comfyClass?: string },
    nodeData: { name: string },
  ) => Promise<void> | void
}

interface DirectorApp {
  graph: {
    _nodes: DirectorNode[]
    nodes: DirectorNode[]
    links: unknown[]
    getNodeById: (id: unknown) => DirectorNode | null
    setDirtyCanvas: () => void
    change: () => void
  }
  canvas: {
    graph: DirectorApp['graph']
    canvas: HTMLCanvasElement
    ds: { scale: number }
    onDrawForeground?: (context: CanvasRenderingContext2D) => void
  }
  canvasEl: HTMLCanvasElement
  queuePrompt: (() => Promise<void>) & { _berniniPatched?: boolean }
  registerExtension: (extension: DirectorExtension) => void
}

interface DirectorApi {
  apiURL: (path: string) => string
  fetchApi: (path: string, init?: RequestInit) => Promise<Response>
  addEventListener: (type: string, listener: EventListener) => void
  removeEventListener: (type: string, listener: EventListener) => void
}

interface DirectorAdapter {
  projectId: string
  storyboardId: string
  videoModel: string
  mediaByKey: Map<string, DirectorMedia>
  chunks: Map<string, Blob[]>
}

interface DirectorBridge {
  app: DirectorApp
  api: DirectorApi
  extension?: DirectorExtension
  modulePromise?: Promise<void>
  setupDone?: boolean
  adapter?: DirectorAdapter
}

type BerniniWindow = Window & typeof globalThis & {
  __waooBerniniDirectorBridge?: DirectorBridge
}

const WIDGET_DEFAULTS: Array<[string, unknown, string]> = [
  ['task_type', 'rv2v — 参考素材改视频', 'combo'],
  ['global_prompt', '', 'string'],
  ['negative_prompt', 'bad video', 'string'],
  ['bd_grp_high', '高噪采样设置', 'group'],
  ['high_noise_cfg', 1, 'number'],
  ['high_noise_seed', 0, 'number'],
  ['bd_grp_low', '低噪采样设置', 'group'],
  ['low_noise_cfg', 1, 'number'],
  ['low_noise_seed', 0, 'number'],
  ['frame_rate', 24, 'number'],
  ['width', 832, 'number'],
  ['height', 480, 'number'],
  ['ref_max_size', 848, 'number'],
  ['total_frames', 81, 'number'],
  ['timeline_data', '', 'string'],
  ['bd_grp_sample', '采样器设置', 'group'],
  ['steps', 6, 'number'],
  ['split_step', 3, 'number'],
  ['sampler', 'euler', 'combo'],
  ['scheduler', 'simple', 'combo'],
  ['bd_grp_pe', '提示词增强 LLM Prompt Enhancer', 'group'],
  ['llm_auto_enhance', false, 'toggle'],
  ['llm_api_format', 'Ollama', 'combo'],
  ['llm_openai_compat_mode', '标准', 'combo'],
  ['llm_url', 'http://127.0.0.1:11434/v1', 'string'],
  ['llm_api_key', '', 'string'],
  ['llm_model', 'qwen3.5', 'string'],
  ['llm_output_language', '中文', 'combo'],
  ['llm_character_feature_enhance', false, 'toggle'],
  ['llm_unload_after', false, 'toggle'],
  ['llm_custom_template', '', 'string'],
  ['bd_grp_perf', '性能 Performance', 'group'],
  ['clear_vram_between_segments', true, 'toggle'],
  ['export_source_images', false, 'toggle'],
]

function safeFilename(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-120) || 'media'
}

function registerMedia(adapter: DirectorAdapter, media: DirectorMedia, prefix = 'media') {
  const key = `waoowaoo/${prefix}-${media.mediaId || crypto.randomUUID()}-${safeFilename(media.filename)}`
  const basename = key.split('/').pop() || key
  adapter.mediaByKey.set(key, media)
  adapter.mediaByKey.set(basename, media)
  return key
}

function lookupMedia(adapter: DirectorAdapter | undefined, rawKey: string) {
  if (!adapter) return undefined
  const key = decodeURIComponent(rawKey || '').replace(/^\/+/, '')
  return adapter.mediaByKey.get(key)
    || adapter.mediaByKey.get(key.split('/').pop() || key)
}

function viewKey(path: string) {
  const parsed = new URL(path, window.location.origin)
  const filename = parsed.searchParams.get('filename') || ''
  const subfolder = parsed.searchParams.get('subfolder') || ''
  return [subfolder, filename].filter(Boolean).join('/')
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function uploadMedia(adapter: DirectorAdapter, file: File) {
  const formData = new FormData()
  formData.set('file', file)
  const response = await apiFetch(`/api/novel-promotion/${adapter.projectId}/storyboard-director/upload`, {
    method: 'POST',
    body: formData,
  })
  await checkApiResponse(response)
  const payload = await response.json() as {
    mediaId: string
    mediaUrl: string
    imageUrl?: string
    filename: string
    mimeType: string
    width?: number
    height?: number
  }
  const media: DirectorMedia = {
    mediaId: payload.mediaId,
    url: payload.imageUrl || payload.mediaUrl,
    filename: payload.filename || file.name,
    mimeType: payload.mimeType,
    width: payload.width,
    height: payload.height,
  }
  const key = registerMedia(adapter, media, 'upload')
  return { key, media }
}

function mediaFromRequest(adapter: DirectorAdapter, body: Record<string, unknown>) {
  const candidates = [
    body.videoFile,
    body.video_file,
    body.filename,
    body.imageFile,
  ].filter((item): item is string => typeof item === 'string')
  return candidates.map((candidate) => lookupMedia(adapter, candidate)).find(Boolean)
}

function probeVideo(url: string) {
  return new Promise<{ width: number; height: number; duration: number }>((resolve, reject) => {
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.muted = true
    video.onloadedmetadata = () => {
      resolve({
        width: video.videoWidth,
        height: video.videoHeight,
        duration: Number.isFinite(video.duration) ? video.duration : 0,
      })
      video.removeAttribute('src')
      video.load()
    }
    video.onerror = () => reject(new Error('Unable to read video metadata'))
    video.src = url
  })
}

async function blobToBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || '').split(',', 2)[1] || '')
    reader.onerror = () => reject(reader.error || new Error('Unable to read media'))
    reader.readAsDataURL(blob)
  })
}

async function extractVideoFrames(url: string, count: number) {
  const video = document.createElement('video')
  video.preload = 'auto'
  video.muted = true
  video.src = url
  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve()
    video.onerror = () => reject(new Error('Unable to load video'))
  })
  const canvas = document.createElement('canvas')
  const scale = Math.min(1, 768 / Math.max(video.videoWidth, video.videoHeight, 1))
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale))
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
  const context = canvas.getContext('2d')
  if (!context) return []
  const frames: string[] = []
  for (let index = 0; index < Math.max(1, count); index += 1) {
    video.currentTime = video.duration > 0
      ? Math.min(video.duration - 0.001, ((index + 1) / (count + 1)) * video.duration)
      : 0
    await new Promise<void>((resolve) => {
      video.onseeked = () => resolve()
      window.setTimeout(resolve, 800)
    })
    context.drawImage(video, 0, 0, canvas.width, canvas.height)
    frames.push(canvas.toDataURL('image/jpeg', 0.8).split(',', 2)[1] || '')
  }
  video.removeAttribute('src')
  video.load()
  return frames.filter(Boolean)
}

async function bridgeFetch(path: string, init?: RequestInit) {
  const adapter = (window as BerniniWindow).__waooBerniniDirectorBridge?.adapter
  if (!adapter) return jsonResponse({ error: 'Bernini Director adapter unavailable' }, 503)
  if (path.startsWith('/upload/image')) {
    const formData = init?.body instanceof FormData ? init.body : null
    const file = formData?.get('image')
    if (!(file instanceof File)) return jsonResponse({ error: 'Missing media file' }, 400)
    const uploaded = await uploadMedia(adapter, file)
    return jsonResponse({
      name: uploaded.key.split('/').pop(),
      subfolder: 'waoowaoo',
      type: 'input',
    })
  }
  if (path.startsWith('/bernini/director/upload_chunk')) {
    const formData = init?.body instanceof FormData ? init.body : null
    const chunk = formData?.get('chunk')
    const uploadId = String(formData?.get('upload_id') || '')
    const filename = String(formData?.get('filename') || '')
    const chunkIndex = Number(formData?.get('chunk_index'))
    const totalChunks = Number(formData?.get('total_chunks'))
    if (!(chunk instanceof Blob) || !uploadId || !filename) {
      return jsonResponse({ error: 'Invalid upload chunk' }, 400)
    }
    const chunks = adapter.chunks.get(uploadId) || []
    chunks[chunkIndex] = chunk
    adapter.chunks.set(uploadId, chunks)
    if (chunks.filter(Boolean).length < totalChunks) return jsonResponse({ done: false })
    const file = new File(chunks, filename, { type: chunk.type || 'video/mp4' })
    const uploaded = await uploadMedia(adapter, file)
    adapter.chunks.delete(uploadId)
    return jsonResponse({
      name: uploaded.key.split('/').pop(),
      subfolder: 'waoowaoo',
      type: 'input',
    })
  }
  if (path.startsWith('/bernini/director/probe_video')) {
    const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
    const media = mediaFromRequest(adapter, body)
    if (!media) return jsonResponse({ error: 'Video not found' }, 404)
    const metadata = await probeVideo(media.url)
    return jsonResponse({
      width: metadata.width,
      height: metadata.height,
      duration: metadata.duration,
      native_fps: 0,
      frame_count: 0,
      probe_method: 'browser_metadata',
    })
  }
  if (path.startsWith('/bernini/director/image_b64')) {
    const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
    const media = mediaFromRequest(adapter, body)
    if (!media) return jsonResponse({ error: 'Image not found' }, 404)
    const response = await fetch(media.url)
    return jsonResponse({ image: await blobToBase64(await response.blob()) })
  }
  if (path.startsWith('/bernini/director/extract_frames')) {
    const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
    const media = mediaFromRequest(adapter, body)
    if (!media) return jsonResponse({ error: 'Video not found' }, 404)
    const frames = await extractVideoFrames(media.url, Number(body.num_frames) || 2)
    return jsonResponse({ frames })
  }
  if (path.startsWith('/bernini/director/detect_shots')) {
    const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
    const clips = Array.isArray(body.clips) ? body.clips : []
    const cutFrames = clips.slice(1).flatMap((item) => {
      const clip = item && typeof item === 'object' ? item as Record<string, unknown> : null
      return typeof clip?.logicalStart === 'number' ? [clip.logicalStart] : []
    })
    return jsonResponse({
      cutFrames,
      shotCount: Math.max(1, cutFrames.length + 1),
      warnings: ['Web adapter preserves clip boundaries; PySceneDetect remains a ComfyUI-side feature.'],
    })
  }
  const serviceAction = [
    'enhance_models',
    'get_template',
    'enhance',
    'unload_model',
  ].find((action) => path.startsWith(`/bernini/director/${action}`))
  if (serviceAction) {
    const payload = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
    return apiFetch(`/api/novel-promotion/${adapter.projectId}/bernini-director/service`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        videoModel: adapter.videoModel,
        action: serviceAction,
        payload,
      }),
    })
  }
  return jsonResponse({ error: `Unsupported Bernini Director endpoint: ${path}` }, 404)
}

function bridgeApiUrl(path: string) {
  if (!path.startsWith('/view')) return path
  const adapter = (window as BerniniWindow).__waooBerniniDirectorBridge?.adapter
  const key = viewKey(path)
  return lookupMedia(adapter, key)?.url || key
}

function getBridge() {
  const directorWindow = window as BerniniWindow
  if (directorWindow.__waooBerniniDirectorBridge) return directorWindow.__waooBerniniDirectorBridge
  const events = new EventTarget()
  const canvasEl = document.createElement('canvas')
  const graph: DirectorApp['graph'] = {
    _nodes: [],
    nodes: [],
    links: [],
    getNodeById: (id) => graph._nodes.find((node) => String(node.id) === String(id)) || null,
    setDirtyCanvas: () => undefined,
    change: () => undefined,
  }
  const queuePrompt = Object.assign(async () => undefined, { _berniniPatched: false })
  const app: DirectorApp = {
    graph,
    canvas: { graph, canvas: canvasEl, ds: { scale: 1 } },
    canvasEl,
    queuePrompt,
    registerExtension: (extension) => {
      const bridge = directorWindow.__waooBerniniDirectorBridge
      if (bridge) bridge.extension = extension
    },
  }
  const api: DirectorApi = {
    apiURL: bridgeApiUrl,
    fetchApi: bridgeFetch,
    addEventListener: (type, listener) => events.addEventListener(type, listener),
    removeEventListener: (type, listener) => events.removeEventListener(type, listener),
  }
  const bridge: DirectorBridge = { app, api }
  directorWindow.__waooBerniniDirectorBridge = bridge
  return bridge
}

function loadOriginalDirector() {
  const bridge = getBridge()
  if (bridge.extension) return Promise.resolve()
  if (bridge.modulePromise) return bridge.modulePromise
  bridge.modulePromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${ORIGINAL_MODULE_SRC}"]`)
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true })
      existing.addEventListener('error', () => reject(new Error('Bernini Director module failed to load')), { once: true })
      return
    }
    const script = document.createElement('script')
    script.type = 'module'
    script.src = ORIGINAL_MODULE_SRC
    script.dataset.waooBerniniDirector = 'true'
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Bernini Director module failed to load'))
    document.head.appendChild(script)
  })
  return bridge.modulePromise
}

function totalFrames(spec: BerniniDirectorSpec) {
  return Math.max(1, ...spec.segments.map((segment) => segment.startFrame + segment.frameCount))
}

function taskLabel(task: string) {
  const labels: Record<string, string> = {
    default: '默认通用', t2i: '文生图(Text to Image)', t2v: '文生视频(Text to Video)',
    i2i: '图生图(Image to Image)', r2i: '参考主体生图(Reference to Image)',
    i2v: '图生视频(Image to Video) [实验性]', v2v: '视频转视频(Video to Video)',
    r2v: '参考主体生视频(Reference to Video)', vi2v: '内容延展改视频',
    rv2v: '参考素材改视频', ads2v: '广告植入视频', vrc2v: '主体位置动作微调',
    mv2v: '全参数精细化改视频',
  }
  return `${task} — ${labels[task] || task}`
}

function widgetValue(name: string, fallback: unknown, spec: BerniniDirectorSpec, timelineData: string) {
  const values: Record<string, unknown> = {
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
    total_frames: totalFrames(spec),
    timeline_data: timelineData,
    steps: spec.steps,
    split_step: spec.splitStep,
    sampler: spec.sampler,
    scheduler: spec.scheduler,
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
    clear_vram_between_segments: spec.clearVramBetweenSegments,
    export_source_images: spec.exportSourceImages,
  }
  return values[name] ?? fallback
}

async function loadSavedMedia(adapter: DirectorAdapter) {
  const response = await apiFetch(
    `/api/novel-promotion/${adapter.projectId}/bernini-director?storyboardId=${encodeURIComponent(adapter.storyboardId)}`,
  )
  if (!response.ok) return []
  const payload = await response.json() as { media?: Array<{
    id: string
    url: string
    filename: string
    mimeType?: string
    width?: number
    height?: number
    durationMs?: number
  }> }
  return payload.media || []
}

function seedTimeline(
  spec: BerniniDirectorSpec,
  sources: BerniniDirectorOriginalSource[],
  adapter: DirectorAdapter,
) {
  const sourceByPanel = new Map(sources.flatMap((source) => (
    source.panelId ? [[source.panelId, source] as const] : []
  )))
  const sourceByMedia = new Map(sources.flatMap((source) => (
    source.mediaId ? [[source.mediaId, source] as const] : []
  )))
  const orders = collectBerniniDirectorMediaOrders(spec)
  const imageFiles = orders.imageKeys.map((key) => {
    const source = key.startsWith('panel:')
      ? sourceByPanel.get(key.slice(6))
      : sourceByMedia.get(key.slice(6))
    if (!source) return { name: 'missing.webp', subfolder: 'waoowaoo', type: 'input' as const }
    const registered = registerMedia(adapter, source, key.startsWith('panel:') ? 'panel' : 'image')
    return {
      name: registered.split('/').pop() || registered,
      subfolder: 'waoowaoo',
      type: 'input' as const,
    }
  })
  const videoFiles = orders.videoMediaIds.map((mediaId) => {
    const source = sourceByMedia.get(mediaId)
    if (!source) return { name: 'missing.mp4', subfolder: 'waoowaoo', type: 'input' as const }
    const registered = registerMedia(adapter, source, 'video')
    return {
      name: registered.split('/').pop() || registered,
      subfolder: 'waoowaoo',
      type: 'input' as const,
    }
  })
  return renderBerniniDirectorNode({ spec, imageFiles, videoFiles }).timelineData
}

function enrichTimelineMedia(timeline: Record<string, unknown>, adapter: DirectorAdapter) {
  const attach = (value: unknown, fields: string[]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    const item = value as Record<string, unknown>
    const key = fields.map((field) => item[field])
      .find((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0)
    const media = key ? lookupMedia(adapter, key) : undefined
    if (media?.mediaId) item.sourceMediaId = media.mediaId
  }
  attach(timeline.video, ['videoFile', 'fileName'])
  for (const clip of Array.isArray(timeline.videoClips) ? timeline.videoClips : []) {
    attach(clip, ['videoFile', 'fileName'])
  }
  const global = timeline.global && typeof timeline.global === 'object' && !Array.isArray(timeline.global)
    ? timeline.global as Record<string, unknown>
    : {}
  for (const ref of Array.isArray(global.refs) ? global.refs : []) attach(ref, ['imageFile'])
  attach(global.referenceVideo, ['videoFile', 'fileName'])
  attach(global.genImage, ['imageFile'])
  for (const value of Array.isArray(timeline.segments) ? timeline.segments : []) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const segment = value as Record<string, unknown>
    for (const ref of Array.isArray(segment.refs) ? segment.refs : []) attach(ref, ['imageFile'])
    attach(segment.referenceVideo, ['videoFile', 'fileName'])
    attach(segment.genImage, ['imageFile'])
  }
}

function specFromNode(node: DirectorNode, adapter: DirectorAdapter, fallback: BerniniDirectorSpec) {
  const values = Object.fromEntries(node.widgets.map((widget) => [widget.name, widget.value]))
  let timeline: Record<string, unknown>
  try {
    timeline = JSON.parse(String(values.timeline_data || '{}')) as Record<string, unknown>
  } catch {
    return fallback
  }
  enrichTimelineMedia(timeline, adapter)
  return updateBerniniDirectorSpecFromTimeline({
    base: fallback,
    timelineData: timeline,
    widgetValues: values,
  })
}

export default function BerniniDirectorOriginalHost({
  projectId,
  storyboardId,
  spec,
  videoModel,
  sources,
  onChange,
  onReady,
  onError,
}: {
  projectId: string
  storyboardId: string
  spec: BerniniDirectorSpec
  videoModel: string
  sources: BerniniDirectorOriginalSource[]
  onChange: (spec: BerniniDirectorSpec) => void
  onReady?: () => void
  onError?: (error: Error) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const nodeRef = useRef<DirectorNode | null>(null)
  const specRef = useRef(spec)
  const videoModelRef = useRef(videoModel)
  const sourcesRef = useRef(sources)
  const onChangeRef = useRef(onChange)
  const onReadyRef = useRef(onReady)
  const onErrorRef = useRef(onError)
  const suppressRef = useRef(true)
  const changeTimerRef = useRef<number | null>(null)
  const adapterRef = useRef<DirectorAdapter | null>(null)
  specRef.current = spec
  videoModelRef.current = videoModel
  sourcesRef.current = sources
  onChangeRef.current = onChange
  onReadyRef.current = onReady
  onErrorRef.current = onError
  if (adapterRef.current) adapterRef.current.videoModel = videoModel

  useEffect(() => {
    let canceled = false
    const mountHost = hostRef.current
    if (!mountHost) return
    const resolvedMountHost: HTMLDivElement = mountHost
    const adapter: DirectorAdapter = {
      projectId,
      storyboardId,
      videoModel: videoModelRef.current,
      mediaByKey: new Map(),
      chunks: new Map(),
    }
    adapterRef.current = adapter
    const bridge = getBridge()
    bridge.adapter = adapter

    void Promise.all([loadOriginalDirector(), loadSavedMedia(adapter)]).then(async ([, savedMedia]) => {
      if (canceled) return
      const allSources = [
        ...sourcesRef.current,
        ...savedMedia.map((media) => ({ ...media, mediaId: media.id })),
      ]
      const timelineData = seedTimeline(specRef.current, allSources, adapter)
      const extension = bridge.extension
      if (!extension?.beforeRegisterNodeDef) {
        throw new Error('Bernini Director extension registration was not captured')
      }
      if (!bridge.setupDone) {
        await extension.setup?.()
        bridge.setupDone = true
      }

      class StandaloneBerniniNode implements DirectorNode {
        static comfyClass = 'ComfyBerniniDirector'
        id = `waoo-bernini-${storyboardId}`
        comfyClass = 'ComfyBerniniDirector'
        type = 'ComfyBerniniDirector'
        widgets: DirectorWidget[] = []
        inputs: Array<Record<string, unknown>> = []
        outputs = [
          { name: 'images', type: 'IMAGE' },
          { name: 'audio', type: 'AUDIO' },
          { name: 'fps', type: 'FLOAT' },
          { name: 'frame_count', type: 'INT' },
          { name: 'source_images', type: 'IMAGE' },
          { name: 'report', type: 'STRING' },
        ]
        properties: Record<string, unknown> = {}
        size: [number, number] = [1000, 680]
        declare _berniniEditor?: DirectorNode['_berniniEditor']
        declare _directorDomWidget?: DirectorWidget
        declare onNodeCreated?: () => void
        declare onRemoved?: () => void

        constructor() {
          for (const [name, fallback, type] of WIDGET_DEFAULTS) {
            this.addWidget(type, name, widgetValue(name, fallback, specRef.current, timelineData))
          }
        }

        addWidget(
          type: string,
          name: string,
          value: unknown,
          callback?: (value: unknown) => void,
          options?: Record<string, unknown>,
        ) {
          const widget: DirectorWidget = { type, name, value, callback, options: options || {} }
          this.widgets.push(widget)
          return widget
        }

        addDOMWidget(
          name: string,
          type: string,
          element: HTMLElement,
          options?: Record<string, unknown>,
        ) {
          resolvedMountHost.replaceChildren(element)
          const widget: DirectorWidget = { name, type, value: '', element, options: options || {} }
          this.widgets.push(widget)
          return widget
        }

        setDirtyCanvas() {
          if (suppressRef.current) return
          if (changeTimerRef.current !== null) window.clearTimeout(changeTimerRef.current)
          changeTimerRef.current = window.setTimeout(() => {
            this._berniniEditor?.flushTimelineSync?.()
            const next = specFromNode(this, adapter, specRef.current)
            specRef.current = next
            onChangeRef.current(next)
          }, 120)
        }

        setSize(size: [number, number]) {
          this.size = size
        }

        computeSize(): [number, number] {
          const minimumHeight = this.widgets.reduce((height, widget) => {
            if (widget.hidden) return height
            return Math.max(height, widget.computeLayoutSize?.().minHeight || 0)
          }, 680)
          return [this.size[0], minimumHeight]
        }

        removeOutput(index: number) {
          this.outputs.splice(index, 1)
        }
      }

      await extension.beforeRegisterNodeDef(
        StandaloneBerniniNode,
        { name: 'ComfyBerniniDirector' },
      )
      if (canceled) return
      const node = new StandaloneBerniniNode()
      nodeRef.current = node
      bridge.app.graph._nodes = [node]
      bridge.app.graph.nodes = bridge.app.graph._nodes
      node.onNodeCreated?.()
      window.setTimeout(() => {
        if (canceled) return
        suppressRef.current = false
        node._berniniEditor?.flushTimelineSync?.()
        const next = specFromNode(node, adapter, specRef.current)
        specRef.current = next
        onChangeRef.current(next)
        onReadyRef.current?.()
      }, 450)
    }).catch((reason: unknown) => {
      onErrorRef.current?.(reason instanceof Error ? reason : new Error(String(reason)))
    })

    return () => {
      canceled = true
      if (changeTimerRef.current !== null) window.clearTimeout(changeTimerRef.current)
      nodeRef.current?.onRemoved?.()
      nodeRef.current = null
      bridge.app.graph._nodes = []
      bridge.app.graph.nodes = []
      resolvedMountHost.replaceChildren()
      if (bridge.adapter === adapter) bridge.adapter = undefined
      if (adapterRef.current === adapter) adapterRef.current = null
    }
  }, [projectId, storyboardId])

  return (
    <div className="overflow-x-auto rounded-xl border border-white/10 bg-[#151515] p-2">
      <div ref={hostRef} className="min-h-[760px] min-w-[920px]" />
    </div>
  )
}
