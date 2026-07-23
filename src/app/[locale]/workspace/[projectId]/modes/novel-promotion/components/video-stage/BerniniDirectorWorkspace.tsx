'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import Image from 'next/image'

import type { Clip, Panel, Storyboard, VideoModelOption } from '../video/types'
import {
  BERNINI_DIRECTOR_SPEC_VERSION,
  BERNINI_DIRECTOR_TASK_TYPES,
  parseBerniniDirectorSpec,
  type BerniniDirectorSegmentSpec,
  type BerniniDirectorSpec,
  type BerniniDirectorTaskType,
} from '@/lib/comfyui/bernini-director'

interface Props {
  projectId: string
  episodeId: string
  storyboards: Storyboard[]
  clips: Clip[]
  videoModels: VideoModelOption[]
  videoRatio: string
}

interface UploadedMedia {
  mediaId: string
  mediaUrl: string
  filename: string
  mimeType: string
  width?: number
  height?: number
}

const SOURCE_VIDEO_TASKS = new Set<BerniniDirectorTaskType>([
  'default', 'v2v', 'vi2v', 'rv2v', 'ads2v', 'vrc2v', 'mv2v',
])
const SOURCE_IMAGE_TASKS = new Set<BerniniDirectorTaskType>(['i2i', 'i2v'])
const REFERENCE_IMAGE_TASKS = new Set<BerniniDirectorTaskType>(['r2i', 'r2v', 'rv2v', 'vrc2v'])

function round16(value: number) {
  return Math.max(16, Math.round(value / 16) * 16)
}

function dimensions(preset: '480p' | '720p' | '1080p', ratio: string) {
  const long = preset === '480p' ? 848 : preset === '720p' ? 1280 : 1920
  const portrait = ratio === '9:16'
  const square = ratio === '1:1'
  if (square) return { width: long, height: long }
  const short = round16(long * 9 / 16)
  return portrait ? { width: short, height: long } : { width: long, height: short }
}

function durationForPanel(panel: Panel) {
  return panel.durationOverride || panel.estimatedDuration || panel.duration || 3
}

function defaultSpec(storyboard: Storyboard, videoRatio: string): BerniniDirectorSpec {
  const fps = 24
  let cursor = 0
  const segments = (storyboard.panels || []).filter((panel) => panel.id).slice(0, 8).map((panel, index) => {
    const frameCount = Math.max(4, Math.round(durationForPanel(panel) * fps))
    const segment: BerniniDirectorSegmentSpec = {
      id: `panel-${panel.id || index}`,
      startFrame: cursor,
      frameCount,
      prompt: panel.videoPrompt || panel.description || panel.imagePrompt || '',
      ...(panel.id ? { sourcePanelId: panel.id } : {}),
    }
    cursor += frameCount
    return segment
  })
  const size = dimensions('720p', videoRatio)
  return {
    kind: 'bernini-director',
    version: BERNINI_DIRECTOR_SPEC_VERSION,
    taskType: 'r2v',
    timelineMode: 'prompt_batch',
    editMode: 'segment',
    globalPrompt: storyboard.continuityAnchor || storyboard.clip?.summary || '',
    negativePrompt: 'bad video',
    globalReferenceMediaIds: [],
    continuousReference: false,
    frameRate: fps,
    width: size.width,
    height: size.height,
    refMaxSize: Math.max(size.width, size.height),
    outputMode: 'fixed',
    maxExportFrames: 0,
    exportMode: 'all',
    continuityEnabled: false,
    continuityOverlapFrames: 9,
    runSelectEnabled: false,
    runSelection: [],
    steps: 6,
    splitStep: 3,
    sampler: 'euler',
    scheduler: 'simple',
    highNoiseCfg: 1,
    highNoiseSeed: 0,
    lowNoiseCfg: 1,
    lowNoiseSeed: 0,
    clearVramBetweenSegments: true,
    exportSourceImages: false,
    llmAutoEnhance: false,
    llmApiFormat: 'Ollama',
    llmOpenaiCompatMode: '标准',
    llmUrl: 'http://127.0.0.1:11434/v1',
    llmApiKey: '',
    llmModel: 'qwen3.5',
    llmOutputLanguage: '中文',
    llmCharacterFeatureEnhance: false,
    llmUnloadAfter: false,
    llmCustomTemplate: '',
    segments: segments.length ? segments : [{
      id: 'segment-1', startFrame: 0, frameCount: 81, prompt: '',
    }],
  }
}

function taskLabel(key: BerniniDirectorTaskType, t: ReturnType<typeof useTranslations>) {
  return t(`berniniDirector.tasks.${key}` as never)
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="space-y-1 text-xs text-[var(--glass-text-secondary)]">
      <span>{label}</span>
      {children}
    </label>
  )
}

const inputClass = 'glass-input w-full rounded-lg px-3 py-2 text-sm'
const buttonClass = 'glass-btn-base glass-btn-secondary rounded-lg px-3 py-2 text-sm'

export default function BerniniDirectorWorkspace({
  projectId,
  storyboards,
  videoModels,
  videoRatio,
}: Props) {
  const t = useTranslations('video')
  const models = useMemo(
    () => videoModels.filter((model) => model.workflowFeatures?.berniniDirector === true),
    [videoModels],
  )
  const [storyboardId, setStoryboardId] = useState(storyboards[0]?.id || '')
  const storyboard = storyboards.find((item) => item.id === storyboardId) || storyboards[0]
  const [spec, setSpec] = useState<BerniniDirectorSpec | null>(null)
  const [model, setModel] = useState('')
  const [media, setMedia] = useState<Record<string, UploadedMedia>>({})
  const [preset, setPreset] = useState<'480p' | '720p' | '1080p'>('720p')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [enhancerOpen, setEnhancerOpen] = useState(false)
  const [busy, setBusy] = useState<'save' | 'run' | 'upload' | null>(null)
  const [message, setMessage] = useState('')
  const initializedId = useRef('')

  useEffect(() => {
    if (!storyboard || initializedId.current === storyboard.id) return
    initializedId.current = storyboard.id
    const saved = parseBerniniDirectorSpec(storyboard.directorConfigJson)
    const next = saved || defaultSpec(storyboard, videoRatio)
    setSpec(next)
    setModel(next.videoModel && models.some((item) => item.value === next.videoModel)
      ? next.videoModel
      : models[0]?.value || '')
    setMessage('')
  }, [models, storyboard, videoRatio])

  if (!storyboard || !spec) {
    return <div className="glass-surface p-6 text-sm">{t('berniniDirector.noStoryboard')}</div>
  }
  const currentSpec = spec

  const patch = (next: Partial<BerniniDirectorSpec>) => setSpec((current) => current && ({ ...current, ...next }))
  const patchSegment = (index: number, next: Partial<BerniniDirectorSegmentSpec>) => patch({
    segments: spec.segments.map((segment, current) => current === index ? { ...segment, ...next } : segment),
  })
  const totalFrames = spec.segments.reduce((latest, segment) => (
    Math.max(latest, segment.startFrame + segment.frameCount)
  ), 1)

  async function upload(file: File): Promise<UploadedMedia> {
    setBusy('upload')
    try {
      const data = new FormData()
      data.append('file', file)
      const response = await fetch(`/api/novel-promotion/${projectId}/storyboard-director/upload`, {
        method: 'POST', body: data,
      })
      const payload = await response.json().catch(() => null) as Record<string, unknown> | null
      if (!response.ok || typeof payload?.mediaId !== 'string' || typeof payload.mediaUrl !== 'string') {
        throw new Error(typeof payload?.error === 'string' ? payload.error : t('berniniDirector.uploadFailed'))
      }
      const uploaded: UploadedMedia = {
        mediaId: payload.mediaId,
        mediaUrl: payload.mediaUrl,
        filename: typeof payload.filename === 'string' ? payload.filename : file.name,
        mimeType: typeof payload.mimeType === 'string' ? payload.mimeType : file.type,
        ...(typeof payload.width === 'number' ? { width: payload.width } : {}),
        ...(typeof payload.height === 'number' ? { height: payload.height } : {}),
      }
      setMedia((current) => ({ ...current, [uploaded.mediaId]: uploaded }))
      return uploaded
    } finally {
      setBusy(null)
    }
  }

  async function uploadSingle(event: React.ChangeEvent<HTMLInputElement>, callback: (item: UploadedMedia) => void) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      callback(await upload(file))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('berniniDirector.uploadFailed'))
    }
  }

  async function uploadReferences(event: React.ChangeEvent<HTMLInputElement>, current: string[], callback: (ids: string[]) => void) {
    const files = [...(event.target.files || [])].slice(0, 5 - current.length)
    event.target.value = ''
    if (!files.length) return
    try {
      const uploaded: UploadedMedia[] = []
      for (const file of files) uploaded.push(await upload(file))
      callback([...current, ...uploaded.map((item) => item.mediaId)].slice(0, 5))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('berniniDirector.uploadFailed'))
    }
  }

  function addSegment() {
    const last = currentSpec.segments.at(-1)
    const startFrame = last ? last.startFrame + last.frameCount : 0
    patch({
      segments: [...currentSpec.segments, {
        id: `segment-${Date.now()}`, startFrame, frameCount: 81, prompt: '',
      }].slice(0, 8),
    })
  }

  function equalSplit(count: number) {
    const frames = Math.max(4, Math.floor(totalFrames / count))
    patch({
      segments: Array.from({ length: count }, (_, index) => ({
        ...(currentSpec.segments[index] || {}),
        id: currentSpec.segments[index]?.id || `segment-${Date.now()}-${index}`,
        startFrame: index * frames,
        frameCount: index === count - 1 ? Math.max(4, totalFrames - index * frames) : frames,
        prompt: currentSpec.segments[index]?.prompt || '',
      })),
    })
  }

  function compactSegments(next = currentSpec.segments) {
    let cursor = 0
    return next.map((segment) => {
      const positioned = { ...segment, startFrame: cursor }
      cursor += segment.frameCount
      return positioned
    })
  }

  async function submit(kind: 'save' | 'run') {
    if (!model) {
      setMessage(t('berniniDirector.modelRequired'))
      return
    }
    setBusy(kind)
    setMessage('')
    try {
      const response = await fetch(`/api/novel-promotion/${projectId}/bernini-director`, {
        method: kind === 'save' ? 'PUT' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          storyboardId: storyboard.id,
          videoModel: model,
          directorSpec: { ...spec, videoModel: model },
        }),
      })
      const payload = await response.json().catch(() => null) as Record<string, unknown> | null
      if (!response.ok) {
        const detail = payload?.details && typeof payload.details === 'object'
          ? (payload.details as Record<string, unknown>).code
          : null
        throw new Error(typeof detail === 'string' ? detail
          : typeof payload?.error === 'string' ? payload.error : t('berniniDirector.requestFailed'))
      }
      setMessage(kind === 'save' ? t('berniniDirector.saved') : t('berniniDirector.submitted'))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('berniniDirector.requestFailed'))
    } finally {
      setBusy(null)
    }
  }

  const globalRefs = spec.globalReferenceMediaIds
  return (
    <div className="space-y-4">
      <section className="glass-surface space-y-4 rounded-xl p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <h2 className="font-semibold text-[var(--glass-text-primary)]">{t('berniniDirector.title')}</h2>
            <p className="text-xs text-[var(--glass-text-tertiary)]">{t('berniniDirector.description')}</p>
          </div>
          <select className={`${inputClass} ml-auto w-auto`} value={storyboard.id} onChange={(event) => setStoryboardId(event.target.value)}>
            {storyboards.map((item, index) => <option key={item.id} value={item.id}>{t('berniniDirector.group', { index: index + 1 })}</option>)}
          </select>
          <select className={`${inputClass} w-auto min-w-52`} value={model} onChange={(event) => setModel(event.target.value)}>
            <option value="">{t('berniniDirector.selectModel')}</option>
            {models.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </div>
        {models.length === 0 && <p className="rounded-lg bg-amber-500/10 p-3 text-sm text-amber-300">{t('berniniDirector.noModel')}</p>}
        <div className="grid gap-3 md:grid-cols-4">
          <Field label={t('berniniDirector.taskType')}>
            <select className={inputClass} value={spec.taskType} onChange={(event) => {
              const next = event.target.value as BerniniDirectorTaskType
              const imageMode = ['t2i', 'i2i', 'r2i'].includes(next)
              let cursor = 0
              const segments = spec.segments.map((segment) => {
                const frameCount = imageMode ? 1 : Math.max(4, segment.frameCount)
                const normalized = { ...segment, startFrame: cursor, frameCount }
                cursor += frameCount
                return normalized
              })
              patch({
                taskType: next,
                timelineMode: ['default', 'v2v', 'vi2v', 'rv2v', 'ads2v', 'vrc2v', 'mv2v'].includes(next)
                  ? 'video' : 'prompt_batch',
                editMode: next === 'v2v' ? 'global' : spec.editMode,
                segments,
              })
            }}>
              {BERNINI_DIRECTOR_TASK_TYPES.map((key) => <option key={key} value={key}>{key} · {taskLabel(key, t)}</option>)}
            </select>
          </Field>
          <Field label={t('berniniDirector.editMode')}>
            <select className={inputClass} value={spec.editMode} onChange={(event) => patch({ editMode: event.target.value as BerniniDirectorSpec['editMode'] })}>
              <option value="global">{t('berniniDirector.globalMode')}</option>
              <option value="segment">{t('berniniDirector.segmentMode')}</option>
            </select>
          </Field>
          <Field label={t('berniniDirector.fps')}><input className={inputClass} type="number" min={1} max={240} step="0.01" value={spec.frameRate} onChange={(event) => patch({ frameRate: Number(event.target.value) || 24 })} /></Field>
          <Field label={t('berniniDirector.resolution')}>
            <div className="flex gap-1">{(['480p', '720p', '1080p'] as const).map((value) => <button type="button" key={value} className={`${buttonClass} flex-1 ${preset === value ? 'glass-btn-primary' : ''}`} onClick={() => {
              setPreset(value)
              const size = dimensions(value, videoRatio)
              patch({ width: size.width, height: size.height, refMaxSize: Math.max(size.width, size.height) })
            }}>{value}</button>)}</div>
          </Field>
        </div>
        <Field label={t('berniniDirector.globalPrompt')}><textarea className={`${inputClass} min-h-24`} value={spec.globalPrompt} onChange={(event) => patch({ globalPrompt: event.target.value })} /></Field>
        <Field label={t('berniniDirector.negativePrompt')}><textarea className={`${inputClass} min-h-16`} value={spec.negativePrompt} onChange={(event) => patch({ negativePrompt: event.target.value })} /></Field>
      </section>

      <section className="glass-surface grid gap-4 rounded-xl p-4 lg:grid-cols-3">
        <div className="space-y-2">
          <h3 className="text-sm font-medium">{t('berniniDirector.sourceVideo')}</h3>
          <label className={`${buttonClass} inline-block cursor-pointer`}><input className="hidden" type="file" accept="video/*" onChange={(event) => uploadSingle(event, (item) => patch({ sourceVideoMediaId: item.mediaId }))} />{spec.sourceVideoMediaId ? t('berniniDirector.replace') : t('berniniDirector.uploadVideo')}</label>
          <p className="truncate text-xs text-[var(--glass-text-tertiary)]">{media[spec.sourceVideoMediaId || '']?.filename || spec.sourceVideoMediaId || t('berniniDirector.notSelected')}</p>
          {SOURCE_VIDEO_TASKS.has(spec.taskType) && !spec.sourceVideoMediaId && <p className="text-xs text-amber-300">{t('berniniDirector.sourceVideoHint')}</p>}
        </div>
        <div className="space-y-2">
          <h3 className="text-sm font-medium">{t('berniniDirector.globalReferences')}</h3>
          <div className="flex flex-wrap gap-2">{globalRefs.map((id, index) => <div key={id} className="relative h-16 w-16 overflow-hidden rounded-lg bg-black/20">
            {media[id]?.mediaUrl ? <Image unoptimized width={64} height={64} src={media[id].mediaUrl} alt={`image${index}`} className="h-full w-full object-cover" /> : <span className="p-1 text-[10px]">image{index}</span>}
            <button type="button" className="absolute right-0 top-0 bg-black/70 px-1 text-xs" onClick={() => patch({ globalReferenceMediaIds: globalRefs.filter((item) => item !== id) })}>×</button>
          </div>)}</div>
          <label className={`${buttonClass} inline-block cursor-pointer`}><input className="hidden" type="file" accept="image/*" multiple onChange={(event) => uploadReferences(event, globalRefs, (ids) => patch({ globalReferenceMediaIds: ids }))} />{t('berniniDirector.addReferences', { count: globalRefs.length })}</label>
          {REFERENCE_IMAGE_TASKS.has(spec.taskType) && globalRefs.length === 0 && <p className="text-xs text-amber-300">{t('berniniDirector.referenceHint')}</p>}
        </div>
        <div className="space-y-2">
          <h3 className="text-sm font-medium">{t('berniniDirector.referenceVideo')}</h3>
          <label className={`${buttonClass} inline-block cursor-pointer`}><input className="hidden" type="file" accept="video/*" onChange={(event) => uploadSingle(event, (item) => patch({ globalReferenceVideoMediaId: item.mediaId }))} />{spec.globalReferenceVideoMediaId ? t('berniniDirector.replace') : t('berniniDirector.uploadVideo')}</label>
          <p className="truncate text-xs text-[var(--glass-text-tertiary)]">{media[spec.globalReferenceVideoMediaId || '']?.filename || spec.globalReferenceVideoMediaId || t('berniniDirector.notSelected')}</p>
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={spec.continuousReference} onChange={(event) => patch({ continuousReference: event.target.checked })} />{t('berniniDirector.continuousReference')}</label>
        </div>
      </section>

      <section className="glass-surface space-y-3 rounded-xl p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-medium">{t('berniniDirector.timeline')}</h3>
          <span className="text-xs text-[var(--glass-text-tertiary)]">{totalFrames}f · {(totalFrames / spec.frameRate).toFixed(2)}s</span>
          <button type="button" className={`${buttonClass} ml-auto`} onClick={addSegment} disabled={spec.segments.length >= 8}>{t('berniniDirector.addSegment')}</button>
          {[2, 4, 6, 8].map((count) => <button type="button" key={count} className={buttonClass} onClick={() => equalSplit(count)}>{t('berniniDirector.equalSplit', { count })}</button>)}
          <button type="button" className={buttonClass} onClick={() => patch({ segments: compactSegments() })}>{t('berniniDirector.compact')}</button>
        </div>
        <div className="relative h-16 overflow-hidden rounded-lg bg-black/20">
          {spec.segments.map((segment, index) => {
            const left = segment.startFrame / totalFrames * 100
            const width = segment.frameCount / totalFrames * 100
            return <button type="button" key={segment.id} className="absolute top-2 h-12 overflow-hidden border border-white/20 bg-cyan-500/20 px-1 text-left text-[10px]" style={{ left: `${left}%`, width: `${Math.max(width, 2)}%` }} onClick={() => document.getElementById(`bernini-segment-${index}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>#{index + 1}<br />{(segment.frameCount / spec.frameRate).toFixed(1)}s</button>
          })}
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={spec.runSelectEnabled} onChange={(event) => patch({ runSelectEnabled: event.target.checked, runSelection: event.target.checked ? spec.segments.map((_, index) => index) : [] })} />{t('berniniDirector.selectRun')}</label>
        <div className="space-y-3">{spec.segments.map((segment, index) => {
          const refs = segment.referenceMediaIds || []
          const panel = storyboard.panels?.find((item) => item.id === segment.sourcePanelId)
          return <article id={`bernini-segment-${index}`} key={segment.id} className="glass-surface-soft space-y-3 rounded-xl p-3">
            <div className="flex flex-wrap items-center gap-2">
              {spec.runSelectEnabled && <input type="checkbox" checked={spec.runSelection.includes(index)} onChange={(event) => patch({ runSelection: event.target.checked ? [...new Set([...spec.runSelection, index])].sort() : spec.runSelection.filter((item) => item !== index) })} />}
              <strong className="text-sm">{t('berniniDirector.segment', { index: index + 1 })}</strong>
              <input className={`${inputClass} w-24`} type="number" min={0} value={segment.startFrame} onChange={(event) => patchSegment(index, { startFrame: Number(event.target.value) || 0 })} title={t('berniniDirector.startFrame')} />
              <input className={`${inputClass} w-24`} type="number" min={1} max={8192} value={segment.frameCount} onChange={(event) => patchSegment(index, { frameCount: Number(event.target.value) || 1 })} title={t('berniniDirector.frameCount')} />
              <select className={`${inputClass} w-auto`} value={segment.taskType || ''} onChange={(event) => patchSegment(index, { taskType: event.target.value ? event.target.value as BerniniDirectorTaskType : undefined })}>
                <option value="">{t('berniniDirector.inheritTask')}</option>
                {BERNINI_DIRECTOR_TASK_TYPES.map((key) => <option key={key} value={key}>{key}</option>)}
              </select>
              <button type="button" className={`${buttonClass} ml-auto`} disabled={spec.segments.length === 1} onClick={() => patch({ segments: compactSegments(spec.segments.filter((_, current) => current !== index)) })}>{t('berniniDirector.remove')}</button>
            </div>
            <div className="grid gap-3 lg:grid-cols-[160px_1fr]">
              <div className="space-y-2">
                <select className={inputClass} value={segment.sourcePanelId || ''} onChange={(event) => patchSegment(index, { sourcePanelId: event.target.value || undefined, sourceMediaId: undefined })}>
                  <option value="">{t('berniniDirector.noPanelSource')}</option>
                  {(storyboard.panels || []).filter((item) => item.id && item.imageUrl).map((item) => <option key={item.id} value={item.id}>{t('berniniDirector.panel', { index: item.panelIndex + 1 })}</option>)}
                </select>
                {panel?.imageUrl && <Image unoptimized width={320} height={180} src={panel.imageUrl} alt="" className="aspect-video w-full rounded-lg object-cover" />}
                <label className={`${buttonClass} inline-block cursor-pointer`}><input className="hidden" type="file" accept="image/*" onChange={(event) => uploadSingle(event, (item) => patchSegment(index, { sourceMediaId: item.mediaId, sourcePanelId: undefined }))} />{t('berniniDirector.uploadSourceImage')}</label>
                {SOURCE_IMAGE_TASKS.has(segment.taskType || spec.taskType) && !segment.sourcePanelId && !segment.sourceMediaId && <p className="text-xs text-amber-300">{t('berniniDirector.sourceImageHint')}</p>}
              </div>
              <div className="space-y-2">
                <textarea className={`${inputClass} min-h-24`} value={segment.prompt} placeholder={t('berniniDirector.segmentPrompt')} onChange={(event) => patchSegment(index, { prompt: event.target.value })} />
                <textarea className={`${inputClass} min-h-12`} value={segment.negativePrompt || ''} placeholder={t('berniniDirector.segmentNegative')} onChange={(event) => patchSegment(index, { negativePrompt: event.target.value })} />
                <div className="flex flex-wrap items-center gap-2">
                  {refs.map((id, refIndex) => <span key={id} className="rounded bg-white/5 px-2 py-1 text-xs">image{refIndex} · {media[id]?.filename || id.slice(0, 8)} <button type="button" onClick={() => patchSegment(index, { referenceMediaIds: refs.filter((item) => item !== id) })}>×</button></span>)}
                  <label className={`${buttonClass} cursor-pointer`}><input className="hidden" type="file" accept="image/*" multiple onChange={(event) => uploadReferences(event, refs, (ids) => patchSegment(index, { referenceMediaIds: ids }))} />{t('berniniDirector.segmentReferences')}</label>
                  <label className={`${buttonClass} cursor-pointer`}><input className="hidden" type="file" accept="video/*" onChange={(event) => uploadSingle(event, (item) => patchSegment(index, { referenceVideoMediaId: item.mediaId }))} />{t('berniniDirector.segmentReferenceVideo')}</label>
                </div>
              </div>
            </div>
          </article>
        })}</div>
      </section>

      <section className="glass-surface space-y-3 rounded-xl p-4">
        <button type="button" className={buttonClass} onClick={() => setAdvancedOpen((value) => !value)}>{t('berniniDirector.samplingAndOutput')}</button>
        <button type="button" className={buttonClass} onClick={() => setEnhancerOpen((value) => !value)}>{t('berniniDirector.promptEnhancer')}</button>
        {advancedOpen && <div className="grid gap-3 md:grid-cols-4">
          <Field label={t('berniniDirector.width')}><input className={inputClass} type="number" step={16} value={spec.width} onChange={(event) => patch({ width: round16(Number(event.target.value)) })} /></Field>
          <Field label={t('berniniDirector.height')}><input className={inputClass} type="number" step={16} value={spec.height} onChange={(event) => patch({ height: round16(Number(event.target.value)) })} /></Field>
          <Field label={t('berniniDirector.refMaxSize')}><input className={inputClass} type="number" step={16} value={spec.refMaxSize} onChange={(event) => patch({ refMaxSize: round16(Number(event.target.value)) })} /></Field>
          <Field label={t('berniniDirector.outputMode')}><select className={inputClass} value={spec.outputMode} onChange={(event) => patch({ outputMode: event.target.value as BerniniDirectorSpec['outputMode'] })}><option value="long_edge">long_edge</option><option value="fixed">fixed</option></select></Field>
          <Field label="Steps"><input className={inputClass} type="number" min={1} max={200} value={spec.steps} onChange={(event) => patch({ steps: Number(event.target.value) })} /></Field>
          <Field label="Split step"><input className={inputClass} type="number" min={1} max={199} value={spec.splitStep} onChange={(event) => patch({ splitStep: Number(event.target.value) })} /></Field>
          <Field label="Sampler"><input className={inputClass} value={spec.sampler} onChange={(event) => patch({ sampler: event.target.value })} /></Field>
          <Field label="Scheduler"><input className={inputClass} value={spec.scheduler} onChange={(event) => patch({ scheduler: event.target.value })} /></Field>
          <Field label="High CFG"><input className={inputClass} type="number" step="0.01" value={spec.highNoiseCfg} onChange={(event) => patch({ highNoiseCfg: Number(event.target.value) })} /></Field>
          <Field label="High seed"><input className={inputClass} type="number" value={spec.highNoiseSeed} onChange={(event) => patch({ highNoiseSeed: Number(event.target.value) })} /></Field>
          <Field label="Low CFG"><input className={inputClass} type="number" step="0.01" value={spec.lowNoiseCfg} onChange={(event) => patch({ lowNoiseCfg: Number(event.target.value) })} /></Field>
          <Field label="Low seed"><input className={inputClass} type="number" value={spec.lowNoiseSeed} onChange={(event) => patch({ lowNoiseSeed: Number(event.target.value) })} /></Field>
          <Field label={t('berniniDirector.exportMode')}><select className={inputClass} value={spec.exportMode} onChange={(event) => patch({ exportMode: event.target.value as BerniniDirectorSpec['exportMode'] })}><option value="all">all</option><option value="segments">segments</option></select></Field>
          <Field label={t('berniniDirector.maxExportFrames')}><input className={inputClass} type="number" min={0} value={spec.maxExportFrames} onChange={(event) => patch({ maxExportFrames: Number(event.target.value) || 0 })} /></Field>
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={spec.continuityEnabled} onChange={(event) => patch({ continuityEnabled: event.target.checked })} />{t('berniniDirector.continuity')}</label>
          <Field label={t('berniniDirector.overlapFrames')}><input className={inputClass} type="number" min={1} max={81} value={spec.continuityOverlapFrames} onChange={(event) => patch({ continuityOverlapFrames: Number(event.target.value) || 9 })} /></Field>
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={spec.clearVramBetweenSegments} onChange={(event) => patch({ clearVramBetweenSegments: event.target.checked })} />{t('berniniDirector.clearVram')}</label>
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={spec.exportSourceImages} onChange={(event) => patch({ exportSourceImages: event.target.checked })} />{t('berniniDirector.exportSource')}</label>
        </div>}
        {enhancerOpen && <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={spec.llmAutoEnhance} onChange={(event) => patch({ llmAutoEnhance: event.target.checked })} />{t('berniniDirector.autoEnhance')}</label>
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="API"><select className={inputClass} value={spec.llmApiFormat} onChange={(event) => patch({ llmApiFormat: event.target.value as BerniniDirectorSpec['llmApiFormat'] })}><option>Ollama</option><option>智谱 GLM</option><option>OpenAI Compatible</option></select></Field>
            <Field label="URL"><input className={inputClass} value={spec.llmUrl} onChange={(event) => patch({ llmUrl: event.target.value })} /></Field>
            <Field label="Model"><input className={inputClass} value={spec.llmModel} onChange={(event) => patch({ llmModel: event.target.value })} /></Field>
            <Field label="API key"><input className={inputClass} type="password" value={spec.llmApiKey} onChange={(event) => patch({ llmApiKey: event.target.value })} /></Field>
            <Field label={t('berniniDirector.language')}><select className={inputClass} value={spec.llmOutputLanguage} onChange={(event) => patch({ llmOutputLanguage: event.target.value as BerniniDirectorSpec['llmOutputLanguage'] })}><option>中文</option><option>English</option></select></Field>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={spec.llmCharacterFeatureEnhance} onChange={(event) => patch({ llmCharacterFeatureEnhance: event.target.checked })} />{t('berniniDirector.characterEnhance')}</label>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={spec.llmUnloadAfter} onChange={(event) => patch({ llmUnloadAfter: event.target.checked })} />{t('berniniDirector.unloadAfter')}</label>
          </div>
          <Field label={t('berniniDirector.customTemplate')}><textarea className={`${inputClass} min-h-24`} value={spec.llmCustomTemplate} onChange={(event) => patch({ llmCustomTemplate: event.target.value })} /></Field>
        </div>}
      </section>

      <div className="glass-surface sticky bottom-3 z-10 flex flex-wrap items-center gap-3 rounded-xl p-3">
        {message && <span className="mr-auto text-sm text-[var(--glass-text-secondary)]">{message}</span>}
        {!message && <span className="mr-auto text-xs text-[var(--glass-text-tertiary)]">{t('berniniDirector.mediaTokenHint')}</span>}
        <button type="button" className={buttonClass} disabled={!!busy} onClick={() => submit('save')}>{busy === 'save' ? t('berniniDirector.saving') : t('berniniDirector.save')}</button>
        <button type="button" className="glass-btn-base glass-btn-primary rounded-lg px-5 py-2 text-sm" disabled={!!busy || !model} onClick={() => submit('run')}>{busy === 'run' ? t('berniniDirector.submitting') : t('berniniDirector.generate')}</button>
      </div>

      {storyboard.directorVideoUrl && <section className="glass-surface space-y-2 rounded-xl p-4"><h3 className="font-medium">{t('berniniDirector.result')}</h3><video className="max-h-[70vh] w-full rounded-lg bg-black" src={storyboard.directorVideoUrl} controls /></section>}
    </div>
  )
}
