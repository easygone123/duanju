import { NextRequest, NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { isErrorResponse, requireProjectAuthLight } from '@/lib/api-auth'
import { attachMediaFieldsToProject } from '@/lib/media/attach'
import { isEpisodeStage, type EpisodeStage } from '@/lib/novel-promotion/episode-stage-data'
import { resolveEpisodeStageArtifacts } from '@/lib/novel-promotion/stage-readiness'

const coreSelect = {
  id: true,
  episodeNumber: true,
  name: true,
} satisfies Prisma.NovelPromotionEpisodeSelect

const clipSelect = {
  id: true,
  episodeId: true,
  start: true,
  end: true,
  duration: true,
  summary: true,
  location: true,
  content: true,
  characters: true,
  props: true,
  endText: true,
  shotCount: true,
  startText: true,
  screenplay: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.NovelPromotionClipSelect

const storyboardPanelSelect = {
  id: true,
  storyboardId: true,
  panelIndex: true,
  panelNumber: true,
  shotType: true,
  cameraMove: true,
  description: true,
  location: true,
  characters: true,
  props: true,
  srtSegment: true,
  srtStart: true,
  srtEnd: true,
  duration: true,
  imagePrompt: true,
  imageUrl: true,
  imageMediaId: true,
  candidateImages: true,
  sketchImageUrl: true,
  sketchImageMediaId: true,
  previousImageUrl: true,
  previousImageMediaId: true,
  gridCellIndex: true,
  normalizedCropRect: true,
  croppedImageUrl: true,
  croppedImageMediaId: true,
  upscaledImageUrl: true,
  upscaledImageMediaId: true,
  imageDerivation: true,
  imageLineage: true,
  photographyRules: true,
  actingNotes: true,
  updatedAt: true,
} satisfies Prisma.NovelPromotionPanelSelect

const videoPanelSelect = {
  id: true,
  storyboardId: true,
  panelIndex: true,
  panelNumber: true,
  shotType: true,
  cameraMove: true,
  description: true,
  location: true,
  characters: true,
  srtSegment: true,
  duration: true,
  imagePrompt: true,
  imageUrl: true,
  imageMediaId: true,
  videoPrompt: true,
  firstLastFramePrompt: true,
  videoUrl: true,
  videoMediaId: true,
  videoGenerationMode: true,
  linkedToNextPanel: true,
  lipSyncTaskId: true,
  lipSyncVideoUrl: true,
  lipSyncVideoMediaId: true,
  hasDialogue: true,
  dialogueSpeaker: true,
  dialogueText: true,
  dialogueEmotion: true,
  includeDialogueInVideoPrompt: true,
  estimatedDuration: true,
  durationOverride: true,
  gridCellIndex: true,
  firstFrameSourceMeta: true,
  lastFrameSourceMeta: true,
  updatedAt: true,
} satisfies Prisma.NovelPromotionPanelSelect

const storyboardSelect = {
  id: true,
  episodeId: true,
  clipId: true,
  storyboardImageUrl: true,
  panelCount: true,
  lastError: true,
  photographyPlan: true,
  layoutMode: true,
  groupSequence: true,
  continuityAnchor: true,
  sixGridCellAspectRatio: true,
  sixGridProcessingOrder: true,
  sheetImageUrl: true,
  sheetImageMediaId: true,
  upscaledSheetImageUrl: true,
  upscaledSheetImageMediaId: true,
  sheetArtifactVersion: true,
  createdAt: true,
  updatedAt: true,
  panels: {
    orderBy: { panelIndex: 'asc' as const },
    select: storyboardPanelSelect,
  },
} satisfies Prisma.NovelPromotionStoryboardSelect

const videoStoryboardSelect = {
  id: true,
  episodeId: true,
  clipId: true,
  panelCount: true,
  layoutMode: true,
  groupSequence: true,
  continuityAnchor: true,
  createdAt: true,
  updatedAt: true,
  panels: {
    orderBy: { panelIndex: 'asc' as const },
    select: videoPanelSelect,
  },
} satisfies Prisma.NovelPromotionStoryboardSelect

const voiceStoryboardSelect = {
  id: true,
  clipId: true,
  panels: {
    orderBy: { panelIndex: 'asc' as const },
    select: {
      id: true,
      storyboardId: true,
      panelIndex: true,
      srtSegment: true,
      description: true,
    },
  },
} satisfies Prisma.NovelPromotionStoryboardSelect

const stageSelects = {
  config: {
    ...coreSelect,
    novelText: true,
    clips: {
      orderBy: { createdAt: 'asc' as const },
      select: { screenplay: true },
    },
    storyboards: {
      orderBy: { createdAt: 'asc' as const },
      select: {
        panels: {
          orderBy: { panelIndex: 'asc' as const },
          select: { id: true, videoUrl: true },
        },
      },
    },
    voiceLines: {
      orderBy: { lineIndex: 'asc' as const },
      select: { id: true },
    },
  },
  script: {
    ...coreSelect,
    clips: { orderBy: { createdAt: 'asc' as const }, select: clipSelect },
  },
  storyboard: {
    ...coreSelect,
    clips: { orderBy: { createdAt: 'asc' as const }, select: clipSelect },
    storyboards: { orderBy: { createdAt: 'asc' as const }, select: storyboardSelect },
  },
  videos: {
    ...coreSelect,
    clips: {
      orderBy: { createdAt: 'asc' as const },
      select: { id: true, start: true, end: true, duration: true, summary: true, createdAt: true },
    },
    storyboards: { orderBy: { createdAt: 'asc' as const }, select: videoStoryboardSelect },
  },
  voice: {
    ...coreSelect,
    clips: { orderBy: { createdAt: 'asc' as const }, select: { id: true } },
    storyboards: { orderBy: { createdAt: 'asc' as const }, select: voiceStoryboardSelect },
  },
} satisfies Record<EpisodeStage, Prisma.NovelPromotionEpisodeSelect>

type StageRow = Record<string, unknown> & {
  id: string
  episodeNumber: number
  name: string
}

function stageCore(row: StageRow) {
  return { id: row.id, episodeNumber: row.episodeNumber, name: row.name }
}

async function buildStageEpisode(stage: EpisodeStage, row: StageRow) {
  if (stage === 'config') {
    const storyboards = Array.isArray(row.storyboards) ? row.storyboards as Array<Record<string, unknown>> : []
    return {
      ...stageCore(row),
      novelText: typeof row.novelText === 'string' ? row.novelText : null,
      readiness: resolveEpisodeStageArtifacts({
        novelText: typeof row.novelText === 'string' ? row.novelText : null,
        clips: Array.isArray(row.clips) ? row.clips : [],
        storyboards,
        voiceLines: Array.isArray(row.voiceLines) ? row.voiceLines : [],
      }),
      storyboardStats: {
        storyboardCount: storyboards.length,
        panelCount: storyboards.reduce((count, storyboard) => (
          count + (Array.isArray(storyboard.panels) ? storyboard.panels.length : 0)
        ), 0),
      },
    }
  }
  if (stage === 'script') {
    return { ...stageCore(row), clips: row.clips || [] }
  }
  if (stage === 'voice') {
    return { ...stageCore(row), clips: row.clips || [], storyboards: row.storyboards || [] }
  }

  const withMedia = await attachMediaFieldsToProject(row)
  return {
    ...stageCore(row),
    clips: withMedia.clips || [],
    storyboards: withMedia.storyboards || [],
  }
}

export const GET = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string; episodeId: string; stage?: string }> },
) => {
  const { projectId, episodeId, stage: rawStage } = await context.params
  if (!isEpisodeStage(rawStage)) throw new ApiError('INVALID_PARAMS')

  const authResult = await requireProjectAuthLight(projectId)
  if (isErrorResponse(authResult)) return authResult

  const episode = await prisma.novelPromotionEpisode.findFirst({
    where: {
      id: episodeId,
      novelPromotionProject: { projectId },
    },
    select: stageSelects[rawStage],
  })
  if (!episode) throw new ApiError('NOT_FOUND')

  return NextResponse.json({
    stage: rawStage,
    episode: await buildStageEpisode(rawStage, episode as StageRow),
  })
})
