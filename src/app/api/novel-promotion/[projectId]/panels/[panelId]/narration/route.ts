import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { isErrorResponse, requireProjectAuthLight } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { readJsonObject } from '@/lib/viral-replication/request-json'
import { prisma } from '@/lib/prisma'
import {
  parseNarrationMode,
  validateManualNarration,
} from '@/lib/novel-promotion/narration/state'
import { syncPanelNarrationVoiceLine } from '@/lib/novel-promotion/narration/sync'

const narrationPatchSchema = z.object({
  mode: z.enum(['auto', 'on', 'off']),
  text: z.string().nullable().optional(),
  emotion: z.string().nullable().optional(),
  locale: z.enum(['zh', 'en']).optional(),
  expectedPanelUpdatedAt: z.string().datetime({ offset: true }),
}).strict()

const narrationPanelSelect = {
  id: true,
  storyboardId: true,
  panelIndex: true,
  hasDialogue: true,
  narrationMode: true,
  narrationRecommended: true,
  narrationSuggestedText: true,
  narrationSuggestedEmotion: true,
  narrationText: true,
  narrationEmotion: true,
  updatedAt: true,
  storyboard: {
    select: { episodeId: true },
  },
} as const

function trimNullable(value: string | null): string | null {
  if (value === null) return null
  return value.trim() || null
}

export const PATCH = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string; panelId: string }> },
) => {
  const { projectId, panelId } = await context.params
  const auth = await requireProjectAuthLight(projectId)
  if (isErrorResponse(auth)) return auth

  const rawBody = await readJsonObject(request)
  const parsed = narrationPatchSchema.safeParse(rawBody)
  if (!parsed.success) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'PANEL_NARRATION_PAYLOAD_INVALID',
      field: parsed.error.issues[0]?.path.join('.') || 'body',
    })
  }
  const body = parsed.data

  const panel = await prisma.novelPromotionPanel.findFirst({
    where: {
      id: panelId,
      storyboard: {
        episode: {
          novelPromotionProject: { projectId },
        },
      },
    },
    select: narrationPanelSelect,
  })
  if (!panel) throw new ApiError('NOT_FOUND')
  if (panel.hasDialogue) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'PANEL_NARRATION_DIALOGUE_UNSUPPORTED',
    })
  }

  const textSupplied = Object.prototype.hasOwnProperty.call(rawBody, 'text')
  const emotionSupplied = Object.prototype.hasOwnProperty.call(rawBody, 'emotion')
  const requestedMode = parseNarrationMode(
    textSupplied || emotionSupplied ? 'on' : body.mode,
  )
  let narrationText = trimNullable(panel.narrationText)
  let narrationEmotion = trimNullable(panel.narrationEmotion)

  if (textSupplied) {
    narrationText = trimNullable(body.text ?? null)
  } else if (
    panel.narrationMode === 'auto'
    && requestedMode !== 'auto'
    && narrationText === null
  ) {
    narrationText = trimNullable(panel.narrationSuggestedText)
  }

  if (emotionSupplied) {
    narrationEmotion = trimNullable(body.emotion ?? null)
  } else if (
    panel.narrationMode === 'auto'
    && requestedMode !== 'auto'
    && narrationEmotion === null
  ) {
    narrationEmotion = trimNullable(panel.narrationSuggestedEmotion)
  }

  try {
    validateManualNarration({ mode: requestedMode, text: narrationText })
  } catch (error) {
    if (error instanceof Error && error.message === 'PANEL_NARRATION_TEXT_REQUIRED') {
      throw new ApiError('INVALID_PARAMS', { code: error.message })
    }
    throw error
  }

  const expectedPanelUpdatedAt = new Date(body.expectedPanelUpdatedAt)
  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.novelPromotionPanel.updateMany({
      where: {
        id: panel.id,
        updatedAt: expectedPanelUpdatedAt,
        storyboard: {
          episode: {
            novelPromotionProject: { projectId },
          },
        },
      },
      data: {
        narrationMode: requestedMode,
        narrationText,
        narrationEmotion,
      },
    })
    if (updated.count !== 1) {
      throw new ApiError('CONFLICT', { code: 'PANEL_NARRATION_STALE' })
    }

    const canonicalPanel = await tx.novelPromotionPanel.findUnique({
      where: { id: panel.id },
      select: narrationPanelSelect,
    })
    if (!canonicalPanel) throw new ApiError('NOT_FOUND')

    const voiceLine = await syncPanelNarrationVoiceLine({
      tx,
      episodeId: canonicalPanel.storyboard.episodeId,
      panelId: canonicalPanel.id,
      storyboardId: canonicalPanel.storyboardId,
      panelIndex: canonicalPanel.panelIndex,
      locale: body.locale || 'zh',
      mode: parseNarrationMode(canonicalPanel.narrationMode),
      recommended: canonicalPanel.narrationRecommended,
      suggestedText: canonicalPanel.narrationSuggestedText,
      suggestedEmotion: canonicalPanel.narrationSuggestedEmotion,
      text: canonicalPanel.narrationText,
      emotion: canonicalPanel.narrationEmotion,
    })

    return { panel: canonicalPanel, voiceLine }
  })

  return NextResponse.json({
    narrationMode: result.panel.narrationMode,
    narrationRecommended: result.panel.narrationRecommended,
    narrationSuggestedText: result.panel.narrationSuggestedText,
    narrationSuggestedEmotion: result.panel.narrationSuggestedEmotion,
    narrationText: result.panel.narrationText,
    narrationEmotion: result.panel.narrationEmotion,
    updatedAt: result.panel.updatedAt.toISOString(),
    ...(result.voiceLine ? { voiceLineId: result.voiceLine.id } : {}),
  })
})
