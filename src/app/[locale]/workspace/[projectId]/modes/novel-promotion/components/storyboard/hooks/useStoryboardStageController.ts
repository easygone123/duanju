'use client'

import { useCallback, useMemo } from 'react'
import {
  NovelPromotionStoryboard,
  NovelPromotionClip,
  Character,
  Location,
} from '@/types/project'
import { useProjectAssets } from '@/lib/query/hooks/useProjectAssets'
import {
  useUpdateProjectPhotographyPlan,
  useUpdateProjectPanelActingNotes,
} from '@/lib/query/hooks'
import { useStoryboardState } from './useStoryboardState'
import { usePanelOperations } from './usePanelOperations'
import { useStoryboardImageGeneration } from './useImageGeneration'
import { usePanelVariant } from './usePanelVariant'
import { useStoryboardTaskAwareStoryboards } from './useStoryboardTaskAwareStoryboards'
import { useStoryboardPanelAssetActions } from './useStoryboardPanelAssetActions'
import { useStoryboardStageUiState } from './useStoryboardStageUiState'
import { useStoryboardStageStatus } from './useStoryboardStageStatus'
import { useWorkspaceStageRuntime } from '../../../WorkspaceStageRuntimeContext'
import { parseModelKeyStrict } from '@/lib/model-config-contract'
import { useGridStoryboard } from '@/lib/query/hooks/useSixGridStoryboard'
import type { GridUpscaleWorkflow } from '../GridGroupControls'
import type { CropEntry } from '../GridCropModal'

interface UseStoryboardStageControllerProps {
  projectId: string
  episodeId: string
  initialStoryboards: NovelPromotionStoryboard[]
  clips: NovelPromotionClip[]
  isTransitioning: boolean
}

export function useStoryboardStageController({
  projectId,
  episodeId,
  initialStoryboards,
  clips,
  isTransitioning,
}: UseStoryboardStageControllerProps) {
  const runtime = useWorkspaceStageRuntime()
  const gridTasks = useGridStoryboard(projectId, episodeId)
  const sixGridUpscaleWorkflow = useMemo<GridUpscaleWorkflow | null>(() => {
    const selected = runtime.userUpscaleModels.find((model) => model.value === runtime.storyboardUpscaleModel)
    const parsed = parseModelKeyStrict(selected?.value || '')
    if (!selected || parsed?.provider !== 'comfyui' || !selected.workflowVersionId) return null
    return { workflowId: parsed.modelId, workflowVersionId: selected.workflowVersionId, label: selected.label }
  }, [runtime.storyboardUpscaleModel, runtime.userUpscaleModels])
  const isRunningPhase = useCallback((phase: string | null | undefined) => {
    return phase === 'queued' || phase === 'processing'
  }, [])

  const { data: assets } = useProjectAssets(projectId)
  const characters: Character[] = useMemo(() => assets?.characters ?? [], [assets?.characters])
  const locations: Location[] = useMemo(() => assets?.locations ?? [], [assets?.locations])

  const { taskAwareStoryboards } = useStoryboardTaskAwareStoryboards({
    projectId,
    initialStoryboards,
    isRunningPhase,
  })

  const storyboardState = useStoryboardState({
    projectId,
    episodeId,
    initialStoryboards: taskAwareStoryboards,
    clips,
  })

  const {
    localStoryboards,
    setLocalStoryboards,
    sortedStoryboards,
    expandedClips,
    toggleExpandedClip,
    panelEditsRef,
    getClipInfo,
    getTextPanels,
    getPanelEditData,
    updatePanelEdit,
    formatClipTitle,
    totalPanels,
    storyboardStartIndex,
  } = storyboardState

  const panelOps = usePanelOperations({
    projectId,
    episodeId,
    panelEditsRef,
  })

  const {
    savingPanels,
    deletingPanelIds,
    saveStateByPanel,
    hasUnsavedByPanel,
    submittingStoryboardTextIds,
    addingStoryboardGroup,
    movingClipId,
    insertingAfterPanelId,
    savePanelWithData,
    debouncedSave,
    retrySave,
    addPanel,
    deletePanel,
    deleteStoryboard,
    regenerateStoryboardText,
    addStoryboardGroup,
    moveStoryboardGroup,
    addCharacterToPanel,
    removeCharacterFromPanel,
    setPanelLocation,
    insertPanel,
  } = panelOps

  const variantOps = usePanelVariant({
    projectId,
    episodeId,
    setLocalStoryboards,
  })

  const { submittingVariantPanelId, generatePanelVariant } = variantOps

  const imageOps = useStoryboardImageGeneration({
    projectId,
    episodeId,
    localStoryboards,
    setLocalStoryboards,
  })

  const {
    submittingStoryboardIds,
    submittingPanelImageIds,
    selectingCandidateIds,
    editingPanel,
    setEditingPanel,
    modifyingPanels,
    isDownloadingImages,
    previewImage,
    setPreviewImage,
    regeneratePanelImage,
    regenerateAllPanelsIndividually,
    selectPanelCandidate,
    selectPanelCandidateIndex,
    cancelPanelCandidate,
    getPanelCandidates,
    modifyPanelImage,
    downloadAllImages,
    clearStoryboardError,
  } = imageOps

  const updatePhotographyPlanMutation = useUpdateProjectPhotographyPlan(projectId)
  const updatePanelActingNotesMutation = useUpdateProjectPanelActingNotes(projectId)

  const {
    assetPickerPanel,
    setAssetPickerPanel,
    aiDataPanel,
    setAIDataPanel,
    isEpisodeBatchSubmitting,
    setIsEpisodeBatchSubmitting,
  } = useStoryboardStageUiState()

  const {
    getDefaultAssetsForClip,
    handleEditSubmit,
    handlePanelUpdate,
    handleAddCharacter,
    handleSetLocation,
    handleRemoveCharacter,
    handleRemoveLocation,
    runningCount,
    pendingPanelCount,
    handleGenerateAllPanels,
  } = useStoryboardPanelAssetActions({
    clips,
    characters,
    locations,
    localStoryboards,
    sortedStoryboards,
    submittingPanelImageIds,
    editingPanel,
    setEditingPanel,
    setIsEpisodeBatchSubmitting,
    getTextPanels,
    getPanelEditData,
    updatePanelEdit,
    debouncedSave,
    regeneratePanelImage,
    modifyPanelImage,
    addCharacterToPanel,
    removeCharacterFromPanel,
    setPanelLocation,
    assetPickerPanel,
    setAssetPickerPanel,
  })

  const { addingStoryboardGroupState, transitioningState } = useStoryboardStageStatus({
    addingStoryboardGroup,
    isTransitioning,
  })

  const generateSixGridSheet = useCallback((storyboardId: string) => {
    gridTasks.sheet.mutate({ operation: 'generate', episodeId, storyboardId })
  }, [episodeId, gridTasks.sheet])
  const upscaleSixGridSheet = useCallback((storyboardId: string, workflow: GridUpscaleWorkflow) => {
    gridTasks.sheet.mutate({
      operation: 'upscale', episodeId, storyboardId,
      workflowId: workflow.workflowId, workflowVersionId: workflow.workflowVersionId,
    })
  }, [episodeId, gridTasks.sheet])
  const cropSixGridSheet = useCallback((storyboardId: string, cropRects: CropEntry[]) => gridTasks.crop.mutateAsync({
    episodeId, storyboardId, cropRects,
  }), [episodeId, gridTasks.crop])
  const uploadSixGridSheet = useCallback(
    (storyboardId: string, file: File, version: number) => gridTasks.upload.mutateAsync({
      file, episodeId, storyboardId, expectedSheetArtifactVersion: version,
    }),
    [episodeId, gridTasks.upload],
  )
  const upscaleSixGridPanel = useCallback((storyboardId: string, panelId: string, workflow: GridUpscaleWorkflow) => gridTasks.panelUpscale.mutateAsync({
    episodeId, storyboardId, panelId,
    workflowId: workflow.workflowId, workflowVersionId: workflow.workflowVersionId,
  }), [episodeId, gridTasks.panelUpscale])
  const undoSixGridPanel = useCallback((storyboardId: string, panelId: string, expectedCurrentMediaId: string, expectedPreviousMediaId: string) => gridTasks.undo.mutateAsync({
    storyboardId, panelId, expectedCurrentMediaId, expectedPreviousMediaId,
  }), [gridTasks.undo])

  return {
    localStoryboards, setLocalStoryboards, sortedStoryboards, expandedClips, toggleExpandedClip,
    getClipInfo, getTextPanels, getPanelEditData, updatePanelEdit, formatClipTitle, totalPanels, storyboardStartIndex,
    savingPanels, deletingPanelIds, saveStateByPanel, hasUnsavedByPanel, submittingStoryboardTextIds, addingStoryboardGroup, movingClipId, insertingAfterPanelId,
    savePanelWithData, addPanel, deletePanel, deleteStoryboard, regenerateStoryboardText, addStoryboardGroup, moveStoryboardGroup, insertPanel,
    submittingVariantPanelId, generatePanelVariant,
    submittingStoryboardIds, submittingPanelImageIds, selectingCandidateIds,
    editingPanel, setEditingPanel, modifyingPanels, isDownloadingImages, previewImage, setPreviewImage,
    regeneratePanelImage, regenerateAllPanelsIndividually, selectPanelCandidate, selectPanelCandidateIndex,
    cancelPanelCandidate, getPanelCandidates, modifyPanelImage, downloadAllImages, clearStoryboardError,
    assetPickerPanel, setAssetPickerPanel, aiDataPanel, setAIDataPanel, isEpisodeBatchSubmitting,
    getDefaultAssetsForClip, handleEditSubmit, handlePanelUpdate, handleAddCharacter, handleSetLocation, handleRemoveCharacter, handleRemoveLocation,
    retrySave,
    updatePhotographyPlanMutation, updatePanelActingNotesMutation,
    addingStoryboardGroupState, transitioningState, runningCount, pendingPanelCount, handleGenerateAllPanels,
    sixGridUpscaleWorkflow,
    sixGridTaskStoryboardId: gridTasks.sheet.isPending
      ? gridTasks.sheet.variables?.storyboardId || null
      : gridTasks.crop.isPending
        ? gridTasks.crop.variables?.storyboardId || null
        : gridTasks.upload.isPending
          ? gridTasks.upload.variables?.storyboardId || null
          : null,
    sixGridTaskPanelId: gridTasks.panelUpscale.isPending
      ? gridTasks.panelUpscale.variables?.panelId || null
      : gridTasks.undo.isPending ? gridTasks.undo.variables?.panelId || null : null,
    sixGridGenerationErrors: gridTasks.generationErrorsByStoryboardId,
    generateSixGridSheet, upscaleSixGridSheet, cropSixGridSheet, uploadSixGridSheet, upscaleSixGridPanel, undoSixGridPanel,
  }
}
