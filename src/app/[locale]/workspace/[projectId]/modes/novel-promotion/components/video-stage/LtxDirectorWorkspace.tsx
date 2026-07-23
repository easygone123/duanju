'use client'

import Image from 'next/image'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
} from 'react'
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
  createLtxDirectorTimelineExport,
  normalizeLtxDirectorGlobalPrompt,
  parseLtxDirectorTimelineSpec,
  resolveLtxDirectorAspectRatioFromDimensions,
  resolveLtxDirectorDimensions,
  type LtxDirectorResolutionPreset,
  type LtxDirectorAudioSegmentSpec,
  type LtxDirectorMotionSegmentSpec,
  type LtxDirectorTimelineSegmentSpec,
  type LtxDirectorTimelineSpec,
} from '@/lib/comfyui/ltx-director'
import { checkApiResponse } from '@/lib/error-handler'
import { invalidateEpisodeStageQueries } from '@/lib/query/episode-stage-cache'
import { useStoryboardTaskPresentation } from '@/lib/query/hooks/useTaskPresentation'
import { queryKeys } from '@/lib/query/keys'

const SOURCE_DRAG_TYPE = 'application/x-waoowaoo-director-source'
const TIMELINE_PX_PER_SECOND = 64
let segmentNonce = 0

type AuxiliaryTrack = 'motion' | 'audio'

interface SelectedAuxiliarySegment {
  track: AuxiliaryTrack
  id: string
}

interface DirectorContextMenuState {
  x: number
  y: number
  segmentId?: string
  timelineSeconds: number
}

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

function readMediaDuration(file: File) {
  return new Promise<number>((resolve) => {
    const element = document.createElement(file.type.startsWith('audio/') ? 'audio' : 'video')
    const url = URL.createObjectURL(file)
    element.preload = 'metadata'
    element.onloadedmetadata = () => {
      const duration = Number.isFinite(element.duration) && element.duration > 0 ? element.duration : 3
      URL.revokeObjectURL(url)
      resolve(Math.round(duration * 10) / 10)
    }
    element.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(3)
    }
    element.src = url
  })
}

function isImageFile(file: File) {
  if (file.type.startsWith('image/')) return true
  return /\.(?:avif|bmp|gif|jpe?g|png|webp)$/i.test(file.name)
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
  if (saved) {
    const savedSegments = saved.segments.map((segment, index) => ({
      ...segment,
      id: segment.id || `saved-${storyboard.id}-${index}`,
    }))
    const savedPanelIds = new Set(savedSegments.flatMap((segment) => {
      const panelId = segment.sourcePanelId || segment.panelId
      return panelId ? [panelId] : []
    }))
    let cursor = totalTimelineDuration(savedSegments)
    const missingPanelSegments = (storyboard.panels || []).flatMap((panel) => {
      if (!panel.id || !panel.imageUrl || savedPanelIds.has(panel.id)) return []
      const durationSeconds = panelDuration(panel)
      const segment: LtxDirectorTimelineSegmentSpec = {
        id: `panel-${panel.id}`,
        sourcePanelId: panel.id,
        prompt: panelPrompt(panel),
        startSeconds: cursor,
        durationSeconds,
        guideStrength: 1,
      }
      cursor += durationSeconds
      return [segment]
    })
    return {
      ...saved,
      videoModel: saved.videoModel || defaultModel,
      aspectRatio: saved.aspectRatio || videoRatio,
      resolutionPreset: saved.resolutionPreset || '720p',
      audioTrackEnabled: saved.audioTrackEnabled ?? true,
      motionTrackEnabled: saved.motionTrackEnabled ?? true,
      segments: [...savedSegments, ...missingPanelSegments],
    }
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
    audioTrackEnabled: true,
    motionTrackEnabled: true,
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

function sortTimelineSegments(segments: LtxDirectorTimelineSegmentSpec[]) {
  return [...segments].sort((left, right) => (left.startSeconds ?? 0) - (right.startSeconds ?? 0))
}

function compactTimelineSegments(segments: LtxDirectorTimelineSegmentSpec[]) {
  let cursor = 0
  return segments.map((segment) => {
    const positioned = { ...segment, startSeconds: cursor }
    cursor += segment.durationSeconds
    return positioned
  })
}

function snapSegmentStart(
  segments: LtxDirectorTimelineSegmentSpec[],
  segmentId: string,
  requestedStart: number,
  snapThresholdSeconds: number,
) {
  const target = segments.find((segment) => segment.id === segmentId)
  if (!target) return requestedStart
  const candidates = [0, ...segments.flatMap((segment, index) => (
    segment.id === segmentId
      ? []
      : [startOfSegment(segments, index), startOfSegment(segments, index) + segment.durationSeconds]
  ))]
  let snappedStart = Math.max(0, requestedStart)
  let closestDistance = snapThresholdSeconds
  for (const candidate of candidates) {
    const startDistance = Math.abs(requestedStart - candidate)
    if (startDistance < closestDistance) {
      closestDistance = startDistance
      snappedStart = candidate
    }
    const endDistance = Math.abs(requestedStart + target.durationSeconds - candidate)
    if (endDistance < closestDistance) {
      closestDistance = endDistance
      snappedStart = candidate - target.durationSeconds
    }
  }
  return Math.max(0, Math.round(snappedStart * 10) / 10)
}

export function moveTimelineSegment(
  segments: LtxDirectorTimelineSegmentSpec[],
  segmentId: string,
  requestedStart: number,
  pointerSeconds: number,
  magneticFill: boolean,
) {
  const ordered = sortTimelineSegments(segments)
  const moved = ordered.find((segment) => segment.id === segmentId)
  if (!moved) return ordered
  const remaining = ordered.filter((segment) => segment.id !== segmentId)
  const insertIndex = remaining.findIndex((segment, index) => (
    pointerSeconds < startOfSegment(remaining, index) + segment.durationSeconds / 2
  ))
  const targetIndex = insertIndex < 0 ? remaining.length : insertIndex
  remaining.splice(targetIndex, 0, { ...moved, startSeconds: Math.max(0, requestedStart) })
  if (magneticFill) return compactTimelineSegments(remaining)

  const positioned = remaining.map((segment) => ({ ...segment }))
  for (let index = targetIndex + 1; index < positioned.length; index += 1) {
    const previous = positioned[index - 1]!
    const current = positioned[index]!
    current.startSeconds = Math.max(
      current.startSeconds ?? 0,
      (previous.startSeconds ?? 0) + previous.durationSeconds,
    )
  }
  for (let index = targetIndex - 1; index >= 0; index -= 1) {
    const current = positioned[index]!
    const next = positioned[index + 1]!
    current.startSeconds = Math.min(
      current.startSeconds ?? 0,
      (next.startSeconds ?? 0) - current.durationSeconds,
    )
  }
  if ((positioned[0]?.startSeconds ?? 0) < 0) {
    positioned[0]!.startSeconds = 0
    for (let index = 1; index < positioned.length; index += 1) {
      const previous = positioned[index - 1]!
      const current = positioned[index]!
      current.startSeconds = Math.max(
        current.startSeconds ?? 0,
        (previous.startSeconds ?? 0) + previous.durationSeconds,
      )
    }
  }
  return positioned
}

export function buildEpisodeDirectorStoryboard(storyboards: Storyboard[]): Storyboard | null {
  const anchor = storyboards[0]
  if (!anchor) return null
  return {
    ...anchor,
    panels: storyboards.flatMap((storyboard) => storyboard.panels || []),
    continuityAnchor: storyboards
      .map((storyboard) => storyboard.continuityAnchor)
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join('\n') || anchor.continuityAnchor,
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
  const mainVideoUploadInputRef = useRef<HTMLInputElement>(null)
  const motionUploadInputRef = useRef<HTMLInputElement>(null)
  const audioUploadInputRef = useRef<HTMLInputElement>(null)
  const retakeUploadInputRef = useRef<HTMLInputElement>(null)
  const importTimelineInputRef = useRef<HTMLInputElement>(null)
  const timelineScrollRef = useRef<HTMLDivElement>(null)
  const timelineTrackRef = useRef<HTMLDivElement>(null)
  const playbackFrameRef = useRef<number | null>(null)
  const mainPreviewVideoRef = useRef<HTMLVideoElement>(null)
  const audioPreviewRefs = useRef(new Map<string, HTMLAudioElement>())
  const undoStackRef = useRef<LtxDirectorTimelineSpec[]>([])
  const redoStackRef = useRef<LtxDirectorTimelineSpec[]>([])
  const previousSpecRef = useRef<LtxDirectorTimelineSpec | null>(null)
  const restoringHistoryRef = useRef(false)
  const gestureHistoryRef = useRef({ active: false, captured: false })
  const copiedSegmentRef = useRef<LtxDirectorTimelineSegmentSpec | null>(null)
  const resizeGestureRef = useRef<{
    index: number
    segmentId?: string
    pointerId: number
    edge: 'left' | 'right'
    originX: number
    originStart: number
    originDuration: number
    originTrimStart: number
  } | null>(null)
  const dragGestureRef = useRef<{
    segmentId: string
    pointerId: number
    originX: number
    originStart: number
    initialSegments: LtxDirectorTimelineSegmentSpec[]
  } | null>(null)
  const auxiliaryGestureRef = useRef<{
    track: AuxiliaryTrack
    segmentId: string
    pointerId: number
    mode: 'move' | 'resizeLeft' | 'resizeRight'
    originX: number
    originStart: number
    originDuration: number
    initialSegments: Array<LtxDirectorMotionSegmentSpec | LtxDirectorAudioSegmentSpec>
  } | null>(null)
  const retakeGestureRef = useRef<{
    pointerId: number
    mode: 'move' | 'left' | 'right'
    originX: number
    originStart: number
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
  const [selectedSegmentIds, setSelectedSegmentIds] = useState<string[]>([])
  const [selectedAuxiliary, setSelectedAuxiliary] = useState<SelectedAuxiliarySegment | null>(null)
  const [magneticFill, setMagneticFill] = useState(true)
  const [playheadSeconds, setPlayheadSeconds] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [loopPlayback, setLoopPlayback] = useState(false)
  const [historyVersion, setHistoryVersion] = useState(0)
  const [timelineScale, setTimelineScale] = useState(TIMELINE_PX_PER_SECOND)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [sourceDrawerOpen, setSourceDrawerOpen] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [contextMenu, setContextMenu] = useState<DirectorContextMenuState | null>(null)
  const [audioWaveforms, setAudioWaveforms] = useState<Record<string, number[]>>({})
  const [helpOpen, setHelpOpen] = useState(false)
  const firstSourceImageUrl = useMemo(() => {
    const first = spec.segments[0]
    if (!first) return null
    const sourcePanelId = first.sourcePanelId || first.panelId
    if (sourcePanelId) return sourceByPanelId.get(sourcePanelId)?.imageUrl || null
    return first.sourceImageUrl || null
  }, [sourceByPanelId, spec.segments])
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
      setSelectedSegmentIds([])
      setSelectedAuxiliary(null)
      undoStackRef.current = []
      redoStackRef.current = []
      previousSpecRef.current = defaultSpec
      setHistoryVersion((current) => current + 1)
    }
  }, [defaultSpec, dirty])

  useEffect(() => {
    const previous = previousSpecRef.current
    if (!previous || previous === spec) {
      previousSpecRef.current = spec
      return
    }
    if (restoringHistoryRef.current) {
      restoringHistoryRef.current = false
    } else if (!gestureHistoryRef.current.active || !gestureHistoryRef.current.captured) {
      undoStackRef.current = [...undoStackRef.current.slice(-49), structuredClone(previous)]
      redoStackRef.current = []
      if (gestureHistoryRef.current.active) gestureHistoryRef.current.captured = true
      setHistoryVersion((current) => current + 1)
    }
    previousSpecRef.current = spec
  }, [spec])

  useEffect(() => {
    if (!firstSourceImageUrl) return
    let canceled = false
    const image = document.createElement('img')
    image.onload = () => {
      if (canceled) return
      const aspectRatio = resolveLtxDirectorAspectRatioFromDimensions(
        image.naturalWidth,
        image.naturalHeight,
        spec.aspectRatio || videoRatio,
      )
      if (aspectRatio === spec.aspectRatio) return
      setSpec((current) => ({ ...current, aspectRatio }))
      setDirty(true)
    }
    image.src = firstSourceImageUrl
    return () => { canceled = true }
  }, [firstSourceImageUrl, spec.aspectRatio, videoRatio])

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
    mutationFn: async ({ file, track }: {
      file: File
      track: 'image' | 'mainVideo' | 'motion' | 'motionImage' | 'audio' | 'retake'
    }) => {
      const durationSeconds = track === 'image' ? 3 : await readMediaDuration(file)
      const formData = new FormData()
      formData.set('file', file)
      const response = await apiFetch(`/api/novel-promotion/${projectId}/storyboard-director/upload`, {
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
      return { ...uploaded, track, durationSeconds }
    },
    onSuccess: (uploaded) => {
      if (uploaded.track === 'mainVideo') {
        const segment: LtxDirectorTimelineSegmentSpec = {
          id: nextSegmentId(),
          type: 'video',
          sourceMediaId: uploaded.mediaId,
          sourceUrl: uploaded.mediaUrl,
          filename: uploaded.filename,
          prompt: '',
          startSeconds: playheadSeconds,
          durationSeconds: uploaded.durationSeconds,
          mediaDurationSeconds: uploaded.durationSeconds,
          trimStartSeconds: 0,
          linkedAudio: true,
          guideStrength: 1,
        }
        const nextSegments = moveTimelineSegment(
          [...spec.segments, segment],
          segment.id!,
          playheadSeconds,
          playheadSeconds,
          magneticFill,
        )
        setSpec((current) => ({
          ...current,
          audioTrackEnabled: true,
          useCustomAudio: true,
          segments: moveTimelineSegment(
            [...current.segments, segment],
            segment.id!,
            playheadSeconds,
            playheadSeconds,
            magneticFill,
          ),
        }))
        setSelectedIndex(Math.max(0, nextSegments.findIndex((item) => item.id === segment.id)))
        setSelectedSegmentIds([segment.id!])
        setSelectedAuxiliary(null)
        setDirty(true)
        return
      }
      if (uploaded.track === 'motion') {
        const segment: LtxDirectorMotionSegmentSpec = {
          id: nextSegmentId(),
          sourceType: 'video',
          sourceMediaId: uploaded.mediaId,
          sourceUrl: uploaded.mediaUrl,
          filename: uploaded.filename,
          startSeconds: playheadSeconds,
          durationSeconds: uploaded.durationSeconds,
          videoStrength: 1,
          videoAttentionStrength: 0.65,
          resampleMode: 'nearest',
        }
        setSpec((current) => ({
          ...current,
          motionTrackEnabled: true,
          useCustomMotion: true,
          motionSegments: [...(current.motionSegments ?? []), segment]
            .sort((left, right) => left.startSeconds - right.startSeconds),
        }))
        setSelectedAuxiliary({ track: 'motion', id: segment.id! })
        setSelectedSegmentIds([])
        setDirty(true)
        return
      }
      if (uploaded.track === 'motionImage') {
        const segment: LtxDirectorMotionSegmentSpec = {
          id: nextSegmentId(),
          sourceType: 'image',
          sourceMediaId: uploaded.mediaId,
          sourceUrl: uploaded.mediaUrl,
          filename: uploaded.filename,
          startSeconds: playheadSeconds,
          durationSeconds: Math.max(1, totalDuration || 3),
          videoStrength: 1,
          videoAttentionStrength: 0.65,
          resampleMode: 'nearest',
        }
        setSpec((current) => ({
          ...current,
          motionTrackEnabled: true,
          useCustomMotion: true,
          motionSegments: [...(current.motionSegments ?? []), segment]
            .sort((left, right) => left.startSeconds - right.startSeconds),
        }))
        setSelectedAuxiliary({ track: 'motion', id: segment.id! })
        setSelectedSegmentIds([])
        setDirty(true)
        return
      }
      if (uploaded.track === 'audio') {
        const segment: LtxDirectorAudioSegmentSpec = {
          id: nextSegmentId(),
          sourceMediaId: uploaded.mediaId,
          sourceUrl: uploaded.mediaUrl,
          filename: uploaded.filename,
          startSeconds: playheadSeconds,
          durationSeconds: uploaded.durationSeconds,
        }
        setSpec((current) => ({
          ...current,
          audioTrackEnabled: true,
          useCustomAudio: true,
          audioSegments: [...(current.audioSegments ?? []), segment]
            .sort((left, right) => left.startSeconds - right.startSeconds),
        }))
        setSelectedAuxiliary({ track: 'audio', id: segment.id! })
        setSelectedSegmentIds([])
        setDirty(true)
        return
      }
      if (uploaded.track === 'retake') {
        patchSpec({
          retakeEnabled: true,
          retakeVideoMediaId: uploaded.mediaId,
          retakeVideoUrl: uploaded.mediaUrl,
          retakeStartSeconds: rangeSelected ? rangeStart : playheadSeconds,
          retakeDurationSeconds: rangeSelected ? rangeEnd - rangeStart : Math.min(3, uploaded.durationSeconds),
        })
        return
      }
      const source: DirectorSource = {
        key: `media:${uploaded.mediaId}`,
        label: t('uploadedImage'),
        imageUrl: uploaded.imageUrl || uploaded.mediaUrl,
        prompt: '',
        sourceMediaId: uploaded.mediaId,
      }
      appendSource(source)
    },
  })

  const totalDuration = Math.max(
    totalTimelineDuration(spec.segments),
    ...(spec.motionSegments ?? []).map((segment) => segment.startSeconds + segment.durationSeconds),
    ...(spec.audioSegments ?? []).map((segment) => segment.startSeconds + segment.durationSeconds),
    (spec.retakeStartSeconds ?? 0) + (spec.retakeDurationSeconds ?? 0),
  )
  const rangeSelected = spec.rangeStartSeconds !== undefined && spec.rangeEndSeconds !== undefined
  const rangeStart = Math.min(totalDuration, Math.max(0, spec.rangeStartSeconds ?? 0))
  const rangeEnd = Math.min(totalDuration, Math.max(rangeStart, spec.rangeEndSeconds ?? totalDuration))
  const resolutionPreset = spec.resolutionPreset ?? '720p'
  const effectiveAspectRatio = spec.aspectRatio || videoRatio
  const dimensions = resolveLtxDirectorDimensions(resolutionPreset, effectiveAspectRatio)
  const timelineVisualDuration = Math.max(5, Math.ceil(totalDuration) + 1)
  const timelineWidth = timelineVisualDuration * timelineScale
  const rulerTicks = Array.from({ length: timelineVisualDuration + 1 }, (_, index) => index)
  const selectedSegment = spec.segments[selectedIndex] || null
  const activeMainIndex = spec.segments.findIndex((segment, index) => {
    const start = startOfSegment(spec.segments, index)
    return playheadSeconds >= start && playheadSeconds < start + segment.durationSeconds
  })
  const activeMainSegment = activeMainIndex >= 0 ? spec.segments[activeMainIndex] : null
  const activeMainSource = activeMainSegment ? resolveSegmentSource(activeMainSegment) : null

  useEffect(() => {
    setPlayheadSeconds((current) => Math.min(current, totalDuration))
  }, [totalDuration])

  useEffect(() => {
    if (!playing || totalDuration <= 0) return
    let previous = performance.now()
    const advance = (now: number) => {
      const delta = Math.max(0, (now - previous) / 1000)
      previous = now
      setPlayheadSeconds((current) => {
        const next = current + delta
        if (next >= totalDuration) {
          if (loopPlayback) return 0
          setPlaying(false)
          return totalDuration
        }
        return next
      })
      playbackFrameRef.current = requestAnimationFrame(advance)
    }
    playbackFrameRef.current = requestAnimationFrame(advance)
    return () => {
      if (playbackFrameRef.current !== null) cancelAnimationFrame(playbackFrameRef.current)
      playbackFrameRef.current = null
    }
  }, [loopPlayback, playing, totalDuration])

  useEffect(() => {
    const video = mainPreviewVideoRef.current
    const retakePreview = spec.retakeEnabled && Boolean(spec.retakeVideoUrl)
    if (!video || (!retakePreview && activeMainSegment?.type !== 'video')) return
    const start = retakePreview ? 0 : activeMainIndex >= 0 ? startOfSegment(spec.segments, activeMainIndex) : 0
    const targetTime = retakePreview
      ? playheadSeconds
      : Math.max(0, (activeMainSegment?.trimStartSeconds ?? 0) + playheadSeconds - start)
    if (Math.abs(video.currentTime - targetTime) > 0.2) video.currentTime = targetTime
    if (playing) void video.play().catch(() => undefined)
    else video.pause()
  }, [activeMainIndex, activeMainSegment, playheadSeconds, playing, spec.retakeEnabled, spec.retakeVideoUrl, spec.segments])

  useEffect(() => {
    const activeIds = new Set<string>()
    const previewElements = audioPreviewRefs.current
    for (const segment of spec.audioSegments ?? []) {
      if (!segment.id) continue
      const element = previewElements.get(segment.id)
      if (!element) continue
      const active = playheadSeconds >= segment.startSeconds
        && playheadSeconds < segment.startSeconds + segment.durationSeconds
      if (!active) {
        element.pause()
        continue
      }
      activeIds.add(segment.id)
      const targetTime = Math.max(0, (segment.trimStartSeconds ?? 0) + playheadSeconds - segment.startSeconds)
      if (Math.abs(element.currentTime - targetTime) > 0.2) element.currentTime = targetTime
      if (playing) void element.play().catch(() => undefined)
      else element.pause()
    }
    return () => {
      if (playing) return
      for (const [id, element] of previewElements) {
        if (!activeIds.has(id)) element.pause()
      }
    }
  }, [playheadSeconds, playing, spec.audioSegments])

  useEffect(() => {
    const pending = (spec.audioSegments ?? []).filter((segment) => (
      segment.id && segment.sourceUrl && !audioWaveforms[segment.id]
    ))
    if (pending.length === 0 || typeof AudioContext === 'undefined') return
    let canceled = false
    const context = new AudioContext()
    void Promise.all(pending.map(async (segment) => {
      try {
        const response = await fetch(segment.sourceUrl!)
        if (!response.ok) throw new Error('audio preview unavailable')
        const decoded = await context.decodeAudioData(await response.arrayBuffer())
        const channel = decoded.getChannelData(0)
        const bucketCount = 48
        const bucketSize = Math.max(1, Math.floor(channel.length / bucketCount))
        const peaks = Array.from({ length: bucketCount }, (_, index) => {
          let peak = 0
          const start = index * bucketSize
          const end = Math.min(channel.length, start + bucketSize)
          for (let cursor = start; cursor < end; cursor += 1) peak = Math.max(peak, Math.abs(channel[cursor] ?? 0))
          return peak
        })
        return segment.id ? [segment.id, peaks] as const : null
      } catch {
        return segment.id ? [segment.id, []] as const : null
      }
    })).then((items) => {
      if (canceled) return
      setAudioWaveforms((current) => ({
        ...current,
        ...Object.fromEntries(items.filter((item): item is readonly [string, number[]] => Boolean(item))),
      }))
    }).catch(() => undefined).finally(() => {
      if (context.state !== 'closed') void context.close().catch(() => undefined)
    })
    return () => {
      canceled = true
      void context.close().catch(() => undefined)
    }
  }, [audioWaveforms, spec.audioSegments])

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

  const ready = (spec.segments.length > 0 || Boolean(spec.retakeEnabled && spec.retakeVideoMediaId))
    && spec.segments.length <= 64
    && Boolean(spec.videoModel)
    && (!rangeSelected || rangeEnd > rangeStart)
    && (!spec.retakeEnabled || Boolean(spec.retakeVideoMediaId && spec.retakeDurationSeconds))
    && spec.segments.every((segment) => (
      segment.type === 'text'
      || (segment.type === 'video' && Boolean(segment.sourceMediaId && segment.sourceUrl))
      || Boolean(resolveSegmentSource(segment))
    ))
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
    if (!targetId) return
    const patched = spec.segments.map((segment, segmentIndex) => (
      segmentIndex === index ? { ...segment, ...patch } : segment
    ))
    const requestedStart = patch.startSeconds
    const segments = requestedStart === undefined
      ? (magneticFill ? compactTimelineSegments(patched) : sortTimelineSegments(patched))
      : moveTimelineSegment(patched, targetId, requestedStart, requestedStart, magneticFill)
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
    if (spec.segments.length >= 64) return
    const created = createSegment(source, Math.max(0, startSeconds))
    const segments = moveTimelineSegment(
      [...spec.segments, created],
      created.id!,
      startSeconds,
      startSeconds,
      magneticFill,
    )
    setSpec((current) => ({ ...current, segments }))
    setSelectedIndex(Math.max(0, segments.findIndex((segment) => segment.id === created.id)))
    setDirty(true)
  }

  function addTextSegment(startSeconds = playheadSeconds) {
    if (spec.segments.length >= 64) return
    const created = createSegment(undefined, Math.max(0, startSeconds))
    created.type = 'text'
    created.guideStrength = 0
    const segments = moveTimelineSegment(
      [...spec.segments, created],
      created.id!,
      startSeconds,
      startSeconds,
      magneticFill,
    )
    setSpec((current) => ({
      ...current,
      segments: moveTimelineSegment(
        [...current.segments, created],
        created.id!,
        startSeconds,
        startSeconds,
        magneticFill,
      ),
    }))
    setSelectedIndex(Math.max(0, segments.findIndex((segment) => segment.id === created.id)))
    setSelectedSegmentIds([created.id!])
    setSelectedAuxiliary(null)
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
      segments: magneticFill
        ? compactTimelineSegments(current.segments.filter((_, segmentIndex) => segmentIndex !== index))
        : current.segments.filter((_, segmentIndex) => segmentIndex !== index),
    }))
    setSelectedIndex((current) => Math.max(0, Math.min(current, spec.segments.length - 2)))
    setDirty(true)
  }

  function removeSelectedSegments() {
    if (selectedSegmentIds.length === 0) {
      if (selectedSegment) removeSegment(selectedIndex)
      return
    }
    const selected = new Set(selectedSegmentIds)
    setSpec((current) => {
      const remaining = current.segments.filter((segment) => !segment.id || !selected.has(segment.id))
      return { ...current, segments: magneticFill ? compactTimelineSegments(remaining) : remaining }
    })
    setSelectedSegmentIds([])
    setSelectedIndex(0)
    setDirty(true)
  }

  function selectMainSegment(index: number, additive = false) {
    const segment = spec.segments[index]
    if (!segment) return
    setSelectedIndex(index)
    setSelectedAuxiliary(null)
    if (!segment.id) return
    setSelectedSegmentIds((current) => {
      if (!additive) return [segment.id!]
      return current.includes(segment.id!)
        ? current.filter((id) => id !== segment.id)
        : [...current, segment.id!]
    })
  }

  function markSelectedSegments() {
    const selected = selectedSegmentIds.length > 0
      ? spec.segments.filter((segment) => segment.id && selectedSegmentIds.includes(segment.id))
      : selectedSegment ? [selectedSegment] : []
    if (selected.length === 0) return
    const starts = selected.map((segment) => startOfSegment(spec.segments, spec.segments.indexOf(segment)))
    const ends = selected.map((segment, index) => starts[index]! + segment.durationSeconds)
    selectRange(Math.min(...starts), Math.max(...ends))
  }

  function copySelectedSegment() {
    if (!selectedSegment) return
    copiedSegmentRef.current = structuredClone(selectedSegment)
  }

  function pasteSegmentAt(seconds: number, replaceId?: string) {
    const copied = copiedSegmentRef.current
    if (!copied) return
    const created = { ...structuredClone(copied), id: nextSegmentId(), startSeconds: Math.max(0, seconds) }
    setSpec((current) => {
      const segments = replaceId
        ? current.segments.map((segment) => segment.id === replaceId ? created : segment)
        : [...current.segments, created]
      return { ...current, segments: sortTimelineSegments(segments) }
    })
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
      ? Math.max(0, (event.clientX - rect.left) / timelineScale)
      : totalDuration
    if (source) {
      appendSource(source, Math.round(startSeconds * 10) / 10)
    }
  }

  function beginSegmentDrag(event: ReactPointerEvent<HTMLDivElement>, index: number) {
    if (event.button !== 0) return
    const segment = spec.segments[index]
    if (!segment?.id) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    gestureHistoryRef.current = { active: true, captured: false }
    dragGestureRef.current = {
      segmentId: segment.id,
      pointerId: event.pointerId,
      originX: event.clientX,
      originStart: startOfSegment(spec.segments, index),
      initialSegments: spec.segments.map((candidate) => ({ ...candidate })),
    }
    setSelectedIndex(index)
    if (!selectedSegmentIds.includes(segment.id)) setSelectedSegmentIds([segment.id])
    setSelectedAuxiliary(null)
  }

  function dragSegment(event: ReactPointerEvent<HTMLDivElement>) {
    const gesture = dragGestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    const deltaSeconds = (event.clientX - gesture.originX) / timelineScale
    const rawStart = Math.max(0, gesture.originStart + deltaSeconds)
    const requestedStart = snapSegmentStart(
      gesture.initialSegments,
      gesture.segmentId,
      rawStart,
      15 / timelineScale,
    )
    const track = timelineTrackRef.current?.getBoundingClientRect()
    const absolutePointerSeconds = track
      ? Math.max(0, (event.clientX - track.left) / timelineScale)
      : rawStart
    const movingIds = selectedSegmentIds.includes(gesture.segmentId) && selectedSegmentIds.length > 1
      ? new Set(selectedSegmentIds)
      : null
    const segments = movingIds
      ? sortTimelineSegments(gesture.initialSegments.map((segment, index) => (
          segment.id && movingIds.has(segment.id)
            ? {
                ...segment,
                startSeconds: Math.max(0, startOfSegment(gesture.initialSegments, index) + requestedStart - gesture.originStart),
              }
            : segment
        )))
      : moveTimelineSegment(
          gesture.initialSegments,
          gesture.segmentId,
          requestedStart,
          absolutePointerSeconds,
          magneticFill,
        )
    setSpec((current) => ({ ...current, segments }))
    const nextIndex = segments.findIndex((segment) => segment.id === gesture.segmentId)
    if (nextIndex >= 0) setSelectedIndex(nextIndex)
    setDirty(true)
  }

  function endSegmentDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragGestureRef.current?.pointerId !== event.pointerId) return
    dragGestureRef.current = null
    gestureHistoryRef.current = { active: false, captured: false }
  }

  function beginResize(event: ReactPointerEvent<HTMLDivElement>, index: number, edge: 'left' | 'right' = 'right') {
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    gestureHistoryRef.current = { active: true, captured: false }
    resizeGestureRef.current = {
      index,
      segmentId: spec.segments[index]?.id,
      pointerId: event.pointerId,
      edge,
      originX: event.clientX,
      originStart: startOfSegment(spec.segments, index),
      originDuration: spec.segments[index]?.durationSeconds ?? 0.5,
      originTrimStart: spec.segments[index]?.trimStartSeconds ?? 0,
    }
  }

  function resizeSegment(event: ReactPointerEvent<HTMLDivElement>) {
    const gesture = resizeGestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    const deltaSeconds = Math.round(((event.clientX - gesture.originX) / timelineScale) * 10) / 10
    const durationSeconds = Math.max(0.1, Math.round((gesture.originDuration
      + (gesture.edge === 'right' ? deltaSeconds : -deltaSeconds)) * 10) / 10)
    const effectiveDelta = gesture.edge === 'left' ? gesture.originDuration - durationSeconds : 0
    setSpec((current) => ({
      ...current,
      segments: sortTimelineSegments(current.segments.map((segment, index) => (
        (gesture.segmentId ? segment.id === gesture.segmentId : index === gesture.index)
          ? {
              ...segment,
              durationSeconds,
              ...(gesture.edge === 'left' ? {
                startSeconds: Math.max(0, gesture.originStart + effectiveDelta),
                ...(segment.type === 'video'
                  ? { trimStartSeconds: Math.max(0, gesture.originTrimStart + effectiveDelta) }
                  : {}),
              } : {}),
            }
          : segment
      ))),
    }))
    setDirty(true)
  }

  function endResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (resizeGestureRef.current?.pointerId !== event.pointerId) return
    resizeGestureRef.current = null
    gestureHistoryRef.current = { active: false, captured: false }
  }

  function toggleMagneticFill() {
    const enabled = !magneticFill
    setMagneticFill(enabled)
    if (!enabled) return
    const selectedId = spec.segments[selectedIndex]?.id
    const segments = compactTimelineSegments(spec.segments)
    setSpec((current) => ({ ...current, segments }))
    const nextIndex = segments.findIndex((segment) => segment.id === selectedId)
    if (nextIndex >= 0) setSelectedIndex(nextIndex)
    setDirty(true)
  }

  function patchMotionSegment(index: number, patch: Partial<LtxDirectorMotionSegmentSpec>) {
    patchSpec({
      motionSegments: (spec.motionSegments ?? []).map((segment, segmentIndex) => (
        segmentIndex === index ? { ...segment, ...patch } : segment
      )).sort((left, right) => left.startSeconds - right.startSeconds),
    })
  }

  function patchAudioSegment(index: number, patch: Partial<LtxDirectorAudioSegmentSpec>) {
    patchSpec({
      audioSegments: (spec.audioSegments ?? []).map((segment, segmentIndex) => (
        segmentIndex === index ? { ...segment, ...patch } : segment
      )).sort((left, right) => left.startSeconds - right.startSeconds),
    })
  }

  function restoreTimeline(next: LtxDirectorTimelineSpec, destination: MutableRefObject<LtxDirectorTimelineSpec[]>) {
    destination.current = [...destination.current.slice(-49), structuredClone(spec)]
    restoringHistoryRef.current = true
    previousSpecRef.current = spec
    setSpec(structuredClone(next))
    setSelectedIndex((current) => Math.min(current, Math.max(0, next.segments.length - 1)))
    setSelectedAuxiliary(null)
    setDirty(true)
    setHistoryVersion((current) => current + 1)
  }

  function undoTimeline() {
    const previous = undoStackRef.current.pop()
    if (previous) restoreTimeline(previous, redoStackRef)
  }

  function redoTimeline() {
    const next = redoStackRef.current.pop()
    if (next) restoreTimeline(next, undoStackRef)
  }

  function auxiliarySegments(track: AuxiliaryTrack) {
    return track === 'motion' ? (spec.motionSegments ?? []) : (spec.audioSegments ?? [])
  }

  function patchAuxiliarySegments(
    track: AuxiliaryTrack,
    segments: Array<LtxDirectorMotionSegmentSpec | LtxDirectorAudioSegmentSpec>,
  ) {
    if (track === 'motion') {
      patchSpec({ motionSegments: segments as LtxDirectorMotionSegmentSpec[] })
      return
    }
    patchSpec({ audioSegments: segments as LtxDirectorAudioSegmentSpec[] })
  }

  function auxiliarySnapCandidates(track: AuxiliaryTrack, segmentId: string) {
    return [
      0,
      ...spec.segments.flatMap((segment, index) => {
        const start = startOfSegment(spec.segments, index)
        return [start, start + segment.durationSeconds]
      }),
      ...auxiliarySegments(track).flatMap((segment) => (
        segment.id === segmentId
          ? []
          : [segment.startSeconds, segment.startSeconds + segment.durationSeconds]
      )),
    ]
  }

  function snapAuxiliaryStart(track: AuxiliaryTrack, segmentId: string, requestedStart: number, duration: number) {
    let result = Math.max(0, requestedStart)
    let distance = 15 / timelineScale
    for (const candidate of auxiliarySnapCandidates(track, segmentId)) {
      const startDistance = Math.abs(requestedStart - candidate)
      if (startDistance < distance) {
        distance = startDistance
        result = candidate
      }
      const endDistance = Math.abs(requestedStart + duration - candidate)
      if (endDistance < distance) {
        distance = endDistance
        result = candidate - duration
      }
    }
    return Math.max(0, Math.round(result * 10) / 10)
  }

  function beginAuxiliaryGesture(
    event: ReactPointerEvent<HTMLDivElement>,
    track: AuxiliaryTrack,
    index: number,
    mode: 'move' | 'resizeLeft' | 'resizeRight',
  ) {
    if (event.button !== 0) return
    const segments = auxiliarySegments(track)
    const segment = segments[index]
    if (!segment?.id) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    gestureHistoryRef.current = { active: true, captured: false }
    auxiliaryGestureRef.current = {
      track,
      segmentId: segment.id,
      pointerId: event.pointerId,
      mode,
      originX: event.clientX,
      originStart: segment.startSeconds,
      originDuration: segment.durationSeconds,
      initialSegments: segments.map((candidate) => ({ ...candidate })),
    }
    setSelectedAuxiliary({ track, id: segment.id })
  }

  function updateAuxiliaryGesture(event: ReactPointerEvent<HTMLDivElement>) {
    const gesture = auxiliaryGestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    const deltaSeconds = (event.clientX - gesture.originX) / timelineScale
    const segments = gesture.initialSegments.map((segment) => {
      if (segment.id !== gesture.segmentId) return segment
      if (gesture.mode === 'resizeRight') {
        return {
          ...segment,
          durationSeconds: Math.max(0.1, Math.round((gesture.originDuration + deltaSeconds) * 10) / 10),
        }
      }
      if (gesture.mode === 'resizeLeft') {
        const durationSeconds = Math.max(0.1, Math.round((gesture.originDuration - deltaSeconds) * 10) / 10)
        const effectiveDelta = gesture.originDuration - durationSeconds
        return {
          ...segment,
          startSeconds: Math.max(0, gesture.originStart + effectiveDelta),
          durationSeconds,
          trimStartSeconds: Math.max(0, (segment.trimStartSeconds ?? 0) + effectiveDelta),
        }
      }
      return {
        ...segment,
        startSeconds: snapAuxiliaryStart(
          gesture.track,
          gesture.segmentId,
          gesture.originStart + deltaSeconds,
          gesture.originDuration,
        ),
      }
    }).sort((left, right) => left.startSeconds - right.startSeconds)
    patchAuxiliarySegments(gesture.track, segments)
  }

  function endAuxiliaryGesture(event: ReactPointerEvent<HTMLDivElement>) {
    if (auxiliaryGestureRef.current?.pointerId !== event.pointerId) return
    auxiliaryGestureRef.current = null
    gestureHistoryRef.current = { active: false, captured: false }
  }

  function beginRetakeGesture(event: ReactPointerEvent<HTMLDivElement>, mode: 'move' | 'left' | 'right') {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    gestureHistoryRef.current = { active: true, captured: false }
    retakeGestureRef.current = {
      pointerId: event.pointerId,
      mode,
      originX: event.clientX,
      originStart: spec.retakeStartSeconds ?? 0,
      originDuration: spec.retakeDurationSeconds ?? 1,
    }
  }

  function updateRetakeGesture(event: ReactPointerEvent<HTMLDivElement>) {
    const gesture = retakeGestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    const delta = Math.round(((event.clientX - gesture.originX) / timelineScale) * 100) / 100
    if (gesture.mode === 'move') {
      patchSpec({ retakeStartSeconds: Math.max(0, Math.min(totalDuration - gesture.originDuration, gesture.originStart + delta)) })
      return
    }
    if (gesture.mode === 'left') {
      const end = gesture.originStart + gesture.originDuration
      const start = Math.max(0, Math.min(end - 0.1, gesture.originStart + delta))
      patchSpec({ retakeStartSeconds: start, retakeDurationSeconds: end - start })
      return
    }
    patchSpec({
      retakeDurationSeconds: Math.max(0.1, Math.min(totalDuration - gesture.originStart, gesture.originDuration + delta)),
    })
  }

  function endRetakeGesture(event: ReactPointerEvent<HTMLDivElement>) {
    if (retakeGestureRef.current?.pointerId !== event.pointerId) return
    retakeGestureRef.current = null
    gestureHistoryRef.current = { active: false, captured: false }
  }

  function removeSelectedAuxiliary() {
    if (!selectedAuxiliary) return
    const segments = auxiliarySegments(selectedAuxiliary.track)
      .filter((segment) => segment.id !== selectedAuxiliary.id)
    patchAuxiliarySegments(selectedAuxiliary.track, segments)
    setSelectedAuxiliary(null)
  }

  function selectRange(startSeconds: number, endSeconds: number) {
    if (totalDuration <= 0) return
    const start = Math.max(0, Math.min(totalDuration - 0.1, Math.round(startSeconds * 10) / 10))
    const end = Math.min(totalDuration, Math.max(start + 0.1, Math.round(endSeconds * 10) / 10))
    patchSpec({ rangeStartSeconds: start, rangeEndSeconds: end })
  }

  function selectCurrentSegmentRange() {
    if (!selectedSegment) return
    const start = startOfSegment(spec.segments, selectedIndex)
    selectRange(start, start + selectedSegment.durationSeconds)
  }

  function markRangeStart() {
    const end = rangeSelected ? Math.max(rangeEnd, playheadSeconds + 0.1) : Math.max(playheadSeconds + 0.1, totalDuration)
    selectRange(playheadSeconds, end)
  }

  function markRangeEnd() {
    if (playheadSeconds <= 0) return
    const start = rangeSelected ? Math.min(rangeStart, playheadSeconds - 0.1) : 0
    selectRange(start, playheadSeconds)
  }

  function fitTimeline() {
    const availableWidth = Math.max(320, (timelineScrollRef.current?.clientWidth ?? 720) - 32)
    setTimelineScale(Math.min(128, Math.max(16, Math.floor(availableWidth / timelineVisualDuration))))
  }

  function setPlayhead(value: number) {
    setPlayheadSeconds(Math.max(0, Math.min(totalDuration, Math.round(value * 100) / 100)))
  }

  function splitAtPlayhead(atSeconds = playheadSeconds) {
    if (selectedAuxiliary) {
      const auxiliary = auxiliarySegments(selectedAuxiliary.track)
      const splitIndex = auxiliary.findIndex((segment) => (
        segment.id === selectedAuxiliary.id
        && atSeconds > segment.startSeconds + 0.05
        && atSeconds < segment.startSeconds + segment.durationSeconds - 0.05
      ))
      if (splitIndex >= 0) {
        const segment = auxiliary[splitIndex]!
        const leftDuration = atSeconds - segment.startSeconds
        const rightDuration = segment.durationSeconds - leftDuration
        const left = { ...segment, durationSeconds: leftDuration }
        const right = {
          ...segment,
          id: nextSegmentId(),
          startSeconds: atSeconds,
          durationSeconds: rightDuration,
          trimStartSeconds: (segment.trimStartSeconds ?? 0) + leftDuration,
        }
        patchAuxiliarySegments(selectedAuxiliary.track, [
          ...auxiliary.slice(0, splitIndex),
          left,
          right,
          ...auxiliary.slice(splitIndex + 1),
        ])
        setSelectedAuxiliary({ track: selectedAuxiliary.track, id: right.id! })
        return
      }
    }
    const splitIndex = spec.segments.findIndex((segment, index) => {
      const start = startOfSegment(spec.segments, index)
      return atSeconds > start + 0.1
        && atSeconds < start + segment.durationSeconds - 0.1
    })
    if (splitIndex < 0) return
    const segment = spec.segments[splitIndex]!
    const start = startOfSegment(spec.segments, splitIndex)
    const leftDuration = Math.round((atSeconds - start) * 10) / 10
    const rightDuration = Math.round((segment.durationSeconds - leftDuration) * 10) / 10
    const left = {
      ...segment,
      durationSeconds: leftDuration,
      isEndFrame: undefined,
    }
    const right = {
      ...segment,
      id: nextSegmentId(),
      startSeconds: atSeconds,
      durationSeconds: rightDuration,
      ...(segment.type === 'video'
        ? { trimStartSeconds: (segment.trimStartSeconds ?? 0) + leftDuration }
        : {}),
    }
    const segments = [
      ...spec.segments.slice(0, splitIndex),
      left,
      right,
      ...spec.segments.slice(splitIndex + 1),
    ]
    const positioned = magneticFill ? compactTimelineSegments(segments) : segments
    setSpec((current) => ({ ...current, segments: positioned }))
    setSelectedIndex(splitIndex + 1)
    setDirty(true)
  }

  function exportTimeline() {
    const blob = new Blob([JSON.stringify(createLtxDirectorTimelineExport(spec), null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `ltx-director-${displayNumber}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  async function importTimeline(file: File) {
    const imported = parseLtxDirectorTimelineSpec(await file.text())
    if (!imported) return
    const segments = imported.segments.map((segment, index) => ({
      ...segment,
      id: segment.id || `imported-${storyboard.id}-${index}`,
    }))
    setSpec({
      ...imported,
      videoModel: imported.videoModel || spec.videoModel,
      aspectRatio: imported.aspectRatio || spec.aspectRatio || videoRatio,
      resolutionPreset: imported.resolutionPreset || resolutionPreset,
      audioTrackEnabled: imported.audioTrackEnabled ?? true,
      motionTrackEnabled: imported.motionTrackEnabled ?? true,
      segments,
    })
    setSelectedIndex(0)
    setPlayheadSeconds(0)
    setDirty(true)
  }

  function handleTimelineKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    const target = event.target as HTMLElement
    if (target.matches('input, textarea, select, [contenteditable="true"]')) return
    if (event.key === ' ') {
      event.preventDefault()
      if (playheadSeconds >= totalDuration) setPlayheadSeconds(0)
      setPlaying((current) => !current)
      return
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      if (selectedAuxiliary) removeSelectedAuxiliary()
      else removeSelectedSegments()
      return
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      if (event.shiftKey) redoTimeline()
      else undoTimeline()
      return
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') {
      event.preventDefault()
      redoTimeline()
      return
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c') {
      event.preventDefault()
      copySelectedSegment()
      return
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v') {
      event.preventDefault()
      pasteSegmentAt(playheadSeconds)
      return
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b') {
      event.preventDefault()
      splitAtPlayhead()
      return
    }
    if (event.key.toLowerCase() === 's' && !(event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      toggleMagneticFill()
      return
    }
    if (event.key.toLowerCase() === 'i') {
      event.preventDefault()
      markRangeStart()
      return
    }
    if (event.key.toLowerCase() === 'o') {
      event.preventDefault()
      markRangeEnd()
      return
    }
    if (event.key.toLowerCase() === 'x') {
      event.preventDefault()
      markSelectedSegments()
      return
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      const direction = event.key === 'ArrowLeft' ? -1 : 1
      setPlayhead(playheadSeconds + direction * (event.shiftKey ? 1 : 1 / spec.fps))
    }
  }

  function handleTimelinePaste(event: ReactClipboardEvent<HTMLElement>) {
    const target = event.target as HTMLElement
    if (target.matches('input, textarea, select, [contenteditable="true"]')) return
    const image = Array.from(event.clipboardData.files).find((file) => file.type.startsWith('image/'))
    if (!image) return
    event.preventDefault()
    uploadMutation.mutate({ file: image, track: 'image' })
  }

  return (
    <section className="glass-surface overflow-hidden rounded-2xl bg-[#303136] text-white outline-none" tabIndex={0} onKeyDown={handleTimelineKeyDown} onPaste={handleTimelinePaste}>
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
          <GlassButton size="sm" variant="ghost" onClick={exportTimeline}>{t('exportTimeline')}</GlassButton>
          <GlassButton size="sm" variant="ghost" onClick={() => importTimelineInputRef.current?.click()}>{t('importTimeline')}</GlassButton>
          <input
            ref={importTimelineInputRef}
            className="hidden"
            type="file"
            accept="application/json,.json"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void importTimeline(file)
              event.target.value = ''
            }}
          />
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
              aspectRatio: effectiveAspectRatio,
              resolutionPreset: event.target.value as LtxDirectorResolutionPreset,
            })}
          >
            <option value="480p">480p</option>
            <option value="720p">720p</option>
            <option value="1080p">1080p</option>
          </select>
          <span className="block text-[10px] text-[var(--glass-text-tertiary)]">
            {t('adaptiveSize', { ratio: effectiveAspectRatio, width: dimensions.width, height: dimensions.height })}
          </span>
        </label>
        <label className="space-y-1.5 text-xs text-[var(--glass-text-secondary)] md:col-span-3">
          <span>{t('globalPrompt')}</span>
          <GlassTextarea
            rows={Math.max(2, Math.round((spec.globalPropHeight ?? 60) / 24))}
            value={spec.globalPrompt}
            placeholder={t('globalPromptPlaceholder')}
            onChange={(event) => patchSpec({ globalPrompt: event.target.value })}
          />
        </label>
        <div className="md:col-span-3">
          <button
            type="button"
            className="text-xs font-medium text-[var(--glass-accent-from)]"
            onClick={() => setAdvancedOpen((current) => !current)}
          >
            {advancedOpen ? '▾' : '▸'} {t('advancedSettings')}
          </button>
          {advancedOpen && (
            <div className="mt-3 grid gap-3 rounded-xl border border-[var(--glass-stroke-base)] bg-black/10 p-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="space-y-1 text-xs text-[var(--glass-text-secondary)]">
                <span>{t('displayMode')}</span>
                <select
                  className="glass-input-base h-9 w-full rounded-lg px-3 text-sm"
                  value={spec.displayMode ?? 'seconds'}
                  onChange={(event) => patchSpec({ displayMode: event.target.value as 'seconds' | 'frames' })}
                >
                  <option value="seconds">{t('displaySeconds')}</option>
                  <option value="frames">{t('displayFrames')}</option>
                </select>
              </label>
              <label className="space-y-1 text-xs text-[var(--glass-text-secondary)]">
                <span>{t('resizeMethod')}</span>
                <select
                  className="glass-input-base h-9 w-full rounded-lg px-3 text-sm"
                  value={spec.resizeMethod ?? 'maintain aspect ratio'}
                  onChange={(event) => patchSpec({
                    resizeMethod: event.target.value as NonNullable<LtxDirectorTimelineSpec['resizeMethod']>,
                  })}
                >
                  <option value="maintain aspect ratio">{t('resizeMaintain')}</option>
                  <option value="crop">{t('resizeCrop')}</option>
                  <option value="pad">{t('resizePad')}</option>
                  <option value="pad green">{t('resizePadGreen')}</option>
                  <option value="stretch to fit">{t('resizeStretch')}</option>
                </select>
              </label>
              <label className="space-y-1 text-xs text-[var(--glass-text-secondary)]">
                <span>{t('divisibleBy')}</span>
                <select
                  className="glass-input-base h-9 w-full rounded-lg px-3 text-sm"
                  value={spec.divisibleBy ?? 32}
                  onChange={(event) => patchSpec({ divisibleBy: Number(event.target.value) as 8 | 16 | 32 | 64 })}
                >
                  {[8, 16, 32, 64].map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <label className="space-y-1 text-xs text-[var(--glass-text-secondary)]">
                <span>{t('imageCompression')}</span>
                <GlassInput
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  value={spec.imageCompression ?? 18}
                  onChange={(event) => patchSpec({ imageCompression: Math.min(100, Math.max(0, Number(event.target.value) || 0)) })}
                />
              </label>
              <label className="space-y-1 text-xs text-[var(--glass-text-secondary)]">
                <span>{t('epsilon')}</span>
                <GlassInput
                  type="number"
                  min={0.000001}
                  max={1}
                  step={0.0001}
                  value={spec.epsilon ?? 0.001}
                  onChange={(event) => patchSpec({ epsilon: Math.min(1, Math.max(0.000001, Number(event.target.value) || 0.001)) })}
                />
              </label>
              <label className="space-y-1 text-xs text-[var(--glass-text-secondary)]">
                <span>全局提示词高度</span>
                <GlassInput type="number" min={48} max={360} step={8} value={spec.globalPropHeight ?? 60} onChange={(event) => patchSpec({ globalPropHeight: Math.min(360, Math.max(48, Number(event.target.value) || 60)) })} />
              </label>
              <label className="space-y-1 text-xs text-[var(--glass-text-secondary)]">
                <span>片段提示词高度</span>
                <GlassInput type="number" min={72} max={480} step={8} value={spec.propHeight ?? 90} onChange={(event) => patchSpec({ propHeight: Math.min(480, Math.max(72, Number(event.target.value) || 90)) })} />
              </label>
              {([
                ['mainTrackEnabled', 'mainTrack'],
                ['audioTrackEnabled', 'audioTrack'],
                ['motionTrackEnabled', 'motionTrack'],
                ['showFilenames', 'showFilenames'],
                ['useCustomAudio', 'useCustomAudio'],
                ['inpaintAudio', 'inpaintAudio'],
                ['useCustomMotion', 'useCustomMotion'],
                ['overrideAudio', 'overrideAudio'],
              ] as const).map(([field, label]) => (
                <label key={field} className="flex items-center gap-2 text-xs text-[var(--glass-text-secondary)]">
                  <input
                    type="checkbox"
                    checked={spec[field] ?? (field === 'mainTrackEnabled' || field === 'motionTrackEnabled'
                      || field === 'showFilenames' || field === 'inpaintAudio' || field === 'useCustomMotion')}
                    onChange={(event) => patchSpec({ [field]: event.target.checked })}
                  />
                  {t(label)}
                </label>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="hidden" aria-hidden="true">
        <input
          ref={uploadInputRef}
          type="file"
          accept="image/*"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) uploadMutation.mutate({ file, track: 'image' })
            event.target.value = ''
          }}
        />
        <input
          ref={mainVideoUploadInputRef}
          type="file"
          accept="video/*,.avi,.m4v,.mkv,.mov,.mp4,.webm"
          multiple
          onChange={(event) => {
            for (const file of Array.from(event.target.files ?? []).slice(0, Math.max(0, 64 - spec.segments.length))) {
              uploadMutation.mutate({ file, track: 'mainVideo' })
            }
            event.target.value = ''
          }}
        />
        <input
          ref={motionUploadInputRef}
          type="file"
          accept="image/*,video/*,.avi,.m4v,.mkv,.mov,.mp4,.webm"
          multiple
          onChange={(event) => {
            for (const file of Array.from(event.target.files ?? []).slice(0, Math.max(0, 64 - (spec.motionSegments?.length ?? 0)))) {
              uploadMutation.mutate({ file, track: isImageFile(file) ? 'motionImage' : 'motion' })
            }
            event.target.value = ''
          }}
        />
        <input
          ref={audioUploadInputRef}
          type="file"
          accept="audio/*,.aac,.flac,.m4a,.mp3,.ogg,.wav,.webm"
          multiple
          onChange={(event) => {
            for (const file of Array.from(event.target.files ?? []).slice(0, Math.max(0, 64 - (spec.audioSegments?.length ?? 0)))) {
              uploadMutation.mutate({ file, track: 'audio' })
            }
            event.target.value = ''
          }}
        />
        <input
          ref={retakeUploadInputRef}
          type="file"
          accept="video/*,.avi,.m4v,.mkv,.mov,.mp4,.webm"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) uploadMutation.mutate({ file, track: 'retake' })
            event.target.value = ''
          }}
        />
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-b border-white/10 bg-[#24262b] px-3 py-2 text-xs text-white/85">
        <button
          type="button"
          className="rounded border border-white/15 bg-[#34363c] px-2.5 py-1.5 hover:bg-[#41444b]"
          disabled={uploadMutation.isPending}
          onClick={() => uploadInputRef.current?.click()}
        >
          ⇧ 添加图片
        </button>
        <button
          type="button"
          className="rounded border border-white/15 bg-[#34363c] px-2.5 py-1.5 hover:bg-[#41444b]"
          disabled={spec.segments.length >= 64}
          onClick={() => addTextSegment()}
        >
          T 添加文本
        </button>
        <button
          type="button"
          className="rounded border border-white/15 bg-[#34363c] px-2.5 py-1.5 hover:bg-[#41444b]"
          disabled={uploadMutation.isPending}
          onClick={() => audioUploadInputRef.current?.click()}
        >
          ♫ 添加音频
        </button>
        <button
          type="button"
          className="rounded border border-white/15 bg-[#34363c] px-2.5 py-1.5 hover:bg-[#41444b]"
          disabled={uploadMutation.isPending}
          onClick={() => mainVideoUploadInputRef.current?.click()}
        >
          ▣ 添加视频
        </button>
        <button
          type="button"
          className="rounded border border-white/15 bg-[#34363c] px-2.5 py-1.5 hover:bg-[#41444b]"
          disabled={uploadMutation.isPending}
          onClick={() => motionUploadInputRef.current?.click()}
        >
          ▣ 添加 IC‑LoRA
        </button>
        <button
          type="button"
          className="rounded border border-white/15 bg-[#34363c] px-2.5 py-1.5 text-red-200 hover:bg-red-500/20 disabled:opacity-35"
          disabled={!selectedSegment && !selectedAuxiliary && selectedSegmentIds.length === 0}
          onClick={() => {
            if (selectedAuxiliary) removeSelectedAuxiliary()
            else removeSelectedSegments()
          }}
        >
          ♜ 删除
        </button>
        <button
          type="button"
          className={`rounded border px-2.5 py-1.5 ${sourceDrawerOpen ? 'border-cyan-300/50 bg-cyan-400/20 text-cyan-100' : 'border-white/15 bg-[#34363c]'}`}
          onClick={() => setSourceDrawerOpen((current) => !current)}
        >
          ▦ 项目素材
        </button>
        <button
          type="button"
          className={`rounded border px-2.5 py-1.5 ${previewOpen ? 'border-cyan-300/50 bg-cyan-400/20 text-cyan-100' : 'border-white/15 bg-[#34363c]'}`}
          onClick={() => setPreviewOpen((current) => !current)}
        >
          ◫ 预览
        </button>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            className={`rounded border px-2.5 py-1.5 ${spec.retakeEnabled ? 'border-cyan-300/50 bg-cyan-400/20 text-cyan-100' : 'border-white/15 bg-[#34363c]'}`}
            onClick={() => {
              if (spec.retakeEnabled) patchSpec({ retakeEnabled: false })
              else if (spec.retakeVideoMediaId) patchSpec({ retakeEnabled: true })
              else retakeUploadInputRef.current?.click()
            }}
          >
            ↻ Retake Mode
          </button>
          <button
            type="button"
            title="吸附 S"
            className={`rounded border px-2.5 py-1.5 ${magneticFill ? 'border-cyan-300/50 bg-cyan-400/20 text-cyan-100' : 'border-white/15 bg-[#34363c]'}`}
            onClick={toggleMagneticFill}
          >
            🧲
          </button>
          <button type="button" title="设置入点 I" className="rounded border border-white/15 bg-[#34363c] px-2.5 py-1.5" onClick={markRangeStart}>{'{'}</button>
          <button type="button" title="设置出点 O" className="rounded border border-white/15 bg-[#34363c] px-2.5 py-1.5" onClick={markRangeEnd}>{'}'}</button>
          <button type="button" title="标记选择 X" className="rounded border border-white/15 bg-[#34363c] px-2.5 py-1.5" onClick={markSelectedSegments}>{'{ }'}</button>
          <button type="button" title="快捷键" className="rounded border border-white/15 bg-[#34363c] px-2.5 py-1.5" onClick={() => setHelpOpen(true)}>?</button>
          <button type="button" title="设置" className="rounded border border-white/15 bg-[#34363c] px-2.5 py-1.5" onClick={() => setAdvancedOpen((current) => !current)}>⚙</button>
        </div>
      </div>

      <div className="min-h-[570px]">
        <aside className={sourceDrawerOpen
          ? 'border-b border-[var(--glass-stroke-base)] bg-[#202126] p-3'
          : 'hidden'}>
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-[var(--glass-text-secondary)]">
              {t('mediaPool')}
            </div>
            <span className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-[var(--glass-text-tertiary)]">LTX Director 2</span>
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

          <div className="mt-3 flex max-w-full gap-2 overflow-x-auto pb-2">
            {sources.map((source) => (
              <button
                key={source.key}
                type="button"
                draggable
                className="w-[128px] min-w-[128px] rounded-lg border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] p-1.5 text-left transition hover:border-[var(--glass-stroke-strong)]"
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
          <div className={`${previewOpen ? 'grid' : 'hidden'} mb-3 gap-3 rounded-xl border border-white/10 bg-[#111318] p-3 md:grid-cols-[minmax(280px,0.7fr)_minmax(280px,1fr)]`}>
            <div className="relative aspect-video overflow-hidden rounded-lg bg-black shadow-inner">
              {spec.retakeEnabled && spec.retakeVideoUrl ? (
                <video
                  ref={mainPreviewVideoRef}
                  className="h-full w-full object-contain"
                  src={spec.retakeVideoUrl}
                  playsInline
                  preload="auto"
                />
              ) : activeMainSegment?.type === 'video' && activeMainSegment.sourceUrl ? (
                <video
                  key={activeMainSegment.id}
                  ref={mainPreviewVideoRef}
                  className="h-full w-full object-contain"
                  src={activeMainSegment.sourceUrl}
                  muted={activeMainSegment.linkedAudio === false}
                  playsInline
                  preload="auto"
                />
              ) : activeMainSegment?.type === 'text' ? (
                <div className="flex h-full items-center justify-center bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950 px-8 text-center text-sm leading-6 text-white/80">
                  {activeMainSegment.prompt || 'Text to video'}
                </div>
              ) : activeMainSource ? (
                <Image src={activeMainSource.imageUrl} alt="Timeline preview" fill sizes="720px" unoptimized className="object-contain" />
              ) : (
                <div className="flex h-full items-center justify-center text-xs text-white/35">Timeline Preview</div>
              )}
              <div className="absolute bottom-2 left-2 rounded bg-black/70 px-2 py-1 font-mono text-[10px] text-white/75">
                {playheadSeconds.toFixed(2)}s · {Math.round(playheadSeconds * spec.fps)}f
              </div>
            </div>
            <div className="flex min-h-0 flex-col">
              <div className="mb-2 flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.15em] text-white/45">
                <span>{activeMainSegment ? `Segment ${activeMainIndex + 1}` : 'No segment'}</span>
                <span>{activeMainSegment?.type?.toUpperCase() || 'IMAGE'}</span>
              </div>
              <GlassTextarea
                rows={Math.max(4, Math.round((spec.propHeight ?? 90) / 20))}
                value={activeMainSegment?.prompt ?? ''}
                disabled={!activeMainSegment}
                placeholder="Segment Prompt"
                onChange={(event) => {
                  if (activeMainIndex >= 0) patchSegment(activeMainIndex, { prompt: event.target.value })
                }}
              />
              <div className="mt-2 text-[10px] leading-4 text-white/40">
                播放头进入片段时同步预览画面与原视频音频；音频轨按时间位置同步播放。
              </div>
            </div>
            {(spec.audioSegments ?? []).map((segment) => (
              <audio
                key={`preview-audio-${segment.id}`}
                ref={(element) => {
                  if (!segment.id) return
                  if (element) audioPreviewRefs.current.set(segment.id, element)
                  else audioPreviewRefs.current.delete(segment.id)
                }}
                className="hidden"
                src={segment.sourceUrl}
                preload="auto"
              />
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-sm font-semibold text-[var(--glass-text-primary)]">{t('timeline')}</div>
              <div className="text-[11px] text-[var(--glass-text-tertiary)]">{t('timelineHint')}</div>
            </div>
            <div className="flex flex-wrap gap-2">
              <GlassButton key={`undo-${historyVersion}`} size="sm" variant="ghost" disabled={undoStackRef.current.length === 0} onClick={undoTimeline}>
                ↶ {t('undo')}
              </GlassButton>
              <GlassButton size="sm" variant="ghost" disabled={redoStackRef.current.length === 0} onClick={redoTimeline}>
                ↷ {t('redo')}
              </GlassButton>
              <GlassButton
                size="sm"
                variant="ghost"
                disabled={totalDuration <= 0}
                onClick={() => {
                  if (playheadSeconds >= totalDuration) setPlayheadSeconds(0)
                  setPlaying((current) => !current)
                }}
              >
                {playing ? `⏸ ${t('pause')}` : `▶ ${t('play')}`}
              </GlassButton>
              <GlassButton
                size="sm"
                variant={loopPlayback ? 'primary' : 'ghost'}
                onClick={() => setLoopPlayback((current) => !current)}
              >
                ↻ {t('loop')}
              </GlassButton>
              <GlassButton
                size="sm"
                variant={spec.retakeEnabled ? 'primary' : 'ghost'}
                onClick={() => {
                  if (spec.retakeEnabled) patchSpec({ retakeEnabled: false })
                  else if (spec.retakeVideoMediaId) patchSpec({ retakeEnabled: true })
                  else retakeUploadInputRef.current?.click()
                }}
              >
                ↻ Retake
              </GlassButton>
              <GlassButton size="sm" variant={spec.useCustomAudio ? 'primary' : 'ghost'} onClick={() => patchSpec({
                useCustomAudio: !spec.useCustomAudio,
                audioTrackEnabled: !spec.useCustomAudio ? true : spec.audioTrackEnabled,
              })}>
                Audio {spec.useCustomAudio ? 'ON' : 'OFF'}
              </GlassButton>
              <GlassButton size="sm" variant={spec.inpaintAudio !== false ? 'primary' : 'ghost'} disabled={!spec.useCustomAudio} onClick={() => patchSpec({ inpaintAudio: spec.inpaintAudio === false })}>
                Inpaint {spec.inpaintAudio !== false ? 'ON' : 'OFF'}
              </GlassButton>
              <GlassButton size="sm" variant="ghost" disabled={spec.segments.length >= 64} onClick={() => splitAtPlayhead()}>
                ✂ {t('splitAtPlayhead')}
              </GlassButton>
              <GlassButton
                size="sm"
                variant={magneticFill ? 'primary' : 'ghost'}
                title={t('magneticFillHint')}
                onClick={toggleMagneticFill}
              >
                🧲 {t('magneticFill')}
              </GlassButton>
              <GlassButton size="sm" variant="ghost" disabled={spec.segments.length >= 64} onClick={() => appendSource()}>
                + {t('addShot')}
              </GlassButton>
            </div>
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
              <GlassButton size="sm" variant="ghost" disabled={totalDuration <= 0} onClick={markRangeStart}>
                {'{'} {t('markIn')}
              </GlassButton>
              <GlassButton size="sm" variant="ghost" disabled={playheadSeconds <= 0} onClick={markRangeEnd}>
                {'}'} {t('markOut')}
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
              <label className="ml-auto w-32 text-[10px] text-[var(--glass-text-tertiary)]">
                {t('timelineZoom')}
                <input
                  className="h-7 w-full accent-[var(--glass-accent-from)]"
                  type="range"
                  min={16}
                  max={128}
                  step={8}
                  value={timelineScale}
                  onChange={(event) => setTimelineScale(Number(event.target.value))}
                />
              </label>
              <GlassButton size="sm" variant="ghost" onClick={fitTimeline}>{t('fitTimeline')}</GlassButton>
              <GlassButton size="sm" variant="ghost" onClick={() => setHelpOpen(true)}>?</GlassButton>
            </div>
            <div
              ref={timelineScrollRef}
              className="overflow-x-auto"
            >
            <div
              ref={timelineTrackRef}
              className="relative min-w-max overflow-hidden rounded-lg border border-white/5 bg-black/25"
              style={{
                width: `${timelineWidth}px`,
                minHeight: `${220
                  + (spec.motionTrackEnabled !== false ? 60 : 0)
                  + (spec.audioTrackEnabled === true ? 60 : 0)}px`,
              }}
              onContextMenu={(event) => {
                if (event.target !== event.currentTarget) return
                event.preventDefault()
                const rect = event.currentTarget.getBoundingClientRect()
                setContextMenu({
                  x: event.clientX,
                  y: event.clientY,
                  timelineSeconds: Math.max(0, (event.clientX - rect.left) / timelineScale),
                })
              }}
            >
              <div className="absolute inset-x-0 top-0 h-7 border-b border-white/10 bg-black/20">
                {rulerTicks.map((tick) => (
                  <div
                    key={tick}
                    className="absolute inset-y-0 border-l border-white/15 pl-1 pt-1 text-[9px] text-white/45"
                    style={{ left: `${tick * timelineScale}px` }}
                  >
                    {(spec.displayMode ?? 'seconds') === 'frames' ? `${tick * spec.fps}f` : `${tick}s`}
                  </div>
                ))}
                <button
                  type="button"
                  aria-label={t('setPlayhead')}
                  className="absolute inset-0 cursor-crosshair"
                  onPointerDown={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect()
                    setPlayhead((event.clientX - rect.left) / timelineScale)
                  }}
                />
              </div>
              {rangeSelected && (
                <div
                  className="pointer-events-none absolute bottom-0 top-7 border-x border-[var(--glass-accent-from)]/80 bg-[var(--glass-accent-from)]/10"
                  style={{
                    left: `${rangeStart * timelineScale}px`,
                    width: `${Math.max(2, (rangeEnd - rangeStart) * timelineScale)}px`,
                  }}
                />
              )}
              <div
                className="pointer-events-none absolute bottom-0 top-0 z-20 w-px bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.8)]"
                style={{ left: `${playheadSeconds * timelineScale}px` }}
              >
                <div className="absolute -left-1.5 top-0 h-0 w-0 border-x-[6px] border-t-[8px] border-x-transparent border-t-red-400" />
              </div>
              {spec.retakeEnabled && spec.retakeVideoUrl ? (
                <div className="absolute left-0 right-0 top-10 h-[156px] overflow-hidden rounded-xl border border-amber-400/35 bg-amber-950/20">
                  <video className="h-full w-full object-cover opacity-55" src={spec.retakeVideoUrl} muted preload="metadata" />
                  <div className="absolute inset-y-0 border-x-2 border-amber-300 bg-amber-300/15 shadow-[0_0_18px_rgba(252,211,77,0.18)]"
                    style={{
                      left: `${(spec.retakeStartSeconds ?? 0) * timelineScale}px`,
                      width: `${Math.max(8, (spec.retakeDurationSeconds ?? 1) * timelineScale)}px`,
                    }}
                    onPointerDown={(event) => beginRetakeGesture(event, 'move')}
                    onPointerMove={updateRetakeGesture}
                    onPointerUp={endRetakeGesture}
                    onPointerCancel={endRetakeGesture}
                  >
                    <div className="absolute left-2 top-2 rounded bg-amber-950/85 px-2 py-1 text-[10px] font-semibold text-amber-100">RETAKE</div>
                    <div
                      className="absolute inset-y-0 left-0 w-2 cursor-ew-resize bg-amber-200/35"
                      onPointerDown={(event) => beginRetakeGesture(event, 'left')}
                      onPointerMove={updateRetakeGesture}
                      onPointerUp={endRetakeGesture}
                      onPointerCancel={endRetakeGesture}
                    />
                    <div
                      className="absolute inset-y-0 right-0 w-2 cursor-ew-resize bg-amber-200/35"
                      onPointerDown={(event) => beginRetakeGesture(event, 'right')}
                      onPointerMove={updateRetakeGesture}
                      onPointerUp={endRetakeGesture}
                      onPointerCancel={endRetakeGesture}
                    />
                  </div>
                </div>
              ) : spec.segments.map((segment, index) => {
                const source = resolveSegmentSource(segment)
                const start = startOfSegment(spec.segments, index)
                const segmentType = segment.type ?? 'image'
                return (
                  <div
                    key={segment.id || index}
                    className={`group absolute top-10 flex h-[156px] touch-none cursor-grab flex-col overflow-hidden rounded-xl border text-left shadow-lg transition active:cursor-grabbing ${
                      (segment.id && selectedSegmentIds.includes(segment.id)) || selectedIndex === index
                        ? 'border-[var(--glass-accent-from)] ring-2 ring-[var(--glass-accent-from)]/20'
                        : 'border-[var(--glass-stroke-base)] hover:border-[var(--glass-stroke-strong)]'
                    } bg-[var(--glass-bg-surface)]`}
                    style={{
                      left: `${start * timelineScale}px`,
                      width: `${Math.max(24, segment.durationSeconds * timelineScale)}px`,
                    }}
                    onClick={(event) => selectMainSegment(index, event.metaKey || event.ctrlKey || event.shiftKey)}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      selectMainSegment(index, false)
                      setContextMenu({
                        x: event.clientX,
                        y: event.clientY,
                        segmentId: segment.id,
                        timelineSeconds: start,
                      })
                    }}
                    onPointerDown={(event) => beginSegmentDrag(event, index)}
                    onPointerMove={dragSegment}
                    onPointerUp={endSegmentDrag}
                    onPointerCancel={endSegmentDrag}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => dropOnSegment(event, index)}
                  >
                    <div className="relative h-[86px] w-full bg-black/70">
                      {segmentType === 'video' && segment.sourceUrl ? (
                        <video
                          className="h-full w-full object-cover"
                          src={segment.sourceUrl}
                          muted
                          preload="metadata"
                          draggable={false}
                        />
                      ) : segmentType === 'text' ? (
                        <div className="flex h-full items-center justify-center bg-gradient-to-br from-slate-900 to-slate-800 px-4 text-center text-xs text-white/75">
                          {segment.prompt || 'Text to video'}
                        </div>
                      ) : source ? (
                        <Image src={source.imageUrl} alt={t('shot', { number: index + 1 })} fill sizes="240px" unoptimized draggable={false} className="object-cover" />
                      ) : (
                        <div className="flex h-full items-center justify-center px-4 text-center text-xs text-white/60">{t('dropImageHere')}</div>
                      )}
                      <div className="absolute left-2 top-2 rounded bg-black/65 px-1.5 py-0.5 text-[10px] text-white">
                        {start.toFixed(1)}–{(start + segment.durationSeconds).toFixed(1)}s
                      </div>
                    </div>
                    <div className="flex min-h-[68px] flex-1 flex-col p-2">
                      <div className="flex items-center justify-between gap-2 text-[11px]">
                        <span className="font-semibold text-[var(--glass-text-primary)]">
                          {segmentType === 'video' ? 'VIDEO' : segmentType === 'text' ? 'TEXT' : t('shot', { number: index + 1 })}
                        </span>
                        <span className="text-[var(--glass-text-tertiary)]">{segment.durationSeconds.toFixed(1)}s</span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-[10px] leading-4 text-[var(--glass-text-secondary)]">
                        {segment.prompt || t('promptEmpty')}
                      </p>
                    </div>
                    <div
                      role="separator"
                      aria-label="Trim segment start"
                      className="absolute bottom-0 left-0 top-0 w-3 cursor-ew-resize border-r border-white/20 bg-white/5 opacity-0 transition group-hover:opacity-100"
                      onPointerDown={(event) => beginResize(event, index, 'left')}
                      onPointerMove={resizeSegment}
                      onPointerUp={endResize}
                      onPointerCancel={endResize}
                    />
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
              {spec.motionTrackEnabled !== false && (
                <>
                  <div className="absolute left-0 right-0 top-[202px] h-[52px] border-y border-emerald-400/15 bg-emerald-400/5" />
                  <div className="absolute left-1 top-[205px] z-30 flex items-center gap-1 rounded bg-black/80 px-1.5 py-0.5 text-[9px] text-emerald-300">
                    <span>{t('motionTrack')}</span>
                    <button
                      type="button"
                      className="rounded bg-emerald-400/20 px-1 text-emerald-100 hover:bg-emerald-400/40"
                      title="添加 IC‑LoRA 图片或视频"
                      onClick={() => motionUploadInputRef.current?.click()}
                    >
                      ＋
                    </button>
                  </div>
                  {(spec.motionSegments ?? []).map((segment, index) => (
                    <div
                      key={segment.id || `motion-${index}`}
                      className={`group absolute top-[206px] z-10 flex h-11 touch-none cursor-grab items-center overflow-hidden rounded-md border bg-emerald-950/85 px-2 text-[10px] text-emerald-100 active:cursor-grabbing ${
                        selectedAuxiliary?.track === 'motion' && selectedAuxiliary.id === segment.id
                          ? 'border-emerald-200 ring-2 ring-emerald-300/30'
                          : 'border-emerald-400/50'
                      }`}
                      style={{
                        left: `${segment.startSeconds * timelineScale}px`,
                        width: `${Math.max(48, segment.durationSeconds * timelineScale)}px`,
                      }}
                      onPointerDown={(event) => beginAuxiliaryGesture(event, 'motion', index, 'move')}
                      onPointerMove={updateAuxiliaryGesture}
                      onPointerUp={endAuxiliaryGesture}
                      onPointerCancel={endAuxiliaryGesture}
                    >
                      <span className="min-w-0 flex-1 truncate">{spec.showFilenames === false ? t('motionClip') : segment.filename || t('motionClip')}</span>
                      <button
                        type="button"
                        className="ml-1 text-emerald-200/70 hover:text-white"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation()
                          patchSpec({ motionSegments: (spec.motionSegments ?? []).filter((_, itemIndex) => itemIndex !== index) })
                        }}
                      >
                        ×
                      </button>
                      <div
                        role="separator"
                        aria-label="Trim motion start"
                        className="absolute bottom-0 left-0 top-0 w-2 cursor-ew-resize border-r border-emerald-200/30 bg-white/5 opacity-0 group-hover:opacity-100"
                        onPointerDown={(event) => beginAuxiliaryGesture(event, 'motion', index, 'resizeLeft')}
                        onPointerMove={updateAuxiliaryGesture}
                        onPointerUp={endAuxiliaryGesture}
                        onPointerCancel={endAuxiliaryGesture}
                      />
                      <div
                        role="separator"
                        aria-label={t('resizeMotion')}
                        className="absolute bottom-0 right-0 top-0 w-2 cursor-ew-resize border-l border-emerald-200/30 bg-white/5 opacity-0 group-hover:opacity-100"
                        onPointerDown={(event) => beginAuxiliaryGesture(event, 'motion', index, 'resizeRight')}
                        onPointerMove={updateAuxiliaryGesture}
                        onPointerUp={endAuxiliaryGesture}
                        onPointerCancel={endAuxiliaryGesture}
                      />
                    </div>
                  ))}
                </>
              )}
              {spec.audioTrackEnabled === true && (
                <>
                  <div
                    className="absolute left-0 right-0 h-[52px] border-y border-violet-400/15 bg-violet-400/5"
                    style={{ top: `${spec.motionTrackEnabled !== false ? 262 : 202}px` }}
                  />
                  <div
                    className="absolute left-1 z-30 flex items-center gap-1 rounded bg-black/80 px-1.5 py-0.5 text-[9px] text-violet-300"
                    style={{ top: `${spec.motionTrackEnabled !== false ? 265 : 205}px` }}
                  >
                    <span>{t('audioTrack')}</span>
                    <button
                      type="button"
                      className="rounded bg-violet-400/20 px-1 text-violet-100 hover:bg-violet-400/40"
                      title="添加音频"
                      onClick={() => audioUploadInputRef.current?.click()}
                    >
                      ＋
                    </button>
                  </div>
                  {(spec.audioSegments ?? []).map((segment, index) => (
                    <div
                      key={segment.id || `audio-${index}`}
                      className={`group absolute z-10 flex h-11 touch-none cursor-grab items-center overflow-hidden rounded-md border bg-violet-950/85 px-2 text-[10px] text-violet-100 active:cursor-grabbing ${
                        selectedAuxiliary?.track === 'audio' && selectedAuxiliary.id === segment.id
                          ? 'border-violet-200 ring-2 ring-violet-300/30'
                          : 'border-violet-400/50'
                      }`}
                      style={{
                        top: `${spec.motionTrackEnabled !== false ? 266 : 206}px`,
                        left: `${segment.startSeconds * timelineScale}px`,
                        width: `${Math.max(48, segment.durationSeconds * timelineScale)}px`,
                      }}
                      onPointerDown={(event) => beginAuxiliaryGesture(event, 'audio', index, 'move')}
                      onPointerMove={updateAuxiliaryGesture}
                      onPointerUp={endAuxiliaryGesture}
                      onPointerCancel={endAuxiliaryGesture}
                    >
                      <div className="pointer-events-none absolute inset-1 flex items-center gap-px opacity-35">
                        {(audioWaveforms[segment.id || '']?.length ? audioWaveforms[segment.id || ''] : Array.from({ length: 32 }, (_, itemIndex) => 0.2 + ((itemIndex * 17) % 9) / 12)).map((peak, peakIndex) => (
                          <span key={peakIndex} className="min-w-px flex-1 rounded-full bg-violet-200" style={{ height: `${Math.max(8, peak * 100)}%` }} />
                        ))}
                      </div>
                      <span className="relative z-10 min-w-0 flex-1 truncate rounded bg-black/35 px-1">{spec.showFilenames === false ? t('audioClip') : segment.filename || t('audioClip')}</span>
                      <button
                        type="button"
                        className="ml-1 text-violet-200/70 hover:text-white"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation()
                          patchSpec({ audioSegments: (spec.audioSegments ?? []).filter((_, itemIndex) => itemIndex !== index) })
                        }}
                      >
                        ×
                      </button>
                      <div
                        role="separator"
                        aria-label="Trim audio start"
                        className="absolute bottom-0 left-0 top-0 w-2 cursor-ew-resize border-r border-violet-200/30 bg-white/5 opacity-0 group-hover:opacity-100"
                        onPointerDown={(event) => beginAuxiliaryGesture(event, 'audio', index, 'resizeLeft')}
                        onPointerMove={updateAuxiliaryGesture}
                        onPointerUp={endAuxiliaryGesture}
                        onPointerCancel={endAuxiliaryGesture}
                      />
                      <div
                        role="separator"
                        aria-label={t('resizeAudio')}
                        className="absolute bottom-0 right-0 top-0 w-2 cursor-ew-resize border-l border-violet-200/30 bg-white/5 opacity-0 group-hover:opacity-100"
                        onPointerDown={(event) => beginAuxiliaryGesture(event, 'audio', index, 'resizeRight')}
                        onPointerMove={updateAuxiliaryGesture}
                        onPointerUp={endAuxiliaryGesture}
                        onPointerCancel={endAuxiliaryGesture}
                      />
                    </div>
                  ))}
                </>
              )}
            </div>
            </div>
            <div className="mt-2 flex min-w-[680px] items-center gap-2 text-[10px] text-[var(--glass-text-tertiary)]">
              <span>{t('playhead')}: {playheadSeconds.toFixed(2)}s / {Math.round(playheadSeconds * spec.fps)}f</span>
              <button type="button" className="text-[var(--glass-accent-from)]" onClick={() => setPlayhead(0)}>{t('goStart')}</button>
              <button type="button" className="text-[var(--glass-accent-from)]" onClick={() => setPlayhead(totalDuration)}>{t('goEnd')}</button>
              <span className="ml-auto">{t('shortcutHint')}</span>
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

          {((spec.motionSegments?.length ?? 0) > 0 || (spec.audioSegments?.length ?? 0) > 0 || spec.retakeEnabled) && (
            <div className="mt-4 grid gap-3 lg:grid-cols-2">
              {(spec.motionSegments ?? []).map((segment, index) => (
                <div key={segment.id || `motion-editor-${index}`} className="rounded-xl border border-emerald-400/25 bg-emerald-950/10 p-3">
                  <div className="mb-2 flex items-center justify-between text-xs font-medium text-emerald-300">
                    <span>{t('motionClip')} · {segment.filename}</span>
                    <button type="button" onClick={() => patchSpec({ motionSegments: (spec.motionSegments ?? []).filter((_, itemIndex) => itemIndex !== index) })}>×</button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="text-[10px] text-[var(--glass-text-tertiary)]">
                      {t('startTime')}
                      <GlassInput type="number" min={0} step={0.1} value={segment.startSeconds} onChange={(event) => patchMotionSegment(index, { startSeconds: Math.max(0, Number(event.target.value) || 0) })} />
                    </label>
                    <label className="text-[10px] text-[var(--glass-text-tertiary)]">
                      {t('duration')}
                      <GlassInput type="number" min={0.1} step={0.1} value={segment.durationSeconds} onChange={(event) => patchMotionSegment(index, { durationSeconds: Math.max(0.1, Number(event.target.value) || 0.1) })} />
                    </label>
                    <label className="text-[10px] text-[var(--glass-text-tertiary)]">
                      {t('trimStart')}
                      <GlassInput type="number" min={0} step={0.1} value={segment.trimStartSeconds ?? 0} onChange={(event) => patchMotionSegment(index, { trimStartSeconds: Math.max(0, Number(event.target.value) || 0) })} />
                    </label>
                    <label className="text-[10px] text-[var(--glass-text-tertiary)]">
                      {t('resampleMode')}
                      <select className="glass-input-base h-9 w-full rounded-lg px-2" value={segment.resampleMode ?? 'nearest'} onChange={(event) => patchMotionSegment(index, { resampleMode: event.target.value })}>
                        <option value="nearest">nearest</option>
                        <option value="linear">linear</option>
                      </select>
                    </label>
                    <label className="text-[10px] text-[var(--glass-text-tertiary)]">
                      {t('motionStrength')}
                      <GlassInput type="number" min={0} max={2} step={0.05} value={segment.videoStrength ?? 1} onChange={(event) => patchMotionSegment(index, { videoStrength: Number(event.target.value) })} />
                    </label>
                    <label className="text-[10px] text-[var(--glass-text-tertiary)]">
                      {t('attentionStrength')}
                      <GlassInput type="number" min={0} max={2} step={0.05} value={segment.videoAttentionStrength ?? 0.65} onChange={(event) => patchMotionSegment(index, { videoAttentionStrength: Number(event.target.value) })} />
                    </label>
                  </div>
                </div>
              ))}
              {(spec.audioSegments ?? []).map((segment, index) => (
                <div key={segment.id || `audio-editor-${index}`} className="rounded-xl border border-violet-400/25 bg-violet-950/10 p-3">
                  <div className="mb-2 flex items-center justify-between text-xs font-medium text-violet-300">
                    <span>{t('audioClip')} · {segment.filename}</span>
                    <button type="button" onClick={() => patchSpec({ audioSegments: (spec.audioSegments ?? []).filter((_, itemIndex) => itemIndex !== index) })}>×</button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="text-[10px] text-[var(--glass-text-tertiary)]">
                      {t('startTime')}
                      <GlassInput type="number" min={0} step={0.1} value={segment.startSeconds} onChange={(event) => patchAudioSegment(index, { startSeconds: Math.max(0, Number(event.target.value) || 0) })} />
                    </label>
                    <label className="text-[10px] text-[var(--glass-text-tertiary)]">
                      {t('duration')}
                      <GlassInput type="number" min={0.1} step={0.1} value={segment.durationSeconds} onChange={(event) => patchAudioSegment(index, { durationSeconds: Math.max(0.1, Number(event.target.value) || 0.1) })} />
                    </label>
                    <label className="text-[10px] text-[var(--glass-text-tertiary)]">
                      {t('trimStart')}
                      <GlassInput type="number" min={0} step={0.1} value={segment.trimStartSeconds ?? 0} onChange={(event) => patchAudioSegment(index, { trimStartSeconds: Math.max(0, Number(event.target.value) || 0) })} />
                    </label>
                  </div>
                </div>
              ))}
              {spec.retakeEnabled && (
                <div className="rounded-xl border border-amber-400/25 bg-amber-950/10 p-3 lg:col-span-2">
                  <div className="mb-2 flex items-center justify-between text-xs font-medium text-amber-300">
                    <span>{t('retakeMode')}</span>
                    <button type="button" onClick={() => patchSpec({ retakeEnabled: false })}>{t('disable')}</button>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-4">
                    <label className="text-[10px] text-[var(--glass-text-tertiary)]">
                      {t('rangeStart')}
                      <GlassInput type="number" min={0} step={0.1} value={spec.retakeStartSeconds ?? 0} onChange={(event) => patchSpec({ retakeStartSeconds: Math.max(0, Number(event.target.value) || 0) })} />
                    </label>
                    <label className="text-[10px] text-[var(--glass-text-tertiary)]">
                      {t('duration')}
                      <GlassInput type="number" min={0.1} step={0.1} value={spec.retakeDurationSeconds ?? 3} onChange={(event) => patchSpec({ retakeDurationSeconds: Math.max(0.1, Number(event.target.value) || 0.1) })} />
                    </label>
                    <label className="text-[10px] text-[var(--glass-text-tertiary)]">
                      {t('retakeStrength')}
                      <GlassInput type="number" min={0} max={2} step={0.05} value={spec.retakeStrength ?? 1} onChange={(event) => patchSpec({ retakeStrength: Math.min(2, Math.max(0, Number(event.target.value) || 0)) })} />
                    </label>
                    <label className="text-[10px] text-[var(--glass-text-tertiary)] sm:col-span-4">
                      {t('retakePrompt')}
                      <GlassTextarea rows={2} value={spec.retakePrompt ?? ''} onChange={(event) => patchSpec({ retakePrompt: event.target.value })} />
                    </label>
                  </div>
                </div>
              )}
            </div>
          )}

          {selectedSegment && (
            <div className="mt-4 rounded-xl border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-muted)] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold text-[var(--glass-text-primary)]">{t('inspectorTitle', { number: selectedIndex + 1 })}</div>
                  <div className="text-[11px] text-[var(--glass-text-tertiary)]">
                    {selectedSegment.type === 'video'
                      ? selectedSegment.filename || 'Video segment'
                      : selectedSegment.type === 'text'
                        ? 'Text segment'
                        : resolveSegmentSource(selectedSegment)?.label || t('imageMissing')}
                  </div>
                </div>
                <div className="flex gap-1">
                  <GlassButton size="sm" variant="ghost" disabled={selectedIndex === 0} onClick={() => moveSegment(selectedIndex, selectedIndex - 1)}>←</GlassButton>
                  <GlassButton size="sm" variant="ghost" disabled={selectedIndex >= spec.segments.length - 1} onClick={() => moveSegment(selectedIndex, selectedIndex + 1)}>→</GlassButton>
                  <GlassButton size="sm" variant="danger" onClick={() => removeSegment(selectedIndex)}>{t('deleteShot')}</GlassButton>
                </div>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {selectedSegment.type !== 'text' && (
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
                )}
                {selectedSegment.type === 'video' && (
                  <>
                    <label className="space-y-1 text-xs text-[var(--glass-text-secondary)]">
                      <span>素材入点</span>
                      <GlassInput
                        type="number"
                        min={0}
                        max={selectedSegment.mediaDurationSeconds ?? 600}
                        step={0.1}
                        value={selectedSegment.trimStartSeconds ?? 0}
                        onChange={(event) => patchSegment(selectedIndex, { trimStartSeconds: Math.max(0, Number(event.target.value) || 0) })}
                      />
                    </label>
                    <label className="flex items-center gap-2 text-xs text-[var(--glass-text-secondary)]">
                      <input
                        type="checkbox"
                        checked={selectedSegment.linkedAudio !== false}
                        onChange={(event) => patchSegment(selectedIndex, { linkedAudio: event.target.checked })}
                      />
                      链接原视频音频
                    </label>
                  </>
                )}
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
                    rows={Math.max(3, Math.round((spec.propHeight ?? 90) / 24))}
                    value={selectedSegment.prompt}
                    placeholder={t('shotPromptPlaceholder')}
                    onChange={(event) => patchSegment(selectedIndex, { prompt: event.target.value })}
                  />
                </label>
                {selectedSegment.type !== 'text' && (
                <label className="flex items-center gap-2 text-xs text-[var(--glass-text-secondary)] sm:col-span-2">
                  <input
                    type="checkbox"
                    checked={selectedSegment.isEndFrame === true}
                    onChange={(event) => patchSegment(selectedIndex, { isEndFrame: event.target.checked })}
                  />
                  {t('endFrame')}
                </label>
                )}
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
      {contextMenu && (
        <div className="fixed inset-0 z-[120]" onPointerDown={() => setContextMenu(null)}>
          <div
            className="fixed min-w-52 overflow-hidden rounded-xl border border-white/15 bg-[#17191f]/[0.98] p-1.5 text-xs text-white shadow-2xl backdrop-blur-xl"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            {contextMenu.segmentId ? (
              <>
                <button type="button" className="block w-full rounded-lg px-3 py-2 text-left hover:bg-white/10" onClick={() => {
                  copySelectedSegment()
                  setContextMenu(null)
                }}>复制片段 · ⌘C</button>
                <button type="button" disabled={!copiedSegmentRef.current} className="block w-full rounded-lg px-3 py-2 text-left hover:bg-white/10 disabled:opacity-35" onClick={() => {
                  pasteSegmentAt(contextMenu.timelineSeconds)
                  setContextMenu(null)
                }}>在播放头粘贴 · ⌘V</button>
                <button type="button" disabled={!copiedSegmentRef.current} className="block w-full rounded-lg px-3 py-2 text-left hover:bg-white/10 disabled:opacity-35" onClick={() => {
                  pasteSegmentAt(contextMenu.timelineSeconds, contextMenu.segmentId)
                  setContextMenu(null)
                }}>粘贴并替换</button>
                <div className="my-1 border-t border-white/10" />
                <button type="button" className="block w-full rounded-lg px-3 py-2 text-left hover:bg-white/10" onClick={() => {
                  if (selectedSegment) void navigator.clipboard.writeText(selectedSegment.prompt)
                  setContextMenu(null)
                }}>复制提示词</button>
                <button type="button" className="block w-full rounded-lg px-3 py-2 text-left hover:bg-white/10" onClick={() => {
                  void navigator.clipboard.readText().then((prompt) => {
                    if (selectedSegment) patchSegment(selectedIndex, { prompt })
                  }).catch(() => undefined)
                  setContextMenu(null)
                }}>粘贴提示词</button>
                <button type="button" className="block w-full rounded-lg px-3 py-2 text-left hover:bg-white/10" onClick={() => {
                  setPlayhead(contextMenu.timelineSeconds)
                  splitAtPlayhead(contextMenu.timelineSeconds)
                  setContextMenu(null)
                }}>在播放头分割 · S</button>
                {selectedSegment?.type === 'image' && (
                  <button type="button" className="block w-full rounded-lg px-3 py-2 text-left hover:bg-white/10" onClick={() => {
                    patchSegment(selectedIndex, { isEndFrame: !selectedSegment.isEndFrame })
                    setContextMenu(null)
                  }}>{selectedSegment.isEndFrame ? '取消尾帧' : '转换为尾帧'}</button>
                )}
                {selectedSegment?.type === 'video' && selectedSegment.linkedAudio !== false && (
                  <button type="button" className="block w-full rounded-lg px-3 py-2 text-left hover:bg-white/10" onClick={() => {
                    patchSegment(selectedIndex, { linkedAudio: false })
                    setContextMenu(null)
                  }}>取消链接音频</button>
                )}
                <button type="button" className="block w-full rounded-lg px-3 py-2 text-left hover:bg-white/10" onClick={() => {
                  markSelectedSegments()
                  setContextMenu(null)
                }}>标记所选区间 · X</button>
                <div className="my-1 border-t border-white/10" />
                <button type="button" className="block w-full rounded-lg px-3 py-2 text-left text-red-300 hover:bg-red-500/15" onClick={() => {
                  removeSelectedSegments()
                  setContextMenu(null)
                }}>删除</button>
              </>
            ) : (
              <>
                <button type="button" disabled={!copiedSegmentRef.current} className="block w-full rounded-lg px-3 py-2 text-left hover:bg-white/10 disabled:opacity-35" onClick={() => {
                  pasteSegmentAt(contextMenu.timelineSeconds)
                  setContextMenu(null)
                }}>粘贴片段</button>
                <button type="button" className="block w-full rounded-lg px-3 py-2 text-left hover:bg-white/10" onClick={() => {
                  addTextSegment(contextMenu.timelineSeconds)
                  setContextMenu(null)
                }}>＋ 纯提示词片段</button>
                <button type="button" className="block w-full rounded-lg px-3 py-2 text-left hover:bg-white/10" onClick={() => {
                  setPlayhead(contextMenu.timelineSeconds)
                  uploadInputRef.current?.click()
                  setContextMenu(null)
                }}>＋ 图片片段</button>
                <button type="button" className="block w-full rounded-lg px-3 py-2 text-left hover:bg-white/10" onClick={() => {
                  setPlayhead(contextMenu.timelineSeconds)
                  mainVideoUploadInputRef.current?.click()
                  setContextMenu(null)
                }}>＋ 视频片段</button>
              </>
            )}
          </div>
        </div>
      )}
      {helpOpen && (
        <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/65 p-6 backdrop-blur-sm" onPointerDown={() => setHelpOpen(false)}>
          <div className="w-full max-w-2xl rounded-2xl border border-white/15 bg-[#17191f] p-5 text-sm text-white shadow-2xl" onPointerDown={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h4 className="text-base font-semibold">LTX Director 快捷键</h4>
              <button type="button" className="rounded-lg px-2 py-1 text-white/60 hover:bg-white/10 hover:text-white" onClick={() => setHelpOpen(false)}>×</button>
            </div>
            <div className="mt-4 grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
              {[
                ['Space', '播放 / 暂停'], ['⌘/Ctrl+B', '在播放头分割'], ['S', '开关吸附'], ['I / O', '设置生成入点 / 出点'],
                ['X', '标记当前选择'], ['⌘/Ctrl+C', '复制片段'], ['⌘/Ctrl+V', '在播放头粘贴片段'],
                ['Delete', '删除选择'], ['⌘/Ctrl+Z', '撤销'], ['⌘/Ctrl+Shift+Z', '重做'],
                ['Shift/⌘ 点击', '多选片段'], ['拖动片段边缘', '裁切素材'], ['右键', '片段与空白区菜单'],
              ].map(([key, label]) => (
                <div key={key} className="flex items-center justify-between gap-3 rounded-lg bg-white/5 px-3 py-2">
                  <span className="font-mono text-white/85">{key}</span><span className="text-white/50">{label}</span>
                </div>
              ))}
            </div>
          </div>
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
  const episodeStoryboard = useMemo(
    () => buildEpisodeDirectorStoryboard(storyboards),
    [storyboards],
  )

  return (
    <div className="space-y-4">
      <div className="glass-surface-soft rounded-xl p-4">
        <h2 className="text-base font-semibold text-[var(--glass-text-primary)]">LTX Director</h2>
        <p className="mt-1 text-sm text-[var(--glass-text-tertiary)]">
          {t('description')} · 整集单一时间线 · {storyboards.length} 组分镜
        </p>
      </div>
      {episodeStoryboard && (
        <DirectorStoryboardEditor
          key={episodeStoryboard.id}
          projectId={projectId}
          episodeId={episodeId}
          storyboard={episodeStoryboard}
          storyboardIndex={Math.max(0, storyboards.length - 1)}
          displayNumber={1}
          clips={clips}
          models={directorModels}
          allStoryboards={storyboards}
          videoRatio={videoRatio}
        />
      )}
    </div>
  )
}
