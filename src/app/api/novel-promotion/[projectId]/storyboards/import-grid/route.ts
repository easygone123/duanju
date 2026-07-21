import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'

import { isErrorResponse, requireProjectAuthLight } from '@/lib/api-auth'
import { ApiError, apiHandler } from '@/lib/api-errors'
import { detachVoiceLinesBeforePanelRemoval } from '@/lib/novel-promotion/narration/orphaning'
import { prisma } from '@/lib/prisma'

const panelSchema = z.object({
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
}).strict()

const groupSchema = z.object({
  summary: z.string().trim().min(1).max(10_000),
  content: z.string().trim().max(30_000).optional(),
  sheetPrompt: z.string().trim().min(1).max(60_000),
  panels: z.array(panelSchema).length(4),
}).strict()

const requestSchema = z.object({
  episodeId: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(500).optional(),
  replaceExisting: z.literal(true),
  groups: z.array(groupSchema).min(1).max(30),
}).strict()

/**
 * Import storyboard planning produced by an external analysis model. The
 * imported groups intentionally contain no generated media; the normal grid
 * upload route remains the only way to attach and crop a finished 2x2 sheet.
 */
export const POST = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) => {
  const { projectId } = await context.params
  const auth = await requireProjectAuthLight(projectId)
  if (isErrorResponse(auth)) return auth

  const parsed = requestSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'GRID_IMPORT_PAYLOAD_INVALID',
      field: parsed.error.issues[0]?.path.join('.') || 'body',
    })
  }
  const body = parsed.data

  const episode = await prisma.novelPromotionEpisode.findFirst({
    where: {
      id: body.episodeId,
      novelPromotionProject: {
        projectId,
        project: { userId: auth.session.user.id },
      },
    },
    select: {
      id: true,
      storyboards: { select: { id: true } },
    },
  })
  if (!episode) throw new ApiError('NOT_FOUND')

  const imported = await prisma.$transaction(async (tx) => {
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
    for (let groupIndex = 0; groupIndex < body.groups.length; groupIndex += 1) {
      const group = body.groups[groupIndex]
      const clipDuration = group.panels.reduce((sum, panel) => sum + panel.duration, 0)
      const clip = await tx.novelPromotionClip.create({
        data: {
          episodeId: episode.id,
          start: Math.round(timelineSeconds * 1000),
          end: Math.round((timelineSeconds + clipDuration) * 1000),
          duration: Math.round(clipDuration * 1000),
          summary: group.summary,
          content: group.content || group.panels.map((panel) => panel.description).join('\n'),
          shotCount: 4,
          createdAt: new Date(Date.now() + groupIndex * 1000),
        },
      })

      const storyboard = await tx.novelPromotionStoryboard.create({
        data: {
          episodeId: episode.id,
          clipId: clip.id,
          panelCount: 4,
          layoutMode: 'four_grid',
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
            storyboardGenerationMode: 'four_grid',
            gridSpec: {
              version: 1,
              mode: 'four_grid',
              rows: 2,
              columns: 2,
              panelCount: 4,
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
      timelineSeconds += clipDuration
    }

    await tx.novelPromotionProject.update({
      where: { projectId },
      data: {
        storyboardGenerationMode: 'four_grid',
        sixGridCellAspectRatio: '16:9',
        sixGridProcessingOrder: 'crop_then_panel_upscale',
        lastEpisodeId: episode.id,
      },
    })
    if (body.title) {
      await tx.novelPromotionEpisode.update({
        where: { id: episode.id },
        data: { name: body.title },
      })
    }

    return { storyboards, totalDuration: timelineSeconds }
  })

  return NextResponse.json({ success: true, ...imported })
})
