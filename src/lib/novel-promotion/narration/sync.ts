import type { Prisma } from '@prisma/client'
import {
  resolveNarrationContent,
  resolveNarrationEnabled,
  type PanelNarrationMode,
} from './state'

export const narrationSourceKey = (panelId: string) => `panel-narration:${panelId}`

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
  const projection = {
    lineType: 'narration',
    enabled: resolveNarrationEnabled({
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

  const existing = await input.tx.novelPromotionVoiceLine.findUnique({
    where: { sourceKey },
    select: { id: true },
  })
  if (existing) {
    return await input.tx.novelPromotionVoiceLine.update({
      where: { id: existing.id },
      data: projection,
      select: { id: true },
    })
  }
  if (!effectiveText) return null

  const aggregate = await input.tx.novelPromotionVoiceLine.aggregate({
    where: { episodeId: input.episodeId },
    _max: { lineIndex: true },
  })

  try {
    return await input.tx.novelPromotionVoiceLine.create({
      data: {
        episodeId: input.episodeId,
        lineIndex: (aggregate._max.lineIndex || 0) + 1,
        sourceKey,
        ...projection,
      },
      select: { id: true },
    })
  } catch (error) {
    if (!isUniqueViolation(error)) throw error

    const raced = await input.tx.novelPromotionVoiceLine.findUnique({
      where: { sourceKey },
      select: { id: true },
    })
    if (!raced) throw error

    return await input.tx.novelPromotionVoiceLine.update({
      where: { id: raced.id },
      data: projection,
      select: { id: true },
    })
  }
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

  const aggregate = await input.tx.novelPromotionVoiceLine.aggregate({
    where: { episodeId: input.episodeId },
    _max: { lineIndex: true },
  })
  const highestIncomingIndex = incomingDialogueIndexes[incomingDialogueIndexes.length - 1] || 0
  const firstAvailableIndex = Math.max(
    aggregate._max.lineIndex || 0,
    highestIncomingIndex,
  ) + 1

  for (let index = 0; index < conflicts.length; index += 1) {
    await input.tx.novelPromotionVoiceLine.update({
      where: { id: conflicts[index].id },
      data: { lineIndex: firstAvailableIndex + index },
    })
  }
}

function isUniqueViolation(error: unknown) {
  return Boolean(
    error
    && typeof error === 'object'
    && (error as { code?: unknown }).code === 'P2002',
  )
}
