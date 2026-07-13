import type { VideoPanel } from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video/types'
import { buildVideoSubmissionKey } from '@/lib/novel-promotion/stages/video-stage-runtime/immediate-video-submission'

const DEFAULT_FPS = 30
const DEFAULT_DURATION_SECONDS = 3
const MAX_TRANSITION_FRAMES = 15

export type CombinedPreviewStatus = 'video' | 'image' | 'generating' | 'failed' | 'missing'

export interface CombinedPreviewItem {
  readonly panelKey: string
  readonly panelId?: string
  readonly storyboardId: string
  readonly panelIndex: number
  readonly groupSequence?: number
  readonly gridCellIndex?: number
  readonly videoUrl: string | null
  readonly imageUrl: string | null
  readonly durationInFrames: number
  readonly startFrame: number
  readonly endFrame: number
  readonly transitionInFrames: number
  readonly transitionOutFrames: number
  readonly status: CombinedPreviewStatus
}

export interface CombinedPreviewTimeline {
  readonly items: readonly CombinedPreviewItem[]
  readonly totalDurationInFrames: number
  readonly itemByPanelKey: ReadonlyMap<string, CombinedPreviewItem>
}

interface MutableCombinedPreviewItem {
  panelKey: string
  panelId?: string
  storyboardId: string
  panelIndex: number
  groupSequence?: number
  gridCellIndex?: number
  videoUrl: string | null
  imageUrl: string | null
  durationInFrames: number
  startFrame: number
  endFrame: number
  transitionInFrames: number
  transitionOutFrames: number
  status: CombinedPreviewStatus
}

function positiveFinite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function resolveDurationInFrames(panel: VideoPanel, fps: number): number {
  const seconds = [
    panel.durationOverride,
    panel.estimatedDuration,
    panel.textPanel?.duration,
  ].find(positiveFinite) ?? DEFAULT_DURATION_SECONDS

  return Math.max(1, Math.round(seconds * fps))
}

function resolveStatus(panel: VideoPanel, videoUrl: string | null, imageUrl: string | null): CombinedPreviewStatus {
  if (panel.videoTaskRunning || panel.lipSyncTaskRunning) return 'generating'
  if (
    panel.videoErrorMessage
    || panel.videoErrorCode
    || panel.lipSyncErrorMessage
    || panel.lipSyncErrorCode
  ) return 'failed'
  if (videoUrl) return 'video'
  if (imageUrl) return 'image'
  return 'missing'
}

function resolvePreference(
  panel: VideoPanel,
  panelKey: string,
  panelVideoPreference: ReadonlyMap<string, boolean>,
): boolean {
  const cardKey = `${panel.storyboardId}-${panel.panelIndex}`
  return panelVideoPreference.get(panelKey) ?? panelVideoPreference.get(cardKey) ?? true
}

export function buildCombinedPreviewTimeline(
  panels: readonly VideoPanel[],
  panelVideoPreference: ReadonlyMap<string, boolean>,
  fps = DEFAULT_FPS,
): CombinedPreviewTimeline {
  const resolvedFps = positiveFinite(fps) ? fps : DEFAULT_FPS
  const mutableItems = panels.map<MutableCombinedPreviewItem>((panel) => {
    const panelKey = buildVideoSubmissionKey(panel)
    const preferLipSync = resolvePreference(panel, panelKey, panelVideoPreference)
    const videoUrl = (preferLipSync && panel.lipSyncVideoUrl ? panel.lipSyncVideoUrl : panel.videoUrl) || null
    const imageUrl = panel.imageUrl || null
    const durationInFrames = resolveDurationInFrames(panel, resolvedFps)

    return {
      panelKey,
      ...(panel.panelId?.trim() ? { panelId: panel.panelId.trim() } : {}),
      storyboardId: panel.storyboardId,
      panelIndex: panel.panelIndex,
      ...(panel.groupSequence == null ? {} : { groupSequence: panel.groupSequence }),
      ...(panel.gridCellIndex == null ? {} : { gridCellIndex: panel.gridCellIndex }),
      videoUrl,
      imageUrl,
      durationInFrames,
      startFrame: 0,
      endFrame: durationInFrames,
      transitionInFrames: 0,
      transitionOutFrames: 0,
      status: resolveStatus(panel, videoUrl, imageUrl),
    }
  })

  for (let index = 0; index < mutableItems.length - 1; index += 1) {
    const current = mutableItems[index]
    const next = mutableItems[index + 1]
    const transition = Math.min(
      MAX_TRANSITION_FRAMES,
      Math.floor(current.durationInFrames / 4),
      Math.floor(next.durationInFrames / 4),
    )

    current.transitionOutFrames = transition
    next.transitionInFrames = transition
    next.startFrame = current.endFrame - transition
    next.endFrame = next.startFrame + next.durationInFrames
  }

  const items = Object.freeze(mutableItems.map((item) => Object.freeze(item)))
  const itemByPanelKey = new Map(items.map((item) => [item.panelKey, item] as const))

  return Object.freeze({
    items,
    totalDurationInFrames: items.at(-1)?.endFrame ?? 0,
    itemByPanelKey,
  })
}

function clampOpacity(opacity: number): number {
  return Math.min(1, Math.max(0, opacity))
}

export function resolveCombinedPreviewOpacity(item: CombinedPreviewItem, localFrame: number): number {
  if (localFrame >= 0 && localFrame < item.transitionInFrames) {
    return clampOpacity(localFrame / item.transitionInFrames)
  }

  const transitionOutStart = item.durationInFrames - item.transitionOutFrames
  if (localFrame >= transitionOutStart && localFrame < item.durationInFrames) {
    return clampOpacity((item.durationInFrames - localFrame) / item.transitionOutFrames)
  }

  return 1
}

export function findCombinedPreviewItemIndexAtFrame(
  items: readonly CombinedPreviewItem[],
  frame: number,
  onProbe?: (index: number) => void,
): number {
  if (items.length === 0) return -1

  let lowerBound = 0
  let upperBound = items.length
  while (lowerBound < upperBound) {
    const middle = Math.floor((lowerBound + upperBound) / 2)
    onProbe?.(middle)
    if (items[middle].startFrame <= frame) lowerBound = middle + 1
    else upperBound = middle
  }

  return Math.max(0, lowerBound - 1)
}
