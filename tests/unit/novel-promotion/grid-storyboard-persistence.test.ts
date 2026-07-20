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
    upsert: vi.fn(async ({
      where,
      create,
      update,
    }: {
      where: { id: string }
      create: Record<string, unknown>
      update: Record<string, unknown>
    }) => {
      const existing = state.storyboards.find((row) => row.id === where.id)
      if (existing) Object.assign(existing, update)
      else state.storyboards.push({ ...create })
      const persisted = existing || state.storyboards[state.storyboards.length - 1]
      return { id: persisted.id as string, clipId: persisted.clipId as string }
    }),
  },
  novelPromotionPanel: {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
      const panel = state.panels.find((row) => row.id === where.id)
      return panel ? { hasDialogue: panel.hasDialogue as boolean } : null
    }),
    deleteMany: vi.fn(async () => ({ count: 0 })),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const persisted = { id: `panel-${state.panels.length + 1}`, ...data }
      state.panels.push(persisted)
      return {
        id: persisted.id,
        panelIndex: data.panelIndex as number,
        description: data.description as string | null,
        srtSegment: data.srtSegment as string | null,
        characters: data.characters as string | null,
        props: data.props as string | null,
      }
    }),
    upsert: vi.fn(async ({
      where,
      create,
      update,
    }: {
      where: { storyboardId_panelIndex: { storyboardId: string; panelIndex: number } }
      create: Record<string, unknown>
      update: Record<string, unknown>
    }) => {
      const key = where.storyboardId_panelIndex
      const existing = state.panels.find((row) => (
        row.storyboardId === key.storyboardId && row.panelIndex === key.panelIndex
      ))
      if (existing) Object.assign(existing, update)
      else state.panels.push({
        id: `panel-${state.panels.length + 1}`,
        narrationMode: 'auto',
        narrationRecommended: false,
        narrationSuggestedText: null,
        narrationSuggestedEmotion: null,
        narrationText: null,
        narrationEmotion: null,
        ...create,
      })
      const persisted = existing || state.panels[state.panels.length - 1]
      return {
        id: persisted.id as string,
        panelIndex: persisted.panelIndex as number,
        description: persisted.description as string | null,
        srtSegment: persisted.srtSegment as string | null,
        characters: persisted.characters as string | null,
        props: persisted.props as string | null,
        narrationMode: persisted.narrationMode as string,
        narrationRecommended: persisted.narrationRecommended as boolean,
        narrationSuggestedText: persisted.narrationSuggestedText as string | null,
        narrationSuggestedEmotion: persisted.narrationSuggestedEmotion as string | null,
        narrationText: persisted.narrationText as string | null,
        narrationEmotion: persisted.narrationEmotion as string | null,
      }
    }),
  },
  novelPromotionVoiceLine: {
    findMany: vi.fn(async ({ where }: {
      where: { episodeId: string; lineType: string; lineIndex: { in: number[] } }
    }) => state.voices
      .filter((row) => (
        row.episodeId === where.episodeId
        && row.lineType === where.lineType
        && where.lineIndex.in.includes(row.lineIndex as number)
      ))
      .sort((left, right) => (
        (left.lineIndex as number) - (right.lineIndex as number)
        || String(left.id).localeCompare(String(right.id))
      ))
      .map((row) => ({ id: row.id as string, lineIndex: row.lineIndex as number }))),
    findUnique: vi.fn(async ({ where }: {
      where: {
        sourceKey?: string
        episodeId_lineIndex?: { episodeId: string; lineIndex: number }
      }
    }) => {
      if (where.sourceKey) {
        return state.voices.find((row) => row.sourceKey === where.sourceKey) || null
      }
      const key = where.episodeId_lineIndex
      return key
        ? state.voices.find((row) => (
          row.episodeId === key.episodeId && row.lineIndex === key.lineIndex
        )) || null
        : null
    }),
    aggregate: vi.fn(async ({ where }: { where: { episodeId: string } }) => ({
      _max: {
        lineIndex: state.voices
          .filter((row) => row.episodeId === where.episodeId)
          .reduce<number | null>((max, row) => (
            max === null ? row.lineIndex as number : Math.max(max, row.lineIndex as number)
          ), null),
      },
    })),
    update: vi.fn(async ({
      where,
      data,
    }: {
      where: { id: string }
      data: Record<string, unknown>
    }) => {
      const row = state.voices.find((candidate) => candidate.id === where.id)
      if (!row) throw new Error('VOICE_ROW_NOT_FOUND')
      Object.assign(row, data)
      return {
        id: row.id as string,
        speaker: row.speaker as string,
        matchedStoryboardId: row.matchedStoryboardId as string | null,
      }
    }),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      if (state.voices.some((row) => (
        row.episodeId === data.episodeId && row.lineIndex === data.lineIndex
      ))) {
        throw { code: 'P2002', meta: { target: ['episodeId', 'lineIndex'] } }
      }
      const persisted = { id: `voice-${state.voices.length + 1}`, sourceKey: null, ...data }
      state.voices.push(persisted)
      return {
        id: persisted.id,
        speaker: persisted.speaker as string,
        matchedStoryboardId: persisted.matchedStoryboardId as string | null,
      }
    }),
    updateMany: vi.fn(async ({
      where,
      data,
    }: {
      where: {
        episodeId?: string
        lineType?: string
        matchedStoryboardId?: { in: string[] }
        OR?: Array<{ sourceKey?: string; matchedPanelId?: string }>
      }
      data: Record<string, unknown>
    }) => {
      let count = 0
      for (const row of state.voices) {
        const matches = (!where.episodeId || row.episodeId === where.episodeId)
          && (!where.lineType || row.lineType === where.lineType)
          && (!where.matchedStoryboardId
            || where.matchedStoryboardId.in.includes(row.matchedStoryboardId as string))
          && (!where.OR || where.OR.some((branch) => (
            (branch.sourceKey && row.sourceKey === branch.sourceKey)
            || (branch.matchedPanelId && row.matchedPanelId === branch.matchedPanelId)
          )))
        if (!matches) continue
        Object.assign(row, data)
        count += 1
      }
      return { count }
    }),
    deleteMany: vi.fn(async ({ where }: {
      where: { episodeId: string; lineType?: string; lineIndex?: { notIn: number[] } }
    }) => {
      const before = state.voices.length
      const retained = state.voices.filter((row) => {
        const matches = row.episodeId === where.episodeId
          && (!where.lineType || row.lineType === where.lineType)
          && (!where.lineIndex || !where.lineIndex.notIn.includes(row.lineIndex as number))
        return !matches
      })
      state.voices.splice(0, state.voices.length, ...retained)
      return { count: before - retained.length }
    }),
    upsert: vi.fn(async ({
      where,
      create,
      update,
    }: {
      where: { episodeId_lineIndex: { episodeId: string; lineIndex: number } }
      create: Record<string, unknown>
      update: Record<string, unknown>
    }) => {
      const key = where.episodeId_lineIndex
      const existing = state.voices.find((row) => (
        row.episodeId === key.episodeId && row.lineIndex === key.lineIndex
      ))
      if (existing) Object.assign(existing, update)
      else state.voices.push({ id: `voice-${state.voices.length + 1}`, ...create })
      const persisted = existing || state.voices[state.voices.length - 1]
      return { id: persisted.id as string }
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

  it('preserves panel narration identity, config, and audio across grid replanning', async () => {
    const gridGroup = group('four_grid')
    const voiceLineRows = Array.from({ length: 4 }, (_, index) => ({
      lineIndex: index + 1,
      speaker: 'Ming',
      content: `line ${index + 1}`,
      emotionStrength: 0.5,
      matchedPanel: { storyboardId: gridGroup.groupId, panelIndex: index },
    }))
    const persist = async (clipPanels: ReturnType<typeof group>[]) => await persistGridStoryboardOutputs({
      episodeId: 'episode-1',
      runId: 'run-1',
      clipPanels,
      voiceLineRows,
      runSnapshot: runSnapshot('four_grid'),
    })

    await persist([gridGroup])
    const panel = state.panels[0]
    const panelId = panel.id as string
    Object.assign(panel, {
      narrationMode: 'on',
      narrationRecommended: true,
      narrationSuggestedText: 'Original suggestion',
      narrationSuggestedEmotion: 'reflective',
      narrationText: 'Manual narration',
      narrationEmotion: 'solemn',
      imagePrompt: 'stale image prompt',
      imageHistory: 'stale history',
      videoUrl: '/media/stale-video.mp4',
      videoMediaId: 'stale-video-media',
      lipSyncVideoUrl: '/media/stale-lipsync.mp4',
      lipSyncVideoMediaId: 'stale-lipsync-media',
      linkedToNextPanel: true,
    })
    state.voices.push({
      id: 'narration-1',
      episodeId: 'episode-1',
      lineIndex: 5,
      lineType: 'narration',
      enabled: true,
      sourceKey: `panel-narration:${panelId}`,
      speaker: 'Narrator',
      content: 'Manual narration',
      emotionPrompt: 'solemn',
      matchedPanelId: panelId,
      matchedStoryboardId: panel.storyboardId,
      matchedPanelIndex: 0,
      voicePresetId: 'preset-1',
      audioUrl: '/media/narration.wav',
      audioMediaId: 'media-1',
      audioDuration: 2400,
    }, {
      id: 'stale-dialogue',
      episodeId: 'episode-1',
      lineIndex: 99,
      lineType: 'dialogue',
      enabled: true,
      sourceKey: null,
      speaker: 'Stale',
      content: 'Remove me',
    })

    const replanned = {
      ...gridGroup,
      finalPanels: gridGroup.finalPanels.map((item, index) => (
        index === 0 ? { ...item, description: 'replanned visual beat' } : item
      )),
    }
    await persist([replanned])

    expect(state.panels).toHaveLength(4)
    expect(state.panels[0]).toMatchObject({
      id: panelId,
      description: 'replanned visual beat',
      narrationMode: 'on',
      narrationRecommended: true,
      narrationSuggestedText: 'Original suggestion',
      narrationSuggestedEmotion: 'reflective',
      narrationText: 'Manual narration',
      narrationEmotion: 'solemn',
      imagePrompt: null,
      imageHistory: null,
      videoUrl: null,
      videoMediaId: null,
      lipSyncVideoUrl: null,
      lipSyncVideoMediaId: null,
      linkedToNextPanel: false,
    })
    expect(state.voices.find((row) => row.id === 'narration-1')).toMatchObject({
      sourceKey: `panel-narration:${panelId}`,
      matchedPanelId: panelId,
      voicePresetId: 'preset-1',
      audioUrl: '/media/narration.wav',
      audioMediaId: 'media-1',
      audioDuration: 2400,
    })
    expect(state.voices.some((row) => row.id === 'stale-dialogue')).toBe(false)

    await persist([{
      ...replanned,
      finalPanels: replanned.finalPanels.map((item, index) => (
        index === 0
          ? { ...item, dialogue: { speaker: 'Ming', text: 'Now this panel has dialogue.' } }
          : item
      )),
    }])

    expect(state.panels[0]).toMatchObject({
      id: panelId,
      hasDialogue: true,
      narrationMode: 'on',
      narrationText: 'Manual narration',
    })
    expect(state.voices.find((row) => row.id === 'narration-1')).toMatchObject({
      enabled: false,
      sourceKey: `panel-narration:${panelId}`,
      voicePresetId: 'preset-1',
      audioUrl: '/media/narration.wav',
    })

    await persist([replanned])

    expect(state.panels[0]).toMatchObject({
      id: panelId,
      hasDialogue: false,
      narrationMode: 'on',
      narrationRecommended: true,
      narrationText: 'Manual narration',
      narrationEmotion: 'solemn',
    })
    expect(state.voices.find((row) => row.id === 'narration-1')).toMatchObject({
      enabled: true,
      sourceKey: `panel-narration:${panelId}`,
      lineType: 'narration',
      speaker: 'Narrator',
      content: 'Manual narration',
      emotionPrompt: 'solemn',
      matchedPanelId: panelId,
      voicePresetId: 'preset-1',
      audioUrl: '/media/narration.wav',
      audioMediaId: 'media-1',
      audioDuration: 2400,
    })
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
