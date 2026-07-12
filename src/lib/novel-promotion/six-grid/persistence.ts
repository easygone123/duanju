import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { estimatePanelDuration } from '@/lib/novel-promotion/six-grid/duration'
import {
  buildSixGridSheetPrompt,
  normalizePanelDialogue,
} from '@/lib/novel-promotion/six-grid/prompt-builder'
import {
  RUN_ARTIFACT_STEP_KEY,
  RUN_ARTIFACT_TYPE,
} from '@/lib/run-runtime/types'
import { serializeGraphArtifactPayload } from '@/lib/run-runtime/service'
import {
  normalizeSixGridPersistenceGroups,
  readNonNegativeNumber,
  runWithSixGridPersistenceRetry,
  sha256PersistencePayload,
  stableSixGridStoryboardId,
  type NormalizedSixGridPersistenceGroup,
  type PersistSixGridParams,
} from './persistence-contract'
import {
  persistSixGridVoiceLines,
  validateSixGridVoiceLineRows,
} from './persistence-voice'

type PersistedStoryboard = {
  storyboardId: string
  clipId: string
  panels: Array<{
    id: string
    panelIndex: number
    description: string | null
    srtSegment: string | null
    characters: string | null
    props: string | null
  }>
}

export async function persistSixGridStoryboardOutputs(params: PersistSixGridParams) {
  const runSettings = params.runSnapshot.runSettings
  if (runSettings.storyboardGenerationMode !== 'six_grid'
    || !runSettings.sixGridCellAspectRatio) {
    throw new Error('SIX_GRID_RUN_SNAPSHOT_INVALID')
  }
  const cellAspectRatio = runSettings.sixGridCellAspectRatio
  const groups = normalizeSixGridPersistenceGroups(params.clipPanels)
  validateSixGridVoiceLineRows(params.voiceLineRows)
  const locale = params.runSnapshot.locale

  const result = await runWithSixGridPersistenceRetry(async () => await prisma.$transaction(async (tx) => {
    await assertClipsBelongToEpisode(tx, params.episodeId, groups)
    const plannedStoryboardIds = groups.map((group) => (
      stableSixGridStoryboardId(params.episodeId, group.groupKey)
    ))
    const obsoleteStoryboards = await tx.novelPromotionStoryboard.findMany({
      where: {
        episodeId: params.episodeId,
        layoutMode: 'six_grid',
        id: { notIn: plannedStoryboardIds },
      },
      select: { id: true },
    })
    const obsoleteIds = obsoleteStoryboards.map((storyboard) => storyboard.id)
    if (obsoleteIds.length > 0) {
      await tx.novelPromotionVoiceLine.updateMany({
        where: { episodeId: params.episodeId, matchedStoryboardId: { in: obsoleteIds } },
        data: {
          matchedPanelId: null,
          matchedStoryboardId: null,
          matchedPanelIndex: null,
        },
      })
      await tx.novelPromotionStoryboard.deleteMany({ where: { id: { in: obsoleteIds } } })
    }
    await tx.novelPromotionStoryboard.updateMany({
      where: { id: { in: plannedStoryboardIds } },
      data: { groupSequence: null },
    })
    await tx.graphArtifact.deleteMany({
      where: {
        runId: params.runId,
        artifactType: RUN_ARTIFACT_TYPE.SIX_GRID_STORYBOARD_GROUP,
        refId: { notIn: groups.map((group) => group.groupId) },
      },
    })
    const persistedStoryboards: PersistedStoryboard[] = []
    const storyboardIdByRef = new Map<string, string>()
    const panelIdByStoryboardRef = new Map<string, string>()

    for (const group of groups) {
      const storyboardId = stableSixGridStoryboardId(params.episodeId, group.groupKey)
      const sheetPrompt = buildSixGridSheetPrompt(group, {
        locale,
        cellAspectRatio,
      })
      const continuityAnchor = {
        groupId: group.groupId,
        groupKey: group.groupKey,
        sceneKey: group.sceneKey,
        incomingContinuity: group.incomingContinuity,
        outgoingContinuity: group.outgoingContinuity,
      }
      const storyboard = await tx.novelPromotionStoryboard.upsert({
        where: { id: storyboardId },
        create: {
          id: storyboardId,
          clipId: group.clipId,
          episodeId: params.episodeId,
          panelCount: 6,
          layoutMode: 'six_grid',
          groupSequence: group.groupSequence,
          continuityAnchor: JSON.stringify(continuityAnchor),
          sixGridCellAspectRatio: cellAspectRatio,
          sixGridProcessingOrder: runSettings.sixGridProcessingOrder,
          sheetPromptSnapshot: sheetPrompt,
          sheetModelSnapshot: null,
          sheetGenerationOptionsSnapshot: JSON.stringify(runSettings),
        },
        update: {
          clipId: group.clipId,
          episodeId: params.episodeId,
          panelCount: 6,
          layoutMode: 'six_grid',
          groupSequence: group.groupSequence,
          continuityAnchor: JSON.stringify(continuityAnchor),
          sixGridCellAspectRatio: cellAspectRatio,
          sixGridProcessingOrder: runSettings.sixGridProcessingOrder,
          sheetImageUrl: null,
          sheetImageMediaId: null,
          upscaledSheetImageUrl: null,
          upscaledSheetImageMediaId: null,
          sheetPromptSnapshot: sheetPrompt,
          sheetModelSnapshot: null,
          sheetGenerationOptionsSnapshot: JSON.stringify(runSettings),
          sheetArtifactVersion: 0,
          lastError: null,
        },
        select: { id: true, clipId: true },
      })
      storyboardIdByRef.set(storyboard.id, storyboard.id)
      storyboardIdByRef.set(group.groupId, storyboard.id)
      storyboardIdByRef.set(group.groupKey, storyboard.id)

      await tx.novelPromotionPanel.deleteMany({ where: { storyboardId: storyboard.id } })
      const persistedPanels: PersistedStoryboard['panels'] = []
      for (let panelIndex = 0; panelIndex < group.panels.length; panelIndex += 1) {
        const panel = group.panels[panelIndex]
        const dialogue = normalizePanelDialogue(panel)
        const duration = estimatePanelDuration({
          dialogueText: dialogue.text,
          actionComplexity: readNonNegativeNumber(panel.actionComplexity),
          cameraComplexity: readNonNegativeNumber(panel.cameraComplexity),
        })
        const created = await tx.novelPromotionPanel.create({
          data: {
            storyboardId: storyboard.id,
            panelIndex,
            gridCellIndex: panelIndex,
            panelNumber: panelIndex + 1,
            shotType: panel.shot_type || '中景',
            cameraMove: panel.camera_move || '固定',
            description: panel.description || null,
            videoPrompt: panel.video_prompt || null,
            location: panel.location || null,
            characters: panel.characters ? JSON.stringify(panel.characters) : null,
            props: panel.props ? JSON.stringify(panel.props) : null,
            srtSegment: panel.source_text || null,
            photographyRules: panel.photographyPlan ? JSON.stringify(panel.photographyPlan) : null,
            actingNotes: panel.actingNotes ? JSON.stringify(panel.actingNotes) : null,
            duration: duration.estimatedDuration,
            estimatedDuration: duration.estimatedDuration,
            durationOverride: null,
            hasDialogue: dialogue.hasDialogue,
            dialogueSpeaker: dialogue.speaker,
            dialogueText: dialogue.text,
            dialogueEmotion: dialogue.emotion,
            includeDialogueInVideoPrompt: dialogue.includeInVideoPrompt,
            imageUrl: null,
            imageMediaId: null,
            normalizedCropRect: null,
            croppedImageUrl: null,
            croppedImageMediaId: null,
            upscaledImageUrl: null,
            upscaledImageMediaId: null,
            imageDerivation: null,
            imageLineage: null,
          },
          select: {
            id: true,
            panelIndex: true,
            description: true,
            srtSegment: true,
            characters: true,
            props: true,
          },
        })
        for (const ref of [storyboard.id, group.groupId, group.groupKey]) {
          panelIdByStoryboardRef.set(`${ref}:${panelIndex}`, created.id)
        }
        persistedPanels.push(created)
      }

      const artifactPayload = {
        groupId: group.groupId,
        groupKey: group.groupKey,
        groupSequence: group.groupSequence,
        clipId: group.clipId,
        sceneKey: group.sceneKey,
        incomingContinuity: group.incomingContinuity,
        outgoingContinuity: group.outgoingContinuity,
        panels: group.panels,
        sheetPrompt,
        runSettings,
      }
      const normalizedArtifact = serializeGraphArtifactPayload(artifactPayload)
      const serializedArtifact = normalizedArtifact.serialized
      await tx.graphArtifact.upsert({
        where: {
          runId_stepKey_artifactType_refId: {
            runId: params.runId,
            stepKey: RUN_ARTIFACT_STEP_KEY.SIX_GRID_PERSIST,
            artifactType: RUN_ARTIFACT_TYPE.SIX_GRID_STORYBOARD_GROUP,
            refId: group.groupId,
          },
        },
        create: {
          runId: params.runId,
          stepKey: RUN_ARTIFACT_STEP_KEY.SIX_GRID_PERSIST,
          artifactType: RUN_ARTIFACT_TYPE.SIX_GRID_STORYBOARD_GROUP,
          refId: group.groupId,
          versionHash: sha256PersistencePayload(serializedArtifact),
          payload: normalizedArtifact.payload as unknown as Prisma.InputJsonValue,
        },
        update: {
          versionHash: sha256PersistencePayload(serializedArtifact),
          payload: normalizedArtifact.payload as unknown as Prisma.InputJsonValue,
        },
      })
      persistedStoryboards.push({
        storyboardId: storyboard.id,
        clipId: storyboard.clipId,
        panels: persistedPanels,
      })
    }

    const createdVoiceLines = await persistSixGridVoiceLines({
      tx,
      episodeId: params.episodeId,
      voiceLineRows: params.voiceLineRows || [],
      storyboardIdByRef,
      panelIdByStoryboardRef,
    })
    return { persistedStoryboards, createdVoiceLines }
  }, { timeout: 30_000 }))

  return {
    persistedStoryboards: result.persistedStoryboards,
    voiceLineCount: result.createdVoiceLines.length,
  }
}

async function assertClipsBelongToEpisode(
  tx: Prisma.TransactionClient,
  episodeId: string,
  groups: NormalizedSixGridPersistenceGroup[],
) {
  const clipIds = [...new Set(groups.map((group) => group.clipId))]
  const count = await tx.novelPromotionClip.count({
    where: { episodeId, id: { in: clipIds } },
  })
  if (count !== clipIds.length) throw new Error('SIX_GRID_CLIP_COVERAGE_INVALID')
}
