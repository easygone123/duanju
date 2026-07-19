import type { Prisma } from '@prisma/client'
import { describe, expect, it, vi } from 'vitest'
import {
  narrationSourceKey,
  relocateNarrationIndexConflicts,
  syncPanelNarrationVoiceLine,
} from '@/lib/novel-promotion/narration/sync'

type VoiceLineRow = {
  id: string
  episodeId: string
  lineIndex: number
  lineType: string
  enabled: boolean
  sourceKey: string | null
  speaker: string
  content: string
  emotionPrompt: string | null
  matchedPanelId: string | null
  matchedStoryboardId: string | null
  matchedPanelIndex: number | null
  voicePresetId: string | null
  audioUrl: string | null
  audioMediaId: string | null
  audioDuration: number | null
}

function voiceLine(overrides: Partial<VoiceLineRow> = {}): VoiceLineRow {
  return {
    id: 'voice-1',
    episodeId: 'episode-1',
    lineIndex: 1,
    lineType: 'narration',
    enabled: true,
    sourceKey: narrationSourceKey('panel-1'),
    speaker: 'Narrator',
    content: 'Old narration',
    emotionPrompt: 'calm',
    matchedPanelId: 'panel-1',
    matchedStoryboardId: 'storyboard-1',
    matchedPanelIndex: 0,
    voicePresetId: null,
    audioUrl: null,
    audioMediaId: null,
    audioDuration: null,
    ...overrides,
  }
}

function makeTransaction(initialRows: VoiceLineRow[] = []) {
  const rows = initialRows.map((row) => ({ ...row }))
  let nextId = rows.length + 1
  const model = {
    findUnique: vi.fn(async ({ where }: { where: { sourceKey: string } }) => (
      rows.find((row) => row.sourceKey === where.sourceKey) || null
    )),
    aggregate: vi.fn(async ({ where }: { where: { episodeId: string } }) => ({
      _max: {
        lineIndex: rows
          .filter((row) => row.episodeId === where.episodeId)
          .reduce<number | null>((max, row) => max === null ? row.lineIndex : Math.max(max, row.lineIndex), null),
      },
    })),
    create: vi.fn(async ({ data }: { data: Omit<VoiceLineRow, 'id'> }) => {
      if (rows.some((row) => row.sourceKey === data.sourceKey)) {
        throw { code: 'P2002', meta: { target: ['sourceKey'] } }
      }
      const created = { id: `voice-${nextId++}`, ...data }
      rows.push(created)
      return { id: created.id }
    }),
    update: vi.fn(async ({
      where,
      data,
    }: {
      where: { id: string }
      data: Partial<VoiceLineRow>
    }) => {
      const row = rows.find((candidate) => candidate.id === where.id)
      if (!row) throw new Error('ROW_NOT_FOUND')
      Object.assign(row, data)
      return { id: row.id }
    }),
    findMany: vi.fn(async ({
      where,
    }: {
      where: { episodeId: string; lineType: string; lineIndex: { in: number[] } }
    }) => rows
      .filter((row) => (
        row.episodeId === where.episodeId
        && row.lineType === where.lineType
        && where.lineIndex.in.includes(row.lineIndex)
      ))
      .sort((left, right) => left.lineIndex - right.lineIndex || left.id.localeCompare(right.id))
      .map(({ id, lineIndex }) => ({ id, lineIndex }))),
  }

  return {
    rows,
    model,
    tx: { novelPromotionVoiceLine: model } as unknown as Prisma.TransactionClient,
  }
}

const baseInput = {
  episodeId: 'episode-1',
  panelId: 'panel-1',
  storyboardId: 'storyboard-1',
  panelIndex: 0,
  locale: 'en' as const,
  mode: 'auto' as const,
  recommended: true,
  suggestedText: 'Suggested narration',
  suggestedEmotion: 'reflective',
  text: 'Manual narration',
  emotion: 'urgent',
}

describe('panel narration voice-line synchronization', () => {
  it('uses one stable source key across creation and refresh', async () => {
    const { tx, rows, model } = makeTransaction()

    const created = await syncPanelNarrationVoiceLine({ tx, ...baseInput })
    const refreshed = await syncPanelNarrationVoiceLine({
      tx,
      ...baseInput,
      suggestedText: 'Refreshed suggestion',
    })

    expect(created).toEqual({ id: 'voice-1' })
    expect(refreshed).toEqual({ id: 'voice-1' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      sourceKey: 'panel-narration:panel-1',
      lineType: 'narration',
      content: 'Refreshed suggestion',
    })
    expect(model.create).toHaveBeenCalledTimes(1)
    expect(model.update).toHaveBeenCalledTimes(1)
  })

  it('does not create a row when effective text is blank', async () => {
    const { tx, model } = makeTransaction()

    await expect(syncPanelNarrationVoiceLine({
      tx,
      ...baseInput,
      suggestedText: '  ',
    })).resolves.toBeNull()
    expect(model.create).not.toHaveBeenCalled()
  })

  it('refreshes automatic content, emotion, matching, speaker, and enabled state', async () => {
    const { tx, rows } = makeTransaction([voiceLine({
      enabled: false,
      speaker: '旁白',
      content: 'Stale suggestion',
      emotionPrompt: 'stale',
    })])

    await syncPanelNarrationVoiceLine({ tx, ...baseInput })

    expect(rows[0]).toMatchObject({
      enabled: true,
      lineType: 'narration',
      speaker: 'Narrator',
      content: 'Suggested narration',
      emotionPrompt: 'reflective',
      matchedPanelId: 'panel-1',
      matchedStoryboardId: 'storyboard-1',
      matchedPanelIndex: 0,
    })
  })

  it('uses manual content when narration is forced on', async () => {
    const { tx, rows } = makeTransaction()

    await syncPanelNarrationVoiceLine({
      tx,
      ...baseInput,
      mode: 'on',
      recommended: false,
    })

    expect(rows[0]).toMatchObject({
      enabled: true,
      content: 'Manual narration',
      emotionPrompt: 'urgent',
    })
  })

  it('keeps disabled manual content coherent while preserving audio and preset fields', async () => {
    const media = {
      voicePresetId: 'preset-1',
      audioUrl: '/media/original.wav',
      audioMediaId: 'media-1',
      audioDuration: 2400,
    }
    const { tx, rows, model } = makeTransaction([voiceLine(media)])

    await syncPanelNarrationVoiceLine({
      tx,
      ...baseInput,
      mode: 'off',
      text: 'Preserved manual narration',
      emotion: 'solemn',
    })

    expect(rows[0]).toMatchObject({
      enabled: false,
      content: 'Preserved manual narration',
      emotionPrompt: 'solemn',
      ...media,
    })
    const updateData = model.update.mock.calls[0]?.[0]?.data
    expect(updateData).not.toHaveProperty('voicePresetId')
    expect(updateData).not.toHaveProperty('audioUrl')
    expect(updateData).not.toHaveProperty('audioMediaId')
    expect(updateData).not.toHaveProperty('audioDuration')
  })

  it('reloads and updates a concurrently created source-key row', async () => {
    const racedRow = voiceLine({ id: 'voice-raced', lineIndex: 5 })
    const sourceKey = narrationSourceKey('panel-1')
    const model = {
      findUnique: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: racedRow.id }),
      aggregate: vi.fn(async () => ({ _max: { lineIndex: 4 } })),
      create: vi.fn(async () => {
        throw { code: 'P2002', meta: { target: ['episodeId', 'lineIndex'] } }
      }),
      update: vi.fn(async () => ({ id: racedRow.id })),
    }
    const tx = { novelPromotionVoiceLine: model } as unknown as Prisma.TransactionClient

    await expect(syncPanelNarrationVoiceLine({ tx, ...baseInput }))
      .resolves.toEqual({ id: 'voice-raced' })
    expect(model.findUnique).toHaveBeenLastCalledWith({
      where: { sourceKey },
      select: { id: true },
    })
    expect(model.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'voice-raced' },
    }))
  })

  it('does not swallow an unrelated unique violation', async () => {
    const uniqueError = { code: 'P2002', meta: { target: ['episodeId', 'lineIndex'] } }
    const model = {
      findUnique: vi.fn().mockResolvedValue(null),
      aggregate: vi.fn(async () => ({ _max: { lineIndex: 4 } })),
      create: vi.fn(async () => { throw uniqueError }),
      update: vi.fn(),
    }
    const tx = { novelPromotionVoiceLine: model } as unknown as Prisma.TransactionClient

    await expect(syncPanelNarrationVoiceLine({ tx, ...baseInput })).rejects.toBe(uniqueError)
    expect(model.update).not.toHaveBeenCalled()
  })
})

describe('narration line-index relocation', () => {
  it('moves only colliding narration rows above the current maximum in deterministic order', async () => {
    const preserved = {
      voicePresetId: 'preset-1',
      audioUrl: '/media/narration.wav',
      audioMediaId: 'media-1',
      audioDuration: 3200,
    }
    const { tx, rows, model } = makeTransaction([
      voiceLine({ id: 'dialogue-1', lineIndex: 1, lineType: 'dialogue', sourceKey: null }),
      voiceLine({
        id: 'narration-b',
        lineIndex: 2,
        sourceKey: narrationSourceKey('panel-2'),
        ...preserved,
      }),
      voiceLine({
        id: 'narration-a',
        lineIndex: 4,
        sourceKey: narrationSourceKey('panel-3'),
      }),
      voiceLine({
        id: 'narration-safe',
        lineIndex: 5,
        sourceKey: narrationSourceKey('panel-4'),
      }),
      voiceLine({
        id: 'other-episode',
        episodeId: 'episode-2',
        lineIndex: 2,
        sourceKey: narrationSourceKey('panel-5'),
      }),
    ])

    await relocateNarrationIndexConflicts({
      tx,
      episodeId: 'episode-1',
      incomingDialogueIndexes: [6, 4, 2, 2],
    })

    expect(rows.find((row) => row.id === 'narration-b')).toMatchObject({
      lineIndex: 7,
      ...preserved,
    })
    expect(rows.find((row) => row.id === 'narration-a')).toMatchObject({ lineIndex: 8 })
    expect(rows.find((row) => row.id === 'narration-safe')).toMatchObject({ lineIndex: 5 })
    expect(rows.find((row) => row.id === 'dialogue-1')).toMatchObject({ lineIndex: 1 })
    expect(rows.find((row) => row.id === 'other-episode')).toMatchObject({ lineIndex: 2 })
    expect(model.update.mock.calls.map((call) => call[0])).toEqual([
      { where: { id: 'narration-b' }, data: { lineIndex: 7 } },
      { where: { id: 'narration-a' }, data: { lineIndex: 8 } },
    ])
  })
})
