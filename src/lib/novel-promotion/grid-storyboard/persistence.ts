import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { estimatePanelDuration } from '@/lib/novel-promotion/six-grid/duration'
import {
  buildGridSheetPrompt,
  normalizePanelDialogue,
} from '@/lib/novel-promotion/six-grid/prompt-builder'
import {
  RUN_ARTIFACT_STEP_KEY,
  RUN_ARTIFACT_TYPE,
} from '@/lib/run-runtime/types'
import { serializeGraphArtifactPayload } from '@/lib/run-runtime/service'
import {
  normalizeGridPersistenceGroups,
  readNonNegativeNumber,
  runWithSixGridPersistenceRetry,
  sha256PersistencePayload,
  stableGridStoryboardId as stableGridStoryboardIdFromContract,
  type NormalizedGridPersistenceGroup,
  type PersistGridParams,
} from '@/lib/novel-promotion/six-grid/persistence-contract'
import {
  persistGridVoiceLines,
  validateGridVoiceLineRows,
} from '@/lib/novel-promotion/six-grid/persistence-voice'
import {
  resolveStoryboardGridSpec,
  type GridStoryboardMode,
  type StoryboardGridSpec,
} from './spec'

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

export function stableGridStoryboardId(
  episodeId: string,
  groupKey: string,
  mode: GridStoryboardMode,
) {
  return stableGridStoryboardIdFromContract(episodeId, groupKey, mode)
}

export async function persistGridStoryboardOutputs(params: PersistGridParams) {
  const runSettings = params.runSnapshot.runSettings
  const gridSpec = runSettings.gridSpec
  if (!gridSpec
    || gridSpec.mode !== runSettings.storyboardGenerationMode
    || gridSpec.cellAspectRatio !== runSettings.sixGridCellAspectRatio
    || !isCanonicalGridSpec(gridSpec)) {
    throw new Error('GRID_RUN_SNAPSHOT_INVALID')
  }
  const groups = normalizeGridPersistenceGroups(params.clipPanels, gridSpec)
  validateGridVoiceLineRows(params.voiceLineRows, gridSpec.panelCount)
  const locale = params.runSnapshot.locale

  const result = await runWithSixGridPersistenceRetry(async () => await prisma.$transaction(async (tx) => {
    await assertClipsBelongToEpisode(tx, params.episodeId, groups, gridSpec.mode)
    const plannedStoryboardIds = groups.map((group) => (
      stableGridStoryboardId(params.episodeId, group.groupKey, gridSpec.mode)
    ))
    const obsoleteStoryboards = await tx.novelPromotionStoryboard.findMany({
      where: {
        episodeId: params.episodeId,
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
      const storyboardId = stableGridStoryboardId(params.episodeId, group.groupKey, gridSpec.mode)
      const sheetPrompt = buildGridSheetPrompt(group, {
        locale,
        gridSpec,
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
          panelCount: gridSpec.panelCount,
          layoutMode: gridSpec.mode,
          groupSequence: group.groupSequence,
          continuityAnchor: JSON.stringify(continuityAnchor),
          sixGridCellAspectRatio: gridSpec.cellAspectRatio,
          sixGridProcessingOrder: runSettings.sixGridProcessingOrder,
          sheetPromptSnapshot: sheetPrompt,
          sheetModelSnapshot: null,
          sheetGenerationOptionsSnapshot: JSON.stringify(runSettings),
        },
        update: {
          clipId: group.clipId,
          episodeId: params.episodeId,
          panelCount: gridSpec.panelCount,
          layoutMode: gridSpec.mode,
          groupSequence: group.groupSequence,
          continuityAnchor: JSON.stringify(continuityAnchor),
          sixGridCellAspectRatio: gridSpec.cellAspectRatio,
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

    const createdVoiceLines = await persistGridVoiceLines({
      tx,
      episodeId: params.episodeId,
      voiceLineRows: params.voiceLineRows || [],
      storyboardIdByRef,
      panelIdByStoryboardRef,
      expectedPanelCount: gridSpec.panelCount,
    })
    return { persistedStoryboards, createdVoiceLines }
  }, { timeout: 30_000 }))

  return {
    persistedStoryboards: result.persistedStoryboards,
    voiceLineCount: result.createdVoiceLines.length,
  }
}

function isCanonicalGridSpec(spec: StoryboardGridSpec) {
  const canonical = resolveStoryboardGridSpec(spec.mode, spec.cellAspectRatio)
  return spec.columns === canonical.columns
    && spec.rows === canonical.rows
    && spec.panelCount === canonical.panelCount
    && spec.sheetAspectRatio === canonical.sheetAspectRatio
}

async function assertClipsBelongToEpisode(
  tx: Prisma.TransactionClient,
  episodeId: string,
  groups: NormalizedGridPersistenceGroup[],
  mode: GridStoryboardMode,
) {
  const clipIds = [...new Set(groups.map((group) => group.clipId))]
  const count = await tx.novelPromotionClip.count({
    where: { episodeId, id: { in: clipIds } },
  })
  if (count !== clipIds.length) {
    throw new Error(mode === 'six_grid' ? 'SIX_GRID_CLIP_COVERAGE_INVALID' : 'GRID_CLIP_COVERAGE_INVALID')
  }
}
