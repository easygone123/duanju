'use client'
import { useTranslations } from 'next-intl'

import { useCallback, useEffect, useMemo, useState } from 'react'
import ScreenplayDisplay from './ScreenplayDisplay'
import { StoryboardPanel } from './hooks/useStoryboardState'
import StoryboardGroupHeader from './StoryboardGroupHeader'
import StoryboardGroupActions from './StoryboardGroupActions'
import StoryboardPanelList from './StoryboardPanelList'
import { resolveTaskPresentationState } from '@/lib/task/presentation'
import TaskStatusOverlay from '@/components/task/TaskStatusOverlay'
import { useStoryboardGroupTaskErrors } from './hooks/useStoryboardGroupTaskErrors'
import { useStoryboardInsertVariantRuntime } from './hooks/useStoryboardInsertVariantRuntime'
import StoryboardGroupFailedAlert from './StoryboardGroupFailedAlert'
import StoryboardGroupDialogs from './StoryboardGroupDialogs'
import type { StoryboardGroupProps } from './StoryboardGroup.types'
import { AppIcon } from '@/components/ui/icons'
import type { ImageTaskCapabilityOverrides } from '@/lib/model-config-contract'
import GridGroupControls from './GridGroupControls'
import GridCropModal from './GridCropModal'
import SixGridPromptModal from './SixGridPromptModal'
import SixGridUploadModal from './SixGridUploadModal'
import { isGridGroupBusy } from '@/lib/query/hooks/useSixGridStoryboard'
import { useVirtualCardRetention } from '@/components/virtualization/VirtualCardRange'
import { isGridStoryboardMode } from '@/lib/novel-promotion/grid-storyboard/spec'

type GridUploadSession = {
  storyboardId: string
  expectedSheetArtifactVersion: number
  cellRatio: '16:9' | '9:16'
}

export default function StoryboardGroup({
  storyboard,
  clip,
  sbIndex,
  totalStoryboards,
  textPanels,
  storyboardStartIndex,
  videoRatio,
  isExpanded,
  isSubmittingStoryboardTask,
  isSelectingCandidate,
  isSubmittingStoryboardTextTask,
  hasAnyImage,
  failedError,
  savingPanels,
  deletingPanelIds,
  saveStateByPanel,
  hasUnsavedByPanel,
  modifyingPanels,
  submittingPanelImageIds,
  onToggleExpand,
  onMoveUp,
  onMoveDown,
  onRegenerateText,
  onAddPanel,
  onDeleteStoryboard,
  onGenerateAllIndividually,
  onPreviewImage,
  onCloseError,
  getPanelEditData,
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
  getPanelCandidates,
  onSelectPanelCandidateIndex,
  onConfirmPanelCandidate,
  onCancelPanelCandidate,
  formatClipTitle,
  movingClipId,
  onInsertPanel,
  insertingAfterPanelId,
  projectId,
  episodeId,
  onPanelVariant,
  submittingVariantPanelId,
  sixGridUpscaleWorkflow,
  isSixGridTaskRunning,
  sixGridTaskPanelId,
  sixGridGenerationError,
  onGenerateSixGridSheet,
  onUpscaleSixGridSheet,
  onCropSixGridSheet,
  onUploadSixGridSheet,
  onUpscaleSixGridPanel,
  onUndoSixGridPanel,
}: StoryboardGroupProps) {
  const t = useTranslations('storyboard')
  const [cropCellIndex, setCropCellIndex] = useState<number | null>(null)
  const [promptModalOpen, setPromptModalOpen] = useState(false)
  const [uploadSession, setUploadSession] = useState<GridUploadSession | null>(null)
  const isGridGroupTaskRunning = isGridGroupBusy(isSixGridTaskRunning, Boolean(storyboard.gridTaskRunning))
  const sixGridCellRatio = storyboard.sixGridCellAspectRatio === '9:16' ? '9:16' : '16:9'

  useEffect(() => {
    setUploadSession((current) => current && current.storyboardId !== storyboard.id ? null : current)
  }, [storyboard.id])

  const {
    insertModalOpen,
    insertAfterPanel,
    nextPanelForInsert,
    variantModalPanel,
    handleOpenInsertModal,
    handleCloseInsertModal,
    handleInsert,
    handleOpenVariantModal,
    handleCloseVariantModal,
    handleVariant,
  } = useStoryboardInsertVariantRuntime({
    storyboardId: storyboard.id,
    textPanels,
    onInsertPanel,
    onPanelVariant,
  })
  useVirtualCardRetention(
    insertModalOpen
      || variantModalPanel !== null
      || cropCellIndex !== null
      || promptModalOpen
      || uploadSession !== null,
  )

  const {
    panelTaskErrorMap,
    clearPanelTaskError,
  } = useStoryboardGroupTaskErrors({
    projectId,
    episodeId,
  })

  const isPanelTaskRunning = useCallback(
    (panel: StoryboardPanel) => {
      const taskIntent = (panel as StoryboardPanel & { imageTaskIntent?: string }).imageTaskIntent
      if (taskIntent === 'modify') return false

      const isTaskRunning = Boolean((panel as StoryboardPanel & { imageTaskRunning?: boolean }).imageTaskRunning)
      const isSubmitting = submittingPanelImageIds.has(panel.id)
      if (isTaskRunning || isSubmitting) return true

      const taskError = panelTaskErrorMap.get(panel.id)
      if (taskError) return false

      return false
    },
    [panelTaskErrorMap, submittingPanelImageIds],
  )

  const currentRunningCount = textPanels.filter(isPanelTaskRunning).length
  const pendingCount = textPanels.filter((panel) => !panel.imageUrl && !isPanelTaskRunning(panel)).length
  const hasTextOutput = textPanels.length > 0

  const groupOverlayState = useMemo(() => {
    const isTextTaskRunning = isSubmittingStoryboardTask || isSubmittingStoryboardTextTask
    if (!isTextTaskRunning && !isSelectingCandidate) return null

    if (isSelectingCandidate) {
      return resolveTaskPresentationState({
        phase: 'processing',
        intent: 'process',
        resource: 'image',
        hasOutput: hasAnyImage,
      })
    }

    return resolveTaskPresentationState({
      phase: 'processing',
      intent: storyboard.storyboardTaskIntent ?? (isSubmittingStoryboardTextTask ? 'regenerate' : 'process'),
      resource: 'text',
      hasOutput: hasTextOutput,
    })
  }, [
    hasAnyImage,
    hasTextOutput,
    isSelectingCandidate,
    isSubmittingStoryboardTask,
    isSubmittingStoryboardTextTask,
    storyboard.storyboardTaskIntent,
  ])

  const handleRegeneratePanelImage = useCallback(
    (panelId: string, count?: number, force?: boolean, imageModel?: string, generationOptions?: ImageTaskCapabilityOverrides) => {
      clearPanelTaskError(panelId)
      return onRegeneratePanelImage(panelId, count, force, imageModel, generationOptions)
    },
    [clearPanelTaskError, onRegeneratePanelImage],
  )

  return (
    <div className={`glass-surface-elevated p-6 relative ${failedError ? 'border-2 border-[var(--glass-stroke-danger)] bg-[var(--glass-danger-ring)]' : ''}`}>
      {failedError && (
        <StoryboardGroupFailedAlert
          failedError={failedError}
          title={`警告 ${t('group.failed')}`}
          closeTitle={t('common.cancel')}
          onClose={onCloseError}
        />
      )}

      {groupOverlayState && (
        <TaskStatusOverlay
          state={groupOverlayState}
          className="z-10 rounded-lg bg-[var(--glass-bg-surface-modal)]/90"
        />
      )}

      <div className="mb-4 pb-2 flex items-start justify-between">
        <StoryboardGroupHeader
          clip={clip}
          sbIndex={sbIndex}
          totalStoryboards={totalStoryboards}
          movingClipId={movingClipId}
          storyboardClipId={storyboard.clipId}
          formatClipTitle={formatClipTitle}
          onMoveUp={onMoveUp}
          onMoveDown={onMoveDown}
        />
        <StoryboardGroupActions
          hasAnyImage={hasAnyImage}
          isSubmittingStoryboardTask={isSubmittingStoryboardTask}
          isSubmittingStoryboardTextTask={isSubmittingStoryboardTextTask}
          currentRunningCount={currentRunningCount}
          pendingCount={pendingCount}
          isGridLayout={isGridStoryboardMode(storyboard.layoutMode)}
          onRegenerateText={onRegenerateText}
          onGenerateAllIndividually={onGenerateAllIndividually}
          onAddPanel={onAddPanel}
          onDeleteStoryboard={onDeleteStoryboard}
        />
      </div>

      <GridGroupControls
        storyboard={storyboard}
        isTaskRunning={isGridGroupTaskRunning}
        upscaleWorkflow={sixGridUpscaleWorkflow}
        generationError={sixGridGenerationError}
        onGenerateSheet={onGenerateSixGridSheet}
        onPreviewSheet={onPreviewImage}
        onUpscaleSheet={onUpscaleSixGridSheet}
        onOpenCrop={() => setCropCellIndex(0)}
        onViewPrompt={() => setPromptModalOpen(true)}
        onUploadSheet={() => setUploadSession({
          storyboardId: storyboard.id,
          expectedSheetArtifactVersion: storyboard.sheetArtifactVersion ?? 0,
          cellRatio: sixGridCellRatio,
        })}
      />

      {clip && (
        <div className="mb-4">
          <button
            onClick={onToggleExpand}
            className="glass-btn-base glass-btn-soft rounded-xl px-3 py-2 text-sm"
          >
            <AppIcon name="chevronRightMd" className={`h-4 w-4 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
            <span>{clip.screenplay ? t('panel.stylePrompt') : t('panel.sourceText')}</span>
          </button>
          {isExpanded && (
            <div className="mt-2 glass-surface-soft p-2">
              {clip.screenplay ? (
                <ScreenplayDisplay screenplay={clip.screenplay} originalContent={clip.content} />
              ) : (
                <div className="whitespace-pre-wrap p-3 text-sm text-[var(--glass-text-secondary)]">
                  {clip.content}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <StoryboardPanelList
        projectId={projectId}
        episodeId={episodeId}
        storyboard={storyboard}
        textPanels={textPanels}
        storyboardStartIndex={storyboardStartIndex}
        videoRatio={videoRatio}
        isSubmittingStoryboardTextTask={isSubmittingStoryboardTextTask}
        savingPanels={savingPanels}
        deletingPanelIds={deletingPanelIds}
        saveStateByPanel={saveStateByPanel}
        hasUnsavedByPanel={hasUnsavedByPanel}
        modifyingPanels={modifyingPanels}
        panelTaskErrorMap={panelTaskErrorMap}
        isPanelTaskRunning={isPanelTaskRunning}
        getPanelEditData={getPanelEditData}
        getPanelCandidates={getPanelCandidates}
        onPanelUpdate={onPanelUpdate}
        onPanelDelete={onPanelDelete}
        onOpenCharacterPicker={onOpenCharacterPicker}
        onOpenLocationPicker={onOpenLocationPicker}
        onRemoveCharacter={onRemoveCharacter}
        onRemoveLocation={onRemoveLocation}
        onRetryPanelSave={onRetryPanelSave}
        onRegeneratePanelImage={handleRegeneratePanelImage}
        onOpenEditModal={onOpenEditModal}
        onOpenAIDataModal={onOpenAIDataModal}
        onSelectPanelCandidateIndex={onSelectPanelCandidateIndex}
        onConfirmPanelCandidate={onConfirmPanelCandidate}
        onCancelPanelCandidate={onCancelPanelCandidate}
        onClearPanelTaskError={clearPanelTaskError}
        onPreviewImage={onPreviewImage}
        onInsertAfter={handleOpenInsertModal}
        onVariant={handleOpenVariantModal}
        isInsertDisabled={(panelId) =>
          isSubmittingStoryboardTextTask ||
          insertingAfterPanelId === panelId ||
          submittingVariantPanelId === panelId
        }
        sixGridUpscaleWorkflow={sixGridUpscaleWorkflow}
        sixGridTaskPanelId={sixGridTaskPanelId}
        isSixGridTaskRunning={isGridGroupTaskRunning}
        onOpenSixGridCrop={setCropCellIndex}
        onUpscaleSixGridPanel={onUpscaleSixGridPanel}
        onUndoSixGridPanel={onUndoSixGridPanel}
      />

      <StoryboardGroupDialogs
        insertAfterPanel={insertAfterPanel}
        nextPanelForInsert={nextPanelForInsert}
        insertModalOpen={insertModalOpen}
        insertingAfterPanelId={insertingAfterPanelId}
        onCloseInsertModal={handleCloseInsertModal}
        onInsert={handleInsert}
        variantModalPanel={variantModalPanel}
        projectId={projectId}
        submittingVariantPanelId={submittingVariantPanelId}
        onCloseVariantModal={handleCloseVariantModal}
        onVariant={handleVariant}
      />
      <GridCropModal
        isOpen={cropCellIndex !== null}
        storyboard={storyboard}
        initialCellIndex={cropCellIndex || 0}
        onClose={() => setCropCellIndex(null)}
        onSubmit={async (cropRects) => { await onCropSixGridSheet(cropRects) }}
      />
      <SixGridPromptModal
        open={promptModalOpen}
        onClose={() => setPromptModalOpen(false)}
        prompt={storyboard.sheetPromptSnapshot}
        groupSequence={storyboard.groupSequence}
        cellRatio={sixGridCellRatio}
        mode={isGridStoryboardMode(storyboard.layoutMode) ? storyboard.layoutMode : 'six_grid'}
      />
      <SixGridUploadModal
        open={uploadSession !== null}
        onClose={() => setUploadSession(null)}
        cellRatio={uploadSession?.cellRatio ?? sixGridCellRatio}
        expectedSheetArtifactVersion={uploadSession?.expectedSheetArtifactVersion ?? 0}
        mode={isGridStoryboardMode(storyboard.layoutMode) ? storyboard.layoutMode : 'six_grid'}
        onSubmit={onUploadSixGridSheet}
      />
    </div>
  )
}
