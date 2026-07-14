'use client'
import { useTranslations } from 'next-intl'
import { useMemo, useState } from 'react'
import './ImageSection.css'
import { GlassButton } from '@/components/ui/primitives'
import { MediaImageWithLoading } from '@/components/media/MediaImageWithLoading'
import TaskStatusOverlay from '@/components/task/TaskStatusOverlay'
import { resolveTaskPresentationState } from '@/lib/task/presentation'
import type { TaskPresentationState } from '@/lib/task/presentation'
import ImageSectionCandidateMode from './ImageSectionCandidateMode'
import ImageSectionActionButtons from './ImageSectionActionButtons'
import { AppIcon } from '@/components/ui/icons'
import { ModelCapabilityDropdown } from '@/components/ui/config-modals/ModelCapabilityDropdown'
import { applyImageTaskCapabilityChange, extractCapabilityFields } from '@/lib/model-capabilities/ui-fields'
import type { ImageTaskCapabilityOverrides } from '@/lib/model-config-contract'
import { useWorkspaceData } from '../../WorkspaceDataProvider'
import { getAspectRatioConfig } from '@/lib/constants'
import { useVirtualCardRetention } from '@/components/virtualization/VirtualCardRange'

interface PanelCandidateData {
  candidates: string[]
  selectedIndex: number
}

interface ImageSectionProps {
  panelId: string
  imageUrl: string | null
  globalPanelNumber: number
  shotType: string
  videoRatio: string
  isDeleting: boolean
  isModifying: boolean
  isSubmittingPanelImageTask: boolean
  failedError: string | null
  candidateData: PanelCandidateData | null
  previousImageUrl?: string | null
  taskPresentationState?: TaskPresentationState | null
  onRegeneratePanelImage: (panelId: string, count?: number, force?: boolean, imageModel?: string, generationOptions?: ImageTaskCapabilityOverrides) => Promise<boolean>
  onOpenEditModal: () => void
  onOpenAIDataModal: () => void
  onSelectCandidateIndex: (panelId: string, index: number) => void
  onConfirmCandidate: (panelId: string, imageUrl: string) => Promise<void>
  onCancelCandidate: (panelId: string) => void
  onClearError: () => void
  onUndo?: (panelId: string) => void
  onPreviewImage?: (url: string) => void
}

export default function ImageSection({
  panelId,
  imageUrl,
  globalPanelNumber,
  shotType,
  videoRatio,
  isDeleting,
  isModifying,
  isSubmittingPanelImageTask,
  failedError,
  candidateData,
  previousImageUrl,
  taskPresentationState,
  onRegeneratePanelImage,
  onOpenEditModal,
  onOpenAIDataModal,
  onSelectCandidateIndex,
  onConfirmCandidate,
  onCancelCandidate,
  onClearError,
  onUndo,
  onPreviewImage,
}: ImageSectionProps) {
  const t = useTranslations('storyboard')
  const tc = useTranslations('comfyui.workflows')
  const [isTaskPulseAnimating, setIsTaskPulseAnimating] = useState(false)
  const [selectedImageModel, setSelectedImageModel] = useState('')
  const [capabilityOverrides, setCapabilityOverrides] = useState<ImageTaskCapabilityOverrides>({})
  useVirtualCardRetention(
    selectedImageModel !== '' || Object.keys(capabilityOverrides).length > 0,
  )
  const { imageModelOptions: taskImageOptions } = useWorkspaceData()
  const selectedImageOption = taskImageOptions.find((option) => option.value === selectedImageModel)
  const capabilityFields = useMemo(
    () => extractCapabilityFields(selectedImageOption?.capabilities, 'image'),
    [selectedImageOption],
  )
  const taskCapabilityOverrides = selectedImageModel && Object.keys(capabilityOverrides).length > 0
    ? capabilityOverrides
    : undefined
  const cssAspectRatio = videoRatio.replace(':', '/')
  const thumbnailSizes = getAspectRatioConfig(videoRatio).isVertical ? '20vw' : '33vw'
  const hasValidCandidates = !!candidateData && candidateData.candidates.some((url) => !url.startsWith('PENDING:'))

  const triggerPulse = () => {
    setIsTaskPulseAnimating(true)
    setTimeout(() => setIsTaskPulseAnimating(false), 600)
  }
  const handleRegeneratePanelImage = async (
    id: string,
    count?: number,
    force?: boolean,
  ) => {
    const accepted = await onRegeneratePanelImage(
      id,
      count,
      force,
      selectedImageModel || undefined,
      taskCapabilityOverrides,
    )
    if (accepted) {
      setSelectedImageModel('')
      setCapabilityOverrides({})
    }
  }

  const renderLoadingState = (
    intent: 'generate' | 'regenerate' | 'modify' | 'process',
    backdropImageUrl: string | null = null,
  ) => {
    const state = resolveTaskPresentationState({
      phase: 'processing',
      intent,
      resource: 'image',
      hasOutput: !!backdropImageUrl,
    })

    return (
      <div className="relative flex h-full w-full items-center justify-center overflow-hidden bg-[var(--glass-bg-surface-modal)] backdrop-blur-md group/loading">
        {backdropImageUrl && (
          <MediaImageWithLoading
            src={backdropImageUrl}
            alt={t('image.clickToPreview')}
            containerClassName="absolute inset-0 h-full w-full"
            className="absolute inset-0 h-full w-full object-cover"
            sizes={thumbnailSizes}
          />
        )}
        <div className={`absolute inset-0 ${backdropImageUrl ? 'bg-black/45 backdrop-blur-[1px]' : 'bg-[var(--glass-bg-surface-modal)] backdrop-blur-md'}`} />
        <TaskStatusOverlay
          state={taskPresentationState ?? state}
          className={backdropImageUrl ? 'bg-black/45 backdrop-blur-[1px]' : undefined}
        />
      </div>
    )
  }

  const renderFailedState = () => (
    <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-[var(--glass-danger-ring)] text-[var(--glass-tone-danger-fg)] p-2">
      <AppIcon name="alert" className="w-6 h-6 mb-1" />
      <span className="text-xs text-center font-medium">{t('image.failed')}</span>
      <span className="text-[10px] text-center mt-1 line-clamp-2 px-1">{failedError}</span>
      <button
        onClick={onClearError}
        className="glass-btn-base glass-btn-tone-danger mt-1 px-2 py-1 text-[10px] rounded-md"
      >
        {t('variant.close')}
      </button>
    </div>
  )

  const renderEmptyState = () => (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-[var(--glass-bg-surface-strong)] text-[var(--glass-text-tertiary)]">
      <AppIcon name="imagePreview" className="w-8 h-8" />
      <span className="text-xs">{t('video.toolbar.showPending')}</span>
      <GlassButton
        variant="primary"
        size="sm"
        onClick={() => {
          triggerPulse()
          void handleRegeneratePanelImage(panelId, 1, false)
        }}
      >
        {t('panel.generateImage')}
      </GlassButton>
    </div>
  )

  return (
    <div
      className={`relative overflow-hidden group rounded-t-2xl transition-all bg-[var(--glass-bg-muted)] ${isTaskPulseAnimating ? 'animate-brightness-boost' : ''}`}
      style={{ aspectRatio: cssAspectRatio }}
    >
      {isDeleting ? (
        renderLoadingState('process', imageUrl)
      ) : isModifying ? (
        renderLoadingState('modify', imageUrl)
      ) : isSubmittingPanelImageTask ? (
        renderLoadingState('regenerate', imageUrl)
      ) : candidateData ? (
        hasValidCandidates ? (
          <ImageSectionCandidateMode
            panelId={panelId}
            imageUrl={imageUrl}
            candidateData={candidateData}
            onSelectCandidateIndex={onSelectCandidateIndex}
            onConfirmCandidate={onConfirmCandidate}
            onCancelCandidate={onCancelCandidate}
            onPreviewImage={onPreviewImage}
          />
        ) : (
          renderLoadingState(imageUrl ? 'regenerate' : 'generate', imageUrl)
        )
      ) : failedError ? (
        renderFailedState()
      ) : imageUrl ? (
        <MediaImageWithLoading
          src={imageUrl}
          alt={t('variant.shotNum', { number: globalPanelNumber })}
          containerClassName="h-full w-full"
          className={`w-full h-full object-cover ${onPreviewImage ? 'cursor-zoom-in' : ''}`}
          onClick={onPreviewImage ? () => onPreviewImage(imageUrl) : undefined}
          title={onPreviewImage ? t('image.clickToPreview') : undefined}
          sizes={thumbnailSizes}
        />
      ) : (
        renderEmptyState()
      )}

      <div className="absolute top-2 left-2">
        <span className="glass-chip glass-chip-neutral px-2 py-0.5 text-xs font-medium">{globalPanelNumber}</span>
      </div>

      <div className="absolute top-2 right-2">
        <span className="glass-chip glass-chip-info px-2 py-0.5 text-xs">{shotType}</span>
      </div>

      {!candidateData && (
        <>
        <div className="absolute bottom-2 left-2 z-20 w-[55%] min-w-0 text-[10px] text-white">
          <span className="sr-only">{tc('taskImageWorkflow')}</span>
          <ModelCapabilityDropdown
            compact
            placementMode="auto"
            models={taskImageOptions}
            value={selectedImageModel || undefined}
            onModelChange={(model) => { setSelectedImageModel(model); setCapabilityOverrides({}) }}
            capabilityFields={capabilityFields}
            capabilityOverrides={capabilityOverrides}
            onCapabilityChange={(field, rawValue, sample) => setCapabilityOverrides((current) =>
              applyImageTaskCapabilityChange(current, field, rawValue, sample))}
            placeholder={tc('inheritProjectDefault')}
          />
        </div>
        <ImageSectionActionButtons
          panelId={panelId}
          imageUrl={imageUrl}
          previousImageUrl={previousImageUrl}
          isSubmittingPanelImageTask={isSubmittingPanelImageTask}
          isModifying={isModifying}
          onRegeneratePanelImage={handleRegeneratePanelImage}
          onOpenEditModal={onOpenEditModal}
          onOpenAIDataModal={onOpenAIDataModal}
          onUndo={onUndo}
          triggerPulse={triggerPulse}
         />
        </>
      )}
    </div>
  )
}
