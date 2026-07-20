import { NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildMockRequest } from '../../../helpers/request'

const authMock = vi.hoisted(() => vi.fn())
const syncMock = vi.hoisted(() => vi.fn())
const mediaMock = vi.hoisted(() => ({
  resolveMediaRef: vi.fn(async () => null),
  resolveMediaRefFromLegacyValue: vi.fn(async () => null),
}))

const state = vi.hoisted(() => ({
  panel: null as Record<string, unknown> | null,
  line: null as Record<string, unknown> | null,
  transactionCalls: 0,
  beforeNextVoiceUpdate: null as (() => void) | null,
}))

const panelFindFirst = vi.hoisted(() => vi.fn(async () => state.panel))
const panelFindUnique = vi.hoisted(() => vi.fn(async () => state.panel))
const panelUpdateMany = vi.hoisted(() => vi.fn(async ({ where, data }: {
  where: { updatedAt?: Date }
  data: Record<string, unknown>
}) => {
  if (!state.panel) return { count: 0 }
  const currentUpdatedAt = state.panel.updatedAt as Date
  if (where.updatedAt && currentUpdatedAt.getTime() !== where.updatedAt.getTime()) {
    return { count: 0 }
  }
  state.panel = {
    ...state.panel,
    ...data,
    updatedAt: new Date('2026-07-20T01:00:01.000Z'),
  }
  return { count: 1 }
}))
const voiceFindFirst = vi.hoisted(() => vi.fn(async () => state.line))
const voiceUpdate = vi.hoisted(() => vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
  state.beforeNextVoiceUpdate?.()
  state.beforeNextVoiceUpdate = null
  state.line = {
    ...state.line,
    ...data,
    updatedAt: new Date('2026-07-20T01:00:01.000Z'),
    matchedPanel: state.panel
      ? {
          id: state.panel.id,
          storyboardId: state.panel.storyboardId,
          panelIndex: state.panel.panelIndex,
        }
      : null,
  }
  return state.line
}))
const panelUpdate = vi.hoisted(() => vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
  state.panel = state.panel ? { ...state.panel, ...data } : null
  return state.panel
}))
const voiceFindUnique = vi.hoisted(() => vi.fn(async () => state.line))

const tx = vi.hoisted(() => ({
  novelPromotionPanel: {
    findFirst: panelFindUnique,
    findUnique: panelFindUnique,
    updateMany: panelUpdateMany,
    update: panelUpdate,
  },
  novelPromotionVoiceLine: {
    findUnique: voiceFindUnique,
    findMany: vi.fn(),
    aggregate: vi.fn(),
    create: vi.fn(),
    update: voiceUpdate,
  },
}))

const prismaMock = vi.hoisted(() => ({
  novelPromotionPanel: {
    findFirst: panelFindFirst,
    findUnique: panelFindUnique,
  },
  novelPromotionVoiceLine: {
    findFirst: voiceFindFirst,
    findUnique: vi.fn(),
    update: voiceUpdate,
    updateMany: vi.fn(),
  },
  $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => {
    state.transactionCalls += 1
    const panelBefore = state.panel ? { ...state.panel } : null
    const lineBefore = state.line ? { ...state.line } : null
    try {
      return await callback(tx)
    } catch (error) {
      state.panel = panelBefore
      state.line = lineBefore
      throw error
    }
  }),
}))

vi.mock('@/lib/api-auth', () => ({
  isErrorResponse: (value: unknown) => value instanceof Response,
  requireProjectAuthLight: authMock,
}))
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/lib/media/service', () => mediaMock)
vi.mock('@/lib/novel-promotion/narration/sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/novel-promotion/narration/sync')>()
  return { ...actual, syncPanelNarrationVoiceLine: syncMock }
})

import { PATCH as patchNarration } from '@/app/api/novel-promotion/[projectId]/panels/[panelId]/narration/route'
import { PATCH as patchVoiceLine } from '@/app/api/novel-promotion/[projectId]/voice-lines/route'

const panelUpdatedAt = '2026-07-20T01:00:00.000Z'

function makePanel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'panel-1',
    storyboardId: 'storyboard-1',
    panelIndex: 2,
    hasDialogue: false,
    narrationMode: 'auto',
    narrationRecommended: true,
    narrationSuggestedText: '建议旁白',
    narrationSuggestedEmotion: 'calm',
    narrationText: null,
    narrationEmotion: null,
    updatedAt: new Date(panelUpdatedAt),
    storyboard: { episodeId: 'episode-1' },
    ...overrides,
  }
}

function makeLine(overrides: Record<string, unknown> = {}) {
  return {
    id: 'line-1',
    episodeId: 'episode-1',
    lineIndex: 7,
    lineType: 'narration',
    enabled: true,
    sourceKey: 'panel-narration:panel-1',
    speaker: '旁白',
    content: '建议旁白',
    emotionPrompt: 'calm',
    emotionStrength: 0.4,
    voicePresetId: 'preset-1',
    audioUrl: '/audio/existing.mp3',
    audioMediaId: 'media-1',
    matchedPanelId: 'panel-1',
    matchedStoryboardId: 'storyboard-1',
    matchedPanelIndex: 2,
    updatedAt: new Date(panelUpdatedAt),
    ...overrides,
  }
}

async function narrationPatch(body: Record<string, unknown>, projectId = 'project-1') {
  return patchNarration(buildMockRequest({
    path: `/api/novel-promotion/${projectId}/panels/panel-1/narration`,
    method: 'PATCH',
    body,
  }), { params: Promise.resolve({ projectId, panelId: 'panel-1' }) })
}

async function voicePatch(body: Record<string, unknown>) {
  return patchVoiceLine(buildMockRequest({
    path: '/api/novel-promotion/project-1/voice-lines',
    method: 'PATCH',
    body,
  }), { params: Promise.resolve({ projectId: 'project-1' }) })
}

async function expectApiError(response: Response, status: number, code: string, detailCode?: string) {
  expect(response.status).toBe(status)
  expect(await response.json()).toMatchObject({
    error: {
      code,
      ...(detailCode ? { details: { code: detailCode } } : {}),
    },
  })
}

describe('panel narration PATCH contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.panel = makePanel()
    state.line = makeLine()
    state.transactionCalls = 0
    state.beforeNextVoiceUpdate = null
    authMock.mockResolvedValue({
      session: { user: { id: 'user-1' } },
      project: { id: 'project-1', userId: 'user-1' },
    })
    syncMock.mockResolvedValue({ id: 'line-1' })
  })

  it('returns an auth response before loading a panel', async () => {
    authMock.mockResolvedValueOnce(NextResponse.json({ code: 'AUTH_REQUIRED' }, { status: 401 }))

    const response = await narrationPatch({ mode: 'auto', expectedPanelUpdatedAt: panelUpdatedAt })

    expect(response.status).toBe(401)
    expect(panelFindFirst).not.toHaveBeenCalled()
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('loads the panel only through the path project ownership chain', async () => {
    panelFindFirst.mockResolvedValueOnce(null)

    const response = await narrationPatch({ mode: 'auto', expectedPanelUpdatedAt: panelUpdatedAt })

    await expectApiError(response, 404, 'NOT_FOUND')
    expect(panelFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: 'panel-1',
        storyboard: { episode: { novelPromotionProject: { projectId: 'project-1' } } },
      },
    }))
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('rejects narration on a dialogue panel', async () => {
    state.panel = makePanel({ hasDialogue: true })

    const response = await narrationPatch({ mode: 'on', text: '旁白', expectedPanelUpdatedAt: panelUpdatedAt })

    await expectApiError(response, 400, 'INVALID_PARAMS', 'PANEL_NARRATION_DIALOGUE_UNSUPPORTED')
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it.each([
    [{ mode: 'sometimes', expectedPanelUpdatedAt: panelUpdatedAt }, 'mode'],
    [{ mode: 'auto', locale: 'fr', expectedPanelUpdatedAt: panelUpdatedAt }, 'locale'],
    [{ mode: 'auto', expectedPanelUpdatedAt: 'not-a-date' }, 'expectedPanelUpdatedAt'],
    [{ mode: 'auto', expectedPanelUpdatedAt: panelUpdatedAt, surprise: true }, 'body'],
  ])('rejects invalid or unknown payload values %#', async (body, field) => {
    const response = await narrationPatch(body)

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: {
        code: 'INVALID_PARAMS',
        details: {
          code: 'PANEL_NARRATION_PAYLOAD_INVALID',
          field,
        },
      },
    })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('requires nonblank effective text when mode is on', async () => {
    state.panel = makePanel({ narrationRecommended: false, narrationSuggestedText: '   ' })

    const response = await narrationPatch({ mode: 'on', expectedPanelUpdatedAt: panelUpdatedAt })

    await expectApiError(response, 400, 'INVALID_PARAMS', 'PANEL_NARRATION_TEXT_REQUIRED')
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('initializes an omitted manual draft from effective suggestions on auto to on', async () => {
    const response = await narrationPatch({ mode: 'on', locale: 'en', expectedPanelUpdatedAt: panelUpdatedAt })

    expect(response.status).toBe(200)
    expect(panelUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        narrationMode: 'on',
        narrationText: '建议旁白',
        narrationEmotion: 'calm',
      }),
    }))
    expect(syncMock).toHaveBeenCalledWith(expect.objectContaining({
      tx,
      mode: 'on',
      text: '建议旁白',
      emotion: 'calm',
      locale: 'en',
    }))
    expect(await response.json()).toEqual({
      success: true,
      narration: {
        narrationMode: 'on',
        narrationRecommended: true,
        narrationSuggestedText: '建议旁白',
        narrationSuggestedEmotion: 'calm',
        narrationText: '建议旁白',
        narrationEmotion: 'calm',
        updatedAt: '2026-07-20T01:00:01.000Z',
      },
    })
  })

  it('treats explicit text or emotion edits as mode on and trims nullable values', async () => {
    const response = await narrationPatch({
      mode: 'off',
      text: '  手写旁白  ',
      emotion: '  tense  ',
      expectedPanelUpdatedAt: panelUpdatedAt,
    })

    expect(response.status).toBe(200)
    expect(state.panel).toMatchObject({
      narrationMode: 'on',
      narrationText: '手写旁白',
      narrationEmotion: 'tense',
    })
  })

  it('preserves a manual draft through off and restores suggestions in auto', async () => {
    state.panel = makePanel({
      narrationMode: 'on',
      narrationText: '手写旁白',
      narrationEmotion: 'dramatic',
    })

    const offResponse = await narrationPatch({ mode: 'off', expectedPanelUpdatedAt: panelUpdatedAt })
    expect(offResponse.status).toBe(200)
    expect(state.panel).toMatchObject({
      narrationMode: 'off',
      narrationText: '手写旁白',
      narrationEmotion: 'dramatic',
    })

    const updatedAt = (state.panel?.updatedAt as Date).toISOString()
    const autoResponse = await narrationPatch({ mode: 'auto', expectedPanelUpdatedAt: updatedAt })
    expect(autoResponse.status).toBe(200)
    expect(state.panel).toMatchObject({
      narrationMode: 'auto',
      narrationSuggestedText: '建议旁白',
      narrationText: '手写旁白',
      narrationEmotion: 'dramatic',
    })
    expect(syncMock).toHaveBeenLastCalledWith(expect.objectContaining({
      mode: 'auto',
      suggestedText: '建议旁白',
      text: '手写旁白',
    }))
  })

  it('returns a conflict when the optimistic timestamp is stale', async () => {
    const response = await narrationPatch({
      mode: 'off',
      expectedPanelUpdatedAt: '2026-07-20T00:59:00.000Z',
    })

    await expectApiError(response, 409, 'CONFLICT', 'PANEL_NARRATION_STALE')
    expect(syncMock).not.toHaveBeenCalled()
  })

  it('rolls back the panel update when voice synchronization fails', async () => {
    syncMock.mockRejectedValueOnce(new Error('sync failed'))

    const response = await narrationPatch({ mode: 'off', expectedPanelUpdatedAt: panelUpdatedAt })

    expect(response.status).toBe(500)
    expect(state.panel).toMatchObject({ narrationMode: 'auto' })
    expect(state.transactionCalls).toBe(1)
  })

  it('does not delete or clear narration audio when mode is off', async () => {
    const response = await narrationPatch({ mode: 'off', expectedPanelUpdatedAt: panelUpdatedAt })

    expect(response.status).toBe(200)
    expect(tx.novelPromotionVoiceLine.update).not.toHaveBeenCalled()
    expect(state.line).toMatchObject({
      audioUrl: '/audio/existing.mp3',
      audioMediaId: 'media-1',
    })
    expect(syncMock).toHaveBeenCalledWith(expect.objectContaining({ mode: 'off' }))
    expect(syncMock).toHaveBeenCalledWith(expect.objectContaining({ locale: 'zh' }))
  })
})

describe('narration voice-line PATCH contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.panel = makePanel()
    state.line = makeLine()
    state.transactionCalls = 0
    state.beforeNextVoiceUpdate = null
    authMock.mockResolvedValue({
      session: { user: { id: 'user-1' } },
      project: { id: 'project-1', userId: 'user-1' },
    })
  })

  it('mirrors narration content and emotion to its panel in one transaction while preserving media', async () => {
    const response = await voicePatch({
      lineId: 'line-1',
      content: '  新旁白  ',
      emotionPrompt: '  excited  ',
    })

    expect(response.status).toBe(200)
    expect(state.transactionCalls).toBe(1)
    expect(voiceFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: 'line-1',
        episode: { novelPromotionProject: { projectId: 'project-1' } },
      },
      select: expect.objectContaining({
        episodeId: true,
        lineType: true,
        sourceKey: true,
        matchedPanelId: true,
      }),
    }))
    expect(tx.novelPromotionPanel.update).toHaveBeenCalledWith({
      where: { id: 'panel-1' },
      data: {
        narrationMode: 'on',
        narrationText: '新旁白',
        narrationEmotion: 'excited',
      },
    })
    expect(voiceUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'line-1' },
      data: expect.objectContaining({
        enabled: true,
        content: '新旁白',
        emotionPrompt: 'excited',
      }),
    }))
    expect(voiceUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      panelUpdate.mock.invocationCallOrder[0],
    )
    expect(state.line).toMatchObject({
      id: 'line-1',
      sourceKey: 'panel-narration:panel-1',
      voicePresetId: 'preset-1',
      audioUrl: '/audio/existing.mp3',
      audioMediaId: 'media-1',
    })
  })

  it('re-enables a disabled narration edit and preserves returned emotion on content-only edits', async () => {
    state.line = makeLine({ enabled: false, emotionPrompt: 'existing-emotion' })

    const response = await voicePatch({ lineId: 'line-1', content: '新内容' })

    expect(response.status).toBe(200)
    expect(state.line).toMatchObject({
      enabled: true,
      content: '新内容',
      emotionPrompt: 'existing-emotion',
    })
    expect(state.panel).toMatchObject({
      narrationMode: 'on',
      narrationText: '新内容',
      narrationEmotion: 'existing-emotion',
    })
  })

  it('preserves returned content on emotion-only edits', async () => {
    state.line = makeLine({ enabled: false, content: 'existing-content' })

    const response = await voicePatch({ lineId: 'line-1', emotionPrompt: 'new-emotion' })

    expect(response.status).toBe(200)
    expect(state.line).toMatchObject({
      enabled: true,
      content: 'existing-content',
      emotionPrompt: 'new-emotion',
    })
    expect(state.panel).toMatchObject({
      narrationMode: 'on',
      narrationText: 'existing-content',
      narrationEmotion: 'new-emotion',
    })
  })

  it('mirrors post-update row values instead of a stale pre-read snapshot', async () => {
    state.line = makeLine({ emotionPrompt: 'pre-read-emotion' })
    state.beforeNextVoiceUpdate = () => {
      state.line = { ...(state.line || {}), emotionPrompt: 'concurrent-emotion' }
    }

    const response = await voicePatch({ lineId: 'line-1', content: 'new-content' })

    expect(response.status).toBe(200)
    expect(state.panel).toMatchObject({
      narrationText: 'new-content',
      narrationEmotion: 'concurrent-emotion',
    })
  })

  it.each([
    [{ lineId: 7, content: 'invalid id' }],
    [{ lineId: 'line-1', speaker: 7 }],
    [{ speaker: 'Alice', episodeId: 7, voicePresetId: 'preset-1' }],
    [{ lineId: 'line-1', voicePresetId: 7 }],
    [{ lineId: 'line-1', emotionPrompt: 7 }],
    [{ lineId: 'line-1', emotionStrength: Number.POSITIVE_INFINITY }],
    [{ lineId: 'line-1', emotionStrength: 1.1 }],
    [{ lineId: 'line-1', content: 7 }],
    [{ lineId: 'line-1', audioUrl: 7 }],
    [{ lineId: 'line-1', matchedPanelId: 7 }],
    [{ lineId: 'line-1', surprise: true }],
    [{ lineId: 'line-1' }],
  ])('rejects malformed, unknown-only, and no-op voice payloads %#', async (body) => {
    const response = await voicePatch(body)

    await expectApiError(response, 400, 'INVALID_PARAMS', 'VOICE_LINE_PATCH_PAYLOAD_INVALID')
    expect(voiceFindFirst).not.toHaveBeenCalled()
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('rejects a narration line whose source key does not match its panel identity', async () => {
    state.line = makeLine({ sourceKey: 'panel-narration:panel-elsewhere' })

    const response = await voicePatch({ lineId: 'line-1', content: '不能写入' })

    await expectApiError(response, 400, 'INVALID_PARAMS', 'NARRATION_SOURCE_KEY_INVALID')
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('rolls back both the voice row and panel when the narration transaction fails', async () => {
    state.line = makeLine({ enabled: false, content: 'before-content' })
    state.panel = makePanel({ narrationMode: 'auto', narrationText: null })
    panelUpdate.mockRejectedValueOnce(new Error('panel write failed'))

    const response = await voicePatch({ lineId: 'line-1', content: 'after-content' })

    expect(response.status).toBe(500)
    expect(state.line).toMatchObject({ enabled: false, content: 'before-content' })
    expect(state.panel).toMatchObject({ narrationMode: 'auto', narrationText: null })
  })

  it('rejects blank narration content and identity reassignment', async () => {
    const blank = await voicePatch({ lineId: 'line-1', content: '   ' })
    await expectApiError(blank, 400, 'INVALID_PARAMS', 'PANEL_NARRATION_TEXT_REQUIRED')

    const speaker = await voicePatch({ lineId: 'line-1', speaker: 'Someone else' })
    await expectApiError(speaker, 400, 'INVALID_PARAMS', 'NARRATION_IDENTITY_IMMUTABLE')

    const panel = await voicePatch({ lineId: 'line-1', matchedPanelId: 'panel-2' })
    await expectApiError(panel, 400, 'INVALID_PARAMS', 'NARRATION_IDENTITY_IMMUTABLE')
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('fails closed when a narration line has no matched panel identity', async () => {
    state.line = makeLine({ matchedPanelId: null })

    const response = await voicePatch({ lineId: 'line-1', content: '不能写入' })

    await expectApiError(response, 400, 'INVALID_PARAMS', 'NARRATION_PANEL_MISSING')
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(state.line).toMatchObject({ content: '建议旁白' })
  })

  it.each([
    [null, 'NARRATION_PANEL_MISSING'],
    [makePanel({ hasDialogue: true }), 'PANEL_NARRATION_DIALOGUE_UNSUPPORTED'],
  ])('fails closed when the narration panel is invalid %#', async (panel, detailCode) => {
    state.panel = panel

    const response = await voicePatch({ lineId: 'line-1', content: '不能写入' })

    await expectApiError(response, 400, 'INVALID_PARAMS', detailCode)
    expect(state.line).toMatchObject({ content: '建议旁白' })
  })

  it('allows narration audio clearing and preset edits without forcing manual mode', async () => {
    const response = await voicePatch({
      lineId: 'line-1',
      audioUrl: null,
      voicePresetId: 'preset-2',
    })

    expect(response.status).toBe(200)
    expect(tx.novelPromotionPanel.update).not.toHaveBeenCalled()
    expect(state.panel).toMatchObject({ narrationMode: 'auto' })
    expect(voiceUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        audioUrl: null,
        audioMediaId: null,
        voicePresetId: 'preset-2',
      }),
    }))
  })

  it('keeps normal dialogue updates unchanged', async () => {
    state.line = makeLine({
      lineType: 'dialogue',
      sourceKey: null,
      speaker: 'Alice',
      matchedPanelId: null,
    })

    const response = await voicePatch({
      lineId: 'line-1',
      content: '  hello  ',
      speaker: '  Bob  ',
    })

    expect(response.status).toBe(200)
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(voiceUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ content: 'hello', speaker: 'Bob' }),
    }))
    expect(tx.novelPromotionPanel.update).not.toHaveBeenCalled()
  })

  it('keeps the valid batch speaker preset update shape unchanged', async () => {
    prismaMock.novelPromotionVoiceLine.updateMany.mockResolvedValueOnce({ count: 2 })

    const response = await voicePatch({
      speaker: 'Alice',
      episodeId: 'episode-1',
      voicePresetId: 'preset-2',
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ success: true, updatedCount: 2 })
    expect(prismaMock.novelPromotionVoiceLine.updateMany).toHaveBeenCalledWith({
      where: { episodeId: 'episode-1', speaker: 'Alice' },
      data: { voicePresetId: 'preset-2' },
    })
  })
})
