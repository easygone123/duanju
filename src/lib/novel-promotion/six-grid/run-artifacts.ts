import {
  replaceArtifactsBatch,
  serializeGraphArtifactPayload,
} from '@/lib/run-runtime/service'
import { RUN_ARTIFACT_STEP_KEY, RUN_ARTIFACT_TYPE } from '@/lib/run-runtime/types'
import type { ScriptToStoryboardOrchestratorResult } from '@/lib/novel-promotion/script-to-storyboard/orchestrator'
import { sha256PersistencePayload } from './persistence-contract'
import type { ResolvedStoryboardRunSnapshot } from './run-snapshot'

const SIX_GRID_PLANNING_ARTIFACT_TYPES = [
  RUN_ARTIFACT_TYPE.SIX_GRID_STORYBOARD_PLAN,
  RUN_ARTIFACT_TYPE.SIX_GRID_STORYBOARD_PHASE1,
  RUN_ARTIFACT_TYPE.SIX_GRID_STORYBOARD_PHASE2_CINE,
  RUN_ARTIFACT_TYPE.SIX_GRID_STORYBOARD_PHASE2_ACTING,
  RUN_ARTIFACT_TYPE.SIX_GRID_STORYBOARD_PHASE3,
]

export async function persistSixGridPlanningArtifacts(params: {
  runSnapshot: ResolvedStoryboardRunSnapshot
  result: ScriptToStoryboardOrchestratorResult
}) {
  const groups = params.result.sixGridGroups || params.result.clipPanels
  const artifacts: Array<{
    runId: string
    stepKey: string
    artifactType: string
    refId: string
    versionHash: string
    payload: Record<string, unknown>
  }> = []
  appendVersionedArtifact(artifacts, {
    runId: params.runSnapshot.runId,
    stepKey: RUN_ARTIFACT_STEP_KEY.SIX_GRID_EPISODE_PLAN,
    artifactType: RUN_ARTIFACT_TYPE.SIX_GRID_STORYBOARD_PLAN,
    refId: params.runSnapshot.episodeId,
    payload: {
      groups: groups.map((group) => ({
        groupId: group.groupId,
        groupKey: group.groupKey,
        groupSequence: group.groupSequence,
        clipId: group.clipId,
        sceneKey: group.sceneKey,
        incomingContinuity: group.incomingContinuity,
        outgoingContinuity: group.outgoingContinuity,
        panelCount: group.finalPanels.length,
      })),
    },
  })

  const phase1 = params.result.sixGridPhase1PanelsByGroupId
    || params.result.phase1PanelsByClipId
    || {}
  const phase2Cine = params.result.sixGridPhase2CinematographyByGroupId
    || params.result.phase2CinematographyByClipId
    || {}
  const phase2Acting = params.result.sixGridPhase2ActingByGroupId
    || params.result.phase2ActingByClipId
    || {}
  const phase3 = params.result.sixGridPhase3PanelsByGroupId
    || params.result.phase3PanelsByClipId
    || {}

  for (const group of groups) {
    if (!group.groupId || !group.groupSequence) throw new Error('SIX_GRID_GROUP_IDENTITY_INVALID')
    const prefix = `six_grid_group_${group.groupSequence}`
    appendPhase(artifacts, {
      runId: params.runSnapshot.runId,
      stepKey: `${prefix}_phase1`,
      artifactType: RUN_ARTIFACT_TYPE.SIX_GRID_STORYBOARD_PHASE1,
      refId: group.groupId,
      payloadKey: 'panels',
      rows: phase1[group.groupId],
    })
    appendPhase(artifacts, {
      runId: params.runSnapshot.runId,
      stepKey: `${prefix}_phase2_cinematography`,
      artifactType: RUN_ARTIFACT_TYPE.SIX_GRID_STORYBOARD_PHASE2_CINE,
      refId: group.groupId,
      payloadKey: 'rules',
      rows: phase2Cine[group.groupId],
    })
    appendPhase(artifacts, {
      runId: params.runSnapshot.runId,
      stepKey: `${prefix}_phase2_acting`,
      artifactType: RUN_ARTIFACT_TYPE.SIX_GRID_STORYBOARD_PHASE2_ACTING,
      refId: group.groupId,
      payloadKey: 'directions',
      rows: phase2Acting[group.groupId],
    })
    appendPhase(artifacts, {
      runId: params.runSnapshot.runId,
      stepKey: `${prefix}_phase3_detail`,
      artifactType: RUN_ARTIFACT_TYPE.SIX_GRID_STORYBOARD_PHASE3,
      refId: group.groupId,
      payloadKey: 'panels',
      rows: phase3[group.groupId],
    })
  }

  await replaceArtifactsBatch({
    runId: params.runSnapshot.runId,
    artifactTypes: SIX_GRID_PLANNING_ARTIFACT_TYPES,
    artifacts,
  })
}

function appendPhase(
  artifacts: Parameters<typeof appendVersionedArtifact>[0],
  params: {
    runId: string
    stepKey: string
    artifactType: string
    refId: string
    payloadKey: string
    rows: unknown[] | undefined
  },
) {
  if (!params.rows || params.rows.length === 0) return
  appendVersionedArtifact(artifacts, {
    runId: params.runId,
    stepKey: params.stepKey,
    artifactType: params.artifactType,
    refId: params.refId,
    payload: { [params.payloadKey]: params.rows },
  })
}

function appendVersionedArtifact(
  artifacts: Array<{
    runId: string
    stepKey: string
    artifactType: string
    refId: string
    versionHash: string
    payload: Record<string, unknown>
  }>,
  params: {
    runId: string
    stepKey: string
    artifactType: string
    refId: string
    payload: Record<string, unknown>
  },
) {
  const normalized = serializeGraphArtifactPayload(params.payload)
  artifacts.push({
    ...params,
    payload: normalized.payload || {},
    versionHash: sha256PersistencePayload(normalized.serialized),
  })
}
