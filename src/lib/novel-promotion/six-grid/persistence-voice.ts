import type { Prisma } from '@prisma/client'
import {
  relocateNarrationIndexConflicts,
  writeDialogueVoiceLine,
} from '@/lib/novel-promotion/narration/sync'
import type { JsonRecord } from './persistence-contract'

export async function persistSixGridVoiceLines(params: {
  tx: Prisma.TransactionClient
  episodeId: string
  voiceLineRows: JsonRecord[]
  storyboardIdByRef: Map<string, string>
  panelIdByStoryboardRef: Map<string, string>
}) {
  return await persistGridVoiceLines({ ...params, expectedPanelCount: 6 })
}

export async function persistGridVoiceLines(params: {
  tx: Prisma.TransactionClient
  episodeId: string
  voiceLineRows: JsonRecord[]
  storyboardIdByRef: Map<string, string>
  panelIdByStoryboardRef: Map<string, string>
  expectedPanelCount: 4 | 6
}) {
  const created: Array<{ id: string }> = []
  const lineIndexes = params.voiceLineRows.map((row, index) => (
    readPositiveInt(row.lineIndex, `voice line ${index + 1} has invalid lineIndex`)
  ))
  await relocateNarrationIndexConflicts({
    tx: params.tx,
    episodeId: params.episodeId,
    incomingDialogueIndexes: lineIndexes,
  })

  for (let index = 0; index < params.voiceLineRows.length; index += 1) {
    const row = params.voiceLineRows[index]
    const matchedPanel = isRecord(row.matchedPanel) ? row.matchedPanel : null
    let matchedStoryboardId: string | null = null
    let matchedPanelId: string | null = null
    let matchedPanelIndex: number | null = null
    if (matchedPanel) {
      const storyboardRef = readRequiredText(
        matchedPanel.storyboardId,
        `voice line ${index + 1} has invalid matchedPanel reference`,
      )
      matchedPanelIndex = readPanelIndex(matchedPanel.panelIndex, index, params.expectedPanelCount)
      matchedStoryboardId = params.storyboardIdByRef.get(storyboardRef) || null
      matchedPanelId = params.panelIdByStoryboardRef.get(`${storyboardRef}:${matchedPanelIndex}`) || null
      if (!matchedStoryboardId || !matchedPanelId) {
        throw new Error(`voice line ${index + 1} references non-existent panel`)
      }
    }
    const lineIndex = lineIndexes[index]
    const speaker = readRequiredText(row.speaker, `voice line ${index + 1} is missing valid speaker`)
    const content = readRequiredText(row.content, `voice line ${index + 1} is missing valid content`)
    if (typeof row.emotionStrength !== 'number' || !Number.isFinite(row.emotionStrength)) {
      throw new Error(`voice line ${index + 1} is missing valid emotionStrength`)
    }
    const emotionStrength = Math.min(1, Math.max(0.1, row.emotionStrength))
    created.push(await writeDialogueVoiceLine({
      tx: params.tx,
      episodeId: params.episodeId,
      lineIndex,
      incomingDialogueIndexes: lineIndexes,
      speaker,
      content,
      emotionStrength,
      matchedPanelId,
      matchedStoryboardId,
      matchedPanelIndex,
    }))
  }
  await params.tx.novelPromotionVoiceLine.deleteMany({
    where: {
      episodeId: params.episodeId,
      lineType: 'dialogue',
      ...(lineIndexes.length > 0 ? { lineIndex: { notIn: lineIndexes } } : {}),
    },
  })
  return created
}

export function validateSixGridVoiceLineRows(rows: JsonRecord[] | null) {
  validateGridVoiceLineRows(rows, 6)
}

export function validateGridVoiceLineRows(
  rows: JsonRecord[] | null,
  expectedPanelCount: 4 | 6,
) {
  const seen = new Set<number>()
  for (let index = 0; index < (rows || []).length; index += 1) {
    const row = rows![index]
    const lineIndex = readPositiveInt(row.lineIndex, `voice line ${index + 1} has invalid lineIndex`)
    if (seen.has(lineIndex)) throw new Error('voice line indexes must be unique')
    seen.add(lineIndex)
    const matchedPanel = isRecord(row.matchedPanel) ? row.matchedPanel : null
    if (matchedPanel) readPanelIndex(matchedPanel.panelIndex, index, expectedPanelCount)
  }
}

function readRequiredText(value: unknown, message: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(message)
  return value.trim()
}

function readPositiveInt(value: unknown, message: string) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) throw new Error(message)
  return value
}

function readPanelIndex(value: unknown, rowIndex: number, expectedPanelCount: 4 | 6) {
  if (typeof value !== 'number'
    || !Number.isInteger(value)
    || value < 0
    || value >= expectedPanelCount) {
    throw new Error(`voice line ${rowIndex + 1} has invalid matchedPanel reference`)
  }
  return value
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
