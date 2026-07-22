import type { StageArtifactReadiness } from './stage-readiness'
import type { MediaRef, NovelPromotionClip, NovelPromotionPanel, NovelPromotionStoryboard } from '@/types/project'

export const EPISODE_STAGES = ['config', 'script', 'storyboard', 'videos', 'voice'] as const

export type EpisodeStage = (typeof EPISODE_STAGES)[number]

export function isEpisodeStage(value: unknown): value is EpisodeStage {
  return typeof value === 'string' && (EPISODE_STAGES as readonly string[]).includes(value)
}

export type EpisodeStageClip = NovelPromotionClip & {
  episodeId?: string
  createdAt?: string
  updatedAt?: string
}

type StoryboardPanelFields =
  | 'id'
  | 'storyboardId'
  | 'panelIndex'
  | 'panelNumber'
  | 'shotType'
  | 'cameraMove'
  | 'description'
  | 'location'
  | 'characters'
  | 'props'
  | 'srtSegment'
  | 'srtStart'
  | 'srtEnd'
  | 'duration'
  | 'imagePrompt'
  | 'imageUrl'
  | 'videoPrompt'
  | 'hasDialogue'
  | 'narrationMode'
  | 'narrationRecommended'
  | 'narrationSuggestedText'
  | 'narrationSuggestedEmotion'
  | 'narrationText'
  | 'narrationEmotion'
  | 'candidateImages'
  | 'sketchImageUrl'
  | 'previousImageUrl'
  | 'gridCellIndex'
  | 'normalizedCropRect'
  | 'croppedImageUrl'
  | 'upscaledImageUrl'
  | 'imageDerivation'
  | 'imageLineage'
  | 'photographyRules'
  | 'actingNotes'

export type StoryboardEpisodeStagePanel = Pick<NovelPromotionPanel, StoryboardPanelFields> & {
  imageMediaId?: string | null
  sketchImageMediaId?: string | null
  previousImageMediaId?: string | null
  croppedImageMediaId?: string | null
  upscaledImageMediaId?: string | null
  media?: MediaRef | null
  imageMedia?: MediaRef | null
  updatedAt: string
}

type VideoPanelFields =
  | 'id'
  | 'storyboardId'
  | 'panelIndex'
  | 'panelNumber'
  | 'shotType'
  | 'cameraMove'
  | 'description'
  | 'location'
  | 'characters'
  | 'srtSegment'
  | 'duration'
  | 'imagePrompt'
  | 'imageUrl'
  | 'videoPrompt'
  | 'firstLastFramePrompt'
  | 'videoUrl'
  | 'videoGenerationMode'
  | 'lipSyncVideoUrl'
  | 'hasDialogue'
  | 'estimatedDuration'
  | 'durationOverride'
  | 'gridCellIndex'

export type VideoEpisodeStagePanel = Pick<NovelPromotionPanel, VideoPanelFields> & {
  imageMediaId?: string | null
  videoMediaId?: string | null
  lipSyncTaskId?: string | null
  lipSyncVideoMediaId?: string | null
  media?: MediaRef | null
  imageMedia?: MediaRef | null
  videoMedia?: MediaRef | null
  lipSyncVideoMedia?: MediaRef | null
  linkedToNextPanel: boolean
  firstFrameSourceMeta: string | null
  lastFrameSourceMeta: string | null
  dialogueSpeaker: string | null
  dialogueText: string | null
  dialogueEmotion: string | null
  includeDialogueInVideoPrompt: boolean
  matchedVoiceLines?: Array<{
    lineType: string
    enabled: boolean
  }>
  updatedAt: string
}

export type VideoEpisodeStageClip = Pick<
  EpisodeStageClip,
  'id' | 'start' | 'end' | 'duration' | 'summary' | 'createdAt'
>

type StoryboardFields =
  | 'id'
  | 'episodeId'
  | 'clipId'
  | 'storyboardImageUrl'
  | 'panelCount'
  | 'lastError'
  | 'photographyPlan'
  | 'layoutMode'
  | 'groupSequence'
  | 'continuityAnchor'
  | 'sixGridCellAspectRatio'
  | 'sixGridProcessingOrder'
  | 'sheetImageUrl'
  | 'sheetImageMediaId'
  | 'upscaledSheetImageUrl'
  | 'upscaledSheetImageMediaId'
  | 'directorVideoUrl'
  | 'directorVideoMediaId'
  | 'sheetPromptSnapshot'
  | 'sheetArtifactVersion'

export type StoryboardEpisodeStageStoryboard = Pick<NovelPromotionStoryboard, StoryboardFields> & {
  panels: StoryboardEpisodeStagePanel[]
  media?: MediaRef | null
  createdAt?: string
  updatedAt?: string
}

export type VideoEpisodeStageStoryboard = Pick<
  NovelPromotionStoryboard,
  'id' | 'episodeId' | 'clipId' | 'panelCount' | 'layoutMode' | 'groupSequence' | 'continuityAnchor'
> & {
  panels: VideoEpisodeStagePanel[]
  createdAt: string
  updatedAt: string
}

export type VoiceEpisodeStageStoryboard = Pick<NovelPromotionStoryboard, 'id' | 'clipId'> & {
  panels: Array<Pick<NovelPromotionPanel, 'id' | 'storyboardId' | 'panelIndex' | 'srtSegment' | 'description'>>
}

export type EpisodeStagePanel = StoryboardEpisodeStagePanel | VideoEpisodeStagePanel | VoiceEpisodeStageStoryboard['panels'][number]
export type EpisodeStageStoryboard = StoryboardEpisodeStageStoryboard | VideoEpisodeStageStoryboard | VoiceEpisodeStageStoryboard

interface EpisodeStageCore {
  id: string
  name: string
  episodeNumber: number
}

export interface ConfigEpisodeStagePayload {
  stage: 'config'
  episode: EpisodeStageCore & {
    novelText: string | null
    readiness: StageArtifactReadiness
    storyboardStats: {
      storyboardCount: number
      panelCount: number
    }
  }
}

export interface ScriptEpisodeStagePayload {
  stage: 'script'
  episode: EpisodeStageCore & {
    clips: EpisodeStageClip[]
  }
}

export interface StoryboardEpisodeStagePayload {
  stage: 'storyboard'
  episode: EpisodeStageCore & {
    clips: EpisodeStageClip[]
    storyboards: StoryboardEpisodeStageStoryboard[]
  }
}

export interface VideosEpisodeStagePayload {
  stage: 'videos'
  episode: EpisodeStageCore & {
    clips: VideoEpisodeStageClip[]
    storyboards: VideoEpisodeStageStoryboard[]
  }
}

export interface VoiceEpisodeStagePayload {
  stage: 'voice'
  episode: EpisodeStageCore & {
    clips: Array<Pick<EpisodeStageClip, 'id'>>
    storyboards: VoiceEpisodeStageStoryboard[]
  }
}

export interface EpisodeStagePayloadByStage {
  config: ConfigEpisodeStagePayload
  script: ScriptEpisodeStagePayload
  storyboard: StoryboardEpisodeStagePayload
  videos: VideosEpisodeStagePayload
  voice: VoiceEpisodeStagePayload
}

export type EpisodeStagePayload = EpisodeStagePayloadByStage[EpisodeStage]
