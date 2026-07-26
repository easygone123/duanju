import { z } from 'zod'

import { ApiError } from '@/lib/api-errors'
import { detachVoiceLinesBeforePanelRemoval } from '@/lib/novel-promotion/voice-lines/orphaning'
import { prisma } from '@/lib/prisma'

export const externalStoryboardPanelSchema = z.object({
  description: z.string().trim().min(1).max(20_000),
  shotType: z.string().trim().min(1).max(500).optional(),
  cameraMove: z.string().trim().min(1).max(500).optional(),
  duration: z.number().finite().positive().max(60),
  videoPrompt: z.string().trim().min(1).max(30_000),
  firstLastFramePrompt: z.string().trim().max(30_000).optional(),
  location: z.string().trim().max(2_000).optional(),
  characters: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  props: z.array(z.string().trim().min(1).max(500)).max(50).optional(),
  sourceText: z.string().trim().max(20_000).optional(),
  dialogueSpeaker: z.string().trim().min(1).max(500).optional(),
  dialogueText: z.string().trim().min(1).max(10_000).optional(),
  dialogueEmotion: z.string().trim().min(1).max(500).optional(),
  includeDialogueInVideoPrompt: z.boolean().optional(),
}).strict()

export const externalStoryboardGroupSchema = z.object({
  mode: z.enum(['four_grid', 'six_grid']).default('four_grid'),
  summary: z.string().trim().min(1).max(10_000),
  content: z.string().trim().max(30_000).optional(),
  sheetPrompt: z.string().trim().min(1).max(60_000),
  panels: z.array(externalStoryboardPanelSchema).min(4).max(6),
}).strict().superRefine((group, context) => {
  const expectedPanelCount = group.mode === 'six_grid' ? 6 : 4
  if (group.panels.length !== expectedPanelCount) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['panels'],
      message: `${group.mode} requires exactly ${expectedPanelCount} panels`,
    })
  }
})

export const externalStoryboardImportSchema = z.object({
  episodeId: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(500).optional(),
  replaceExisting: z.literal(true),
  groups: z.array(externalStoryboardGroupSchema).min(1).max(30),
}).strict().superRefine((request, context) => {
  const modes = new Set(request.groups.map((group) => group.mode))
  if (modes.size > 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['groups'],
      message: 'all imported groups must use the same grid mode',
    })
  }
})

export type ExternalStoryboardImportInput = z.infer<typeof externalStoryboardImportSchema>

export async function importExternalGridStoryboards(input: {
  userId: string
  projectId: string
  data: ExternalStoryboardImportInput
}) {
  const { data, projectId, userId } = input
  const episode = await prisma.novelPromotionEpisode.findFirst({
    where: {
      id: data.episodeId,
      novelPromotionProject: {
        projectId,
        project: { userId },
      },
    },
    select: {
      id: true,
      storyboards: { select: { id: true } },
    },
  })
  if (!episode) throw new ApiError('NOT_FOUND')

  return prisma.$transaction(async (tx) => {
    const obsoleteStoryboardIds = episode.storyboards.map((storyboard) => storyboard.id)
    if (obsoleteStoryboardIds.length > 0) {
      await detachVoiceLinesBeforePanelRemoval({
        tx,
        episodeId: episode.id,
        storyboardIds: obsoleteStoryboardIds,
      })
      await tx.novelPromotionStoryboard.deleteMany({
        where: { id: { in: obsoleteStoryboardIds } },
      })
    }
    await tx.novelPromotionClip.deleteMany({ where: { episodeId: episode.id } })

    const storyboards = []
    let timelineSeconds = 0
    let dialogueLineIndex = 0
    const incomingDialogueIndexes = Array.from({
      length: data.groups.reduce((total, group) => (
        total + group.panels.filter((panel) => Boolean(panel.dialogueText)).length
      ), 0),
    }, (_, index) => index + 1)

    for (let groupIndex = 0; groupIndex < data.groups.length; groupIndex += 1) {
      const group = data.groups[groupIndex]
      const panelCount = group.mode === 'six_grid' ? 6 : 4
      const clipDuration = group.panels.reduce((sum, panel) => sum + panel.duration, 0)
      const clip = await tx.novelPromotionClip.create({
        data: {
          episodeId: episode.id,
          start: Math.round(timelineSeconds * 1000),
          end: Math.round((timelineSeconds + clipDuration) * 1000),
          duration: Math.round(clipDuration * 1000),
          summary: group.summary,
          content: group.content || group.panels.map((panel) => panel.description).join('\n'),
          shotCount: panelCount,
          createdAt: new Date(Date.now() + groupIndex * 1000),
        },
      })

      const storyboard = await tx.novelPromotionStoryboard.create({
        data: {
          episodeId: episode.id,
          clipId: clip.id,
          panelCount,
          layoutMode: group.mode,
          groupSequence: groupIndex + 1,
          continuityAnchor: JSON.stringify({
            source: 'external_analysis_import',
            groupSequence: groupIndex + 1,
          }),
          sixGridCellAspectRatio: '16:9',
          sixGridProcessingOrder: 'crop_then_panel_upscale',
          sheetPromptSnapshot: group.sheetPrompt,
          sheetModelSnapshot: null,
          sheetGenerationOptionsSnapshot: JSON.stringify({
            storyboardGenerationMode: group.mode,
            gridSpec: {
              version: 1,
              mode: group.mode,
              rows: 2,
              columns: group.mode === 'six_grid' ? 3 : 2,
              panelCount,
              cellAspectRatio: '16:9',
            },
          }),
          panels: {
            create: group.panels.map((panel, panelIndex) => {
              const panelStart = timelineSeconds + group.panels
                .slice(0, panelIndex)
                .reduce((sum, candidate) => sum + candidate.duration, 0)
              return {
                panelIndex,
                panelNumber: panelIndex + 1,
                gridCellIndex: panelIndex,
                shotType: panel.shotType || '中景',
                cameraMove: panel.cameraMove || '固定',
                description: panel.description,
                location: panel.location || null,
                characters: JSON.stringify(panel.characters || []),
                props: JSON.stringify(panel.props || []),
                srtSegment: panel.sourceText || panel.description,
                srtStart: panelStart,
                srtEnd: panelStart + panel.duration,
                duration: panel.duration,
                estimatedDuration: panel.duration,
                videoPrompt: panel.videoPrompt,
                firstLastFramePrompt: panel.firstLastFramePrompt || panel.videoPrompt,
                hasDialogue: Boolean(panel.dialogueText),
                dialogueSpeaker: panel.dialogueText ? panel.dialogueSpeaker || null : null,
                dialogueText: panel.dialogueText || null,
                dialogueEmotion: panel.dialogueText ? panel.dialogueEmotion || null : null,
                includeDialogueInVideoPrompt: panel.dialogueText
                  ? panel.includeDialogueInVideoPrompt !== false
                  : false,
              }
            }),
          },
        },
        select: {
          id: true,
          groupSequence: true,
          panels: {
            orderBy: { panelIndex: 'asc' },
            select: { id: true, panelIndex: true, duration: true },
          },
        },
      })
      storyboards.push(storyboard)

      for (let panelIndex = 0; panelIndex < group.panels.length; panelIndex += 1) {
        const panel = group.panels[panelIndex]
        if (!panel.dialogueText) continue
        dialogueLineIndex += 1
        const persistedPanel = storyboard.panels[panelIndex]
        if (!persistedPanel) throw new ApiError('INTERNAL_ERROR')
        const voiceLineData = {
          speaker: panel.dialogueSpeaker || data.title || '角色',
          content: panel.dialogueText,
          emotionStrength: 0.6,
          matchedPanelId: persistedPanel.id,
          matchedStoryboardId: storyboard.id,
          matchedPanelIndex: panelIndex,
        }
        await tx.novelPromotionVoiceLine.upsert({
          where: {
            episodeId_lineIndex: {
              episodeId: episode.id,
              lineIndex: dialogueLineIndex,
            },
          },
          create: {
            episodeId: episode.id,
            lineIndex: dialogueLineIndex,
            ...voiceLineData,
          },
          update: voiceLineData,
        })
      }
      timelineSeconds += clipDuration
    }

    await tx.novelPromotionVoiceLine.deleteMany({
      where: {
        episodeId: episode.id,
        ...(incomingDialogueIndexes.length > 0
          ? { lineIndex: { notIn: incomingDialogueIndexes } }
          : {}),
      },
    })

    await tx.novelPromotionProject.update({
      where: { projectId },
      data: {
        storyboardGenerationMode: data.groups[0]!.mode,
        sixGridCellAspectRatio: '16:9',
        sixGridProcessingOrder: 'crop_then_panel_upscale',
        lastEpisodeId: episode.id,
      },
    })
    if (data.title) {
      await tx.novelPromotionEpisode.update({
        where: { id: episode.id },
        data: { name: data.title },
      })
    }

    return { storyboards, totalDuration: timelineSeconds }
  })
}
