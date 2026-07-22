'use client'

import Image from 'next/image'
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'

import type {
  Clip,
  Storyboard,
  VideoModelOption,
} from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video'
import { GlassButton, GlassInput, GlassTextarea } from '@/components/ui/primitives'
import { apiFetch } from '@/lib/api-fetch'
import {
  LTX_DIRECTOR_TIMELINE_VERSION,
  parseLtxDirectorTimelineSpec,
  type LtxDirectorTimelineSegmentSpec,
  type LtxDirectorTimelineSpec,
} from '@/lib/comfyui/ltx-director'
import { checkApiResponse } from '@/lib/error-handler'
import { invalidateEpisodeStageQueries } from '@/lib/query/episode-stage-cache'
import { useStoryboardTaskPresentation } from '@/lib/query/hooks/useTaskPresentation'
import { queryKeys } from '@/lib/query/keys'

const SOURCE_DRAG_TYPE = 'application/x-waoowaoo-director-source'
const SEGMENT_DRAG_TYPE = 'application/x-waoowaoo-director-segment'
let segmentNonce = 0

interface LtxDirectorWorkspaceProps {
  projectId: string
  episodeId: string
  storyboards: Storyboard[]
  clips: Clip[]
  videoModels: VideoModelOption[]
}

interface DirectorSource {
  key: string
  label: string
  imageUrl: string
  prompt: string
  sourcePanelId?: string
  sourceMediaId?: string
}

function nextSegmentId() {
  segmentNonce += 1
  return `director-${Date.now()}-${segmentNonce}`
}

function panelDuration(panel: NonNullable<Storyboard['panels']>[number]) {
  const values = [panel.durationOverride, panel.estimatedDuration, panel.duration]
  return values.find((value): value is number => (
    typeof value === 'number' && Number.isFinite(value) && value > 0
  )) ?? 3
}

function panelPrompt(panel: NonNullable<Storyboard['panels']>[number]) {
  return panel.videoPrompt?.trim() || panel.description?.trim() || panel.imagePrompt?.trim() || ''
}

function createSegment(source?: DirectorSource): LtxDirectorTimelineSegmentSpec {
  return {
    id: nextSegmentId(),
    ...(source?.sourcePanelId ? { sourcePanelId: source.sourcePanelId } : {}),
    ...(source?.sourceMediaId ? {
      sourceMediaId: source.sourceMediaId,
      sourceImageUrl: source.imageUrl,
    } : {}),
    prompt: source?.prompt || '',
    durationSeconds: 3,
    guideStrength: 1,
  }
}

function storyboardSources(storyboards: Storyboard[], currentIndex: number): DirectorSource[] {
  return storyboards.slice(0, currentIndex + 1).flatMap((storyboard, storyboardIndex) => (
    (storyboard.panels || []).flatMap((panel, panelIndex) => (
      panel.id && panel.imageUrl
        ? [{
            key: `panel:${panel.id}`,
            label: `G${storyboard.groupSequence ?? (storyboardIndex + 1)} · #${panelIndex + 1}`,
            imageUrl: panel.imageUrl,
            prompt: panelPrompt(panel),
            sourcePanelId: panel.id,
          }]
        : []
    ))
  ))
}

function buildDefaultSpec(
  storyboard: Storyboard,
  clips: Clip[],
  defaultModel: string,
): LtxDirectorTimelineSpec {
  const saved = parseLtxDirectorTimelineSpec(storyboard.directorConfigJson)
  if (saved) return { ...saved, videoModel: saved.videoModel || defaultModel }
  const panels = (storyboard.panels || []).filter((panel) => panel.id && panel.imageUrl)
  const clip = clips.find((candidate) => candidate.id === storyboard.clipId)
  return {
    version: LTX_DIRECTOR_TIMELINE_VERSION,
    fps: 24,
    globalPrompt: [storyboard.continuityAnchor, clip?.summary]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join('\n'),
    videoModel: defaultModel,
    segments: panels.map((panel) => ({
      id: `panel-${panel.id}`,
      sourcePanelId: panel.id,
      prompt: panelPrompt(panel),
      durationSeconds: panelDuration(panel),
      guideStrength: 1,
    })),
  }
}

function DirectorStoryboardEditor({
  projectId,
  episodeId,
  storyboard,
  storyboardIndex,
  displayNumber,
  clips,
  models,
  allStoryboards,
}: {
  projectId: string
  episodeId: string
  storyboard: Storyboard
  storyboardIndex: number
  displayNumber: number
  clips: Clip[]
  models: VideoModelOption[]
  allStoryboards: Storyboard[]
}) {
  const t = useTranslations('video.director')
  const queryClient = useQueryClient()
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const defaultSpec = useMemo(
    () => buildDefaultSpec(storyboard, clips, models[0]?.value || ''),
    [clips, models, storyboard],
  )
  const sources = useMemo(
    () => storyboardSources(allStoryboards, storyboardIndex),
    [allStoryboards, storyboardIndex],
  )
  const sourceByPanelId = useMemo(
    () => new Map(sources.flatMap((source) => source.sourcePanelId ? [[source.sourcePanelId, source]] : [])),
    [sources],
  )
  const previousSource = useMemo(() => {
    if (storyboardIndex <= 0) return null
    const previousPanels = allStoryboards[storyboardIndex - 1]?.panels || []
    const previousPanel = [...previousPanels].reverse().find((panel) => panel.id && panel.imageUrl)
    return previousPanel?.id ? sourceByPanelId.get(previousPanel.id) || null : null
  }, [allStoryboards, sourceByPanelId, storyboardIndex])
  const [spec, setSpec] = useState(defaultSpec)
  const [dirty, setDirty] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const taskTargets = useMemo(() => [{
    key: `storyboard-director:${storyboard.id}`,
    targetType: 'NovelPromotionStoryboard',
    targetId: storyboard.id,
    types: ['storyboard_director_video'],
    resource: 'video' as const,
    hasOutput: Boolean(storyboard.directorVideoUrl),
  }], [storyboard.directorVideoUrl, storyboard.id])
  const taskPresentation = useStoryboardTaskPresentation(projectId, taskTargets)
  const taskState = taskPresentation.getTaskState(`storyboard-director:${storyboard.id}`)
  const taskRunning = taskState?.phase === 'queued' || taskState?.phase === 'processing'

  useEffect(() => {
    if (!dirty) {
      setSpec(defaultSpec)
      setSelectedIndex((current) => Math.min(current, Math.max(0, defaultSpec.segments.length - 1)))
    }
  }, [defaultSpec, dirty])

  const saveMutation = useMutation({
    mutationFn: async (generate: boolean) => {
      const response = await apiFetch(`/api/novel-promotion/${projectId}/storyboard-director`, {
        method: generate ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storyboardId: storyboard.id, videoModel: spec.videoModel, timelineSpec: spec }),
      })
      await checkApiResponse(response)
      return response.json()
    },
    onSettled: async (_data, error) => {
      await invalidateEpisodeStageQueries(queryClient, projectId, episodeId)
      await queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all(projectId), exact: false })
      if (!error) setDirty(false)
    },
  })
  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData()
      formData.set('file', file)
      const response = await apiFetch(`/api/novel-promotion/${projectId}/storyboard-director/upload`, {
        method: 'POST',
        body: formData,
      })
      await checkApiResponse(response)
      return response.json() as Promise<{ mediaId: string; imageUrl: string }>
    },
    onSuccess: (uploaded) => {
      const source: DirectorSource = {
        key: `media:${uploaded.mediaId}`,
        label: t('uploadedImage'),
        imageUrl: uploaded.imageUrl,
        prompt: '',
        sourceMediaId: uploaded.mediaId,
      }
      appendSource(source)
    },
  })

  const totalDuration = spec.segments.reduce((sum, segment) => sum + segment.durationSeconds, 0)
  const selectedSegment = spec.segments[selectedIndex] || null

  function resolveSegmentSource(segment: LtxDirectorTimelineSegmentSpec): DirectorSource | null {
    const panelId = segment.sourcePanelId || segment.panelId
    if (panelId) return sourceByPanelId.get(panelId) || null
    if (segment.sourceMediaId && segment.sourceImageUrl) {
      return {
        key: `media:${segment.sourceMediaId}`,
        label: t('uploadedImage'),
        imageUrl: segment.sourceImageUrl,
        prompt: segment.prompt,
        sourceMediaId: segment.sourceMediaId,
      }
    }
    return null
  }

  const ready = spec.segments.length > 0
    && spec.segments.length <= 8
    && Boolean(spec.videoModel)
    && spec.segments.every((segment) => Boolean(resolveSegmentSource(segment)))
  const error = saveMutation.error instanceof Error
    ? saveMutation.error.message
    : uploadMutation.error instanceof Error
      ? uploadMutation.error.message
      : taskState?.phase === 'failed'
        ? taskState.lastError?.message || taskState.lastError?.code
        : null

  function patchSpec(patch: Partial<LtxDirectorTimelineSpec>) {
    setSpec((current) => ({ ...current, ...patch }))
    setDirty(true)
  }

  function patchSegment(index: number, patch: Partial<LtxDirectorTimelineSegmentSpec>) {
    setSpec((current) => ({
      ...current,
      segments: current.segments.map((segment, segmentIndex) => (
        segmentIndex === index ? { ...segment, ...patch } : segment
      )),
    }))
    setDirty(true)
  }

  function applySource(index: number, source: DirectorSource) {
    const currentPrompt = spec.segments[index]?.prompt || ''
    patchSegment(index, {
      panelId: undefined,
      sourcePanelId: source.sourcePanelId,
      sourceMediaId: source.sourceMediaId,
      sourceImageUrl: source.sourceMediaId ? source.imageUrl : undefined,
      prompt: currentPrompt.trim() ? currentPrompt : source.prompt,
    })
    setSelectedIndex(index)
  }

  function appendSource(source?: DirectorSource) {
    if (spec.segments.length >= 8) return
    setSpec((current) => ({ ...current, segments: [...current.segments, createSegment(source)] }))
    setSelectedIndex(spec.segments.length)
    setDirty(true)
  }

  function usePreviousAsFirstFrame() {
    if (!previousSource) return
    setSpec((current) => {
      if (current.segments.length === 0) {
        return { ...current, segments: [createSegment(previousSource)] }
      }
      const first = current.segments[0]!
      return {
        ...current,
        segments: [{
          ...first,
          panelId: undefined,
          sourcePanelId: previousSource.sourcePanelId,
          sourceMediaId: undefined,
          sourceImageUrl: undefined,
        }, ...current.segments.slice(1)],
      }
    })
    setSelectedIndex(0)
    setDirty(true)
  }

  function removeSegment(index: number) {
    setSpec((current) => ({
      ...current,
      segments: current.segments.filter((_, segmentIndex) => segmentIndex !== index),
    }))
    setSelectedIndex((current) => Math.max(0, Math.min(current, spec.segments.length - 2)))
    setDirty(true)
  }

  function moveSegment(from: number, to: number) {
    if (from === to || from < 0 || to < 0 || from >= spec.segments.length || to >= spec.segments.length) return
    setSpec((current) => {
      const segments = [...current.segments]
      const [moved] = segments.splice(from, 1)
      if (!moved) return current
      segments.splice(to, 0, moved)
      return { ...current, segments }
    })
    setSelectedIndex(to)
    setDirty(true)
  }

  function writeSourceDrag(event: DragEvent, source: DirectorSource) {
    event.dataTransfer.effectAllowed = 'copy'
    event.dataTransfer.setData(SOURCE_DRAG_TYPE, JSON.stringify(source))
  }

  function readDraggedSource(event: DragEvent): DirectorSource | null {
    const value = event.dataTransfer.getData(SOURCE_DRAG_TYPE)
    if (!value) return null
    try {
      return JSON.parse(value) as DirectorSource
    } catch {
      return null
    }
  }

  function dropOnSegment(event: DragEvent, index: number) {
    event.preventDefault()
    event.stopPropagation()
    const source = readDraggedSource(event)
    if (source) {
      applySource(index, source)
      return
    }
    const from = Number(event.dataTransfer.getData(SEGMENT_DRAG_TYPE))
    if (Number.isInteger(from)) moveSegment(from, index)
  }

  function dropOnTimeline(event: DragEvent) {
    event.preventDefault()
    event.stopPropagation()
    const source = readDraggedSource(event)
    if (source) appendSource(source)
  }

  return (
    <section className="glass-surface overflow-hidden rounded-2xl">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--glass-stroke-base)] p-4 md:p-5">
        <div>
          <h3 className="text-base font-semibold text-[var(--glass-text-primary)]">
            {t('groupTitle', { number: displayNumber })}
          </h3>
          <p className="mt-1 text-xs text-[var(--glass-text-tertiary)]">
            {t('groupMeta', { count: spec.segments.length, duration: totalDuration.toFixed(1) })}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <GlassButton
            size="sm"
            variant="ghost"
            disabled={saveMutation.isPending || taskRunning}
            onClick={() => {
              setSpec(buildDefaultSpec({ ...storyboard, directorConfigJson: null }, clips, models[0]?.value || ''))
              setSelectedIndex(0)
              setDirty(true)
            }}
          >
            {t('reset')}
          </GlassButton>
          <GlassButton
            size="sm"
            disabled={!ready || !dirty || saveMutation.isPending || taskRunning}
            loading={saveMutation.isPending && saveMutation.variables === false}
            onClick={() => saveMutation.mutate(false)}
          >
            {t('save')}
          </GlassButton>
          <GlassButton
            size="sm"
            variant="primary"
            disabled={!ready || saveMutation.isPending || taskRunning}
            loading={taskRunning || (saveMutation.isPending && saveMutation.variables === true)}
            onClick={() => saveMutation.mutate(true)}
          >
            {taskRunning ? t('generating') : t('generate')}
          </GlassButton>
        </div>
      </header>

      <div className="grid gap-3 border-b border-[var(--glass-stroke-base)] p-4 md:grid-cols-[minmax(0,1fr)_140px] md:p-5">
        <label className="space-y-1.5 text-xs text-[var(--glass-text-secondary)]">
          <span>{t('model')}</span>
          <select
            className="glass-input-base h-9 w-full rounded-lg px-3 text-sm"
            value={spec.videoModel || ''}
            onChange={(event) => patchSpec({ videoModel: event.target.value })}
          >
            <option value="">{t('selectModel')}</option>
            {models.map((model) => <option key={model.value} value={model.value}>{model.label}</option>)}
          </select>
        </label>
        <label className="space-y-1.5 text-xs text-[var(--glass-text-secondary)]">
          <span>{t('fps')}</span>
          <GlassInput
            type="number"
            min={1}
            max={240}
            step={1}
            value={spec.fps}
            onChange={(event) => patchSpec({ fps: Math.min(240, Math.max(1, Number(event.target.value) || 24)) })}
          />
        </label>
        <label className="space-y-1.5 text-xs text-[var(--glass-text-secondary)] md:col-span-2">
          <span>{t('globalPrompt')}</span>
          <GlassTextarea
            rows={2}
            value={spec.globalPrompt}
            placeholder={t('globalPromptPlaceholder')}
            onChange={(event) => patchSpec({ globalPrompt: event.target.value })}
          />
        </label>
      </div>

      <div className="grid min-h-[570px] lg:grid-cols-[230px_minmax(0,1fr)]">
        <aside className="border-b border-[var(--glass-stroke-base)] bg-[var(--glass-bg-muted)] p-3 lg:border-b-0 lg:border-r">
          <div className="flex items-center justify-between">
            <div className="text-xs font-semibold uppercase tracking-wide text-[var(--glass-text-secondary)]">
              {t('mediaPool')}
            </div>
            <GlassButton size="sm" variant="ghost" loading={uploadMutation.isPending} onClick={() => uploadInputRef.current?.click()}>
              {t('uploadImage')}
            </GlassButton>
            <input
              ref={uploadInputRef}
              className="hidden"
              type="file"
              accept="image/*"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) uploadMutation.mutate(file)
                event.target.value = ''
              }}
            />
          </div>
          <p className="mt-1 text-[11px] leading-4 text-[var(--glass-text-tertiary)]">{t('dragHint')}</p>

          {previousSource && (
            <div className="mt-3 rounded-xl border border-[var(--glass-accent-from)]/40 bg-[var(--glass-bg-surface)] p-2">
              <div className="mb-2 text-[11px] font-medium text-[var(--glass-accent-from)]">{t('previousEndFrame')}</div>
              <button
                type="button"
                draggable
                className="group block w-full text-left"
                onDragStart={(event) => writeSourceDrag(event, previousSource)}
                onClick={usePreviousAsFirstFrame}
              >
                <div className="relative aspect-video overflow-hidden rounded-lg bg-black">
                  <Image src={previousSource.imageUrl} alt={t('previousEndFrame')} fill sizes="210px" unoptimized className="object-cover" />
                </div>
                <div className="mt-1.5 text-[11px] text-[var(--glass-text-secondary)]">{t('clickAsFirstFrame')}</div>
              </button>
            </div>
          )}

          <div className="mt-3 grid max-h-[390px] grid-cols-2 gap-2 overflow-y-auto pr-1 lg:grid-cols-1 xl:grid-cols-2">
            {sources.map((source) => (
              <button
                key={source.key}
                type="button"
                draggable
                className="rounded-lg border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] p-1.5 text-left transition hover:border-[var(--glass-stroke-strong)]"
                onDragStart={(event) => writeSourceDrag(event, source)}
                onClick={() => appendSource(source)}
              >
                <div className="relative aspect-video overflow-hidden rounded-md bg-black">
                  <Image src={source.imageUrl} alt={source.label} fill sizes="100px" unoptimized className="object-cover" />
                </div>
                <div className="mt-1 truncate text-[10px] text-[var(--glass-text-secondary)]">{source.label}</div>
              </button>
            ))}
          </div>
        </aside>

        <main className="min-w-0 p-3 md:p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-sm font-semibold text-[var(--glass-text-primary)]">{t('timeline')}</div>
              <div className="text-[11px] text-[var(--glass-text-tertiary)]">{t('timelineHint')}</div>
            </div>
            <GlassButton size="sm" variant="ghost" disabled={spec.segments.length >= 8} onClick={() => appendSource()}>
              + {t('addShot')}
            </GlassButton>
          </div>

          <div
            className="mt-3 overflow-x-auto rounded-xl border border-[var(--glass-stroke-base)] bg-black/15 p-3 pb-4"
            onDragOver={(event) => event.preventDefault()}
            onDrop={dropOnTimeline}
          >
            <div className="flex min-h-[180px] min-w-max items-stretch gap-2">
              {spec.segments.map((segment, index) => {
                const source = resolveSegmentSource(segment)
                const start = spec.segments.slice(0, index).reduce((sum, item) => sum + item.durationSeconds, 0)
                return (
                  <button
                    key={segment.id || index}
                    type="button"
                    draggable
                    className={`group relative flex shrink-0 flex-col overflow-hidden rounded-xl border text-left transition ${
                      selectedIndex === index
                        ? 'border-[var(--glass-accent-from)] ring-2 ring-[var(--glass-accent-from)]/20'
                        : 'border-[var(--glass-stroke-base)] hover:border-[var(--glass-stroke-strong)]'
                    } bg-[var(--glass-bg-surface)]`}
                    style={{ width: `${Math.min(360, Math.max(180, segment.durationSeconds * 52))}px` }}
                    onClick={() => setSelectedIndex(index)}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = 'move'
                      event.dataTransfer.setData(SEGMENT_DRAG_TYPE, String(index))
                    }}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => dropOnSegment(event, index)}
                  >
                    <div className="relative h-[108px] w-full bg-black/70">
                      {source ? (
                        <Image src={source.imageUrl} alt={t('shot', { number: index + 1 })} fill sizes="240px" unoptimized className="object-cover" />
                      ) : (
                        <div className="flex h-full items-center justify-center px-4 text-center text-xs text-white/60">{t('dropImageHere')}</div>
                      )}
                      <div className="absolute left-2 top-2 rounded bg-black/65 px-1.5 py-0.5 text-[10px] text-white">
                        {start.toFixed(1)}–{(start + segment.durationSeconds).toFixed(1)}s
                      </div>
                    </div>
                    <div className="flex min-h-[68px] flex-1 flex-col p-2">
                      <div className="flex items-center justify-between gap-2 text-[11px]">
                        <span className="font-semibold text-[var(--glass-text-primary)]">{t('shot', { number: index + 1 })}</span>
                        <span className="text-[var(--glass-text-tertiary)]">{segment.durationSeconds.toFixed(1)}s</span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-[10px] leading-4 text-[var(--glass-text-secondary)]">
                        {segment.prompt || t('promptEmpty')}
                      </p>
                    </div>
                  </button>
                )
              })}
              <button
                type="button"
                disabled={spec.segments.length >= 8}
                className="flex w-[150px] shrink-0 items-center justify-center rounded-xl border border-dashed border-[var(--glass-stroke-strong)] text-sm text-[var(--glass-text-tertiary)] disabled:opacity-40"
                onClick={() => appendSource()}
                onDragOver={(event) => event.preventDefault()}
                onDrop={dropOnTimeline}
              >
                + {t('addShot')}
              </button>
            </div>
          </div>

          {selectedSegment && (
            <div className="mt-4 rounded-xl border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-muted)] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold text-[var(--glass-text-primary)]">{t('inspectorTitle', { number: selectedIndex + 1 })}</div>
                  <div className="text-[11px] text-[var(--glass-text-tertiary)]">
                    {resolveSegmentSource(selectedSegment)?.label || t('imageMissing')}
                  </div>
                </div>
                <div className="flex gap-1">
                  <GlassButton size="sm" variant="ghost" disabled={selectedIndex === 0} onClick={() => moveSegment(selectedIndex, selectedIndex - 1)}>←</GlassButton>
                  <GlassButton size="sm" variant="ghost" disabled={selectedIndex >= spec.segments.length - 1} onClick={() => moveSegment(selectedIndex, selectedIndex + 1)}>→</GlassButton>
                  <GlassButton size="sm" variant="danger" onClick={() => removeSegment(selectedIndex)}>{t('deleteShot')}</GlassButton>
                </div>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-xs text-[var(--glass-text-secondary)]">
                  <span>{t('duration')}</span>
                  <GlassInput
                    type="number"
                    min={0.1}
                    max={60}
                    step={0.1}
                    value={selectedSegment.durationSeconds}
                    onChange={(event) => patchSegment(selectedIndex, {
                      durationSeconds: Math.min(60, Math.max(0.1, Number(event.target.value) || 0.1)),
                    })}
                  />
                </label>
                <label className="space-y-1 text-xs text-[var(--glass-text-secondary)]">
                  <span>{t('guideStrengthValue', { value: (selectedSegment.guideStrength ?? 1).toFixed(2) })}</span>
                  <input
                    className="h-9 w-full accent-[var(--glass-accent-from)]"
                    type="range"
                    min={0}
                    max={2}
                    step={0.05}
                    value={selectedSegment.guideStrength ?? 1}
                    onChange={(event) => patchSegment(selectedIndex, { guideStrength: Number(event.target.value) })}
                  />
                </label>
                <label className="space-y-1 text-xs text-[var(--glass-text-secondary)] sm:col-span-2">
                  <span>{t('shotPrompt')}</span>
                  <GlassTextarea
                    rows={5}
                    value={selectedSegment.prompt}
                    placeholder={t('shotPromptPlaceholder')}
                    onChange={(event) => patchSegment(selectedIndex, { prompt: event.target.value })}
                  />
                </label>
                <label className="flex items-center gap-2 text-xs text-[var(--glass-text-secondary)] sm:col-span-2">
                  <input
                    type="checkbox"
                    checked={selectedSegment.isEndFrame === true}
                    onChange={(event) => patchSegment(selectedIndex, { isEndFrame: event.target.checked })}
                  />
                  {t('endFrame')}
                </label>
              </div>
            </div>
          )}
        </main>
      </div>

      {!ready && (
        <p className="mx-4 mb-3 text-xs text-[var(--glass-text-danger)] md:mx-5">
          {models.length === 0 ? t('modelRequired') : t('timelineIncomplete')}
        </p>
      )}
      {error && <p className="mx-4 mb-3 text-xs text-[var(--glass-text-danger)] md:mx-5">{error}</p>}
      {storyboard.directorVideoUrl && (
        <div className="border-t border-[var(--glass-stroke-base)] p-4 md:p-5">
          <div className="mb-2 text-xs font-medium text-[var(--glass-text-secondary)]">{t('preview')}</div>
          <video className="max-h-[560px] w-full rounded-xl bg-black" src={storyboard.directorVideoUrl} controls preload="metadata" />
        </div>
      )}
    </section>
  )
}

export default function LtxDirectorWorkspace({
  projectId,
  episodeId,
  storyboards,
  clips,
  videoModels,
}: LtxDirectorWorkspaceProps) {
  const t = useTranslations('video.director')
  const directorModels = useMemo(
    () => videoModels.filter((model) => model.workflowFeatures?.ltxDirector === true),
    [videoModels],
  )

  return (
    <div className="space-y-4">
      <div className="glass-surface-soft rounded-xl p-4">
        <h2 className="text-base font-semibold text-[var(--glass-text-primary)]">LTX Director</h2>
        <p className="mt-1 text-sm text-[var(--glass-text-tertiary)]">{t('description')}</p>
      </div>
      {storyboards.map((storyboard, index) => (
        <DirectorStoryboardEditor
          key={storyboard.id}
          projectId={projectId}
          episodeId={episodeId}
          storyboard={storyboard}
          storyboardIndex={index}
          displayNumber={storyboard.groupSequence ?? (index + 1)}
          clips={clips}
          models={directorModels}
          allStoryboards={storyboards}
        />
      ))}
    </div>
  )
}
