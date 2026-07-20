import type { Prisma } from '@prisma/client'
import { describe, expect, it, vi } from 'vitest'
import {
  narrationSourceKey,
  relocateNarrationIndexConflicts,
  syncPanelNarrationVoiceLine,
  writeDialogueVoiceLine,
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

function transactionWithVoiceModel(model: unknown, hasDialogue = false) {
  return {
    novelPromotionPanel: {
      findUnique: vi.fn(async () => ({ hasDialogue })),
    },
    novelPromotionVoiceLine: model,
  } as unknown as Prisma.TransactionClient
}

function makeTransaction(initialRows: VoiceLineRow[] = [], hasDialogue = false) {
  const rows = initialRows.map((row) => ({ ...row }))
  let nextId = rows.length + 1
  const model = {
    findUnique: vi.fn(async ({ where }: {
      where: {
        sourceKey?: string
        episodeId_lineIndex?: { episodeId: string; lineIndex: number }
      }
    }) => {
      if (where.sourceKey) {
        return rows.find((row) => row.sourceKey === where.sourceKey) || null
      }
      const key = where.episodeId_lineIndex
      return key
        ? rows.find((row) => row.episodeId === key.episodeId && row.lineIndex === key.lineIndex) || null
        : null
    }),
    aggregate: vi.fn(async ({ where }: { where: { episodeId: string } }) => ({
      _max: {
        lineIndex: rows
          .filter((row) => row.episodeId === where.episodeId)
          .reduce<number | null>((max, row) => max === null ? row.lineIndex : Math.max(max, row.lineIndex), null),
      },
    })),
    create: vi.fn(async ({ data }: {
      data: Partial<VoiceLineRow> & Pick<
        VoiceLineRow,
        'episodeId' | 'lineIndex' | 'lineType' | 'enabled' | 'speaker' | 'content'
      >
    }) => {
      if (rows.some((row) => row.sourceKey === data.sourceKey)) {
        throw { code: 'P2002', meta: { target: ['sourceKey'] } }
      }
      if (rows.some((row) => (
        row.episodeId === data.episodeId && row.lineIndex === data.lineIndex
      ))) {
        throw { code: 'P2002', meta: { target: ['episodeId', 'lineIndex'] } }
      }
      const created = voiceLine({
        id: `voice-${nextId++}`,
        sourceKey: data.sourceKey ?? null,
        ...data,
      })
      rows.push(created)
      return { id: created.id }
    }),
    update: vi.fn(async ({
      where,
      data,
    }: {
      where: { id?: string; sourceKey?: string }
      data: Partial<VoiceLineRow>
    }) => {
      const row = rows.find((candidate) => (
        (where.id && candidate.id === where.id)
        || (where.sourceKey && candidate.sourceKey === where.sourceKey)
      ))
      if (!row) throw { code: 'P2025' }
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
    tx: transactionWithVoiceModel(model, hasDialogue),
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

  it('disables an existing manual row without changing projection or media fields', async () => {
    const media = {
      voicePresetId: 'preset-1',
      audioUrl: '/media/original.wav',
      audioMediaId: 'media-1',
      audioDuration: 2400,
    }
    const existingProjection = {
      speaker: 'Existing narrator',
      content: 'Existing narration',
      emotionPrompt: 'existing emotion',
      matchedPanelId: 'existing-panel',
      matchedStoryboardId: 'existing-storyboard',
      matchedPanelIndex: 3,
    }
    const { tx, rows, model } = makeTransaction([voiceLine({
      ...media,
      ...existingProjection,
    })])

    await syncPanelNarrationVoiceLine({
      tx,
      ...baseInput,
      mode: 'off',
      text: 'Preserved manual narration',
      emotion: 'solemn',
    })

    expect(rows[0]).toMatchObject({
      enabled: false,
      ...existingProjection,
      ...media,
    })
    const updateData = model.update.mock.calls[0]?.[0]?.data
    expect(updateData).toEqual({ enabled: false })
  })

  it('disables an auto-unrecommended row without refreshing its prior projection', async () => {
    const prior = voiceLine({
      content: 'Prior automatic narration',
      emotionPrompt: 'prior emotion',
      audioUrl: '/media/prior.wav',
    })
    const { tx, rows, model } = makeTransaction([prior])

    await syncPanelNarrationVoiceLine({
      tx,
      ...baseInput,
      recommended: false,
      suggestedText: 'New disabled suggestion',
      suggestedEmotion: 'new disabled emotion',
    })

    expect(rows[0]).toEqual({ ...prior, enabled: false })
    expect(model.update.mock.calls[0]?.[0]?.data).toEqual({ enabled: false })
  })

  it('keeps narration disabled while the canonical panel has dialogue', async () => {
    const prior = voiceLine({ enabled: true, audioUrl: '/media/dialogue-panel.wav' })
    const { tx, rows, model } = makeTransaction([prior], true)

    await syncPanelNarrationVoiceLine({ tx, ...baseInput, mode: 'on' })

    expect(rows[0]).toEqual({ ...prior, enabled: false })
    expect(model.update.mock.calls[0]?.[0]?.data).toEqual({ enabled: false })
  })

  it('updates a concurrently created row with a current write by source key', async () => {
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
    const tx = transactionWithVoiceModel(model)

    await expect(syncPanelNarrationVoiceLine({ tx, ...baseInput }))
      .resolves.toEqual({ id: 'voice-raced' })
    expect(model.findUnique).toHaveBeenLastCalledWith({
      where: { sourceKey },
      select: { id: true },
    })
    expect(model.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { sourceKey: 'panel-narration:panel-1' },
    }))
  })

  it('does not swallow an unrelated unique violation', async () => {
    const uniqueError = { code: 'P2002', meta: { target: ['unrelatedUniqueField'] } }
    const model = {
      findUnique: vi.fn().mockResolvedValue(null),
      aggregate: vi.fn(async () => ({ _max: { lineIndex: 4 } })),
      create: vi.fn(async () => { throw uniqueError }),
      update: vi.fn().mockRejectedValue({ code: 'P2025' }),
    }
    const tx = transactionWithVoiceModel(model)

    await expect(syncPanelNarrationVoiceLine({ tx, ...baseInput })).rejects.toBe(uniqueError)
    expect(model.update).toHaveBeenCalledTimes(1)
  })

  it('advances the next index when a repeatable-read snapshot does not advance', async () => {
    const model = {
      findUnique: vi.fn().mockResolvedValue(null),
      aggregate: vi.fn().mockResolvedValue({ _max: { lineIndex: 4 } }),
      create: vi.fn()
        .mockRejectedValueOnce({ code: 'P2002', meta: { target: ['episodeId', 'lineIndex'] } })
        .mockResolvedValueOnce({ id: 'voice-retried' }),
      update: vi.fn().mockRejectedValue({ code: 'P2025' }),
    }
    const tx = transactionWithVoiceModel(model)

    await expect(syncPanelNarrationVoiceLine({ tx, ...baseInput }))
      .resolves.toEqual({ id: 'voice-retried' })
    expect(model.aggregate).toHaveBeenCalledTimes(2)
    expect(model.create.mock.calls.map((call) => call[0].data.lineIndex)).toEqual([5, 6])
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

  it('allocates above a higher incoming dialogue index', async () => {
    const { tx, rows } = makeTransaction([
      voiceLine({ id: 'narration-3', lineIndex: 3 }),
    ])

    await relocateNarrationIndexConflicts({
      tx,
      episodeId: 'episode-1',
      incomingDialogueIndexes: [1, 2, 3, 4],
    })

    expect(rows[0].lineIndex).toBe(5)
  })

  it('advances relocation when a repeatable-read aggregate remains stale', async () => {
    const model = {
      findMany: vi.fn(async () => [{ id: 'narration-3', lineIndex: 3 }]),
      aggregate: vi.fn(async () => ({ _max: { lineIndex: 4 } })),
      update: vi.fn()
        .mockRejectedValueOnce({ code: 'P2002', meta: { target: ['episodeId', 'lineIndex'] } })
        .mockResolvedValueOnce({ id: 'narration-3' }),
    }
    const tx = transactionWithVoiceModel(model)

    await relocateNarrationIndexConflicts({
      tx,
      episodeId: 'episode-1',
      incomingDialogueIndexes: [1, 2, 3, 4],
    })

    expect(model.aggregate).toHaveBeenCalledTimes(2)
    expect(model.update.mock.calls.map((call) => call[0].data.lineIndex)).toEqual([5, 6])
  })

  it('relocates narration inserted between dialogue lookup and create without mutating it', async () => {
    const media = {
      voicePresetId: 'preset-race',
      audioUrl: '/media/raced.wav',
      audioMediaId: 'media-race',
      audioDuration: 1800,
    }
    const harness = makeTransaction()
    harness.model.create.mockImplementationOnce(async () => {
      harness.rows.push(voiceLine({
        id: 'narration-race',
        lineIndex: 2,
        sourceKey: narrationSourceKey('panel-race'),
        ...media,
      }))
      throw { code: 'P2002', meta: { target: ['episodeId', 'lineIndex'] } }
    })

    await writeDialogueVoiceLine({
      tx: harness.tx,
      episodeId: 'episode-1',
      lineIndex: 2,
      incomingDialogueIndexes: [1, 2],
      speaker: 'Hero',
      content: 'Dialogue wins index two',
      emotionStrength: 0.5,
      matchedPanelId: 'panel-2',
      matchedStoryboardId: 'storyboard-1',
      matchedPanelIndex: 1,
    })

    expect(harness.rows.find((row) => row.id === 'narration-race')).toMatchObject({
      lineIndex: 3,
      lineType: 'narration',
      sourceKey: narrationSourceKey('panel-race'),
      ...media,
    })
    expect(harness.rows.find((row) => row.lineIndex === 2)).toMatchObject({
      lineType: 'dialogue',
      enabled: true,
      content: 'Dialogue wins index two',
    })
  })
})
