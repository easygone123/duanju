import type { Prisma } from '@prisma/client'
import {
  resolveNarrationContent,
  resolveNarrationEnabled,
  type PanelNarrationMode,
} from './state'

export const narrationSourceKey = (panelId: string) => `panel-narration:${panelId}`

const MAX_VOICE_LINE_WRITE_ATTEMPTS = 4

type SyncPanelNarrationInput = {
  tx: Prisma.TransactionClient
  episodeId: string
  panelId: string
  storyboardId: string
  panelIndex: number
  locale: 'zh' | 'en'
  mode: PanelNarrationMode
  recommended: boolean
  suggestedText: string | null
  suggestedEmotion: string | null
  text: string | null
  emotion: string | null
}

export async function syncPanelNarrationVoiceLine(
  input: SyncPanelNarrationInput,
): Promise<{ id: string } | null> {
  const sourceKey = narrationSourceKey(input.panelId)
  const content = resolveNarrationContent({
    mode: input.mode,
    suggestedText: input.suggestedText,
    suggestedEmotion: input.suggestedEmotion,
    manualText: input.text,
    manualEmotion: input.emotion,
  })
  const effectiveText = content.text?.trim() || ''
  const effectiveEmotion = content.emotion?.trim() || null
  const panel = await input.tx.novelPromotionPanel.findUnique({
    where: { id: input.panelId },
    select: { hasDialogue: true },
  })
  if (!panel) throw new Error('PANEL_NARRATION_PANEL_NOT_FOUND')
  const projection = {
    lineType: 'narration',
    enabled: !panel.hasDialogue && resolveNarrationEnabled({
      mode: input.mode,
      recommended: input.recommended,
    }),
    speaker: input.locale === 'zh' ? '旁白' : 'Narrator',
    content: effectiveText,
    emotionPrompt: effectiveEmotion,
    matchedPanelId: input.panelId,
    matchedStoryboardId: input.storyboardId,
    matchedPanelIndex: input.panelIndex,
  }
  const updateProjection = projection.enabled ? projection : { enabled: false }

  const existing = await input.tx.novelPromotionVoiceLine.findUnique({
    where: { sourceKey },
    select: { id: true },
  })
  if (existing) {
    return await input.tx.novelPromotionVoiceLine.update({
      where: { id: existing.id },
      data: updateProjection,
      select: { id: true },
    })
  }
  if (!effectiveText) return null

  let nextLineIndex = 0
  for (let attempt = 1; attempt <= MAX_VOICE_LINE_WRITE_ATTEMPTS; attempt += 1) {
    const aggregate = await input.tx.novelPromotionVoiceLine.aggregate({
      where: { episodeId: input.episodeId },
      _max: { lineIndex: true },
    })
    nextLineIndex = Math.max(
      nextLineIndex + 1,
      (aggregate._max.lineIndex || 0) + 1,
    )

    try {
      return await input.tx.novelPromotionVoiceLine.create({
        data: {
          episodeId: input.episodeId,
          lineIndex: nextLineIndex,
          sourceKey,
          ...projection,
        },
        select: { id: true },
      })
    } catch (error) {
      if (!isUniqueViolation(error)) throw error

      try {
        return await input.tx.novelPromotionVoiceLine.update({
          where: { sourceKey },
          data: updateProjection,
          select: { id: true },
        })
      } catch (updateError) {
        if (!isRecordNotFound(updateError)) throw updateError
      }
      if (!isLineIndexUniqueViolation(error) || attempt === MAX_VOICE_LINE_WRITE_ATTEMPTS) {
        throw error
      }
    }
  }

  throw new Error('NARRATION_LINE_INDEX_CONFLICT')
}

export async function writeDialogueVoiceLine(input: {
  tx: Prisma.TransactionClient
  episodeId: string
  lineIndex: number
  incomingDialogueIndexes: number[]
  speaker: string
  content: string
  emotionStrength: number
  matchedPanelId: string | null
  matchedStoryboardId: string | null
  matchedPanelIndex: number | null
}): Promise<{
  id: string
  speaker: string
  matchedStoryboardId: string | null
}> {
  const projection = {
    lineType: 'dialogue',
    enabled: true,
    speaker: input.speaker,
    content: input.content,
    emotionStrength: input.emotionStrength,
    matchedPanelId: input.matchedPanelId,
    matchedStoryboardId: input.matchedStoryboardId,
    matchedPanelIndex: input.matchedPanelIndex,
  }
  const key = {
    episodeId: input.episodeId,
    lineIndex: input.lineIndex,
  }

  for (let attempt = 1; attempt <= MAX_VOICE_LINE_WRITE_ATTEMPTS; attempt += 1) {
    const occupant = await input.tx.novelPromotionVoiceLine.findUnique({
      where: { episodeId_lineIndex: key },
      select: { id: true, lineType: true },
    })
    if (occupant?.lineType === 'dialogue') {
      return await input.tx.novelPromotionVoiceLine.update({
        where: { id: occupant.id },
        data: projection,
        select: { id: true, speaker: true, matchedStoryboardId: true },
      })
    }
    if (occupant?.lineType === 'narration') {
      await relocateNarrationIndexConflicts({
        tx: input.tx,
        episodeId: input.episodeId,
        incomingDialogueIndexes: input.incomingDialogueIndexes,
      })
    } else if (occupant) {
      throw new Error('VOICE_LINE_TYPE_CONFLICT')
    }

    try {
      return await input.tx.novelPromotionVoiceLine.create({
        data: {
          episodeId: input.episodeId,
          lineIndex: input.lineIndex,
          ...projection,
        },
        select: { id: true, speaker: true, matchedStoryboardId: true },
      })
    } catch (error) {
      if (!isUniqueViolation(error)) throw error

      const raced = await input.tx.novelPromotionVoiceLine.findUnique({
        where: { episodeId_lineIndex: key },
        select: { id: true, lineType: true },
      })
      if (!raced && !isLineIndexUniqueViolation(error)) throw error
      if (attempt === MAX_VOICE_LINE_WRITE_ATTEMPTS) throw error
    }
  }

  throw new Error('VOICE_LINE_INDEX_CONFLICT')
}

export async function relocateNarrationIndexConflicts(input: {
  tx: Prisma.TransactionClient
  episodeId: string
  incomingDialogueIndexes: number[]
}): Promise<void> {
  const incomingDialogueIndexes = Array.from(new Set(input.incomingDialogueIndexes))
    .sort((left, right) => left - right)
  if (incomingDialogueIndexes.length === 0) return

  const conflicts = await input.tx.novelPromotionVoiceLine.findMany({
    where: {
      episodeId: input.episodeId,
      lineType: 'narration',
      lineIndex: { in: incomingDialogueIndexes },
    },
    select: { id: true, lineIndex: true },
    orderBy: [{ lineIndex: 'asc' }, { id: 'asc' }],
  })
  if (conflicts.length === 0) return

  const highestIncomingIndex = incomingDialogueIndexes[incomingDialogueIndexes.length - 1] || 0
  let nextLineIndex = highestIncomingIndex

  for (let index = 0; index < conflicts.length; index += 1) {
    for (let attempt = 1; attempt <= MAX_VOICE_LINE_WRITE_ATTEMPTS; attempt += 1) {
      const aggregate = await input.tx.novelPromotionVoiceLine.aggregate({
        where: { episodeId: input.episodeId },
        _max: { lineIndex: true },
      })
      nextLineIndex = Math.max(
        nextLineIndex + 1,
        (aggregate._max.lineIndex || 0) + 1,
      )
      try {
        await input.tx.novelPromotionVoiceLine.update({
          where: { id: conflicts[index].id },
          data: { lineIndex: nextLineIndex },
        })
        break
      } catch (error) {
        if (
          !isLineIndexUniqueViolation(error)
          || attempt === MAX_VOICE_LINE_WRITE_ATTEMPTS
        ) {
          throw error
        }
      }
    }
  }
}

function isUniqueViolation(error: unknown) {
  return Boolean(
    error
    && typeof error === 'object'
    && (error as { code?: unknown }).code === 'P2002',
  )
}

function isLineIndexUniqueViolation(error: unknown) {
  if (!isUniqueViolation(error)) return false
  const target = (error as { meta?: { target?: unknown } }).meta?.target
  if (target === undefined) return true
  const fields = Array.isArray(target) ? target : [target]
  return fields.some((field) => (
    typeof field === 'string' && field.toLowerCase().includes('lineindex')
  ))
}

function isRecordNotFound(error: unknown) {
  return Boolean(
    error
    && typeof error === 'object'
    && (error as { code?: unknown }).code === 'P2025',
  )
}
