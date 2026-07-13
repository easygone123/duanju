import { describe, expect, it } from 'vitest'

import {
  resolveFrameLinkChoices,
  resolveFrameLinkSubmission,
  serializeFrameSourceMeta,
  type FrameLinkStoryboard,
} from '@/lib/novel-promotion/video/frame-link-resolver'

function sixGridStoryboard(input: {
  id: string
  groupSequence: number
  sceneKey: string
  panelIds: string[]
}): FrameLinkStoryboard {
  return {
    id: input.id,
    layoutMode: 'six_grid',
    groupSequence: input.groupSequence,
    continuityAnchor: JSON.stringify({ sceneKey: input.sceneKey }),
    panels: input.panelIds.map((id, gridCellIndex) => ({
      id,
      storyboardId: input.id,
      panelIndex: gridCellIndex,
      gridCellIndex,
      firstFrameSourceMeta: null,
      lastFrameSourceMeta: null,
    })),
  }
}

describe('continuous first/last-frame resolver', () => {
  it('links cell 0 to cell 1 using persisted grid identity', () => {
    const group = sixGridStoryboard({
      id: 'group-1',
      groupSequence: 1,
      sceneKey: 'office',
      panelIds: ['g1-0', 'g1-1', 'g1-2', 'g1-3', 'g1-4', 'g1-5'],
    })

    expect(resolveFrameLinkChoices({
      panelId: 'g1-0',
      storyboards: [group],
    })).toEqual({
      firstFrame: { mode: 'automatic', sourcePanelId: 'g1-0' },
      lastFrame: { mode: 'automatic', sourcePanelId: 'g1-1' },
    })
  })

  it('links cell 5 to cell 0 of the next persisted continuous group', () => {
    const first = sixGridStoryboard({
      id: 'group-1', groupSequence: 10, sceneKey: 'office',
      panelIds: ['g1-0', 'g1-1', 'g1-2', 'g1-3', 'g1-4', 'g1-5'],
    })
    const next = sixGridStoryboard({
      id: 'group-2', groupSequence: 20, sceneKey: 'office',
      panelIds: ['g2-0', 'g2-1', 'g2-2', 'g2-3', 'g2-4', 'g2-5'],
    })

    expect(resolveFrameLinkChoices({
      panelId: 'g1-5',
      // Deliberately reverse visual-list order: groupSequence is authoritative.
      storyboards: [next, first],
    }).lastFrame).toEqual({ mode: 'automatic', sourcePanelId: 'g2-0' })
  })

  it('does not link across a scene boundary', () => {
    const first = sixGridStoryboard({
      id: 'group-1', groupSequence: 1, sceneKey: 'office',
      panelIds: ['g1-0', 'g1-1', 'g1-2', 'g1-3', 'g1-4', 'g1-5'],
    })
    const next = sixGridStoryboard({
      id: 'group-2', groupSequence: 2, sceneKey: 'street',
      panelIds: ['g2-0', 'g2-1', 'g2-2', 'g2-3', 'g2-4', 'g2-5'],
    })

    expect(resolveFrameLinkChoices({ panelId: 'g1-5', storyboards: [first, next] }).lastFrame).toBeNull()
  })

  it('leaves the final shot without an automatic last frame', () => {
    const group = sixGridStoryboard({
      id: 'group-1', groupSequence: 1, sceneKey: 'office',
      panelIds: ['g1-0', 'g1-1', 'g1-2', 'g1-3', 'g1-4', 'g1-5'],
    })

    expect(resolveFrameLinkChoices({ panelId: 'g1-5', storyboards: [group] }).lastFrame).toBeNull()
  })

  it('prefers a stored manual source over automatic resolution', () => {
    const group = sixGridStoryboard({
      id: 'group-1', groupSequence: 1, sceneKey: 'office',
      panelIds: ['g1-0', 'g1-1', 'g1-2', 'g1-3', 'g1-4', 'g1-5'],
    })
    group.panels[0].lastFrameSourceMeta = serializeFrameSourceMeta({
      mode: 'manual',
      sourcePanelId: 'g1-4',
    })

    expect(resolveFrameLinkChoices({ panelId: 'g1-0', storyboards: [group] }).lastFrame)
      .toEqual({ mode: 'manual', sourcePanelId: 'g1-4' })
  })

  it('keeps an explicit clear/unlink until automatic linking is restored', () => {
    const group = sixGridStoryboard({
      id: 'group-1', groupSequence: 1, sceneKey: 'office',
      panelIds: ['g1-0', 'g1-1', 'g1-2', 'g1-3', 'g1-4', 'g1-5'],
    })
    group.panels[0].lastFrameSourceMeta = serializeFrameSourceMeta(null)

    expect(resolveFrameLinkChoices({ panelId: 'g1-0', storyboards: [group] }).lastFrame).toBeNull()

    group.panels[0].lastFrameSourceMeta = null
    expect(resolveFrameLinkChoices({ panelId: 'g1-0', storyboards: [group] }).lastFrame)
      .toEqual({ mode: 'automatic', sourcePanelId: 'g1-1' })
  })

  it('preserves stored choices but blocks submission for an incompatible model', () => {
    const storedChoices = {
      firstFrame: { mode: 'manual' as const, sourcePanelId: 'g1-3' },
      lastFrame: { mode: 'manual' as const, sourcePanelId: 'g1-4' },
    }

    expect(resolveFrameLinkSubmission({
      choices: storedChoices,
      supportsFirstLastFrame: false,
    })).toEqual({
      choices: storedChoices,
      submission: null,
      diagnostic: 'FIRST_LAST_FRAME_MODEL_UNSUPPORTED',
    })
  })
})
