import { createHash } from 'node:crypto'
import type { StoryboardPanel } from '@/lib/storyboard-phases'
import {
  validateGridSceneGroups,
  type GridSceneGroup,
} from '@/lib/novel-promotion/grid-storyboard/scene-planner'
import {
  resolveStoryboardGridSpec,
  type GridStoryboardMode,
  type StoryboardGridSpec,
} from '@/lib/novel-promotion/grid-storyboard/spec'
import type { ResolvedStoryboardRunSnapshot } from './run-snapshot'
import {
  validateAndNormalizeSixGridGroups,
  type SixGridSceneGroup,
  type SixStoryboardPanels,
} from './scene-planner'

export type JsonRecord = Record<string, unknown>

export type GridPersistenceGroupInput = {
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

export type NormalizedGridPersistenceGroup = GridSceneGroup & {
  clipIndex: number
  groupId: string
  groupKey: string
  groupSequence: number
}

export type PersistGridParams = {
  episodeId: string
  runId: string
  clipPanels: GridPersistenceGroupInput[]
  voiceLineRows: JsonRecord[] | null
  runSnapshot: ResolvedStoryboardRunSnapshot
}

export type SixGridPersistenceGroupInput = GridPersistenceGroupInput
export type NormalizedSixGridPersistenceGroup = SixGridSceneGroup & NormalizedGridPersistenceGroup
export type PersistSixGridParams = PersistGridParams

export function normalizeGridPersistenceGroups(
  input: GridPersistenceGroupInput[],
  gridSpec: StoryboardGridSpec,
): NormalizedGridPersistenceGroup[] {
  const candidates = input.map((group) => ({
    sceneKey: group.sceneKey,
    clipId: group.clipId,
    incomingContinuity: group.incomingContinuity,
    outgoingContinuity: group.outgoingContinuity,
    panels: group.finalPanels,
  }))
  const normalized = gridSpec.mode === 'six_grid'
    ? validateAndNormalizeSixGridGroups(candidates)
    : validateGridSceneGroups(candidates, gridSpec)
  const errorPrefix = gridSpec.mode === 'six_grid' ? 'SIX_GRID' : 'GRID'
  const seenGroupKeys = new Set<string>()
  const seenGroupIds = new Set<string>()
  const seenSequences = new Set<number>()
  return normalized.map((group, index) => {
    const source = input[index]
    const groupId = readRequiredText(source.groupId, `${errorPrefix}_GROUP_ID_INVALID`)
    const groupKey = readRequiredText(source.groupKey, `${errorPrefix}_GROUP_KEY_INVALID`)
    const groupSequence = source.groupSequence
    if (!Number.isInteger(groupSequence) || Number(groupSequence) <= 0) {
      throw new Error(`${errorPrefix}_GROUP_SEQUENCE_INVALID`)
    }
    if (seenGroupIds.has(groupId)
      || seenGroupKeys.has(groupKey)
      || seenSequences.has(groupSequence as number)) {
      throw new Error(`${errorPrefix}_GROUP_IDENTITY_DUPLICATE`)
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

export function normalizeSixGridPersistenceGroups(
  input: SixGridPersistenceGroupInput[],
): NormalizedSixGridPersistenceGroup[] {
  return normalizeGridPersistenceGroups(
    input,
    resolveStoryboardGridSpec('six_grid', '16:9'),
  ).map((group) => ({ ...group, panels: group.panels as SixStoryboardPanels }))
}

export function stableGridStoryboardId(
  episodeId: string,
  groupKey: string,
  mode: GridStoryboardMode,
) {
  return `${mode}_${sha256PersistencePayload(`${episodeId}\u0000${groupKey}`)}`
}

export function stableSixGridStoryboardId(episodeId: string, groupKey: string) {
  return stableGridStoryboardId(episodeId, groupKey, 'six_grid')
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
