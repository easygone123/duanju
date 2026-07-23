'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'

import BerniniDirectorOriginalHost, {
  type BerniniDirectorOriginalSource,
} from './BerniniDirectorOriginalHost'
import type { Clip, Panel, Storyboard, VideoModelOption } from '../video/types'
import {
  BERNINI_DIRECTOR_SPEC_VERSION,
  parseBerniniDirectorSpec,
  type BerniniDirectorSegmentSpec,
  type BerniniDirectorSpec,
} from '@/lib/comfyui/bernini-director'

interface Props {
  projectId: string
  episodeId: string
  storyboards: Storyboard[]
  clips: Clip[]
  videoModels: VideoModelOption[]
  videoRatio: string
}

function round16(value: number) {
  return Math.max(16, Math.round(value / 16) * 16)
}

function dimensions(ratio: string) {
  const long = 1280
  if (ratio === '1:1') return { width: long, height: long }
  const short = round16(long * 9 / 16)
  return ratio === '9:16'
    ? { width: short, height: long }
    : { width: long, height: short }
}

function durationForPanel(panel: Panel) {
  return panel.durationOverride || panel.estimatedDuration || panel.duration || 3
}

function defaultSpec(storyboard: Storyboard, videoRatio: string): BerniniDirectorSpec {
  const frameRate = 24
  let cursor = 0
  const segments = (storyboard.panels || [])
    .filter((panel): panel is Panel & { id: string } => Boolean(panel.id))
    .slice(0, 8)
    .map((panel, index) => {
      const frameCount = Math.max(4, Math.round(durationForPanel(panel) * frameRate))
      const segment: BerniniDirectorSegmentSpec = {
        id: `panel-${panel.id || index}`,
        startFrame: cursor,
        frameCount,
        prompt: panel.videoPrompt || panel.description || panel.imagePrompt || '',
        sourcePanelId: panel.id,
      }
      cursor += frameCount
      return segment
    })
  const size = dimensions(videoRatio)
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
    frameRate,
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
    segments: segments.length
      ? segments
      : [{ id: 'segment-1', startFrame: 0, frameCount: 81, prompt: '' }],
  }
}

function sourceFilename(panel: Panel) {
  const path = panel.imageUrl?.split('?', 1)[0] || ''
  return path.split('/').pop() || `panel-${panel.panelIndex + 1}.webp`
}

export default function BerniniDirectorWorkspace({
  projectId,
  storyboards,
  videoModels,
  videoRatio,
}: Props) {
  const t = useTranslations('video')
  const models = useMemo(
    () => videoModels.filter((item) => item.workflowFeatures?.berniniDirector === true),
    [videoModels],
  )
  const [storyboardId, setStoryboardId] = useState(storyboards[0]?.id || '')
  const storyboard = storyboards.find((item) => item.id === storyboardId) || storyboards[0]
  const [spec, setSpec] = useState<BerniniDirectorSpec | null>(null)
  const [model, setModel] = useState('')
  const [busy, setBusy] = useState<'save' | 'run' | null>(null)
  const [ready, setReady] = useState(false)
  const [message, setMessage] = useState('')
  const initializedId = useRef('')

  const sources = useMemo<BerniniDirectorOriginalSource[]>(() => (
    storyboards.flatMap((item) => (item.panels || []).flatMap((panel) => (
      panel.id && panel.imageUrl
        ? [{
            panelId: panel.id,
            url: panel.imageUrl,
            filename: sourceFilename(panel),
            mimeType: 'image/webp',
          }]
        : []
    )))
  ), [storyboards])

  useEffect(() => {
    if (!storyboard || initializedId.current === storyboard.id) return
    initializedId.current = storyboard.id
    const saved = parseBerniniDirectorSpec(storyboard.directorConfigJson)
    const next = saved || defaultSpec(storyboard, videoRatio)
    setSpec(next)
    setModel(
      next.videoModel && models.some((item) => item.value === next.videoModel)
        ? next.videoModel
        : models[0]?.value || '',
    )
    setReady(false)
    setMessage('')
  }, [models, storyboard, videoRatio])

  async function submit(kind: 'save' | 'run') {
    if (!storyboard || !spec || !model) {
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
        throw new Error(
          typeof detail === 'string'
            ? detail
            : typeof payload?.error === 'string'
              ? payload.error
              : t('berniniDirector.requestFailed'),
        )
      }
      setSpec((current) => current ? { ...current, videoModel: model } : current)
      setMessage(kind === 'save' ? t('berniniDirector.saved') : t('berniniDirector.submitted'))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('berniniDirector.requestFailed'))
    } finally {
      setBusy(null)
    }
  }

  if (!storyboard || !spec) {
    return <div className="glass-surface p-6 text-sm">{t('berniniDirector.noStoryboard')}</div>
  }

  return (
    <div className="space-y-4">
      <section className="glass-surface space-y-4 rounded-xl p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <h2 className="font-semibold text-[var(--glass-text-primary)]">
              {t('berniniDirector.title')}
            </h2>
            <p className="text-xs text-[var(--glass-text-tertiary)]">
              Bernini Director 原版界面 · 时间线与节点参数保持同步
            </p>
          </div>
          <select
            className="glass-input ml-auto w-auto rounded-lg px-3 py-2 text-sm"
            value={storyboard.id}
            onChange={(event) => setStoryboardId(event.target.value)}
          >
            {storyboards.map((item, index) => (
              <option key={item.id} value={item.id}>
                {t('berniniDirector.group', { index: index + 1 })}
              </option>
            ))}
          </select>
          <select
            className="glass-input w-auto min-w-52 rounded-lg px-3 py-2 text-sm"
            value={model}
            onChange={(event) => {
              setModel(event.target.value)
              setSpec((current) => current
                ? { ...current, videoModel: event.target.value || undefined }
                : current)
            }}
          >
            <option value="">{t('berniniDirector.selectModel')}</option>
            {models.map((item) => (
              <option key={item.value} value={item.value}>{item.label}</option>
            ))}
          </select>
        </div>
        {models.length === 0 && (
          <p className="rounded-lg bg-amber-500/10 p-3 text-sm text-amber-300">
            {t('berniniDirector.noModel')}
          </p>
        )}
        <p className="text-xs text-[var(--glass-text-tertiary)]">
          导演台中的图片、视频、分段、局部提示词、连续性和选择运行会随项目一起保存。
        </p>
      </section>

      <BerniniDirectorOriginalHost
        key={storyboard.id}
        projectId={projectId}
        storyboardId={storyboard.id}
        spec={spec}
        videoModel={model}
        sources={sources}
        onChange={(next) => setSpec({ ...next, videoModel: model || next.videoModel })}
        onReady={() => setReady(true)}
        onError={(error) => {
          setReady(false)
          setMessage(error.message)
        }}
      />

      <section className="glass-surface flex flex-wrap items-center gap-3 rounded-xl p-4">
        {message && (
          <span className="mr-auto text-sm text-[var(--glass-text-secondary)]">{message}</span>
        )}
        {!message && (
          <span className="mr-auto text-xs text-[var(--glass-text-tertiary)]">
            {ready ? '原版导演台已就绪' : '正在加载原版导演台…'}
          </span>
        )}
        <button
          type="button"
          className="glass-btn-base glass-btn-secondary rounded-lg px-4 py-2 text-sm"
          disabled={Boolean(busy) || !ready || !model}
          onClick={() => submit('save')}
        >
          {busy === 'save' ? t('berniniDirector.saving') : t('berniniDirector.save')}
        </button>
        <button
          type="button"
          className="glass-btn-base glass-btn-primary rounded-lg px-5 py-2 text-sm"
          disabled={Boolean(busy) || !ready || !model}
          onClick={() => submit('run')}
        >
          {busy === 'run' ? t('berniniDirector.submitting') : t('berniniDirector.generate')}
        </button>
      </section>

      {storyboard.directorVideoUrl && (
        <section className="glass-surface space-y-2 rounded-xl p-4">
          <h3 className="font-medium">{t('berniniDirector.result')}</h3>
          <video
            className="max-h-[70vh] w-full rounded-lg bg-black"
            src={storyboard.directorVideoUrl}
            controls
          />
        </section>
      )}
    </div>
  )
}
