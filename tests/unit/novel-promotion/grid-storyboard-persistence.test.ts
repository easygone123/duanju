import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveStoryboardGridSpec } from '@/lib/novel-promotion/grid-storyboard/spec'
import { buildGridSheetPrompt } from '@/lib/novel-promotion/six-grid/prompt-builder'

const state = vi.hoisted(() => ({
  storyboards: [] as Array<Record<string, unknown>>,
  panels: [] as Array<Record<string, unknown>>,
  voices: [] as Array<Record<string, unknown>>,
  artifacts: [] as Array<Record<string, unknown>>,
}))
const getRunIdentitySnapshotMock = vi.hoisted(() => vi.fn())

const tx = vi.hoisted(() => ({
  novelPromotionClip: {
    count: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.length),
  },
  novelPromotionStoryboard: {
    findFirst: vi.fn(async () => null),
    findMany: vi.fn(async () => [] as Array<{
      id: string
      clipId?: string
      layoutMode?: string
    }>),
    deleteMany: vi.fn(async () => ({ count: 0 })),
    updateMany: vi.fn(async () => ({ count: 0 })),
    upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => {
      state.storyboards.push(create)
      return { id: create.id as string, clipId: create.clipId as string }
    }),
  },
  novelPromotionPanel: {
    deleteMany: vi.fn(async () => ({ count: 0 })),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      state.panels.push(data)
      return {
        id: `panel-${state.panels.length}`,
        panelIndex: data.panelIndex as number,
        description: data.description as string | null,
        srtSegment: data.srtSegment as string | null,
        characters: data.characters as string | null,
        props: data.props as string | null,
      }
    }),
  },
  novelPromotionVoiceLine: {
    updateMany: vi.fn(async () => ({ count: 0 })),
    deleteMany: vi.fn(async () => ({ count: 0 })),
    upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => {
      state.voices.push(create)
      return { id: `voice-${state.voices.length}` }
    }),
  },
  graphArtifact: {
    deleteMany: vi.fn(async () => ({ count: 0 })),
    upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => {
      state.artifacts.push(create)
      return create
    }),
  },
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: vi.fn(async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx)),
  },
}))

vi.mock('@/lib/run-runtime/service', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/run-runtime/service')>(),
  getRunIdentitySnapshot: getRunIdentitySnapshotMock,
}))

import {
  persistGridStoryboardOutputs,
  stableGridStoryboardId,
} from '@/lib/novel-promotion/grid-storyboard/persistence'
import { persistSixGridStoryboardOutputs } from '@/lib/novel-promotion/six-grid/persistence'
import {
  normalizeGridPersistenceGroups,
  normalizeSixGridPersistenceGroups,
  stableSixGridStoryboardId,
} from '@/lib/novel-promotion/six-grid/persistence-contract'
import { persistStoryboardOutputs } from '@/lib/workers/handlers/script-to-storyboard-helpers'

function panels(count: 4 | 6) {
  return Array.from({ length: count }, (_, index) => ({
    panel_number: index + 1,
    description: `visual beat ${index + 1}`,
    location: 'rainy-platform',
    source_text: `source ${index + 1}`,
    characters: ['Ming'],
    props: ['red umbrella'],
    shot_type: 'wide shot',
    camera_move: 'static',
    video_prompt: `animate beat ${index + 1}`,
  }))
}

function runSnapshot(mode: 'four_grid' | 'six_grid') {
  const gridSpec = resolveStoryboardGridSpec(mode, '16:9')
  return Object.freeze({
    runId: 'run-1',
    projectId: 'project-1',
    episodeId: 'episode-1',
    workflowType: 'script_to_storyboard_run',
    locale: 'en' as const,
    sourceHash: 'source-hash',
    runSettings: Object.freeze({
      storyboardGenerationMode: mode,
      sixGridCellAspectRatio: '16:9' as const,
      gridSpec,
      sixGridProcessingOrder: 'crop_then_panel_upscale' as const,
      storyboardUpscaleModel: null,
      dialogueVideoModel: null,
    }),
  })
}

function group(mode: 'four_grid' | 'six_grid') {
  const prefix = mode === 'four_grid' ? 'four-grid' : 'six-grid'
  const panelCount = mode === 'four_grid' ? 4 : 6
  return {
    clipId: 'clip-1',
    clipIndex: 1,
    groupId: `${prefix}:1:clip-1:1`,
    groupKey: `${prefix}:1:clip-1:1`,
    groupSequence: 1,
    sceneKey: 'rainy-platform',
    incomingContinuity: 'Ming enters frame',
    outgoingContinuity: 'Ming remains by the platform',
    finalPanels: panels(panelCount),
  }
}

describe('grid storyboard persistence', () => {
  beforeEach(() => {
    state.storyboards.length = 0
    state.panels.length = 0
    state.voices.length = 0
    state.artifacts.length = 0
    vi.clearAllMocks()
    getRunIdentitySnapshotMock.mockResolvedValue({
      runId: 'run-1',
      projectId: 'project-1',
      episodeId: 'episode-1',
      workflowType: 'script_to_storyboard_run',
    })
  })

  it('persists a four-grid storyboard, exact prompt snapshot, four panels, and four voice mappings', async () => {
    const gridGroup = group('four_grid')
    const snapshot = runSnapshot('four_grid')
    const voiceLineRows = Array.from({ length: 4 }, (_, index) => ({
      lineIndex: index + 1,
      speaker: 'Ming',
      content: `line ${index + 1}`,
      emotionStrength: 0.5,
      matchedPanel: { storyboardId: gridGroup.groupId, panelIndex: index },
    }))

    const result = await persistGridStoryboardOutputs({
      episodeId: 'episode-1',
      runId: 'run-1',
      clipPanels: [gridGroup],
      voiceLineRows,
      runSnapshot: snapshot,
    })

    expect(result).toMatchObject({ voiceLineCount: 4 })
    expect(state.storyboards).toHaveLength(1)
    expect(state.storyboards[0]).toMatchObject({
      layoutMode: 'four_grid',
      panelCount: 4,
      sixGridCellAspectRatio: '16:9',
      sixGridProcessingOrder: 'crop_then_panel_upscale',
    })
    expect(state.storyboards[0].sheetPromptSnapshot).toBe(buildGridSheetPrompt({
      sceneKey: gridGroup.sceneKey,
      clipId: gridGroup.clipId,
      incomingContinuity: gridGroup.incomingContinuity,
      outgoingContinuity: gridGroup.outgoingContinuity,
      panels: gridGroup.finalPanels,
    }, {
      locale: 'en',
      gridSpec: snapshot.runSettings.gridSpec,
    }))
    expect(state.panels).toHaveLength(4)
    expect(state.panels.map((panel) => panel.gridCellIndex)).toEqual([0, 1, 2, 3])
    expect(state.panels.map((panel) => panel.panelNumber)).toEqual([1, 2, 3, 4])
    expect(state.voices).toHaveLength(4)
  })

  it('replaces stale six-grid and individual storyboards when rebuilding as four-grid', async () => {
    tx.novelPromotionStoryboard.findMany.mockResolvedValueOnce([
      { id: 'stale-six-grid' },
      { id: 'stale-individual' },
    ])

    await persistGridStoryboardOutputs({
      episodeId: 'episode-1',
      runId: 'run-1',
      clipPanels: [group('four_grid')],
      voiceLineRows: null,
      runSnapshot: runSnapshot('four_grid'),
    })

    const plannedId = stableGridStoryboardId(
      'episode-1',
      group('four_grid').groupKey,
      'four_grid',
    )
    expect(tx.novelPromotionStoryboard.findMany).toHaveBeenCalledWith({
      where: {
        episodeId: 'episode-1',
        id: { notIn: [plannedId] },
      },
      select: { id: true },
    })
    expect(tx.novelPromotionVoiceLine.updateMany).toHaveBeenCalledWith({
      where: {
        episodeId: 'episode-1',
        matchedStoryboardId: { in: ['stale-six-grid', 'stale-individual'] },
      },
      data: {
        matchedPanelId: null,
        matchedStoryboardId: null,
        matchedPanelIndex: null,
      },
    })
    expect(tx.novelPromotionStoryboard.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['stale-six-grid', 'stale-individual'] } },
    })
    expect(state.storyboards).toHaveLength(1)
    expect(state.storyboards[0]).toMatchObject({ layoutMode: 'four_grid', panelCount: 4 })
    expect(state.panels.map((panel) => panel.panelIndex)).toEqual([0, 1, 2, 3])
  })

  it('fails closed when group panel count does not match the immutable grid spec', async () => {
    const invalid = { ...group('four_grid'), finalPanels: panels(6) }
    await expect(persistGridStoryboardOutputs({
      episodeId: 'episode-1',
      runId: 'run-1',
      clipPanels: [invalid],
      voiceLineRows: null,
      runSnapshot: runSnapshot('four_grid'),
    })).rejects.toThrow('GRID_REQUIRES_EXACT_PANEL_COUNT')
    expect(tx.novelPromotionStoryboard.upsert).not.toHaveBeenCalled()
  })

  it('rejects a non-canonical snapshot spec instead of accepting its forged panel count', async () => {
    const snapshot = runSnapshot('four_grid')
    const forgedSnapshot = {
      ...snapshot,
      runSettings: {
        ...snapshot.runSettings,
        gridSpec: {
          ...snapshot.runSettings.gridSpec,
          panelCount: 6 as const,
        },
      },
    }
    await expect(persistGridStoryboardOutputs({
      episodeId: 'episode-1',
      runId: 'run-1',
      clipPanels: [{ ...group('four_grid'), finalPanels: panels(6) }],
      voiceLineRows: null,
      runSnapshot: forgedSnapshot,
    })).rejects.toThrow('GRID_RUN_SNAPSHOT_INVALID')
    expect(tx.novelPromotionStoryboard.upsert).not.toHaveBeenCalled()
  })

  it('uses mode-discriminated stable ids while preserving the legacy six-grid id', () => {
    const groupKey = 'shared-logical-group'
    const legacyHash = createHash('sha256').update(`episode-1\u0000${groupKey}`).digest('hex')
    const fourGridId = stableGridStoryboardId('episode-1', groupKey, 'four_grid')
    const sixGridId = stableGridStoryboardId('episode-1', groupKey, 'six_grid')

    expect(fourGridId).not.toBe(sixGridId)
    expect(fourGridId).toBe(`four_grid_${legacyHash}`)
    expect(sixGridId).toBe(`six_grid_${legacyHash}`)
  })

  it('preserves unique positive sparse six-grid group sequences and their stable keys', () => {
    const first = {
      ...group('six_grid'),
      groupId: 'six-grid:2:clip-1:1',
      groupKey: 'six-grid:2:clip-1:1',
      groupSequence: 2,
    }
    const second = {
      ...group('six_grid'),
      groupId: 'six-grid:5:clip-1:2',
      groupKey: 'six-grid:5:clip-1:2',
      groupSequence: 5,
      incomingContinuity: first.outgoingContinuity,
    }

    const normalized = normalizeSixGridPersistenceGroups([first, second])

    expect(normalized.map((item) => item.groupSequence)).toEqual([2, 5])
    expect(normalized.map((item) => item.groupKey)).toEqual([
      first.groupKey,
      second.groupKey,
    ])
    expect(normalized.map((item) => stableSixGridStoryboardId('episode-1', item.groupKey))).toEqual([
      stableGridStoryboardId('episode-1', first.groupKey, 'six_grid'),
      stableGridStoryboardId('episode-1', second.groupKey, 'six_grid'),
    ])
    expect(() => normalizeSixGridPersistenceGroups([
      first,
      { ...second, groupSequence: 2 },
    ])).toThrow('SIX_GRID_GROUP_IDENTITY_DUPLICATE')
    expect(() => normalizeSixGridPersistenceGroups([
      { ...first, groupSequence: 0 },
    ])).toThrow('SIX_GRID_GROUP_SEQUENCE_INVALID')
  })

  it('allows sparse four-grid group sequences while rejecting duplicate and non-positive values', () => {
    const spec = resolveStoryboardGridSpec('four_grid', '16:9')
    const first = {
      ...group('four_grid'),
      groupId: 'four-grid:2:clip-1:1',
      groupKey: 'four-grid:2:clip-1:1',
      groupSequence: 2,
    }
    const second = {
      ...group('four_grid'),
      groupId: 'four-grid:5:clip-1:2',
      groupKey: 'four-grid:5:clip-1:2',
      groupSequence: 5,
      incomingContinuity: first.outgoingContinuity,
    }
    expect(normalizeGridPersistenceGroups([first, second], spec)
      .map((item) => item.groupSequence)).toEqual([2, 5])

    expect(() => normalizeGridPersistenceGroups([
      first,
      { ...second, groupSequence: 2 },
    ], spec)).toThrow('GRID_GROUP_IDENTITY_DUPLICATE')
    expect(() => normalizeGridPersistenceGroups([
      { ...first, groupSequence: 0 },
    ], spec)).toThrow('GRID_GROUP_SEQUENCE_INVALID')
  })

  it('routes a four-grid worker persistence call through the generic grid path', async () => {
    await persistStoryboardOutputs({
      episodeId: 'episode-1',
      runId: 'run-1',
      clipPanels: [group('four_grid')],
      voiceLineRows: null,
      runSnapshot: runSnapshot('four_grid'),
    })

    expect(state.storyboards).toHaveLength(1)
    expect(state.storyboards[0]).toMatchObject({ layoutMode: 'four_grid', panelCount: 4 })
    expect(state.panels.map((panel) => panel.gridCellIndex)).toEqual([0, 1, 2, 3])
  })

  it('keeps individual worker persistence on the legacy non-grid path', async () => {
    const snapshot = Object.freeze({
      ...runSnapshot('four_grid'),
      runSettings: Object.freeze({
        storyboardGenerationMode: 'individual' as const,
        sixGridCellAspectRatio: null,
        gridSpec: null,
        sixGridProcessingOrder: 'crop_then_panel_upscale' as const,
        storyboardUpscaleModel: null,
        dialogueVideoModel: null,
      }),
    })
    await persistStoryboardOutputs({
      episodeId: 'episode-1',
      runId: 'run-1',
      clipPanels: [{
        clipId: 'clip-1',
        clipIndex: 1,
        finalPanels: [panels(4)[0]],
      }],
      voiceLineRows: null,
      runSnapshot: snapshot,
    })

    expect(state.storyboards).toHaveLength(1)
    expect(state.storyboards[0]).toMatchObject({
      id: 'individual:episode-1:clip-1',
      panelCount: 1,
    })
    expect(state.storyboards[0]).not.toHaveProperty('layoutMode')
    expect(state.panels).toHaveLength(1)
    expect(state.panels[0]).not.toHaveProperty('gridCellIndex')
  })

  it('replaces stale grid storyboards when rebuilding as individual panels', async () => {
    tx.novelPromotionStoryboard.findMany.mockResolvedValueOnce([
      { id: 'stale-four-grid', clipId: 'clip-old', layoutMode: 'four_grid' },
      { id: 'stale-six-grid', clipId: 'clip-old', layoutMode: 'six_grid' },
    ])
    const snapshot = Object.freeze({
      ...runSnapshot('four_grid'),
      runSettings: Object.freeze({
        storyboardGenerationMode: 'individual' as const,
        sixGridCellAspectRatio: null,
        gridSpec: null,
        sixGridProcessingOrder: 'crop_then_panel_upscale' as const,
        storyboardUpscaleModel: null,
        dialogueVideoModel: null,
      }),
    })

    await persistStoryboardOutputs({
      episodeId: 'episode-1',
      runId: 'run-1',
      clipPanels: [{ clipId: 'clip-1', clipIndex: 1, finalPanels: [panels(4)[0]] }],
      voiceLineRows: null,
      runSnapshot: snapshot,
    })

    expect(tx.novelPromotionStoryboard.findMany).toHaveBeenCalledWith({
      where: { episodeId: 'episode-1' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, clipId: true, layoutMode: true },
    })
    expect(tx.novelPromotionVoiceLine.updateMany).toHaveBeenCalledWith({
      where: {
        episodeId: 'episode-1',
        matchedStoryboardId: { in: ['stale-four-grid', 'stale-six-grid'] },
      },
      data: {
        matchedPanelId: null,
        matchedStoryboardId: null,
        matchedPanelIndex: null,
      },
    })
    expect(tx.novelPromotionStoryboard.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['stale-four-grid', 'stale-six-grid'] } },
    })
    expect(state.storyboards).toHaveLength(1)
    expect(state.storyboards[0]).not.toHaveProperty('layoutMode')
    expect(state.panels).toHaveLength(1)
  })

  it('keeps the legacy six-grid persistence export and derives its missing spec safely', async () => {
    const snapshot = runSnapshot('six_grid')
    const { gridSpec: _legacyOmittedGridSpec, ...legacyRunSettings } = snapshot.runSettings
    await persistSixGridStoryboardOutputs({
      episodeId: 'episode-1',
      runId: 'run-1',
      clipPanels: [group('six_grid')],
      voiceLineRows: null,
      runSnapshot: {
        ...snapshot,
        runSettings: legacyRunSettings,
      },
    })

    expect(state.storyboards).toHaveLength(1)
    expect(state.storyboards[0]).toMatchObject({ layoutMode: 'six_grid', panelCount: 6 })
    expect(state.panels.map((panel) => panel.gridCellIndex)).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('rejects a voice mapping outside the four-grid panel range', async () => {
    const gridGroup = group('four_grid')
    await expect(persistGridStoryboardOutputs({
      episodeId: 'episode-1',
      runId: 'run-1',
      clipPanels: [gridGroup],
      voiceLineRows: [{
        lineIndex: 1,
        speaker: 'Ming',
        content: 'invalid fifth panel',
        emotionStrength: 0.5,
        matchedPanel: { storyboardId: gridGroup.groupId, panelIndex: 4 },
      }],
      runSnapshot: runSnapshot('four_grid'),
    })).rejects.toThrow('voice line 1 has invalid matchedPanel reference')
    expect(tx.novelPromotionStoryboard.upsert).not.toHaveBeenCalled()
  })
})
