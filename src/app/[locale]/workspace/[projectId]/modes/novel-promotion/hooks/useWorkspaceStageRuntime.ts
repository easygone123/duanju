'use client'

import { useMemo } from 'react'
import type { WorkspaceStageRuntimeValue } from '../WorkspaceStageRuntimeContext'
import type { CapabilitySelections, ModelCapabilities } from '@/lib/model-config-contract'
import type { VideoPricingTier } from '@/lib/model-pricing/video-tier'
import type { BatchVideoGenerationParams, VideoGenerationOptions } from '../components/video'
import type {
  SixGridCellAspectRatio,
  SixGridProcessingOrder,
  StoryboardGenerationMode,
} from '@/lib/novel-promotion/six-grid/contracts'
import type { StoryboardConfigKey } from './useWorkspaceConfigActions'

interface UseWorkspaceStageRuntimeParams {
  assetsLoading: boolean
  isSubmittingTTS: boolean
  isTransitioning: boolean
  isConfirmingAssets: boolean
  isStartingStoryToScript: boolean
  isStartingScriptToStoryboard: boolean
  isScriptToStoryboardRunning: boolean
  videoRatio: string | undefined
  storyboardGenerationMode: StoryboardGenerationMode
  sixGridCellAspectRatio: SixGridCellAspectRatio | null
  sixGridProcessingOrder: SixGridProcessingOrder
  storyboardUpscaleModel: string | null
  dialogueVideoModel: string | null
  artStyle: string | undefined
  videoModel: string | undefined
  capabilityOverrides: CapabilitySelections
  userVideoModels: Array<{
    value: string
    label: string
    provider?: string
    providerName?: string
    capabilities?: ModelCapabilities
    videoPricingTiers?: VideoPricingTier[]
  }> | undefined
  userUpscaleModels: Array<{
    value: string
    label: string
    provider?: string
    providerName?: string
    capabilities?: ModelCapabilities
  }> | undefined
  handleUpdateEpisode: (key: string, value: unknown) => Promise<void>
  handleUpdateConfig: (key: string, value: unknown) => Promise<void>
  handleUpdateStoryboardConfig: (key: StoryboardConfigKey, value: unknown) => Promise<boolean>
  runWithRebuildConfirm: (action: 'storyToScript' | 'scriptToStoryboard', operation: () => Promise<void>) => Promise<void>
  runStoryToScriptFlow: () => Promise<void>
  runScriptToStoryboardFlow: () => Promise<void>
  handleUpdateClip: (clipId: string, updates: Record<string, unknown>) => Promise<void>
  openAssetLibrary: (characterId?: string | null, refreshAssets?: boolean) => void
  handleStageChange: (stage: string) => void
  handleGenerateVideo: (
    storyboardId: string,
    panelIndex: number,
    videoModel?: string,
    firstLastFrame?: {
      lastFrameStoryboardId: string
      lastFramePanelIndex: number
      flModel: string
      customPrompt?: string
    },
    generationOptions?: VideoGenerationOptions,
    panelId?: string,
  ) => Promise<void>
  handleGenerateAllVideos: (options?: BatchVideoGenerationParams) => Promise<void>
  handleUpdateVideoPrompt: (
    storyboardId: string,
    panelIndex: number,
    value: string,
    field?: 'videoPrompt' | 'firstLastFramePrompt',
  ) => Promise<void>
  handleUpdatePanelVideoModel: (storyboardId: string, panelIndex: number, model: string) => Promise<void>
}

export function useWorkspaceStageRuntime({
  assetsLoading,
  isSubmittingTTS,
  isTransitioning,
  isConfirmingAssets,
  isStartingStoryToScript,
  isStartingScriptToStoryboard,
  isScriptToStoryboardRunning,
  videoRatio,
  storyboardGenerationMode,
  sixGridCellAspectRatio,
  sixGridProcessingOrder,
  storyboardUpscaleModel,
  dialogueVideoModel,
  artStyle,
  videoModel,
  capabilityOverrides,
  userVideoModels,
  userUpscaleModels,
  handleUpdateEpisode,
  handleUpdateConfig,
  handleUpdateStoryboardConfig,
  runWithRebuildConfirm,
  runStoryToScriptFlow,
  runScriptToStoryboardFlow,
  handleUpdateClip,
  openAssetLibrary,
  handleStageChange,
  handleGenerateVideo,
  handleGenerateAllVideos,
  handleUpdateVideoPrompt,
  handleUpdatePanelVideoModel,
}: UseWorkspaceStageRuntimeParams) {
  const resolvedUserVideoModels = useMemo(
    () => userVideoModels || [],
    [userVideoModels],
  )
  const resolvedUserUpscaleModels = useMemo(
    () => userUpscaleModels || [],
    [userUpscaleModels],
  )

  return useMemo<WorkspaceStageRuntimeValue>(() => ({
    assetsLoading,
    isSubmittingTTS,
    isTransitioning,
    isConfirmingAssets,
    isStartingStoryToScript,
    isStartingScriptToStoryboard,
    isScriptToStoryboardRunning,
    videoRatio,
    storyboardGenerationMode,
    sixGridCellAspectRatio,
    sixGridProcessingOrder,
    storyboardUpscaleModel,
    dialogueVideoModel,
    artStyle,
    videoModel,
    capabilityOverrides,
    userVideoModels: resolvedUserVideoModels,
    userUpscaleModels: resolvedUserUpscaleModels,
    onNovelTextChange: (value) => handleUpdateEpisode('novelText', value),
    onVideoRatioChange: (value) => handleUpdateConfig('videoRatio', value),
    onArtStyleChange: (value) => handleUpdateConfig('artStyle', value),
    onStoryboardConfigChange: handleUpdateStoryboardConfig,
    onRunStoryToScript: () => runWithRebuildConfirm('storyToScript', runStoryToScriptFlow),
    onClipUpdate: (clipId, data) => {
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('onClipUpdate requires a plain object payload')
      }
      return handleUpdateClip(clipId, data as Record<string, unknown>)
    },
    onOpenAssetLibrary: () => openAssetLibrary(),
    onRunScriptToStoryboard: () => runWithRebuildConfirm('scriptToStoryboard', runScriptToStoryboardFlow),
    onStageChange: handleStageChange,
    onGenerateVideo: handleGenerateVideo,
    onGenerateAllVideos: handleGenerateAllVideos,
    onUpdateVideoPrompt: handleUpdateVideoPrompt,
    onUpdatePanelVideoModel: handleUpdatePanelVideoModel,
    onOpenAssetLibraryForCharacter: (characterId, refreshAssets) => openAssetLibrary(characterId, refreshAssets),
  }), [
    artStyle,
    assetsLoading,
    handleGenerateAllVideos,
    handleGenerateVideo,
    handleStageChange,
    handleUpdateClip,
    handleUpdateConfig,
    handleUpdateEpisode,
    handleUpdateStoryboardConfig,
    handleUpdatePanelVideoModel,
    handleUpdateVideoPrompt,
    isConfirmingAssets,
    isStartingScriptToStoryboard,
    isScriptToStoryboardRunning,
    isStartingStoryToScript,
    isSubmittingTTS,
    isTransitioning,
    openAssetLibrary,
    runScriptToStoryboardFlow,
    runStoryToScriptFlow,
    runWithRebuildConfirm,
    resolvedUserVideoModels,
    resolvedUserUpscaleModels,
    capabilityOverrides,
    videoModel,
    videoRatio,
    storyboardGenerationMode,
    sixGridCellAspectRatio,
    sixGridProcessingOrder,
    storyboardUpscaleModel,
    dialogueVideoModel,
  ])
}
