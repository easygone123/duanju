import { describe, expect, it } from 'vitest'
import type { VideoPanel } from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video/types'
import {
  buildCombinedPreviewTimeline,
  findCombinedPreviewItemIndexAtFrame,
  resolveCombinedPreviewOpacity,
  type CombinedPreviewItem,
} from '@/lib/novel-promotion/video/combined-preview'

function panel(overrides: Partial<VideoPanel> = {}): VideoPanel {
  return {
    panelId: 'panel-1',
    storyboardId: 'storyboard-1',
    panelIndex: 0,
    videoUrl: 'base.mp4',
    imageUrl: 'still.png',
    estimatedDuration: 3,
    ...overrides,
  }
}

describe('combined video preview projection', () => {
  it('selects lip-sync video by default and when explicitly enabled', () => {
    const input = panel({ lipSyncVideoUrl: 'lip.mp4' })

    expect(buildCombinedPreviewTimeline([input], new Map()).items[0].videoUrl).toBe('lip.mp4')
    expect(buildCombinedPreviewTimeline([input], new Map([['panel-1', true]])).items[0].videoUrl).toBe('lip.mp4')
  })

  it('selects base video when lip-sync is disabled or unavailable', () => {
    const withLipSync = panel({ lipSyncVideoUrl: 'lip.mp4' })
    const withoutLipSync = panel()

    expect(buildCombinedPreviewTimeline([withLipSync], new Map([['panel-1', false]])).items[0].videoUrl)
      .toBe('base.mp4')
    expect(buildCombinedPreviewTimeline([withoutLipSync], new Map()).items[0].videoUrl).toBe('base.mp4')
  })

  it('uses the current card preference key while exposing the stable panel key', () => {
    const input = panel({ panelId: undefined, panelIndex: 4, lipSyncVideoUrl: 'lip.mp4' })

    const item = buildCombinedPreviewTimeline(
      [input],
      new Map([['storyboard-1-4', false]]),
    ).items[0]

    expect(item.panelKey).toBe('storyboard-1:4')
    expect(item.videoUrl).toBe('base.mp4')
  })

  it('trims present panel ids and falls back for blank panel ids', () => {
    const timeline = buildCombinedPreviewTimeline([
      panel({ panelId: '  p  ' }),
      panel({ panelId: '   ', storyboardId: 'storyboard-blank', panelIndex: 7 }),
    ], new Map())

    expect(timeline.items[0]).toMatchObject({ panelKey: 'p', panelId: 'p' })
    expect(timeline.items[1].panelKey).toBe('storyboard-blank:7')
    expect(timeline.items[1]).not.toHaveProperty('panelId')
  })

  it('falls back from video to image and then to a missing placeholder', () => {
    const imageOnly = panel({ panelId: 'image', videoUrl: undefined })
    const missing = panel({ panelId: 'missing', videoUrl: undefined, imageUrl: undefined })

    const timeline = buildCombinedPreviewTimeline([imageOnly, missing], new Map())

    expect(timeline.items[0]).toMatchObject({ videoUrl: null, imageUrl: 'still.png', status: 'image' })
    expect(timeline.items[1]).toMatchObject({ videoUrl: null, imageUrl: null, status: 'missing' })
  })

  it('uses only positive finite durations in override, estimate, text, and default priority', () => {
    const inputs = [
      panel({ panelId: 'override', durationOverride: 1.25, estimatedDuration: 8, textPanel: { panel_number: 1, shot_type: '', description: '', duration: 9 } }),
      panel({ panelId: 'estimate', durationOverride: 0, estimatedDuration: 2.5, textPanel: { panel_number: 2, shot_type: '', description: '', duration: 9 } }),
      panel({ panelId: 'text', durationOverride: Number.NaN, estimatedDuration: Number.POSITIVE_INFINITY, textPanel: { panel_number: 3, shot_type: '', description: '', duration: 4.25 } }),
      panel({ panelId: 'default', durationOverride: -1, estimatedDuration: 0, textPanel: { panel_number: 4, shot_type: '', description: '', duration: Number.NaN } }),
    ]

    expect(buildCombinedPreviewTimeline(inputs, new Map(), 20).items.map((item) => item.durationInFrames))
      .toEqual([25, 50, 85, 60])
    expect(buildCombinedPreviewTimeline([panel({ estimatedDuration: 0.001 })], new Map(), 30).items[0].durationInFrames)
      .toBe(1)
  })

  it('preserves ordered individual and six-grid panel identity and metadata', () => {
    const inputs = [
      panel({ panelId: 'individual-2', storyboardId: 'individual', panelIndex: 2, groupSequence: undefined, gridCellIndex: undefined }),
      panel({ panelId: 'cell-5', storyboardId: 'grid-b', panelIndex: 5, groupSequence: 2, gridCellIndex: 5, layoutMode: 'six_grid' }),
      panel({ panelId: 'cell-0', storyboardId: 'grid-a', panelIndex: 0, groupSequence: 1, gridCellIndex: 0, layoutMode: 'six_grid' }),
      panel({ panelId: 'individual-0', storyboardId: 'individual', panelIndex: 0, groupSequence: undefined, gridCellIndex: undefined }),
    ]

    const timeline = buildCombinedPreviewTimeline(inputs, new Map())

    expect(timeline.items.map((item) => item.panelKey)).toEqual([
      'individual-2', 'cell-5', 'cell-0', 'individual-0',
    ])
    expect(timeline.items[1]).toMatchObject({ storyboardId: 'grid-b', panelIndex: 5, groupSequence: 2, gridCellIndex: 5 })
    expect(timeline.itemByPanelKey.get('cell-0')).toBe(timeline.items[2])
  })

  it('preserves explicit null group and grid metadata while omitting undefined metadata', () => {
    const timeline = buildCombinedPreviewTimeline([
      panel({ panelId: 'null-metadata', groupSequence: null, gridCellIndex: null }),
      panel({ panelId: 'undefined-metadata', groupSequence: undefined, gridCellIndex: undefined }),
    ], new Map())

    expect(timeline.items[0]).toMatchObject({ groupSequence: null, gridCellIndex: null })
    expect(timeline.items[1]).not.toHaveProperty('groupSequence')
    expect(timeline.items[1]).not.toHaveProperty('gridCellIndex')
  })

  it('reports generating and failed diagnostics without discarding fallback media', () => {
    const inputs = [
      panel({ panelId: 'generating-video', videoTaskRunning: true }),
      panel({ panelId: 'generating-image', videoUrl: undefined, lipSyncTaskRunning: true }),
      panel({ panelId: 'failed-video', videoErrorMessage: 'provider failed' }),
      panel({ panelId: 'failed-image', videoUrl: undefined, lipSyncErrorCode: 'LIP_SYNC_FAILED' }),
    ]

    const timeline = buildCombinedPreviewTimeline(inputs, new Map())

    expect(timeline.items[0]).toMatchObject({ status: 'generating', videoUrl: 'base.mp4' })
    expect(timeline.items[1]).toMatchObject({ status: 'generating', imageUrl: 'still.png' })
    expect(timeline.items[2]).toMatchObject({ status: 'failed', videoUrl: 'base.mp4' })
    expect(timeline.items[3]).toMatchObject({ status: 'failed', imageUrl: 'still.png' })
  })

  it('overlaps adjacent items and derives the total duration from the last end frame', () => {
    const timeline = buildCombinedPreviewTimeline([
      panel({ panelId: 'first', estimatedDuration: 2 }),
      panel({ panelId: 'second', estimatedDuration: 4 }),
      panel({ panelId: 'third', estimatedDuration: 1 }),
    ], new Map(), 10)

    expect(timeline.items.map((item) => ({
      start: item.startFrame,
      end: item.endFrame,
      transitionIn: item.transitionInFrames,
      transitionOut: item.transitionOutFrames,
    }))).toEqual([
      { start: 0, end: 20, transitionIn: 0, transitionOut: 5 },
      { start: 15, end: 55, transitionIn: 5, transitionOut: 2 },
      { start: 53, end: 63, transitionIn: 2, transitionOut: 0 },
    ])
    expect(timeline.totalDurationInFrames).toBe(63)
  })

  it('caps transitions between long adjacent clips at exactly fifteen frames', () => {
    const timeline = buildCombinedPreviewTimeline([
      panel({ panelId: 'long-first', estimatedDuration: 4 }),
      panel({ panelId: 'long-second', estimatedDuration: 4 }),
    ], new Map(), 30)

    expect(timeline.items[0].durationInFrames).toBe(120)
    expect(timeline.items[0].transitionOutFrames).toBe(15)
    expect(timeline.items[1].transitionInFrames).toBe(15)
  })

  it('freezes the timeline, item array, and projected items against mutation', () => {
    const timeline = buildCombinedPreviewTimeline([panel()], new Map())

    expect(Object.isFrozen(timeline)).toBe(true)
    expect(Object.isFrozen(timeline.items)).toBe(true)
    expect(Object.isFrozen(timeline.items[0])).toBe(true)
    expect(() => {
      (timeline as { totalDurationInFrames: number }).totalDurationInFrames = 999
    }).toThrow(TypeError)
    expect(() => {
      (timeline.items as CombinedPreviewItem[]).push(timeline.items[0])
    }).toThrow(TypeError)
    expect(() => {
      (timeline.items[0] as { startFrame: number }).startFrame = 999
    }).toThrow(TypeError)
  })

  it('keeps outgoing and incoming opacity complementary at every overlap frame', () => {
    const { items } = buildCombinedPreviewTimeline([
      panel({ panelId: 'first', estimatedDuration: 2 }),
      panel({ panelId: 'second', estimatedDuration: 4 }),
      panel({ panelId: 'third', estimatedDuration: 1 }),
    ], new Map(), 10)

    for (let index = 0; index < items.length - 1; index += 1) {
      const outgoing = items[index]
      const incoming = items[index + 1]
      for (let globalFrame = incoming.startFrame; globalFrame < outgoing.endFrame; globalFrame += 1) {
        const outgoingOpacity = resolveCombinedPreviewOpacity(outgoing, globalFrame - outgoing.startFrame)
        const incomingOpacity = resolveCombinedPreviewOpacity(incoming, globalFrame - incoming.startFrame)
        expect(outgoingOpacity + incomingOpacity).toBe(1)
      }
    }

    expect(resolveCombinedPreviewOpacity(items[0], -100)).toBe(1)
    expect(resolveCombinedPreviewOpacity(items[1], items[1].transitionInFrames)).toBe(1)
    expect(resolveCombinedPreviewOpacity(items[2], 10_000)).toBe(1)
  })
})

describe('combined preview frame lookup', () => {
  const timeline = buildCombinedPreviewTimeline([
    panel({ panelId: 'first', estimatedDuration: 2 }),
    panel({ panelId: 'second', estimatedDuration: 4 }),
    panel({ panelId: 'third', estimatedDuration: 1 }),
  ], new Map(), 10)

  it('selects the newly entered item during overlap and clamps timeline boundaries', () => {
    expect(findCombinedPreviewItemIndexAtFrame([], 0)).toBe(-1)
    expect(findCombinedPreviewItemIndexAtFrame(timeline.items, -1)).toBe(0)
    expect(findCombinedPreviewItemIndexAtFrame(timeline.items, 14)).toBe(0)
    expect(findCombinedPreviewItemIndexAtFrame(timeline.items, 15)).toBe(1)
    expect(findCombinedPreviewItemIndexAtFrame(timeline.items, 52)).toBe(1)
    expect(findCombinedPreviewItemIndexAtFrame(timeline.items, 53)).toBe(2)
    expect(findCombinedPreviewItemIndexAtFrame(timeline.items, 62)).toBe(2)
    expect(findCombinedPreviewItemIndexAtFrame(timeline.items, 63)).toBe(2)
    expect(findCombinedPreviewItemIndexAtFrame(timeline.items, Number.POSITIVE_INFINITY)).toBe(2)
  })

  it('uses an upper-bound binary search with at most eleven probes for 1024 items', () => {
    const largeTimeline = buildCombinedPreviewTimeline(
      Array.from({ length: 1024 }, (_, index) => panel({ panelId: `panel-${index}`, panelIndex: index })),
      new Map(),
      30,
    )

    let probes = 0
    expect(findCombinedPreviewItemIndexAtFrame(
      largeTimeline.items,
      largeTimeline.items[777].startFrame,
      () => { probes += 1 },
    )).toBe(777)
    expect(probes).toBeLessThanOrEqual(11)
  })
})
