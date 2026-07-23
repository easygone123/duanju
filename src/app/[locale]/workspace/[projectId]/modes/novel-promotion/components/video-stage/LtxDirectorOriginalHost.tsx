'use client'

import { useEffect, useRef } from 'react'

import { apiFetch } from '@/lib/api-fetch'
import {
  createLtxDirectorTimelineExport,
  parseLtxDirectorTimelineSpec,
  resolveLtxDirectorAspectRatioFromDimensions,
  resolveLtxDirectorDimensions,
  type LtxDirectorResolutionPreset,
  type LtxDirectorTimelineSpec,
} from '@/lib/comfyui/ltx-director'
import { checkApiResponse } from '@/lib/error-handler'

const ORIGINAL_SCRIPT_SRC = '/vendor/whatdreamscost-ltx-director/ltx_director.js'

interface DirectorMedia {
  mediaId?: string
  url: string
  filename: string
  mimeType?: string
}

export interface LtxDirectorOriginalSource extends DirectorMedia {
  panelId?: string
}

interface StandaloneWidget {
  name: string
  type: string
  value: unknown
  callback?: (value: unknown) => void
  options?: Record<string, unknown>
  element?: HTMLElement
  hidden?: boolean
  computeSize?: (width?: number) => [number, number]
  draw?: () => void
}

interface StandaloneInput {
  name: string
  type: string
  link: null
  widget?: { name: string }
}

interface DirectorNode {
  widgets: StandaloneWidget[]
  inputs: StandaloneInput[]
  properties: Record<string, unknown>
  size: [number, number]
  _timelineEditor?: { destroy?: () => void; commitChanges?: (force?: boolean) => void }
  onNodeCreated?: () => void
  onRemoved?: () => void
  onWidgetChanged?: (
    name: string,
    value: unknown,
    oldValue: unknown,
    widget: StandaloneWidget,
  ) => void
  addWidget: (
    type: string,
    name: string,
    value: unknown,
    callback?: (value: unknown) => void,
    options?: Record<string, unknown>,
  ) => StandaloneWidget
  addDOMWidget: (
    name: string,
    type: string,
    element: HTMLElement,
    options?: Record<string, unknown>,
  ) => StandaloneWidget
  addInput: (name: string, type: string) => StandaloneInput
  removeInput: (index: number) => void
  computeSize: () => [number, number]
  setDirtyCanvas: () => void
}

interface DirectorExtension {
  name: string
  beforeRegisterNodeDef: (
    nodeType: { new (...args: never[]): DirectorNode; prototype: DirectorNode },
    nodeData: { name: string },
    app: DirectorApp,
  ) => Promise<void> | void
}

interface DirectorApp {
  canvasEl: HTMLCanvasElement
  canvas: {
    canvas: HTMLCanvasElement
    ds: { scale: number }
    checkState: () => void
    captureCanvasState: () => void
  }
  graph: {
    links: Record<string, unknown>
    getNodeById: () => null
    setDirtyCanvas: () => void
    change: () => void
    onNodeChanged: () => void
    onStateChanged: () => void
  }
  registerExtension: (extension: DirectorExtension) => void
}

interface DirectorAdapter {
  projectId: string
  mediaByKey: Map<string, DirectorMedia>
  chunks: Map<string, Blob[]>
}

interface DirectorBridge {
  app: DirectorApp
  extension?: DirectorExtension
  scriptPromise?: Promise<void>
  adapter?: DirectorAdapter
}

type DirectorWindow = Window & typeof globalThis & {
  comfyAPI?: {
    app: { app: DirectorApp }
    api: {
      api: {
        apiURL: (path: string) => string
        fetchApi: (path: string, init?: RequestInit) => Promise<Response>
      }
    }
  }
  app?: DirectorApp
  __waooLtxDirectorBridge?: DirectorBridge
}

const WIDGET_DEFAULTS: Array<[string, unknown, string]> = [
  ['start_second', 0, 'number'],
  ['end_second', 5, 'number'],
  ['duration_seconds', 5, 'number'],
  ['start_frame', 0, 'number'],
  ['end_frame', 120, 'number'],
  ['duration_frames', 120, 'number'],
  ['timeline_data', '{}', 'string'],
  ['use_custom_audio', false, 'toggle'],
  ['use_custom_motion', true, 'toggle'],
  ['inpaint_audio', true, 'toggle'],
  ['local_prompts', '', 'string'],
  ['segment_lengths', '', 'string'],
  ['epsilon', 0.001, 'number'],
  ['frame_rate', 24, 'number'],
  ['display_mode', 'seconds', 'combo'],
  ['guide_strength', '', 'string'],
  ['custom_width', 1280, 'number'],
  ['custom_height', 720, 'number'],
  ['resize_method', 'maintain aspect ratio', 'combo'],
  ['divisible_by', 32, 'number'],
  ['img_compression', 18, 'number'],
  ['override_audio', false, 'toggle'],
  ['global_prompt', '', 'string'],
]

function safeFilename(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-120) || 'media'
}

function mediaKey(media: DirectorMedia, prefix = 'media') {
  return `waoowaoo/${prefix}-${media.mediaId || crypto.randomUUID()}-${safeFilename(media.filename)}`
}

function registerMedia(adapter: DirectorAdapter, media: DirectorMedia, prefix?: string) {
  const key = mediaKey(media, prefix)
  const basename = key.split('/').pop() || key
  adapter.mediaByKey.set(key, media)
  adapter.mediaByKey.set(basename, media)
  return key
}

function lookupMedia(adapter: DirectorAdapter | undefined, key: string) {
  if (!adapter) return undefined
  const decoded = decodeURIComponent(key).replace(/^\/+/, '')
  return adapter.mediaByKey.get(decoded)
    || adapter.mediaByKey.get(decoded.split('/').pop() || decoded)
}

function viewKey(path: string) {
  const parsed = new URL(path, window.location.origin)
  const filename = parsed.searchParams.get('filename') || ''
  const subfolder = parsed.searchParams.get('subfolder') || ''
  return [subfolder, filename].filter(Boolean).join('/')
}

async function uploadDirectorMedia(adapter: DirectorAdapter, file: File) {
  const formData = new FormData()
  formData.set('file', file)
  const response = await apiFetch(`/api/novel-promotion/${adapter.projectId}/storyboard-director/upload`, {
    method: 'POST',
    body: formData,
  })
  await checkApiResponse(response)
  const uploaded = await response.json() as {
    mediaId: string
    mediaUrl: string
    imageUrl?: string
    mimeType: string
    filename: string
  }
  const media: DirectorMedia = {
    mediaId: uploaded.mediaId,
    url: uploaded.imageUrl || uploaded.mediaUrl,
    filename: uploaded.filename || file.name,
    mimeType: uploaded.mimeType,
  }
  const key = registerMedia(adapter, media, 'upload')
  return { key, media }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function bridgeFetch(path: string, init?: RequestInit) {
  const bridge = (window as DirectorWindow).__waooLtxDirectorBridge
  const adapter = bridge?.adapter
  if (!adapter) return jsonResponse({ error: 'Director adapter unavailable' }, 503)

  if (path.startsWith('/upload/image')) {
    const formData = init?.body instanceof FormData ? init.body : null
    const file = formData?.get('image')
    if (!(file instanceof File)) return jsonResponse({ error: 'Missing media file' }, 400)
    const uploaded = await uploadDirectorMedia(adapter, file)
    const [name] = uploaded.key.split('/').reverse()
    return jsonResponse({ name, subfolder: 'waoowaoo', type: 'input' })
  }

  if (path.startsWith('/ltx_director_check_file')) {
    return jsonResponse({ exists: false })
  }

  if (path.startsWith('/ltx_director_upload_chunk')) {
    const formData = init?.body instanceof FormData ? init.body : null
    const chunk = formData?.get('file')
    const filename = String(formData?.get('filename') || '')
    const chunkIndex = Number(formData?.get('chunk_index'))
    const totalChunks = Number(formData?.get('total_chunks'))
    if (!(chunk instanceof Blob) || !filename || !Number.isFinite(chunkIndex) || !Number.isFinite(totalChunks)) {
      return jsonResponse({ error: 'Invalid upload chunk' }, 400)
    }
    const chunks = adapter.chunks.get(filename) || []
    chunks[chunkIndex] = chunk
    adapter.chunks.set(filename, chunks)
    if (chunks.filter(Boolean).length === totalChunks) {
      const file = new File(chunks, filename, { type: chunk.type || 'video/mp4' })
      const uploaded = await uploadDirectorMedia(adapter, file)
      adapter.mediaByKey.set(filename, uploaded.media)
      adapter.chunks.delete(filename)
    }
    return jsonResponse({ success: true })
  }

  if (path.startsWith('/ltx_director_get_audio')) {
    const filename = new URL(path, window.location.origin).searchParams.get('filename') || ''
    const media = lookupMedia(adapter, filename)
    if (!media) return jsonResponse({ error: 'Audio not found' }, 404)
    return fetch(media.url)
  }

  if (path.startsWith('/ltx_director_open_folder')) {
    return jsonResponse({
      success: false,
      error: 'Server folders cannot be opened from the waoowaoo web client.',
    })
  }

  return jsonResponse({ error: `Unsupported LTX Director endpoint: ${path}` }, 404)
}

function bridgeApiUrl(path: string) {
  const adapter = (window as DirectorWindow).__waooLtxDirectorBridge?.adapter
  if (!path.startsWith('/view')) return path
  const key = viewKey(path)
  return lookupMedia(adapter, key)?.url || key
}

function getBridge() {
  const directorWindow = window as DirectorWindow
  if (directorWindow.__waooLtxDirectorBridge) return directorWindow.__waooLtxDirectorBridge
  const canvasEl = document.createElement('canvas')
  const app: DirectorApp = {
    canvasEl,
    canvas: {
      canvas: canvasEl,
      ds: { scale: 1 },
      checkState: () => undefined,
      captureCanvasState: () => undefined,
    },
    graph: {
      links: {},
      getNodeById: () => null,
      setDirtyCanvas: () => undefined,
      change: () => undefined,
      onNodeChanged: () => undefined,
      onStateChanged: () => undefined,
    },
    registerExtension: (extension) => {
      const bridge = directorWindow.__waooLtxDirectorBridge
      if (bridge) bridge.extension = extension
    },
  }
  const bridge: DirectorBridge = { app }
  directorWindow.__waooLtxDirectorBridge = bridge
  directorWindow.comfyAPI = {
    app: { app },
    api: { api: { apiURL: bridgeApiUrl, fetchApi: bridgeFetch } },
  }
  directorWindow.app = app
  return bridge
}

function loadOriginalDirector() {
  const bridge = getBridge()
  if (bridge.extension) return Promise.resolve()
  if (bridge.scriptPromise) return bridge.scriptPromise
  bridge.scriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${ORIGINAL_SCRIPT_SRC}"]`)
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true })
      existing.addEventListener('error', () => reject(new Error('LTX Director script failed to load')), { once: true })
      return
    }
    const script = document.createElement('script')
    script.src = ORIGINAL_SCRIPT_SRC
    script.async = true
    script.dataset.waooLtxDirector = 'true'
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('LTX Director script failed to load'))
    document.head.appendChild(script)
  })
  return bridge.scriptPromise
}

function presetFromDimensions(width: number, height: number): LtxDirectorResolutionPreset {
  const edge = Math.min(width, height)
  if (edge >= 900) return '1080p'
  if (edge >= 600) return '720p'
  return '480p'
}

function enrichTimelineMedia(
  timeline: Record<string, unknown>,
  adapter: DirectorAdapter,
) {
  const enrich = (value: unknown, fields: string[]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    const segment = value as Record<string, unknown>
    const candidate = fields
      .map((field) => segment[field])
      .find((item): item is string => typeof item === 'string' && item.length > 0)
    const media = candidate ? lookupMedia(adapter, candidate) : undefined
    if (!media) return
    segment.sourceMediaId = segment.sourceMediaId || media.mediaId
    segment.fileName = segment.fileName || media.filename
  }
  for (const segment of Array.isArray(timeline.segments) ? timeline.segments : []) {
    enrich(segment, ['imageFile', 'fileName'])
  }
  for (const segment of Array.isArray(timeline.motionSegments) ? timeline.motionSegments : []) {
    enrich(segment, ['videoFile', 'imageFile', 'fileName'])
  }
  for (const segment of Array.isArray(timeline.audioSegments) ? timeline.audioSegments : []) {
    enrich(segment, ['audioFile', 'fileName'])
  }
  enrich(timeline.retakeVideo, ['imageFile', 'fileName'])
}

function specFromNode(
  node: DirectorNode,
  adapter: DirectorAdapter,
  fallback: LtxDirectorTimelineSpec,
) {
  const widgetValues = Object.fromEntries(node.widgets.map((widget) => [widget.name, widget.value]))
  let timeline: Record<string, unknown>
  try {
    timeline = JSON.parse(String(widgetValues.timeline_data || '{}')) as Record<string, unknown>
  } catch {
    return fallback
  }
  enrichTimelineMedia(timeline, adapter)
  const raw = {
    version: 1,
    settings: widgetValues,
    global_prompt: typeof timeline.global_prompt === 'string' ? timeline.global_prompt : fallback.globalPrompt,
    retake_global_prompt: typeof timeline.retake_global_prompt === 'string'
      ? timeline.retake_global_prompt
      : fallback.retakePrompt || fallback.globalPrompt,
    timeline,
  }
  const parsed = parseLtxDirectorTimelineSpec(raw)
  if (!parsed) return fallback
  const width = Number(widgetValues.custom_width)
  const height = Number(widgetValues.custom_height)
  const validDimensions = Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0
  return {
    ...parsed,
    videoModel: fallback.videoModel,
    aspectRatio: validDimensions
      ? resolveLtxDirectorAspectRatioFromDimensions(width, height, fallback.aspectRatio)
      : fallback.aspectRatio,
    resolutionPreset: validDimensions
      ? presetFromDimensions(width, height)
      : fallback.resolutionPreset,
  }
}

function seedTimeline(
  spec: LtxDirectorTimelineSpec,
  sources: LtxDirectorOriginalSource[],
  adapter: DirectorAdapter,
) {
  const sourceByPanelId = new Map(sources.flatMap((source) => (
    source.panelId ? [[source.panelId, source] as const] : []
  )))
  const sourceByMediaId = new Map(sources.flatMap((source) => (
    source.mediaId ? [[source.mediaId, source] as const] : []
  )))
  const exported = createLtxDirectorTimelineExport(spec)
  const timeline = structuredClone(exported.timeline) as Record<string, unknown>
  const segments = Array.isArray(timeline.segments) ? timeline.segments : []
  for (const value of segments) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const segment = value as Record<string, unknown>
    const panelId = typeof segment.sourcePanelId === 'string' ? segment.sourcePanelId : undefined
    const ownedMediaId = typeof segment.sourceMediaId === 'string' ? segment.sourceMediaId : undefined
    const source = (panelId ? sourceByPanelId.get(panelId) : undefined)
      || (ownedMediaId ? sourceByMediaId.get(ownedMediaId) : undefined)
    const directUrl = typeof segment.imageFile === 'string' ? segment.imageFile : ''
    if (!source && !directUrl) continue
    const media: DirectorMedia = source || {
      mediaId: ownedMediaId,
      url: directUrl,
      filename: typeof segment.fileName === 'string' && segment.fileName
        ? segment.fileName
        : `${segment.id || 'segment'}.webp`,
    }
    const key = registerMedia(adapter, media, panelId ? `panel-${panelId}` : 'saved')
    segment.imageFile = key
    segment.imageB64 = media.url
    segment.fileName = media.filename
  }
  const seedAuxiliary = (items: unknown, field: 'videoFile' | 'audioFile') => {
    if (!Array.isArray(items)) return
    for (const value of items) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const segment = value as Record<string, unknown>
      const ownedMediaId = typeof segment.sourceMediaId === 'string' ? segment.sourceMediaId : undefined
      const directUrl = typeof segment[field] === 'string' ? segment[field] as string : ''
      const source = ownedMediaId ? sourceByMediaId.get(ownedMediaId) : undefined
      if (!source && !directUrl) continue
      const media: DirectorMedia = source || {
        mediaId: ownedMediaId,
        url: directUrl,
        filename: typeof segment.fileName === 'string' && segment.fileName
          ? segment.fileName
          : `${segment.id || 'media'}`,
      }
      segment[field] = registerMedia(adapter, media, field === 'audioFile' ? 'audio' : 'motion')
      segment.fileName = media.filename
    }
  }
  seedAuxiliary(timeline.motionSegments, 'videoFile')
  seedAuxiliary(timeline.audioSegments, 'audioFile')
  return JSON.stringify(timeline)
}

function initialWidgetValue(
  name: string,
  defaultValue: unknown,
  spec: LtxDirectorTimelineSpec,
  timelineData: string,
) {
  const dimensions = resolveLtxDirectorDimensions(spec.resolutionPreset, spec.aspectRatio)
  const durationSeconds = Math.max(
    1 / spec.fps,
    ...spec.segments.map((segment) => (segment.startSeconds || 0) + segment.durationSeconds),
  )
  const startSeconds = spec.rangeStartSeconds || 0
  const endSeconds = spec.rangeEndSeconds || durationSeconds
  const values: Record<string, unknown> = {
    start_second: startSeconds,
    end_second: endSeconds,
    duration_seconds: Math.max(1 / spec.fps, endSeconds - startSeconds),
    start_frame: Math.round(startSeconds * spec.fps),
    end_frame: Math.round(endSeconds * spec.fps),
    duration_frames: Math.max(1, Math.round((endSeconds - startSeconds) * spec.fps)),
    timeline_data: timelineData,
    use_custom_audio: spec.useCustomAudio === true,
    use_custom_motion: spec.useCustomMotion !== false,
    inpaint_audio: spec.inpaintAudio !== false,
    epsilon: spec.epsilon ?? 0.001,
    frame_rate: spec.fps,
    display_mode: spec.displayMode || 'seconds',
    custom_width: dimensions.width,
    custom_height: dimensions.height,
    resize_method: spec.resizeMethod || 'maintain aspect ratio',
    divisible_by: spec.divisibleBy ?? 32,
    img_compression: spec.imageCompression ?? 18,
    override_audio: spec.overrideAudio === true,
    global_prompt: spec.globalPrompt,
  }
  return values[name] ?? defaultValue
}

export default function LtxDirectorOriginalHost({
  projectId,
  spec,
  sources,
  onChange,
  onReady,
  onError,
}: {
  projectId: string
  spec: LtxDirectorTimelineSpec
  sources: LtxDirectorOriginalSource[]
  onChange: (spec: LtxDirectorTimelineSpec) => void
  onReady?: () => void
  onError?: (error: Error) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const nodeRef = useRef<DirectorNode | null>(null)
  const specRef = useRef(spec)
  const onChangeRef = useRef(onChange)
  const onReadyRef = useRef(onReady)
  const onErrorRef = useRef(onError)
  const sourcesRef = useRef(sources)
  const suppressChangesRef = useRef(true)
  const changeTimerRef = useRef<number | null>(null)

  specRef.current = spec
  onChangeRef.current = onChange
  onReadyRef.current = onReady
  onErrorRef.current = onError
  sourcesRef.current = sources

  useEffect(() => {
    let canceled = false
    const host = hostRef.current
    if (!host) return
    const mountHost = host
    const adapter: DirectorAdapter = {
      projectId,
      mediaByKey: new Map(),
      chunks: new Map(),
    }
    const bridge = getBridge()
    bridge.adapter = adapter
    const timelineData = seedTimeline(specRef.current, sourcesRef.current, adapter)

    void loadOriginalDirector().then(async () => {
      if (canceled) return
      const extension = getBridge().extension
      if (!extension) throw new Error('LTX Director extension registration was not captured')

      class StandaloneDirectorNode implements DirectorNode {
        widgets: StandaloneWidget[] = []
        inputs: StandaloneInput[] = []
        properties: Record<string, unknown> = {}
        size: [number, number] = [1375, 760]
        _timelineEditor?: DirectorNode['_timelineEditor']
        onNodeCreated?: () => void
        onRemoved?: () => void

        constructor() {
          for (const [name, defaultValue, type] of WIDGET_DEFAULTS) {
            this.addWidget(type, name, initialWidgetValue(name, defaultValue, specRef.current, timelineData))
          }
        }

        addWidget(
          type: string,
          name: string,
          value: unknown,
          callback?: (value: unknown) => void,
          options?: Record<string, unknown>,
        ) {
          const widget: StandaloneWidget = { type, name, value, callback, options: options || {} }
          this.widgets.push(widget)
          return widget
        }

        addDOMWidget(
          name: string,
          type: string,
          element: HTMLElement,
          options?: Record<string, unknown>,
        ) {
          mountHost.replaceChildren(element)
          const widget: StandaloneWidget = { name, type, value: '', options: options || {}, element }
          this.widgets.push(widget)
          return widget
        }

        addInput(name: string, type: string) {
          const input: StandaloneInput = { name, type, link: null }
          this.inputs.push(input)
          return input
        }

        removeInput(index: number) {
          this.inputs.splice(index, 1)
        }

        computeSize(): [number, number] {
          return [this.size[0], this.size[1]]
        }

        setDirtyCanvas() {
          return undefined
        }

        onWidgetChanged() {
          if (suppressChangesRef.current) return
          if (changeTimerRef.current !== null) window.clearTimeout(changeTimerRef.current)
          changeTimerRef.current = window.setTimeout(() => {
            const next = specFromNode(this, adapter, specRef.current)
            specRef.current = next
            onChangeRef.current(next)
          }, 60)
        }
      }

      await extension.beforeRegisterNodeDef(
        StandaloneDirectorNode,
        { name: 'LTXDirector' },
        bridge.app,
      )
      if (canceled) return
      const node = new StandaloneDirectorNode()
      nodeRef.current = node
      node.onNodeCreated?.()
      window.setTimeout(() => {
        if (canceled) return
        suppressChangesRef.current = false
        const next = specFromNode(node, adapter, specRef.current)
        specRef.current = next
        onChangeRef.current(next)
        onReadyRef.current?.()
      }, 250)
    }).catch((reason: unknown) => {
      const error = reason instanceof Error ? reason : new Error(String(reason))
      onErrorRef.current?.(error)
    })

    return () => {
      canceled = true
      if (changeTimerRef.current !== null) window.clearTimeout(changeTimerRef.current)
      nodeRef.current?.onRemoved?.()
      nodeRef.current = null
      mountHost.replaceChildren()
      if (bridge.adapter === adapter) bridge.adapter = undefined
    }
  }, [projectId])

  useEffect(() => {
    const node = nodeRef.current
    if (!node) return
    const dimensions = resolveLtxDirectorDimensions(spec.resolutionPreset, spec.aspectRatio)
    const updates: Record<string, unknown> = {
      custom_width: dimensions.width,
      custom_height: dimensions.height,
    }
    for (const [name, value] of Object.entries(updates)) {
      const widget = node.widgets.find((candidate) => candidate.name === name)
      if (!widget || widget.value === value) continue
      widget.value = value
      widget.callback?.(value)
    }
  }, [spec.aspectRatio, spec.resolutionPreset])

  return (
    <div className="overflow-x-auto rounded-xl border border-white/10 bg-[#111318] p-2">
      <div ref={hostRef} className="min-h-[660px] min-w-[1080px]" />
    </div>
  )
}
