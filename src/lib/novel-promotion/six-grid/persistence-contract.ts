import { createHash } from 'node:crypto'
import type { StoryboardPanel } from '@/lib/storyboard-phases'
import type { ResolvedStoryboardRunSnapshot } from './run-snapshot'
import {
  validateAndNormalizeSixGridGroups,
  type SixGridSceneGroup,
} from './scene-planner'

export type JsonRecord = Record<string, unknown>

export type SixGridPersistenceGroupInput = {
  clipId: string
  clipIndex: number
  finalPanels: StoryboardPanel[]
  groupId?: string
  groupKey?: string
  groupSequence?: number
  sceneKey?: string
  incomingContinuity?: string
  outgoingContinuity?: string
}

export type NormalizedSixGridPersistenceGroup = SixGridSceneGroup & {
  clipIndex: number
  groupId: string
  groupKey: string
  groupSequence: number
}

export type PersistSixGridParams = {
  episodeId: string
  runId: string
  clipPanels: SixGridPersistenceGroupInput[]
  voiceLineRows: JsonRecord[] | null
  runSnapshot: ResolvedStoryboardRunSnapshot
}

export function normalizeSixGridPersistenceGroups(
  input: SixGridPersistenceGroupInput[],
): NormalizedSixGridPersistenceGroup[] {
  const normalized = validateAndNormalizeSixGridGroups(input.map((group) => ({
    sceneKey: group.sceneKey,
    clipId: group.clipId,
    incomingContinuity: group.incomingContinuity,
    outgoingContinuity: group.outgoingContinuity,
    panels: group.finalPanels,
  })))
  const seenGroupKeys = new Set<string>()
  const seenGroupIds = new Set<string>()
  const seenSequences = new Set<number>()
  return normalized.map((group, index) => {
    const source = input[index]
    const groupId = readRequiredText(source.groupId, 'SIX_GRID_GROUP_ID_INVALID')
    const groupKey = readRequiredText(source.groupKey, 'SIX_GRID_GROUP_KEY_INVALID')
    const groupSequence = source.groupSequence
    if (!Number.isInteger(groupSequence) || Number(groupSequence) <= 0) {
      throw new Error('SIX_GRID_GROUP_SEQUENCE_INVALID')
    }
    if (seenGroupIds.has(groupId)
      || seenGroupKeys.has(groupKey)
      || seenSequences.has(groupSequence as number)) {
      throw new Error('SIX_GRID_GROUP_IDENTITY_DUPLICATE')
    }
    seenGroupIds.add(groupId)
    seenGroupKeys.add(groupKey)
    seenSequences.add(groupSequence as number)
    return {
      ...group,
      clipIndex: source.clipIndex,
      groupId,
      groupKey,
      groupSequence: groupSequence as number,
    }
  })
}

export function stableSixGridStoryboardId(episodeId: string, groupKey: string) {
  return `six_grid_${sha256PersistencePayload(`${episodeId}\u0000${groupKey}`)}`
}

export function sha256PersistencePayload(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

export function readPersistenceSettingsSource(input: JsonRecord): JsonRecord {
  return isRecord(input.runSettings) ? input.runSettings : input
}

export function readPersistenceLocale(input: JsonRecord): 'en' | 'zh' {
  const meta = isRecord(input.meta) ? input.meta : null
  return input.locale === 'en' || meta?.locale === 'en' ? 'en' : 'zh'
}

export function readNonNegativeNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

export async function runWithSixGridPersistenceRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (!isRetryablePersistenceConflict(error) || attempt === 3) throw error
      await new Promise((resolve) => setTimeout(resolve, attempt * 10))
    }
  }
  throw lastError
}

function isRetryablePersistenceConflict(error: unknown) {
  if (!isRecord(error)) return false
  if (error.code === 'P2002' || error.code === 'P2034') return true
  const message = typeof error.message === 'string' ? error.message.toLowerCase() : ''
  return message.includes('deadlock') || message.includes('write conflict')
}

function readRequiredText(value: unknown, message: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(message)
  return value.trim()
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
