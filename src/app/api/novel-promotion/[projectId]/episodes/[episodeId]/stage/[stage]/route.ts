import { NextRequest, NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { isErrorResponse, requireProjectAuthLight } from '@/lib/api-auth'
import { attachMediaFieldsToStagePayload } from '@/lib/media/attach'
import { isEpisodeStage, type EpisodeStage } from '@/lib/novel-promotion/episode-stage-data'

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
  videoPrompt: true,
  hasDialogue: true,
  narrationMode: true,
  narrationRecommended: true,
  narrationSuggestedText: true,
  narrationSuggestedEmotion: true,
  narrationText: true,
  narrationEmotion: true,
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
  matchedVoiceLines: {
    where: { lineType: 'narration' },
    select: { lineType: true, enabled: true },
  },
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
  sheetPromptSnapshot: true,
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

type ConfigArtifactCounts = {
  scriptCount: number
  storyboardCount: number
  panelCount: number
  videoCount: number
  voiceCount: number
}

async function loadConfigArtifactCounts(episodeId: string): Promise<ConfigArtifactCounts> {
  const [scriptCount, storyboardCount, panelCount, videoCount, voiceCount] = await Promise.all([
    prisma.novelPromotionClip.count({
      where: { episodeId, screenplay: { not: null }, NOT: { screenplay: '' } },
    }),
    prisma.novelPromotionStoryboard.count({ where: { episodeId } }),
    prisma.novelPromotionPanel.count({ where: { storyboard: { episodeId } } }),
    prisma.novelPromotionPanel.count({
      where: { storyboard: { episodeId }, videoUrl: { not: null }, NOT: { videoUrl: '' } },
    }),
    prisma.novelPromotionVoiceLine.count({ where: { episodeId, enabled: true } }),
  ])
  return { scriptCount, storyboardCount, panelCount, videoCount, voiceCount }
}

async function buildStageEpisode(
  stage: EpisodeStage,
  row: StageRow,
  configCounts?: ConfigArtifactCounts,
) {
  if (stage === 'config') {
    if (!configCounts) throw new Error('Config artifact counts are required')
    return {
      ...stageCore(row),
      novelText: typeof row.novelText === 'string' ? row.novelText : null,
      readiness: {
        hasStory: typeof row.novelText === 'string' && row.novelText.trim().length > 0,
        hasScript: configCounts.scriptCount > 0,
        hasStoryboard: configCounts.panelCount > 0,
        hasVideo: configCounts.videoCount > 0,
        hasVoice: configCounts.voiceCount > 0,
      },
      storyboardStats: {
        storyboardCount: configCounts.storyboardCount,
        panelCount: configCounts.panelCount,
      },
    }
  }
  if (stage === 'script') {
    return { ...stageCore(row), clips: row.clips || [] }
  }
  if (stage === 'voice') {
    return { ...stageCore(row), clips: row.clips || [], storyboards: row.storyboards || [] }
  }

  const withMedia = await attachMediaFieldsToStagePayload(row)
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
  const configCounts = rawStage === 'config' ? await loadConfigArtifactCounts(episodeId) : undefined

  return NextResponse.json({
    stage: rawStage,
    episode: await buildStageEpisode(rawStage, episode as StageRow, configCounts),
  })
})
