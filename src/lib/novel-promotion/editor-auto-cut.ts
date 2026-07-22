import type { VideoEditorProject } from '@/features/video-editor/types/editor.types'

export const EDITOR_AUTO_CUT_TRANSITIONS = ['none', 'dissolve', 'fade', 'slide'] as const

export type EditorAutoCutTransition = (typeof EDITOR_AUTO_CUT_TRANSITIONS)[number]

export interface EditorAutoCutSourceClip {
  clipId: string
  panelId: string
  storyboardId: string
  sourceOrder: number
  durationSeconds: number
  description: string
  subtitleText: string
  hasVoiceAudio: boolean
}

export interface EditorAutoCutDecision {
  panelId: string
  include: boolean
  order: number
  trimStartSeconds: number
  trimEndSeconds: number
  transition: EditorAutoCutTransition
  transitionDurationSeconds: number
  subtitleStyle: 'default' | 'cinematic'
  reason: string
}

export interface EditorAutoCutPlan {
  summary: string
  rhythm: string
  decisions: EditorAutoCutDecision[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function readText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

function readFiniteNumber(value: unknown, fallback: number): number {
  const numberValue = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numberValue) ? numberValue : fallback
}

export function normalizeEditorAutoCutSourceClips(value: unknown): EditorAutoCutSourceClip[] {
  if (!Array.isArray(value)) return []
  const clips: EditorAutoCutSourceClip[] = []
  const seenPanelIds = new Set<string>()

  for (let index = 0; index < Math.min(value.length, 120); index += 1) {
    const item = value[index]
    if (!isRecord(item)) continue
    const clipId = readText(item.clipId)
    const panelId = readText(item.panelId)
    const storyboardId = readText(item.storyboardId)
    if (!clipId || !panelId || !storyboardId || seenPanelIds.has(panelId)) continue
    seenPanelIds.add(panelId)
    clips.push({
      clipId,
      panelId,
      storyboardId,
      sourceOrder: Math.max(0, Math.floor(readFiniteNumber(item.sourceOrder, index))),
      durationSeconds: Math.max(0.5, Math.min(120, readFiniteNumber(item.durationSeconds, 3))),
      description: readText(item.description).slice(0, 2000),
      subtitleText: readText(item.subtitleText).slice(0, 2000),
      hasVoiceAudio: item.hasVoiceAudio === true,
    })
  }

  return clips.sort((left, right) => left.sourceOrder - right.sourceOrder)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function normalizeTransition(value: unknown): EditorAutoCutTransition {
  return EDITOR_AUTO_CUT_TRANSITIONS.includes(value as EditorAutoCutTransition)
    ? value as EditorAutoCutTransition
    : 'none'
}

export function normalizeEditorAutoCutPlan(
  raw: unknown,
  clips: EditorAutoCutSourceClip[],
): EditorAutoCutPlan {
  if (!isRecord(raw)) throw new Error('EDITOR_AUTO_CUT_INVALID_RESPONSE')

  const sourceByPanelId = new Map(clips.map((clip) => [clip.panelId, clip]))
  const rawDecisions = Array.isArray(raw.decisions) ? raw.decisions : []
  const seenPanelIds = new Set<string>()
  const decisions: EditorAutoCutDecision[] = []

  for (const item of rawDecisions) {
    if (!isRecord(item)) continue
    const panelId = readText(item.panelId)
    const source = sourceByPanelId.get(panelId)
    if (!source || seenPanelIds.has(panelId)) continue
    seenPanelIds.add(panelId)

    const duration = Math.max(0.5, source.durationSeconds)
    const hasTimedSpeech = source.hasVoiceAudio || !!source.subtitleText
    const trimStartSeconds = hasTimedSpeech
      ? 0
      : clamp(readFiniteNumber(item.trimStartSeconds, 0), 0, Math.max(0, duration - 0.5))
    const trimEndSeconds = hasTimedSpeech
      ? duration
      : clamp(
        readFiniteNumber(item.trimEndSeconds, duration),
        trimStartSeconds + 0.5,
        duration,
      )

    decisions.push({
      panelId,
      include: item.include !== false,
      order: Math.max(0, Math.floor(readFiniteNumber(item.order, source.sourceOrder))),
      trimStartSeconds,
      trimEndSeconds,
      transition: normalizeTransition(item.transition),
      transitionDurationSeconds: clamp(readFiniteNumber(item.transitionDurationSeconds, 0), 0, 1.2),
      subtitleStyle: item.subtitleStyle === 'cinematic' ? 'cinematic' : 'default',
      reason: readText(item.reason),
    })
  }

  for (const source of clips) {
    if (seenPanelIds.has(source.panelId)) continue
    decisions.push({
      panelId: source.panelId,
      include: true,
      order: source.sourceOrder,
      trimStartSeconds: 0,
      trimEndSeconds: Math.max(0.5, source.durationSeconds),
      transition: 'none',
      transitionDurationSeconds: 0,
      subtitleStyle: 'default',
      reason: '',
    })
  }

  if (decisions.length === 0) throw new Error('EDITOR_AUTO_CUT_EMPTY_PLAN')
  if (!decisions.some((decision) => decision.include)) {
    for (const decision of decisions) decision.include = true
  }

  return {
    summary: readText(raw.summary, 'AI 已完成自动剪辑'),
    rhythm: readText(raw.rhythm),
    decisions,
  }
}

export function applyEditorAutoCutPlan(
  sourceProject: VideoEditorProject,
  plan: EditorAutoCutPlan,
  projectId = sourceProject.id,
): VideoEditorProject {
  const sourceOrder = new Map(sourceProject.timeline.map((clip, index) => [clip.metadata.panelId, index]))
  const sourceByPanelId = new Map(sourceProject.timeline.map((clip) => [clip.metadata.panelId, clip]))

  const ordered = plan.decisions
    .filter((decision) => decision.include && sourceByPanelId.has(decision.panelId))
    .sort((left, right) => {
      const orderDiff = left.order - right.order
      if (orderDiff !== 0) return orderDiff
      return (sourceOrder.get(left.panelId) || 0) - (sourceOrder.get(right.panelId) || 0)
    })

  const timeline = ordered.map((decision, index) => {
    const source = sourceByPanelId.get(decision.panelId)!
    const fps = sourceProject.config.fps
    const from = Math.max(0, Math.round(decision.trimStartSeconds * fps))
    const maxSourceFrames = Math.max(1, source.durationInFrames)
    const to = clamp(Math.round(decision.trimEndSeconds * fps), from + 1, maxSourceFrames)
    const durationInFrames = Math.max(1, to - from)
    const isLast = index === ordered.length - 1
    const transitionFrames = Math.min(
      Math.round(decision.transitionDurationSeconds * fps),
      Math.max(0, Math.floor(durationInFrames / 3)),
    )

    return {
      ...source,
      durationInFrames,
      trim: from > 0 || to < maxSourceFrames ? { from, to } : undefined,
      attachment: source.attachment ? {
        ...source.attachment,
        subtitle: source.attachment.subtitle ? {
          ...source.attachment.subtitle,
          style: decision.subtitleStyle,
        } : undefined,
      } : undefined,
      transition: !isLast && decision.transition !== 'none' && transitionFrames > 0
        ? { type: decision.transition, durationInFrames: transitionFrames }
        : undefined,
      metadata: {
        ...source.metadata,
        autoCutReason: decision.reason || undefined,
      },
    }
  })

  return {
    ...sourceProject,
    id: projectId,
    timeline,
  }
}
