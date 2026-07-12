import { beforeEach, describe, expect, it } from 'vitest'
import { estimatePanelDuration } from '@/lib/novel-promotion/six-grid/duration'
import { persistSixGridPlanningArtifacts } from '@/lib/novel-promotion/six-grid/run-artifacts'
import { resolveStoryboardRunSnapshot } from '@/lib/novel-promotion/six-grid/run-snapshot'
import type { ResolvedStoryboardRunSnapshot } from '@/lib/novel-promotion/six-grid/run-snapshot'
import { persistStoryboardOutputs as persistStoryboardOutputsRaw } from '@/lib/workers/handlers/script-to-storyboard-helpers'
import { resetSystemState } from '../../helpers/db-reset'
import {
  createFixtureEpisode,
  createFixtureNovelProject,
  createFixtureProject,
  createFixtureUser,
} from '../../helpers/fixtures'
import { prisma } from '../../helpers/prisma'

const immutableRunSettings = {
  storyboardGenerationMode: 'six_grid' as const,
  sixGridCellAspectRatio: '16:9' as const,
  sixGridProcessingOrder: 'crop_then_panel_upscale' as const,
  storyboardUpscaleModel: 'comfyui::upscale-v1',
  dialogueVideoModel: 'comfyui::dialogue-video-v1',
}

async function persistStoryboardOutputs(
  input: Parameters<typeof persistStoryboardOutputsRaw>[0] & {
    runSnapshot?: ResolvedStoryboardRunSnapshot
  },
) {
  if (!input.runId || input.runSnapshot) return await persistStoryboardOutputsRaw(input)
  return await persistStoryboardOutputsRaw({
    ...input,
    runSnapshot: await resolveStoryboardRunSnapshot(input.runId),
  })
}

function sixPanels(dialogue = true) {
  return Array.from({ length: 6 }, (_, index) => ({
    panel_number: index + 1,
    description: `visual beat ${index + 1}`,
    location: 'rainy-platform',
    source_text: `source ${index + 1}`,
    characters: ['Ming'],
    props: ['red umbrella'],
    shot_type: index % 2 ? 'close-up' : 'wide shot',
    camera_move: 'static',
    video_prompt: `animate visual beat ${index + 1}`,
    dialogue: dialogue && index === 2
      ? {
        speaker: 'Ming',
        text: '请不要离开我，我马上就会回来',
        emotion: 'afraid',
        includeDialogueInVideoPrompt: false,
      }
      : undefined,
  }))
}

function sixGridGroup(clipId: string, groupSequence = 1) {
  return {
    clipId,
    clipIndex: 1,
    groupId: `six-grid:${groupSequence}:${clipId}:${groupSequence}`,
    groupKey: `six-grid:${groupSequence}:${clipId}:${groupSequence}`,
    groupSequence,
    sceneKey: 'rainy-platform',
    incomingContinuity: `continuity-${groupSequence}`,
    outgoingContinuity: `continuity-${groupSequence + 1}`,
    finalPanels: sixPanels(groupSequence === 1),
  }
}

async function seedDomain() {
  const user = await createFixtureUser()
  const project = await createFixtureProject(user.id)
  const novelProject = await createFixtureNovelProject(project.id)
  const episode = await createFixtureEpisode(novelProject.id)
  const clip = await prisma.novelPromotionClip.create({
    data: {
      episodeId: episode.id,
      summary: 'platform scene',
      content: 'Ming waits on the platform.',
    },
  })
  const run = await prisma.graphRun.create({
    data: {
      userId: user.id,
      projectId: project.id,
      episodeId: episode.id,
      workflowType: 'script_to_storyboard_run',
      taskType: 'script_to_storyboard_run',
      targetType: 'NovelPromotionEpisode',
      targetId: episode.id,
      input: { ...immutableRunSettings, locale: 'en' },
    },
  })
  return { user, project, novelProject, episode, clip, run }
}

describe('six-grid storyboard persistence', () => {
  beforeEach(async () => {
    await resetSystemState()
  })

  it('persists six panels, dialogue, duration, continuity, voice lineage, and one idempotent artifact', async () => {
    const { episode, clip, run } = await seedDomain()
    const group = sixGridGroup(clip.id)
    const input = {
      episodeId: episode.id,
      runId: run.id,
      clipPanels: [group],
      voiceLineRows: [{
        lineIndex: 1,
        speaker: 'Ming',
        content: '请不要离开我，我马上就会回来',
        emotionStrength: 0.8,
        matchedPanel: { storyboardId: group.groupId, panelIndex: 2 },
      }],
    }

    await persistStoryboardOutputs(input)
    const firstArtifact = await prisma.graphArtifact.findFirstOrThrow({ where: { runId: run.id } })
    const firstPanelIds = (await prisma.novelPromotionPanel.findMany({
      where: { storyboard: { episodeId: episode.id } },
      orderBy: { panelIndex: 'asc' },
      select: { id: true },
    })).map((panel) => panel.id)
    input.clipPanels[0].finalPanels[0].description = 'updated visual beat 1'
    await persistStoryboardOutputs(input)

    const storyboards = await prisma.novelPromotionStoryboard.findMany({
      where: { episodeId: episode.id },
      include: { panels: { orderBy: { panelIndex: 'asc' } } },
    })
    expect(storyboards).toHaveLength(1)
    expect(storyboards[0]).toMatchObject({
      clipId: clip.id,
      layoutMode: 'six_grid',
      groupSequence: 1,
      panelCount: 6,
      sixGridCellAspectRatio: '16:9',
      sixGridProcessingOrder: 'crop_then_panel_upscale',
      sheetImageUrl: null,
      sheetImageMediaId: null,
      upscaledSheetImageUrl: null,
      upscaledSheetImageMediaId: null,
    })
    expect(JSON.parse(storyboards[0].continuityAnchor!)).toMatchObject({
      groupId: group.groupId,
      groupKey: group.groupKey,
      sceneKey: 'rainy-platform',
      incomingContinuity: group.incomingContinuity,
      outgoingContinuity: group.outgoingContinuity,
    })
    expect(storyboards[0].sheetPromptSnapshot).toContain('3 columns x 2 rows')
    expect(storyboards[0].sheetPromptSnapshot).not.toContain('请不要离开我')
    expect(JSON.parse(storyboards[0].sheetGenerationOptionsSnapshot!)).toEqual(immutableRunSettings)

    expect(storyboards[0].panels).toHaveLength(6)
    expect(storyboards[0].panels[0].description).toBe('updated visual beat 1')
    expect(storyboards[0].panels.map((panel) => panel.gridCellIndex)).toEqual([0, 1, 2, 3, 4, 5])
    expect(storyboards[0].panels.map((panel) => panel.panelNumber)).toEqual([1, 2, 3, 4, 5, 6])
    for (const panel of storyboards[0].panels) {
      expect(panel).toMatchObject({
        durationOverride: null,
        imageUrl: null,
        imageMediaId: null,
        normalizedCropRect: null,
        croppedImageUrl: null,
        croppedImageMediaId: null,
        upscaledImageUrl: null,
        upscaledImageMediaId: null,
        imageDerivation: null,
        imageLineage: null,
      })
      expect(panel.estimatedDuration).toBeGreaterThanOrEqual(2)
    }
    expect(storyboards[0].panels[2]).toMatchObject({
      hasDialogue: true,
      dialogueSpeaker: 'Ming',
      dialogueText: '请不要离开我，我马上就会回来',
      dialogueEmotion: 'afraid',
      includeDialogueInVideoPrompt: false,
      estimatedDuration: estimatePanelDuration({
        dialogueText: '请不要离开我，我马上就会回来',
      }).estimatedDuration,
    })
    expect(storyboards[0].panels[0]).toMatchObject({
      hasDialogue: false,
      dialogueSpeaker: null,
      dialogueText: null,
      dialogueEmotion: null,
      includeDialogueInVideoPrompt: false,
    })

    const voiceLines = await prisma.novelPromotionVoiceLine.findMany({ where: { episodeId: episode.id } })
    expect(voiceLines).toHaveLength(1)
    expect(voiceLines[0]).toMatchObject({
      matchedStoryboardId: storyboards[0].id,
      matchedPanelId: storyboards[0].panels[2].id,
      matchedPanelIndex: 2,
    })
    expect(firstPanelIds).not.toContain(voiceLines[0].matchedPanelId)

    const artifacts = await prisma.graphArtifact.findMany({ where: { runId: run.id } })
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]).toMatchObject({
      stepKey: 'six_grid_persist',
      artifactType: 'storyboard.six_grid.group',
      refId: group.groupId,
    })
    expect(artifacts[0].versionHash).toMatch(/^[a-f0-9]{64}$/)
    expect(artifacts[0].versionHash).not.toBe(firstArtifact.versionHash)
    expect(artifacts[0].payload).toMatchObject({
      groupId: group.groupId,
      groupSequence: 1,
      runSettings: immutableRunSettings,
    })
  })

  it('uses the immutable GraphRun input after project defaults change', async () => {
    const { novelProject, episode, clip, run } = await seedDomain()
    await prisma.novelPromotionProject.update({
      where: { id: novelProject.id },
      data: {
        storyboardGenerationMode: 'individual',
        sixGridCellAspectRatio: '9:16',
        sixGridProcessingOrder: 'sheet_upscale_then_crop',
      },
    })

    await persistStoryboardOutputs({
      episodeId: episode.id,
      runId: run.id,
      clipPanels: [sixGridGroup(clip.id)],
      voiceLineRows: null,
    })

    const storyboard = await prisma.novelPromotionStoryboard.findFirstOrThrow({
      where: { episodeId: episode.id },
    })
    expect(storyboard).toMatchObject({
      layoutMode: 'six_grid',
      sixGridCellAspectRatio: '16:9',
      sixGridProcessingOrder: 'crop_then_panel_upscale',
    })
  })

  it('keeps two stable six-grid groups for the same clip', async () => {
    const { episode, clip, run } = await seedDomain()
    const first = sixGridGroup(clip.id, 1)
    const second = sixGridGroup(clip.id, 2)
    await persistStoryboardOutputs({
      episodeId: episode.id,
      runId: run.id,
      clipPanels: [first, second],
      voiceLineRows: null,
    })
    await persistStoryboardOutputs({
      episodeId: episode.id,
      runId: run.id,
      clipPanels: [
        {
          ...second,
          groupSequence: 1,
          incomingContinuity: first.incomingContinuity,
          outgoingContinuity: first.outgoingContinuity,
        },
        {
          ...first,
          groupSequence: 2,
          incomingContinuity: second.incomingContinuity,
          outgoingContinuity: second.outgoingContinuity,
        },
      ],
      voiceLineRows: null,
    })

    const storyboards = await prisma.novelPromotionStoryboard.findMany({
      where: { episodeId: episode.id },
      orderBy: { groupSequence: 'asc' },
      include: { panels: true },
    })
    expect(storyboards).toHaveLength(2)
    expect(storyboards.map((storyboard) => storyboard.groupSequence)).toEqual([1, 2])
    expect(storyboards.map((storyboard) => storyboard.id)).toHaveLength(2)
    expect(new Set(storyboards.map((storyboard) => storyboard.id)).size).toBe(2)
    expect(storyboards.every((storyboard) => storyboard.panels.length === 6)).toBe(true)
    expect(JSON.parse(storyboards[0].continuityAnchor!).groupId).toBe(second.groupId)
    expect(JSON.parse(storyboards[1].continuityAnchor!).groupId).toBe(first.groupId)
  })

  it('rolls back every group, artifact, and voice line when a later group is invalid', async () => {
    const { episode, clip, run } = await seedDomain()
    const invalidGroup = { ...sixGridGroup(clip.id, 2), finalPanels: sixPanels(false).slice(0, 5) }

    await expect(persistStoryboardOutputs({
      episodeId: episode.id,
      runId: run.id,
      clipPanels: [sixGridGroup(clip.id, 1), invalidGroup],
      voiceLineRows: null,
    })).rejects.toThrow('SIX_GRID_REQUIRES_EXACTLY_SIX_PANELS')

    expect(await prisma.novelPromotionStoryboard.count({ where: { episodeId: episode.id } })).toBe(0)
    expect(await prisma.novelPromotionPanel.count()).toBe(0)
    expect(await prisma.novelPromotionVoiceLine.count({ where: { episodeId: episode.id } })).toBe(0)
    expect(await prisma.graphArtifact.count({ where: { runId: run.id } })).toBe(0)
  })

  it('preserves the legacy individual persistence contract', async () => {
    const { episode, clip } = await seedDomain()
    await persistStoryboardOutputs({
      episodeId: episode.id,
      clipPanels: [{
        clipId: clip.id,
        clipIndex: 1,
        finalPanels: [{
          panel_number: 1,
          description: 'legacy panel',
          location: 'rainy-platform',
          source_text: 'legacy source',
          characters: ['Ming'],
        }],
      }],
      voiceLineRows: null,
    })

    const storyboard = await prisma.novelPromotionStoryboard.findFirstOrThrow({
      where: { episodeId: episode.id },
      include: { panels: true },
    })
    expect(storyboard).toMatchObject({ layoutMode: 'individual', panelCount: 1, groupSequence: null })
    expect(storyboard.panels).toHaveLength(1)
  })

  it('uses an individual GraphRun snapshot even when the input has six-grid-shaped metadata', async () => {
    const { episode, clip, run } = await seedDomain()
    await prisma.graphRun.update({
      where: { id: run.id },
      data: {
        input: {
          storyboardGenerationMode: 'individual',
          sixGridCellAspectRatio: '9:16',
          sixGridProcessingOrder: 'sheet_upscale_then_crop',
        },
      },
    })

    await persistStoryboardOutputs({
      episodeId: episode.id,
      runId: run.id,
      clipPanels: [sixGridGroup(clip.id)],
      voiceLineRows: null,
    })

    const storyboard = await prisma.novelPromotionStoryboard.findFirstOrThrow({
      where: { episodeId: episode.id },
      include: { panels: true },
    })
    expect(storyboard).toMatchObject({
      layoutMode: 'individual',
      groupSequence: null,
      sixGridCellAspectRatio: null,
      sixGridProcessingOrder: null,
    })
    expect(storyboard.panels).toHaveLength(6)
    expect(await prisma.graphArtifact.count({ where: { runId: run.id } })).toBe(0)
  })

  it('serializes concurrent persistence of the same group without duplicates', async () => {
    const { episode, clip, run } = await seedDomain()
    const group = sixGridGroup(clip.id)
    const input = {
      episodeId: episode.id,
      runId: run.id,
      clipPanels: [group],
      voiceLineRows: [{
        lineIndex: 1,
        speaker: 'Ming',
        content: '请不要离开我，我马上就会回来',
        emotionStrength: 0.8,
        matchedPanel: { storyboardId: group.groupId, panelIndex: 2 },
      }],
    }

    await Promise.all([
      persistStoryboardOutputs(input),
      persistStoryboardOutputs(input),
    ])

    expect(await prisma.novelPromotionStoryboard.count({ where: { episodeId: episode.id } })).toBe(1)
    expect(await prisma.novelPromotionPanel.count({ where: { storyboard: { episodeId: episode.id } } })).toBe(6)
    expect(await prisma.novelPromotionVoiceLine.count({ where: { episodeId: episode.id } })).toBe(1)
    expect(await prisma.graphArtifact.count({ where: { runId: run.id } })).toBe(1)
  })

  it('upserts planner and group phase artifacts with content-addressed versions', async () => {
    const { episode, clip, run } = await seedDomain()
    const group = sixGridGroup(clip.id)
    const result = {
      clipPanels: [group],
      sixGridGroups: [group],
      phase1PanelsByClipId: { [group.groupId]: group.finalPanels },
      phase2CinematographyByClipId: { [group.groupId]: [{ panel_number: 1, composition: 'wide' }] },
      phase2ActingByClipId: { [group.groupId]: [{ panel_number: 1, characters: [] }] },
      phase3PanelsByClipId: { [group.groupId]: group.finalPanels },
      summary: { clipCount: 1, totalPanelCount: 6, totalStepCount: 5 },
    }

    const runSnapshot = await resolveStoryboardRunSnapshot(run.id)
    await prisma.graphArtifact.create({
      data: {
        runId: run.id,
        stepKey: 'other_workflow',
        artifactType: 'storyboard.other.result',
        refId: episode.id,
        payload: { preserved: true },
      },
    })
    await prisma.graphArtifact.create({
      data: {
        runId: run.id,
        stepKey: 'six_grid_group_99_phase3_detail',
        artifactType: 'storyboard.six_grid.phase3',
        refId: 'obsolete-group',
        payload: { stale: true },
      },
    })
    await persistSixGridPlanningArtifacts({ runSnapshot, result })
    await persistSixGridPlanningArtifacts({ runSnapshot, result })
    const before = await prisma.graphArtifact.findFirstOrThrow({
      where: { runId: run.id, artifactType: 'storyboard.six_grid.phase3' },
    })

    result.phase3PanelsByClipId[group.groupId] = [
      { ...group.finalPanels[0], description: 'changed phase3 panel' },
      ...group.finalPanels.slice(1),
    ]
    await persistSixGridPlanningArtifacts({ runSnapshot, result })

    const artifacts = await prisma.graphArtifact.findMany({ where: { runId: run.id } })
    expect(artifacts).toHaveLength(6)
    expect(new Set(artifacts.filter((artifact) => artifact.artifactType.startsWith('storyboard.six_grid.'))
      .map((artifact) => artifact.artifactType))).toEqual(new Set([
      'storyboard.six_grid.plan',
      'storyboard.six_grid.phase1',
      'storyboard.six_grid.phase2.cine',
      'storyboard.six_grid.phase2.acting',
      'storyboard.six_grid.phase3',
    ]))
    const phase3 = artifacts.find((artifact) => artifact.artifactType === 'storyboard.six_grid.phase3')
    expect(phase3?.versionHash).not.toBe(before.versionHash)
    const phase3Payload = phase3?.payload as { panels?: Array<{ description?: string }> } | null
    expect(phase3Payload?.panels?.[0]).toMatchObject({ description: 'changed phase3 panel' })
    expect(artifacts).toContainEqual(expect.objectContaining({
      artifactType: 'storyboard.other.result',
      refId: episode.id,
    }))
    expect(artifacts).not.toContainEqual(expect.objectContaining({ refId: 'obsolete-group' }))
  })

  it('reconciles a two-group episode down to one group without stale voice references', async () => {
    const { episode, clip, run } = await seedDomain()
    const first = sixGridGroup(clip.id, 1)
    const second = sixGridGroup(clip.id, 2)
    await persistStoryboardOutputs({
      episodeId: episode.id,
      runId: run.id,
      clipPanels: [first, second],
      voiceLineRows: [{
        lineIndex: 1,
        speaker: 'Ming',
        content: 'old group line',
        emotionStrength: 0.5,
        matchedPanel: { storyboardId: second.groupId, panelIndex: 0 },
      }],
    })

    await persistStoryboardOutputs({
      episodeId: episode.id,
      runId: run.id,
      clipPanels: [first],
      voiceLineRows: [{
        lineIndex: 1,
        speaker: 'Ming',
        content: 'retained as unmatched',
        emotionStrength: 0.5,
      }],
    })

    const storyboards = await prisma.novelPromotionStoryboard.findMany({
      where: { episodeId: episode.id, layoutMode: 'six_grid' },
      include: { panels: true },
    })
    expect(storyboards).toHaveLength(1)
    expect(storyboards[0].groupSequence).toBe(1)
    expect(storyboards[0].panels).toHaveLength(6)
    const finalArtifacts = await prisma.graphArtifact.findMany({
      where: { runId: run.id, artifactType: 'storyboard.six_grid.group' },
    })
    expect(finalArtifacts.map((artifact) => artifact.refId)).toEqual([first.groupId])
    const voice = await prisma.novelPromotionVoiceLine.findFirstOrThrow({ where: { episodeId: episode.id } })
    expect(voice).toMatchObject({ matchedStoryboardId: null, matchedPanelId: null, matchedPanelIndex: null })
  })

  it('replaces the same sequence when group identity and clip change', async () => {
    const { episode, clip, run } = await seedDomain()
    const replacementClip = await prisma.novelPromotionClip.create({
      data: { episodeId: episode.id, summary: 'replacement', content: 'replacement content' },
    })
    const original = sixGridGroup(clip.id, 1)
    const replacement = {
      ...sixGridGroup(replacementClip.id, 1),
      groupId: `replacement-group:${replacementClip.id}`,
      groupKey: `replacement-key:${replacementClip.id}`,
    }
    await persistStoryboardOutputs({
      episodeId: episode.id,
      runId: run.id,
      clipPanels: [original],
      voiceLineRows: null,
    })
    await persistStoryboardOutputs({
      episodeId: episode.id,
      runId: run.id,
      clipPanels: [replacement],
      voiceLineRows: null,
    })

    const storyboards = await prisma.novelPromotionStoryboard.findMany({
      where: { episodeId: episode.id, layoutMode: 'six_grid' },
    })
    expect(storyboards).toHaveLength(1)
    expect(storyboards[0]).toMatchObject({ clipId: replacementClip.id, groupSequence: 1 })
    expect(JSON.parse(storyboards[0].continuityAnchor!)).toMatchObject({
      groupId: replacement.groupId,
      groupKey: replacement.groupKey,
    })
  })

  it('rejects duplicate groupId values before writing any storyboard', async () => {
    const { episode, clip, run } = await seedDomain()
    const first = sixGridGroup(clip.id, 1)
    const second = { ...sixGridGroup(clip.id, 2), groupId: first.groupId }
    await expect(persistStoryboardOutputs({
      episodeId: episode.id,
      runId: run.id,
      clipPanels: [first, second],
      voiceLineRows: null,
    })).rejects.toThrow('SIX_GRID_GROUP_IDENTITY_DUPLICATE')
    expect(await prisma.novelPromotionStoryboard.count({ where: { episodeId: episode.id } })).toBe(0)
  })

  it('uses the resolved snapshot object after GraphRun input changes', async () => {
    const { episode, clip, run } = await seedDomain()
    const runSnapshot = await resolveStoryboardRunSnapshot(run.id)
    await prisma.graphRun.update({
      where: { id: run.id },
      data: { input: { storyboardGenerationMode: 'individual' } },
    })

    await persistStoryboardOutputs({
      episodeId: episode.id,
      runId: run.id,
      runSnapshot,
      clipPanels: [sixGridGroup(clip.id)],
      voiceLineRows: null,
    })

    const storyboard = await prisma.novelPromotionStoryboard.findFirstOrThrow({ where: { episodeId: episode.id } })
    expect(storyboard.layoutMode).toBe('six_grid')
  })

  it('fails an oversized artifact batch without leaving partial artifacts', async () => {
    const { clip, run } = await seedDomain()
    const group = sixGridGroup(clip.id)
    const oversized = 'x'.repeat(300 * 1024)
    const result = {
      clipPanels: [group],
      sixGridGroups: [group],
      phase1PanelsByClipId: { [group.groupId]: group.finalPanels },
      phase2CinematographyByClipId: {},
      phase2ActingByClipId: {},
      phase3PanelsByClipId: {
        [group.groupId]: [{ ...group.finalPanels[0], description: oversized }],
      },
      summary: { clipCount: 1, totalPanelCount: 6, totalStepCount: 5 },
    }

    await expect(persistSixGridPlanningArtifacts({
      runSnapshot: await resolveStoryboardRunSnapshot(run.id),
      result,
    })).rejects.toThrow('GRAPH_ARTIFACT_PAYLOAD_TOO_LARGE')
    expect(await prisma.graphArtifact.count({ where: { runId: run.id } })).toBe(0)
  })

  it('keeps one internally complete plan when different identities race for the same sequence', async () => {
    const { episode, clip, run } = await seedDomain()
    const left = sixGridGroup(clip.id, 1)
    const right = {
      ...sixGridGroup(clip.id, 1),
      groupId: `race-right:${clip.id}`,
      groupKey: `race-right-key:${clip.id}`,
      finalPanels: sixPanels(false).map((panel) => ({ ...panel, description: `right ${panel.panel_number}` })),
    }
    await Promise.all([
      persistStoryboardOutputs({ episodeId: episode.id, runId: run.id, clipPanels: [left], voiceLineRows: null }),
      persistStoryboardOutputs({ episodeId: episode.id, runId: run.id, clipPanels: [right], voiceLineRows: null }),
    ])

    const storyboards = await prisma.novelPromotionStoryboard.findMany({
      where: { episodeId: episode.id, layoutMode: 'six_grid' },
      include: { panels: { orderBy: { panelIndex: 'asc' } } },
    })
    expect(storyboards).toHaveLength(1)
    expect(storyboards[0].panels).toHaveLength(6)
    const anchor = JSON.parse(storyboards[0].continuityAnchor!) as { groupId: string }
    const isLeft = anchor.groupId === left.groupId
    expect(storyboards[0].panels.every((panel) => (
      isLeft ? panel.description?.startsWith('visual beat') : panel.description?.startsWith('right')
    ))).toBe(true)
  })
})
