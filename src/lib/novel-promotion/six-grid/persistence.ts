import { resolveStoryboardGridSpec } from '@/lib/novel-promotion/grid-storyboard/spec'
import { persistGridStoryboardOutputs } from '@/lib/novel-promotion/grid-storyboard/persistence'
import {
  normalizeSixGridPersistenceGroups,
  type PersistSixGridParams,
} from './persistence-contract'
import { validateSixGridVoiceLineRows } from './persistence-voice'

export async function persistSixGridStoryboardOutputs(params: PersistSixGridParams) {
  const runSettings = params.runSnapshot.runSettings
  if (runSettings.storyboardGenerationMode !== 'six_grid'
    || !runSettings.sixGridCellAspectRatio) {
    throw new Error('SIX_GRID_RUN_SNAPSHOT_INVALID')
  }
  normalizeSixGridPersistenceGroups(params.clipPanels)
  validateSixGridVoiceLineRows(params.voiceLineRows)
  const gridSpec = resolveStoryboardGridSpec('six_grid', runSettings.sixGridCellAspectRatio)
  return await persistGridStoryboardOutputs({
    ...params,
    runSnapshot: Object.freeze({
      ...params.runSnapshot,
      runSettings: Object.freeze({ ...runSettings, gridSpec }),
    }),
  })
}
