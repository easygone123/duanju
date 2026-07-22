'use client'

import Image from 'next/image'
import { useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from 'react'
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
  normalizeLtxDirectorGlobalPrompt,
  parseLtxDirectorTimelineSpec,
  resolveLtxDirectorDimensions,
  type LtxDirectorResolutionPreset,
  type LtxDirectorTimelineSegmentSpec,
  type LtxDirectorTimelineSpec,
} from '@/lib/comfyui/ltx-director'
import { checkApiResponse } from '@/lib/error-handler'
import { invalidateEpisodeStageQueries } from '@/lib/query/episode-stage-cache'
import { useStoryboardTaskPresentation } from '@/lib/query/hooks/useTaskPresentation'
import { queryKeys } from '@/lib/query/keys'

const SOURCE_DRAG_TYPE = 'application/x-waoowaoo-director-source'
const SEGMENT_DRAG_TYPE = 'application/x-waoowaoo-director-segment'
const TIMELINE_PX_PER_SECOND = 64
let segmentNonce = 0

interface LtxDirectorWorkspaceProps {
  projectId: string
  episodeId: string
  storyboards: Storyboard[]
  clips: Clip[]
  videoModels: VideoModelOption[]
  videoRatio?: string
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

function createSegment(source?: DirectorSource, startSeconds = 0): LtxDirectorTimelineSegmentSpec {
  return {
    id: nextSegmentId(),
    ...(source?.sourcePanelId ? { sourcePanelId: source.sourcePanelId } : {}),
    ...(source?.sourceMediaId ? {
      sourceMediaId: source.sourceMediaId,
      sourceImageUrl: source.imageUrl,
    } : {}),
    prompt: source?.prompt || '',
    startSeconds,
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
  videoRatio: string,
): LtxDirectorTimelineSpec {
  const saved = parseLtxDirectorTimelineSpec(storyboard.directorConfigJson)
  if (saved) return {
    ...saved,
    videoModel: saved.videoModel || defaultModel,
    aspectRatio: videoRatio,
    resolutionPreset: saved.resolutionPreset || '720p',
  }
  const panels = (storyboard.panels || []).filter((panel) => panel.id && panel.imageUrl)
  const clip = clips.find((candidate) => candidate.id === storyboard.clipId)
  let cursor = 0
  return {
    version: LTX_DIRECTOR_TIMELINE_VERSION,
    fps: 24,
    globalPrompt: normalizeLtxDirectorGlobalPrompt([storyboard.continuityAnchor, clip?.summary]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join('\n')),
    videoModel: defaultModel,
    aspectRatio: videoRatio,
    resolutionPreset: '720p',
    segments: panels.map((panel) => {
      const durationSeconds = panelDuration(panel)
      const segment = {
        id: `panel-${panel.id}`,
        sourcePanelId: panel.id,
        prompt: panelPrompt(panel),
        startSeconds: cursor,
        durationSeconds,
        guideStrength: 1,
      }
      cursor += durationSeconds
      return segment
    }),
  }
}

function startOfSegment(segments: LtxDirectorTimelineSegmentSpec[], index: number) {
  if (typeof segments[index]?.startSeconds === 'number') return segments[index]!.startSeconds!
  return segments.slice(0, index).reduce((sum, segment) => sum + segment.durationSeconds, 0)
}

function totalTimelineDuration(segments: LtxDirectorTimelineSegmentSpec[]) {
  return segments.reduce((latest, segment, index) => Math.max(
    latest,
    startOfSegment(segments, index) + segment.durationSeconds,
  ), 0)
}

function resolveTimelineCollisions(segments: LtxDirectorTimelineSegmentSpec[]) {
  let cursor = 0
  return [...segments]
    .sort((left, right) => (left.startSeconds ?? 0) - (right.startSeconds ?? 0))
    .map((segment) => {
      const startSeconds = Math.max(cursor, segment.startSeconds ?? cursor)
      cursor = startSeconds + segment.durationSeconds
      return { ...segment, startSeconds }
    })
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
  videoRatio,
}: {
  projectId: string
  episodeId: string
  storyboard: Storyboard
  storyboardIndex: number
  displayNumber: number
  clips: Clip[]
  models: VideoModelOption[]
  allStoryboards: Storyboard[]
  videoRatio: string
}) {
  const t = useTranslations('video.director')
  const queryClient = useQueryClient()
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const timelineTrackRef = useRef<HTMLDivElement>(null)
  const resizeGestureRef = useRef<{
    index: number
    segmentId?: string
    pointerId: number
    originX: number
    originDuration: number
  } | null>(null)
  const defaultSpec = useMemo(
    () => buildDefaultSpec(storyboard, clips, models[0]?.value || '', videoRatio),
    [clips, models, storyboard, videoRatio],
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

  const totalDuration = totalTimelineDuration(spec.segments)
  const rangeSelected = spec.rangeStartSeconds !== undefined && spec.rangeEndSeconds !== undefined
  const rangeStart = Math.min(totalDuration, Math.max(0, spec.rangeStartSeconds ?? 0))
  const rangeEnd = Math.min(totalDuration, Math.max(rangeStart, spec.rangeEndSeconds ?? totalDuration))
  const resolutionPreset = spec.resolutionPreset ?? '720p'
  const dimensions = resolveLtxDirectorDimensions(resolutionPreset, videoRatio)
  const timelineVisualDuration = Math.max(5, Math.ceil(totalDuration) + 1)
  const timelineWidth = timelineVisualDuration * TIMELINE_PX_PER_SECOND
  const rulerTicks = Array.from({ length: timelineVisualDuration + 1 }, (_, index) => index)
  const selectedSegment = spec.segments[selectedIndex] || null

  useEffect(() => {
    if (!rangeSelected) return
    const rawStart = spec.rangeStartSeconds ?? 0
    const rawEnd = spec.rangeEndSeconds ?? totalDuration
    if (totalDuration <= 0 || rawStart >= totalDuration || rawEnd <= rawStart) {
      setSpec((current) => ({
        ...current,
        rangeStartSeconds: undefined,
        rangeEndSeconds: undefined,
      }))
      return
    }
    if (rawEnd > totalDuration) {
      setSpec((current) => ({ ...current, rangeEndSeconds: totalDuration }))
    }
  }, [rangeSelected, spec.rangeEndSeconds, spec.rangeStartSeconds, totalDuration])

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
    && (!rangeSelected || rangeEnd > rangeStart)
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

  function patchSegmentTiming(index: number, patch: Partial<LtxDirectorTimelineSegmentSpec>) {
    const targetId = spec.segments[index]?.id
    const segments = resolveTimelineCollisions(spec.segments.map((segment, segmentIndex) => (
      segmentIndex === index ? { ...segment, ...patch } : segment
    )))
    setSpec((current) => ({ ...current, segments }))
    const nextIndex = segments.findIndex((segment, segmentIndex) => (
      targetId ? segment.id === targetId : segmentIndex === index
    ))
    if (nextIndex >= 0) setSelectedIndex(nextIndex)
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

  function appendSource(source?: DirectorSource, startSeconds = totalDuration) {
    if (spec.segments.length >= 8) return
    const created = createSegment(source, Math.max(0, startSeconds))
    const segments = resolveTimelineCollisions([...spec.segments, created])
    setSpec((current) => ({ ...current, segments }))
    setSelectedIndex(Math.max(0, segments.findIndex((segment) => segment.id === created.id)))
    setDirty(true)
  }

  function usePreviousAsFirstFrame() {
    if (!previousSource) return
    setSpec((current) => {
      if (current.segments.length === 0) {
        return { ...current, segments: [createSegment(previousSource, 0)] }
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
      let cursor = 0
      return {
        ...current,
        segments: segments.map((segment) => {
          const positioned = { ...segment, startSeconds: cursor }
          cursor += segment.durationSeconds
          return positioned
        }),
      }
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
    const source = readDraggedSource(event)
    if (source) {
      event.stopPropagation()
      applySource(index, source)
      return
    }
    dropOnTimeline(event)
  }

  function dropOnTimeline(event: DragEvent) {
    event.preventDefault()
    event.stopPropagation()
    const source = readDraggedSource(event)
    const track = timelineTrackRef.current
    const rect = track?.getBoundingClientRect()
    const startSeconds = rect
      ? Math.max(0, (event.clientX - rect.left) / TIMELINE_PX_PER_SECOND)
      : totalDuration
    if (source) {
      appendSource(source, Math.round(startSeconds * 10) / 10)
      return
    }
    const from = Number(event.dataTransfer.getData(SEGMENT_DRAG_TYPE))
    if (!Number.isInteger(from)) return
    const movedId = spec.segments[from]?.id
    const segments = resolveTimelineCollisions(spec.segments.map((segment, index) => (
      index === from ? { ...segment, startSeconds: Math.round(startSeconds * 10) / 10 } : segment
    )))
    setSpec((current) => ({ ...current, segments }))
    const nextIndex = segments.findIndex((segment) => segment.id === movedId)
    if (nextIndex >= 0) setSelectedIndex(nextIndex)
    setDirty(true)
  }

  function beginResize(event: ReactPointerEvent<HTMLDivElement>, index: number) {
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    resizeGestureRef.current = {
      index,
      segmentId: spec.segments[index]?.id,
      pointerId: event.pointerId,
      originX: event.clientX,
      originDuration: spec.segments[index]?.durationSeconds ?? 0.5,
    }
  }

  function resizeSegment(event: ReactPointerEvent<HTMLDivElement>) {
    const gesture = resizeGestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    const durationSeconds = Math.max(
      0.5,
      Math.round((gesture.originDuration + (event.clientX - gesture.originX) / TIMELINE_PX_PER_SECOND) * 10) / 10,
    )
    setSpec((current) => ({
      ...current,
      segments: resolveTimelineCollisions(current.segments.map((segment, index) => (
        (gesture.segmentId ? segment.id === gesture.segmentId : index === gesture.index)
          ? { ...segment, durationSeconds }
          : segment
      ))),
    }))
    setDirty(true)
  }

  function endResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (resizeGestureRef.current?.pointerId === event.pointerId) resizeGestureRef.current = null
  }

  function selectRange(startSeconds: number, endSeconds: number) {
    const start = Math.max(0, Math.min(totalDuration, Math.round(startSeconds * 10) / 10))
    const end = Math.max(start + 0.1, Math.min(totalDuration, Math.round(endSeconds * 10) / 10))
    patchSpec({ rangeStartSeconds: start, rangeEndSeconds: end })
  }

  function selectCurrentSegmentRange() {
    if (!selectedSegment) return
    const start = startOfSegment(spec.segments, selectedIndex)
    selectRange(start, start + selectedSegment.durationSeconds)
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
              setSpec(buildDefaultSpec(
                { ...storyboard, directorConfigJson: null },
                clips,
                models[0]?.value || '',
                videoRatio,
              ))
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
            {taskRunning ? t('generating') : rangeSelected ? t('generateRange') : t('generate')}
          </GlassButton>
        </div>
      </header>

      <div className="grid gap-3 border-b border-[var(--glass-stroke-base)] p-4 md:grid-cols-[minmax(0,1fr)_140px_180px] md:p-5">
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
        <label className="space-y-1.5 text-xs text-[var(--glass-text-secondary)]">
          <span>{t('resolution')}</span>
          <select
            className="glass-input-base h-9 w-full rounded-lg px-3 text-sm"
            value={resolutionPreset}
            onChange={(event) => patchSpec({
              aspectRatio: videoRatio,
              resolutionPreset: event.target.value as LtxDirectorResolutionPreset,
            })}
          >
            <option value="480p">480p</option>
            <option value="720p">720p</option>
            <option value="1080p">1080p</option>
          </select>
          <span className="block text-[10px] text-[var(--glass-text-tertiary)]">
            {t('adaptiveSize', { ratio: videoRatio, width: dimensions.width, height: dimensions.height })}
          </span>
        </label>
        <label className="space-y-1.5 text-xs text-[var(--glass-text-secondary)] md:col-span-3">
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
            <div className="mb-3 flex min-w-[680px] flex-wrap items-end gap-2 rounded-lg bg-black/20 p-2">
              <div className="mr-auto">
                <div className="text-[11px] font-medium text-[var(--glass-text-secondary)]">{t('generationRange')}</div>
                <div className="text-[10px] text-[var(--glass-text-tertiary)]">
                  {rangeSelected
                    ? t('rangeSummary', { start: rangeStart.toFixed(1), end: rangeEnd.toFixed(1) })
                    : t('fullRangeSummary', { duration: totalDuration.toFixed(1) })}
                </div>
              </div>
              <GlassButton
                size="sm"
                variant={rangeSelected ? 'ghost' : 'primary'}
                onClick={() => patchSpec({ rangeStartSeconds: undefined, rangeEndSeconds: undefined })}
              >
                {t('fullTimeline')}
              </GlassButton>
              <GlassButton size="sm" variant={rangeSelected ? 'primary' : 'ghost'} disabled={!selectedSegment} onClick={selectCurrentSegmentRange}>
                {t('selectedShotRange')}
              </GlassButton>
              {rangeSelected && (
                <>
                  <label className="w-24 text-[10px] text-[var(--glass-text-tertiary)]">
                    {t('rangeStart')}
                    <GlassInput
                      type="number"
                      min={0}
                      max={Math.max(0, rangeEnd - 0.1)}
                      step={0.1}
                      value={rangeStart}
                      onChange={(event) => selectRange(Number(event.target.value) || 0, rangeEnd)}
                    />
                  </label>
                  <label className="w-24 text-[10px] text-[var(--glass-text-tertiary)]">
                    {t('rangeEnd')}
                    <GlassInput
                      type="number"
                      min={rangeStart + 0.1}
                      max={totalDuration}
                      step={0.1}
                      value={rangeEnd}
                      onChange={(event) => selectRange(rangeStart, Number(event.target.value) || totalDuration)}
                    />
                  </label>
                </>
              )}
            </div>
            <div
              ref={timelineTrackRef}
              className="relative min-h-[220px] min-w-max overflow-hidden rounded-lg border border-white/5 bg-black/25"
              style={{ width: `${timelineWidth}px` }}
            >
              <div className="absolute inset-x-0 top-0 h-7 border-b border-white/10 bg-black/20">
                {rulerTicks.map((tick) => (
                  <div
                    key={tick}
                    className="absolute inset-y-0 border-l border-white/15 pl-1 pt-1 text-[9px] text-white/45"
                    style={{ left: `${tick * TIMELINE_PX_PER_SECOND}px` }}
                  >
                    {tick}s
                  </div>
                ))}
              </div>
              {rangeSelected && (
                <div
                  className="pointer-events-none absolute bottom-0 top-7 border-x border-[var(--glass-accent-from)]/80 bg-[var(--glass-accent-from)]/10"
                  style={{
                    left: `${rangeStart * TIMELINE_PX_PER_SECOND}px`,
                    width: `${Math.max(2, (rangeEnd - rangeStart) * TIMELINE_PX_PER_SECOND)}px`,
                  }}
                />
              )}
              {spec.segments.map((segment, index) => {
                const source = resolveSegmentSource(segment)
                const start = startOfSegment(spec.segments, index)
                return (
                  <div
                    key={segment.id || index}
                    draggable
                    className={`group absolute top-10 flex h-[156px] flex-col overflow-hidden rounded-xl border text-left shadow-lg transition ${
                      selectedIndex === index
                        ? 'border-[var(--glass-accent-from)] ring-2 ring-[var(--glass-accent-from)]/20'
                        : 'border-[var(--glass-stroke-base)] hover:border-[var(--glass-stroke-strong)]'
                    } bg-[var(--glass-bg-surface)]`}
                    style={{
                      left: `${start * TIMELINE_PX_PER_SECOND}px`,
                      width: `${Math.max(76, segment.durationSeconds * TIMELINE_PX_PER_SECOND)}px`,
                    }}
                    onClick={() => setSelectedIndex(index)}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = 'move'
                      event.dataTransfer.setData(SEGMENT_DRAG_TYPE, String(index))
                    }}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => dropOnSegment(event, index)}
                  >
                    <div className="relative h-[86px] w-full bg-black/70">
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
                    <div
                      role="separator"
                      aria-label={t('resizeShot')}
                      className="absolute bottom-0 right-0 top-0 w-3 cursor-ew-resize border-l border-white/20 bg-white/5 opacity-0 transition group-hover:opacity-100"
                      onPointerDown={(event) => beginResize(event, index)}
                      onPointerMove={resizeSegment}
                      onPointerUp={endResize}
                      onPointerCancel={endResize}
                    />
                  </div>
                )
              })}
            </div>
            {rangeSelected && (
              <div className="relative mt-3 h-8 min-w-max" style={{ width: `${timelineWidth}px` }}>
                <input
                  aria-label={t('rangeStart')}
                  className="absolute inset-x-0 top-0 w-full accent-[var(--glass-accent-from)]"
                  type="range"
                  min={0}
                  max={Math.max(0.1, totalDuration)}
                  step={0.1}
                  value={rangeStart}
                  onChange={(event) => selectRange(Number(event.target.value), rangeEnd)}
                />
                <input
                  aria-label={t('rangeEnd')}
                  className="absolute inset-x-0 top-3 w-full accent-[var(--glass-accent-to)]"
                  type="range"
                  min={0.1}
                  max={Math.max(0.1, totalDuration)}
                  step={0.1}
                  value={rangeEnd}
                  onChange={(event) => selectRange(rangeStart, Number(event.target.value))}
                />
              </div>
            )}
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
                  <span>{t('startTime')}</span>
                  <GlassInput
                    type="number"
                    min={0}
                    max={600}
                    step={0.1}
                    value={startOfSegment(spec.segments, selectedIndex)}
                    onChange={(event) => patchSegmentTiming(selectedIndex, {
                      startSeconds: Math.max(0, Number(event.target.value) || 0),
                    })}
                  />
                </label>
                <label className="space-y-1 text-xs text-[var(--glass-text-secondary)]">
                  <span>{t('duration')}</span>
                  <GlassInput
                    type="number"
                    min={0.1}
                    max={60}
                    step={0.1}
                    value={selectedSegment.durationSeconds}
                    onChange={(event) => patchSegmentTiming(selectedIndex, {
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
  videoRatio = '16:9',
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
          videoRatio={videoRatio}
        />
      ))}
    </div>
  )
}
