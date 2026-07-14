import type { QueryClient } from '@tanstack/react-query'
import type { EpisodeStage } from '@/lib/novel-promotion/episode-stage-data'
import { queryKeys } from '@/lib/query/keys'

type TaskCompletionInput = {
  projectId: string
  episodeId: string
  targetType: string | null
  targetId: string | null
  taskType: string | null
  payload: Record<string, unknown> | null
}

type PatchResult = {
  handled: boolean
  patched: boolean
  stages: EpisodeStage[]
}

const PANEL_IMAGE_FIELDS = [
  'imageUrl',
  'imageMediaId',
  'previousImageUrl',
  'previousImageMediaId',
  'candidateImages',
  'croppedImageUrl',
  'croppedImageMediaId',
  'upscaledImageUrl',
  'upscaledImageMediaId',
] as const

const PANEL_VIDEO_FIELDS = [
  'videoUrl',
  'videoMediaId',
  'videoGenerationMode',
  'lipSyncVideoUrl',
  'lipSyncVideoMediaId',
  'lipSyncTaskId',
] as const

function pickDefined(
  payload: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const updates: Record<string, unknown> = {}
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(payload, field)) continue
    const value = payload[field]
    if (value === null || value === undefined) continue
    updates[field] = value
  }
  return updates
}

function patchPanelArray(
  panels: unknown,
  panelId: string,
  updates: Record<string, unknown>,
): { value: unknown; eligible: boolean; matched: boolean; changed: boolean } {
  if (!Array.isArray(panels)) {
    return { value: panels, eligible: false, matched: false, changed: false }
  }
  let matched = false
  let changed = false
  const value = panels.map((panel) => {
    if (!panel || typeof panel !== 'object' || Array.isArray(panel)) return panel
    const record = panel as Record<string, unknown>
    if (record.id !== panelId) return panel
    matched = true
    const hasChange = Object.entries(updates).some(([key, value]) => record[key] !== value)
    if (!hasChange) return panel
    changed = true
    return { ...record, ...updates }
  })
  return { value: changed ? value : panels, eligible: true, matched, changed }
}

function patchStoryboards(
  storyboards: unknown,
  panelId: string,
  updates: Record<string, unknown>,
): { value: unknown; eligible: boolean; matched: boolean; changed: boolean } {
  if (!Array.isArray(storyboards)) {
    return { value: storyboards, eligible: false, matched: false, changed: false }
  }
  let eligible = false
  let matched = false
  let changed = false
  const value = storyboards.map((storyboard) => {
    if (!storyboard || typeof storyboard !== 'object' || Array.isArray(storyboard)) return storyboard
    const record = storyboard as Record<string, unknown>
    const panels = patchPanelArray(record.panels, panelId, updates)
    if (panels.eligible) eligible = true
    if (panels.matched) matched = true
    if (!panels.changed) return storyboard
    changed = true
    return { ...record, panels: panels.value }
  })
  return { value: changed ? value : storyboards, eligible, matched, changed }
}

function patchEpisodePayload(
  current: unknown,
  panelId: string,
  updates: Record<string, unknown>,
): { value: unknown; eligible: boolean; matched: boolean; changed: boolean } {
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    return { value: current, eligible: false, matched: false, changed: false }
  }
  const root = current as Record<string, unknown>

  if (root.episode && typeof root.episode === 'object' && !Array.isArray(root.episode)) {
    const episode = root.episode as Record<string, unknown>
    const storyboards = patchStoryboards(episode.storyboards, panelId, updates)
    if (!storyboards.changed) return { ...storyboards, value: current }
    return {
      ...storyboards,
      value: { ...root, episode: { ...episode, storyboards: storyboards.value } },
    }
  }

  const storyboards = patchStoryboards(root.storyboards, panelId, updates)
  if (!storyboards.changed) return { ...storyboards, value: current }
  return { ...storyboards, value: { ...root, storyboards: storyboards.value } }
}

function resolvePanelPatch(input: TaskCompletionInput): {
  updates: Record<string, unknown>
  stages: EpisodeStage[]
} | null {
  if (input.targetType !== 'NovelPromotionPanel' || !input.targetId || !input.payload) return null
  const taskType = input.taskType || ''
  const hasImageOutput = PANEL_IMAGE_FIELDS.some((field) =>
    Object.prototype.hasOwnProperty.call(input.payload, field))
  const hasVideoOutput = PANEL_VIDEO_FIELDS.some((field) =>
    Object.prototype.hasOwnProperty.call(input.payload, field))

  if (hasVideoOutput || taskType === 'video_panel' || taskType === 'lip_sync') {
    return {
      updates: pickDefined(input.payload, PANEL_VIDEO_FIELDS),
      stages: ['videos'],
    }
  }
  if (hasImageOutput || taskType.includes('image') || taskType.includes('storyboard')) {
    return {
      updates: pickDefined(input.payload, PANEL_IMAGE_FIELDS),
      stages: ['storyboard', 'videos'],
    }
  }
  return null
}

export function applyWorkspaceTaskCompletion(
  queryClient: QueryClient,
  input: TaskCompletionInput,
): PatchResult {
  const patch = resolvePanelPatch(input)
  if (!patch) return { handled: false, patched: false, stages: [] }
  if (Object.keys(patch.updates).length === 0) {
    return { handled: false, patched: false, stages: patch.stages }
  }

  let changed = false
  let eligible = 0
  let matched = 0
  for (const stage of patch.stages) {
    queryClient.setQueriesData(
      { queryKey: queryKeys.episodeStage(input.projectId, input.episodeId, stage) },
      (current) => {
        const result = patchEpisodePayload(current, input.targetId!, patch.updates)
        if (result.eligible) eligible += 1
        if (result.matched) matched += 1
        if (result.changed) changed = true
        return result.value
      },
    )
  }
  queryClient.setQueriesData(
    { queryKey: queryKeys.episodeData(input.projectId, input.episodeId) },
    (current) => {
      const result = patchEpisodePayload(current, input.targetId!, patch.updates)
      if (result.eligible) eligible += 1
      if (result.matched) matched += 1
      if (result.changed) changed = true
      return result.value
    },
  )

  return {
    handled: eligible === 0 || matched === eligible,
    patched: changed,
    stages: patch.stages,
  }
}
