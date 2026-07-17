import { describe, expect, it } from 'vitest'

import {
  buildFrameLinkResolutionIndex,
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

function fourGridStoryboard(input: {
  id: string
  groupSequence: number
  sceneKey: string
  cellIndexes: number[]
}): FrameLinkStoryboard {
  return {
    id: input.id,
    layoutMode: 'four_grid',
    groupSequence: input.groupSequence,
    continuityAnchor: JSON.stringify({ sceneKey: input.sceneKey }),
    panels: input.cellIndexes.map((gridCellIndex, dbIndex) => ({
      id: `${input.id}-${gridCellIndex}`,
      storyboardId: input.id,
      panelIndex: dbIndex,
      gridCellIndex,
      firstFrameSourceMeta: null,
      lastFrameSourceMeta: null,
    })),
  }
}

describe('continuous first/last-frame resolver', () => {
  it('orders four-grid groups by sequence and each group by row-major cell identity', () => {
    const first = fourGridStoryboard({
      id: 'four-1', groupSequence: 1, sceneKey: 'office', cellIndexes: [3, 1, 0, 2],
    })
    const second = fourGridStoryboard({
      id: 'four-2', groupSequence: 2, sceneKey: 'office', cellIndexes: [2, 0, 3, 1],
    })
    const visited: string[] = []

    const index = buildFrameLinkResolutionIndex({
      storyboards: [second, first],
      onPanelVisit: (panel) => visited.push(panel.id),
    })

    expect(visited).toEqual([
      'four-1-0', 'four-1-1', 'four-1-2', 'four-1-3',
      'four-2-0', 'four-2-1', 'four-2-2', 'four-2-3',
    ])
    expect(index.automaticChoicesByPanelId.get('four-1-0')?.lastFrame)
      .toEqual({ mode: 'automatic', sourcePanelId: 'four-1-1' })
    expect(index.automaticChoicesByPanelId.get('four-1-3')?.lastFrame)
      .toEqual({ mode: 'automatic', sourcePanelId: 'four-2-0' })
  })

  it('uses deterministic panel-index and id tie-breaks for missing or duplicate grid cells', () => {
    const storyboard: FrameLinkStoryboard = {
      id: 'four-ties',
      layoutMode: 'four_grid',
      groupSequence: 1,
      continuityAnchor: JSON.stringify({ sceneKey: 'office' }),
      panels: [
        { id: 'missing-b', storyboardId: 'four-ties', panelIndex: 3, gridCellIndex: null },
        { id: 'cell-0-z', storyboardId: 'four-ties', panelIndex: 2, gridCellIndex: 0 },
        { id: 'cell-0-a', storyboardId: 'four-ties', panelIndex: 1, gridCellIndex: 0 },
        { id: 'missing-a', storyboardId: 'four-ties', panelIndex: 0, gridCellIndex: null },
      ],
    }
    const visited: string[] = []

    buildFrameLinkResolutionIndex({
      storyboards: [storyboard],
      onPanelVisit: (panel) => visited.push(panel.id),
    })

    expect(visited).toEqual(['missing-a', 'cell-0-a', 'cell-0-z', 'missing-b'])
  })

  it('keeps individual ordering on panelIndex even when a grid cell value is present', () => {
    const visited: string[] = []
    buildFrameLinkResolutionIndex({
      storyboards: [{
        id: 'individual-1',
        layoutMode: 'individual',
        panels: [
          { id: 'individual-2', storyboardId: 'individual-1', panelIndex: 2, gridCellIndex: 0 },
          { id: 'individual-0', storyboardId: 'individual-1', panelIndex: 0, gridCellIndex: 2 },
          { id: 'individual-1', storyboardId: 'individual-1', panelIndex: 1, gridCellIndex: 1 },
        ],
      }],
      onPanelVisit: (panel) => visited.push(panel.id),
    })

    expect(visited).toEqual(['individual-0', 'individual-1', 'individual-2'])
  })

  it('reorders grid groups without moving individual storyboards out of their legacy slots', () => {
    const visited: string[] = []
    const individual = (id: string): FrameLinkStoryboard => ({
      id,
      layoutMode: 'individual',
      panels: [{ id: `${id}-0`, storyboardId: id, panelIndex: 0 }],
    })
    buildFrameLinkResolutionIndex({
      storyboards: [
        individual('individual-a'),
        fourGridStoryboard({ id: 'four-2', groupSequence: 2, sceneKey: 'office', cellIndexes: [0, 1, 2, 3] }),
        individual('individual-b'),
        fourGridStoryboard({ id: 'four-1', groupSequence: 1, sceneKey: 'office', cellIndexes: [0, 1, 2, 3] }),
      ],
      onPanelVisit: (panel) => visited.push(panel.id),
    })

    expect(visited).toEqual([
      'individual-a-0',
      'four-1-0', 'four-1-1', 'four-1-2', 'four-1-3',
      'individual-b-0',
      'four-2-0', 'four-2-1', 'four-2-2', 'four-2-3',
    ])
  })

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

  it.each([
    [null, null],
    [JSON.stringify({ sceneKey: 'office' }), null],
    ['{malformed', JSON.stringify({ sceneKey: 'office' })],
  ])('fails closed across groups when continuity scene keys are missing or invalid', (leftAnchor, rightAnchor) => {
    const first = sixGridStoryboard({
      id: 'group-1', groupSequence: 1, sceneKey: 'office',
      panelIds: ['g1-0', 'g1-1', 'g1-2', 'g1-3', 'g1-4', 'g1-5'],
    })
    const next = sixGridStoryboard({
      id: 'group-2', groupSequence: 2, sceneKey: 'office',
      panelIds: ['g2-0', 'g2-1', 'g2-2', 'g2-3', 'g2-4', 'g2-5'],
    })
    first.continuityAnchor = leftAnchor
    next.continuityAnchor = rightAnchor

    expect(resolveFrameLinkChoices({ panelId: 'g1-5', storyboards: [first, next] }).lastFrame).toBeNull()
  })

  it('keeps legacy linked individual panels usable across storyboard boundaries', () => {
    const first = {
      id: 'legacy-1', layoutMode: 'individual', panels: [{
        id: 'legacy-panel-1', storyboardId: 'legacy-1', panelIndex: 0,
        linkedToNextPanel: true,
      }],
    } as FrameLinkStoryboard
    const next: FrameLinkStoryboard = {
      id: 'legacy-2', layoutMode: 'individual', panels: [{
        id: 'legacy-panel-2', storyboardId: 'legacy-2', panelIndex: 0,
      }],
    }

    const choices = resolveFrameLinkChoices({
      panelId: 'legacy-panel-1', storyboards: [first, next],
    })
    expect(choices.lastFrame).toEqual({ mode: 'automatic', sourcePanelId: 'legacy-panel-2' })
    expect(resolveFrameLinkSubmission({ choices, supportsFirstLastFrame: true }).submission)
      .toEqual({
        firstFrameSourcePanelId: 'legacy-panel-1',
        lastFrameSourcePanelId: 'legacy-panel-2',
      })
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

  it('builds all frame-link choices with one linear panel visit', () => {
    const makeGroups = (groupCount: number) => Array.from({ length: groupCount }, (_, groupIndex) => (
      sixGridStoryboard({
        id: `group-${groupIndex}`,
        groupSequence: groupIndex,
        sceneKey: 'office',
        panelIds: Array.from({ length: 6 }, (__, panelIndex) => `g${groupIndex}-${panelIndex}`),
      })
    ))
    const visits: number[] = []

    for (const groupCount of [8, 16]) {
      let panelVisits = 0
      const groups = makeGroups(groupCount)
      const index = buildFrameLinkResolutionIndex({
        storyboards: [...groups].reverse(),
        onPanelVisit: () => { panelVisits += 1 },
      })
      visits.push(panelVisits)
      expect(index.choicesByPanelId.size).toBe(groupCount * 6)
      expect(index.automaticChoicesByPanelId.size).toBe(groupCount * 6)
      expect(panelVisits).toBe(groupCount * 6)
    }

    expect(visits[1]).toBe(visits[0] * 2)
  })
})
