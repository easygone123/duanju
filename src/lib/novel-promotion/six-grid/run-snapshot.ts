import { getRunInputSnapshot } from '@/lib/run-runtime/service'
import {
  parseStoryboardRunSettingsTask,
  resolveStoryboardRunSettings,
  type ResolvedStoryboardRunSettings,
} from './run-settings'
import {
  readPersistenceLocale,
  readPersistenceSettingsSource,
  sha256PersistencePayload,
} from './persistence-contract'

export type ResolvedStoryboardRunSnapshot = Readonly<{
  runId: string
  projectId: string
  episodeId: string
  workflowType: string
  locale: 'en' | 'zh'
  sourceHash: string
  runSettings: Readonly<ResolvedStoryboardRunSettings>
}>

export async function resolveStoryboardRunSnapshot(
  runId: string,
): Promise<ResolvedStoryboardRunSnapshot> {
  const source = await getRunInputSnapshot(runId)
  if (!source || !source.episodeId) throw new Error('STORYBOARD_RUN_SNAPSHOT_INVALID')
  const runSettings = Object.freeze(resolveStoryboardRunSettings({
    task: parseStoryboardRunSettingsTask(readPersistenceSettingsSource(source.input)),
  }))
  return Object.freeze({
    runId: source.runId,
    projectId: source.projectId,
    episodeId: source.episodeId,
    workflowType: source.workflowType,
    locale: readPersistenceLocale(source.input),
    sourceHash: sha256PersistencePayload(JSON.stringify(source.input)),
    runSettings,
  })
}
