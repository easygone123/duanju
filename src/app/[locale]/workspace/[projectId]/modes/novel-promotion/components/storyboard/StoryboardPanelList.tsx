'use client'

import React, { useMemo, useState } from 'react'
import { NovelPromotionPanel, NovelPromotionStoryboard } from '@/types/project'
import { StoryboardPanel } from './hooks/useStoryboardState'
import { PanelEditData } from '../PanelEditForm'
import { ASPECT_RATIO_CONFIGS } from '@/lib/constants'
import PanelCard from './PanelCard'
import type { PanelSaveState } from './hooks/usePanelCrudActions'
import type { ImageTaskCapabilityOverrides } from '@/lib/model-config-contract'
import type { SixGridUpscaleWorkflow } from './SixGridGroupControls'
import { isSixGridPanelBusy } from '@/lib/query/hooks/useSixGridStoryboard'
import { VirtualCardRange } from '@/components/virtualization/VirtualCardRange'
import { isGridStoryboardMode, resolveStoryboardGridSpec } from '@/lib/novel-promotion/grid-storyboard/spec'

interface StoryboardPanelListProps {
  projectId: string
  episodeId: string
  storyboard: NovelPromotionStoryboard
  textPanels: StoryboardPanel[]
  storyboardStartIndex: number
  videoRatio: string
  isSubmittingStoryboardTextTask: boolean
  savingPanels: Set<string>
  deletingPanelIds: Set<string>
  saveStateByPanel: Record<string, PanelSaveState>
  hasUnsavedByPanel: Set<string>
  modifyingPanels: Set<string>
  panelTaskErrorMap: Map<string, { taskId: string; message: string }>
  isPanelTaskRunning: (panel: StoryboardPanel) => boolean
  getPanelEditData: (panel: StoryboardPanel) => PanelEditData
  getPanelCandidates: (panel: NovelPromotionPanel) => { candidates: string[]; selectedIndex: number } | null
  onPanelUpdate: (panelId: string, panel: StoryboardPanel, updates: Partial<PanelEditData>) => void
  onPanelDelete: (panelId: string) => void
  onOpenCharacterPicker: (panelId: string) => void
  onOpenLocationPicker: (panelId: string) => void
  onRemoveCharacter: (panel: StoryboardPanel, index: number) => void
  onRemoveLocation: (panel: StoryboardPanel) => void
  onRetryPanelSave: (panelId: string) => void
  onRegeneratePanelImage: (panelId: string, count?: number, force?: boolean, imageModel?: string, generationOptions?: ImageTaskCapabilityOverrides) => Promise<boolean>
  onOpenEditModal: (panelIndex: number) => void
  onOpenAIDataModal: (panelIndex: number) => void
  onSelectPanelCandidateIndex: (panelId: string, index: number) => void
  onConfirmPanelCandidate: (panelId: string, imageUrl: string) => Promise<void>
  onCancelPanelCandidate: (panelId: string) => void
  onClearPanelTaskError: (panelId: string) => void
  onPreviewImage: (url: string) => void
  onInsertAfter: (panelIndex: number) => void
  onVariant: (panelIndex: number) => void
  isInsertDisabled: (panelId: string) => boolean
  sixGridUpscaleWorkflow: SixGridUpscaleWorkflow | null
  sixGridTaskPanelId: string | null
  isSixGridTaskRunning: boolean
  onOpenSixGridCrop: (cellIndex: number) => void
  onUpscaleSixGridPanel: (panelId: string, workflow: SixGridUpscaleWorkflow) => Promise<unknown>
  onUndoSixGridPanel: (panelId: string, expectedCurrentMediaId: string, expectedPreviousMediaId: string) => Promise<unknown>
}

export default function StoryboardPanelList({
  projectId,
  episodeId,
  storyboard,
  textPanels,
  storyboardStartIndex,
  videoRatio,
  isSubmittingStoryboardTextTask,
  savingPanels,
  deletingPanelIds,
  saveStateByPanel,
  hasUnsavedByPanel,
  modifyingPanels,
  panelTaskErrorMap,
  isPanelTaskRunning,
  getPanelEditData,
  getPanelCandidates,
  onPanelUpdate,
  onPanelDelete,
  onOpenCharacterPicker,
  onOpenLocationPicker,
  onRemoveCharacter,
  onRemoveLocation,
  onRetryPanelSave,
  onRegeneratePanelImage,
  onOpenEditModal,
  onOpenAIDataModal,
  onSelectPanelCandidateIndex,
  onConfirmPanelCandidate,
  onCancelPanelCandidate,
  onClearPanelTaskError,
  onPreviewImage,
  onInsertAfter,
  onVariant,
  isInsertDisabled,
  sixGridUpscaleWorkflow,
  sixGridTaskPanelId,
  isSixGridTaskRunning,
  onOpenSixGridCrop,
  onUpscaleSixGridPanel,
  onUndoSixGridPanel,
}: StoryboardPanelListProps) {
  const [activeEditPanelId, setActiveEditPanelId] = useState<string | null>(null)
  const gridSpec = isGridStoryboardMode(storyboard.layoutMode)
    ? resolveStoryboardGridSpec(
      storyboard.layoutMode,
      storyboard.sixGridCellAspectRatio === '9:16' ? '9:16' : '16:9',
    )
    : null
  const displayedPanels = gridSpec ? textPanels.slice(0, gridSpec.panelCount) : textPanels
  const displayImages = useMemo(
    () => displayedPanels.map((panel) => panel.imageUrl || null),
    [displayedPanels],
  )
  const isVertical = ASPECT_RATIO_CONFIGS[videoRatio]?.isVertical ?? false
  const gridColumnsClass = gridSpec?.columns === 2 ? 'grid-cols-2' : 'grid-cols-3'
  const panelColumnsClass = gridSpec
    ? gridColumnsClass
    : isVertical ? 'grid-cols-5' : 'grid-cols-3'
  const pinnedPanelIndices = displayedPanels.flatMap((panel, index) => {
    const saveState = saveStateByPanel[panel.id]
    const isBusy = savingPanels.has(panel.id)
      || deletingPanelIds.has(panel.id)
      || modifyingPanels.has(panel.id)
      || saveState?.status === 'saving'
      || isPanelTaskRunning(panel)
      || Boolean(getPanelCandidates(panel as unknown as NovelPromotionPanel))
    const isEditing = activeEditPanelId === panel.id
      || hasUnsavedByPanel.has(panel.id)
      || saveState?.status === 'error'
    return isBusy || isEditing ? [index] : []
  })

  return (
    <VirtualCardRange
      items={displayedPanels}
      getKey={(panel, index) => panel.id || String(index)}
      estimatedCardHeight={760}
      estimatedRowHeight={776}
      overscan={1}
      pinnedIndices={pinnedPanelIndices}
      className={`grid gap-4 ${panelColumnsClass} ${isSubmittingStoryboardTextTask ? 'opacity-50 pointer-events-none' : ''}`}
      cardClassName="relative group/panel h-full"
      cardStyle={(_panel, index) => ({ zIndex: displayedPanels.length - index })}
      renderCard={(panel, index) => {
        const imageUrl = displayImages[index]
        const globalPanelNumber = storyboardStartIndex + index + 1
        const isPanelModifying =
          modifyingPanels.has(panel.id) ||
          Boolean(
            (panel as StoryboardPanel & { imageTaskRunning?: boolean; imageTaskIntent?: string }).imageTaskRunning &&
            (panel as StoryboardPanel & { imageTaskIntent?: string }).imageTaskIntent === 'modify',
          )
        const isPanelDeleting = deletingPanelIds.has(panel.id)
        const panelSaveState = saveStateByPanel[panel.id]
        const isPanelSaving = savingPanels.has(panel.id) || panelSaveState?.status === 'saving'
        const hasUnsavedChanges = hasUnsavedByPanel.has(panel.id) || panelSaveState?.status === 'error'
        const panelSaveError = panelSaveState?.errorMessage || null
        const panelTaskRunning = isPanelTaskRunning(panel)
        const taskError = panelTaskErrorMap.get(panel.id)
        const panelFailedError = taskError?.message || null
        const panelData = getPanelEditData(panel)
        const panelCandidateData = getPanelCandidates(panel as unknown as NovelPromotionPanel)

        return (
          <PanelCard
              projectId={projectId}
              episodeId={episodeId}
              panel={panel}
              panelData={panelData}
              imageUrl={imageUrl}
              globalPanelNumber={globalPanelNumber}
              storyboardId={storyboard.id}
              videoRatio={videoRatio}
              isSaving={isPanelSaving}
              hasUnsavedChanges={hasUnsavedChanges}
              saveErrorMessage={panelSaveError}
              isDeleting={isPanelDeleting}
              isModifying={isPanelModifying}
              isSubmittingPanelImageTask={panelTaskRunning}
              failedError={panelFailedError}
              candidateData={panelCandidateData}
              onUpdate={(updates) => {
                setActiveEditPanelId(panel.id)
                onPanelUpdate(panel.id, panel, updates)
              }}
              onDelete={gridSpec ? undefined : () => onPanelDelete(panel.id)}
              onOpenCharacterPicker={() => onOpenCharacterPicker(panel.id)}
              onOpenLocationPicker={() => onOpenLocationPicker(panel.id)}
              onRetrySave={() => onRetryPanelSave(panel.id)}
              onRemoveCharacter={(characterIndex) => onRemoveCharacter(panel, characterIndex)}
              onRemoveLocation={() => onRemoveLocation(panel)}
              onRegeneratePanelImage={onRegeneratePanelImage}
              onOpenEditModal={() => {
                setActiveEditPanelId(panel.id)
                onOpenEditModal(index)
              }}
              onOpenAIDataModal={() => {
                setActiveEditPanelId(panel.id)
                onOpenAIDataModal(index)
              }}
              onSelectCandidateIndex={onSelectPanelCandidateIndex}
              onConfirmCandidate={onConfirmPanelCandidate}
              onCancelCandidate={onCancelPanelCandidate}
              onClearError={() => onClearPanelTaskError(panel.id)}
              onPreviewImage={onPreviewImage}
              onInsertAfter={gridSpec ? undefined : () => onInsertAfter(index)}
              onVariant={gridSpec ? undefined : () => onVariant(index)}
              isInsertDisabled={isInsertDisabled(panel.id)}
              previousImageUrl={panel.previousImageUrl}
              allowIndividualImageGeneration={!gridSpec}
              sixGridActions={isGridStoryboardMode(storyboard.layoutMode) ? {
                previousUrl: panel.previousImageUrl,
                isBusy: isSixGridPanelBusy(
                  sixGridTaskPanelId,
                  panel.id,
                  Boolean((panel as StoryboardPanel & { imageTaskRunning?: boolean }).imageTaskRunning),
                  isSixGridTaskRunning,
                ),
                canUpscale: Boolean(
                  sixGridUpscaleWorkflow
                  && storyboard.sixGridProcessingOrder === 'crop_then_panel_upscale'
                  && panel.croppedImageUrl
                  && panel.imageUrl === panel.croppedImageUrl,
                ),
                onRecrop: () => onOpenSixGridCrop(panel.gridCellIndex ?? index),
                onUpscale: () => { if (sixGridUpscaleWorkflow) void onUpscaleSixGridPanel(panel.id, sixGridUpscaleWorkflow) },
                onUndo: panel.previousImageUrl && panel.imageMediaId && panel.previousImageMediaId
                  ? () => void onUndoSixGridPanel(panel.id, panel.imageMediaId!, panel.previousImageMediaId!)
                  : undefined,
              } : undefined}
          />
        )
      }}
    />
  )
}
