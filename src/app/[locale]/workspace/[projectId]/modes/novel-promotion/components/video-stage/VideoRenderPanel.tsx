import { getAspectRatioConfig } from '@/lib/constants'
import type { MutableRefObject } from 'react'
import type { CapabilitySelections, CapabilityValue } from '@/lib/model-config-contract'
import { VideoPanelCard, type VideoPanel, type VideoModelOption, type MatchedVoiceLine, type FirstLastFrameParams, type VideoGenerationOptions } from '../video'
import type { PromptField } from '@/lib/novel-promotion/stages/video-stage-runtime/useVideoPromptState'
import type { FrameLinkChoices } from '@/lib/novel-promotion/video/frame-link-resolver'
import { VirtualCardRange } from '@/components/virtualization/VirtualCardRange'

interface VideoRenderPanelProps {
  allPanels: VideoPanel[]
  linkedPanels: Map<string, boolean>
  highlightedPanelKey: string | null
  panelRefs: MutableRefObject<Map<string, HTMLDivElement>>
  videoRatio: string
  defaultVideoModel: string
  dialogueVideoModel?: string | null
  capabilityOverrides: CapabilitySelections
  userVideoModels?: VideoModelOption[]
  projectId: string
  episodeId: string
  runningVoiceLineIds: Set<string>
  panelVoiceLines: Map<string, MatchedVoiceLine[]>
  panelVideoPreference: Map<string, boolean>
  savingPrompts: Set<string>
  flModel: string
  flModelOptions: VideoModelOption[]
  flGenerationOptions: VideoGenerationOptions
  flCapabilityFields: Array<{
    field: string
    label: string
    options: CapabilityValue[]
    disabledOptions?: CapabilityValue[]
    value: CapabilityValue | undefined
  }>
  flMissingCapabilityFields: string[]
  flModelSupportsFirstLastFrame: boolean
  flCustomPrompts: Map<string, string>
  onGenerateVideo: (
    storyboardId: string,
    panelIndex: number,
    videoModel?: string,
    firstLastFrame?: FirstLastFrameParams,
    generationOptions?: VideoGenerationOptions,
    panelId?: string,
    submissionMeta?: {
      explicitVideoModel?: string
      durationOverride?: number | null
      expectedPanelUpdatedAt?: string
      referenceSubject?: boolean
    },
  ) => Promise<boolean>
  onUpdatePanelVideoModel: (storyboardId: string, panelIndex: number, model: string) => Promise<void>
  onLipSync: (storyboardId: string, panelIndex: number, voiceLineId: string, panelId?: string) => Promise<void>
  onToggleLink: (panelKey: string, storyboardId: string, panelIndex: number) => Promise<void>
  onUpdateFrameLink: (
    panelKey: string,
    storyboardId: string,
    panelIndex: number,
    input: { action: 'replace' | 'clear' | 'unlink' | 'restore-auto'; frame?: 'first' | 'last'; sourcePanelId?: string },
  ) => Promise<void>
  onFlModelChange: (model: string) => void
  onFlCapabilityChange: (field: string, rawValue: string) => void
  onFlCustomPromptChange: (key: string, value: string) => void
  onResetFlPrompt: (key: string) => void
  onGenerateFirstLastFrame: (
    firstStoryboardId: string,
    firstPanelIndex: number,
    lastStoryboardId: string,
    lastPanelIndex: number,
    panelKey: string,
    generationOptions?: VideoGenerationOptions,
    firstPanelId?: string,
  ) => Promise<void>
  onPreviewImage: (imageUrl: string | null) => void
  onToggleLipSyncVideo: (key: string, value: boolean) => void
  getNextPanel: (currentIndex: number) => VideoPanel | null
  getPreviousPanel: (currentIndex: number) => VideoPanel | null
  getFrameLinkChoices: (currentIndex: number) => FrameLinkChoices
  isLinkedAsLastFrame: (currentIndex: number) => boolean
  getDefaultFlPrompt: (firstPrompt?: string, lastPrompt?: string) => string
  getLocalPrompt: (panelKey: string, externalPrompt?: string, field?: PromptField) => string
  updateLocalPrompt: (panelKey: string, value: string, field?: PromptField) => void
  savePrompt: (
    storyboardId: string,
    panelIndex: number,
    panelKey: string,
    value: string,
    field?: PromptField,
  ) => Promise<void>
}

export default function VideoRenderPanel({
  allPanels,
  linkedPanels,
  highlightedPanelKey,
  panelRefs,
  videoRatio,
  defaultVideoModel,
  dialogueVideoModel,
  capabilityOverrides,
  userVideoModels,
  projectId,
  episodeId,
  runningVoiceLineIds,
  panelVoiceLines,
  panelVideoPreference,
  savingPrompts,
  flModel,
  flModelOptions,
  flGenerationOptions,
  flCapabilityFields,
  flMissingCapabilityFields,
  flModelSupportsFirstLastFrame,
  flCustomPrompts,
  onGenerateVideo,
  onUpdatePanelVideoModel,
  onLipSync,
  onToggleLink,
  onUpdateFrameLink,
  onFlModelChange,
  onFlCapabilityChange,
  onFlCustomPromptChange,
  onResetFlPrompt,
  onGenerateFirstLastFrame,
  onPreviewImage,
  onToggleLipSyncVideo,
  getNextPanel,
  getPreviousPanel,
  getFrameLinkChoices,
  isLinkedAsLastFrame,
  getDefaultFlPrompt,
  getLocalPrompt,
  updateLocalPrompt,
  savePrompt,
}: VideoRenderPanelProps) {
  const pinnedPanelIndices = allPanels.flatMap((panel, index) => {
    const panelKey = `${panel.storyboardId}-${panel.panelIndex}`
    const hasRunningVoice = (panelVoiceLines.get(panelKey) || []).some((line) => runningVoiceLineIds.has(line.id))
    const isSavingPrompt = savingPrompts.has(`videoPrompt:${panelKey}`)
      || savingPrompts.has(`firstLastFramePrompt:${panelKey}`)
    return highlightedPanelKey === panelKey
      || panel.videoTaskRunning
      || panel.lipSyncTaskRunning
      || hasRunningVoice
      || isSavingPrompt
      ? [index]
      : []
  })

  return (
    <VirtualCardRange
      items={allPanels}
      getKey={(panel) => `${panel.storyboardId}-${panel.panelIndex}`}
      estimatedCardHeight={720}
      estimatedRowHeight={736}
      overscan={1}
      pinnedIndices={pinnedPanelIndices}
      className={`grid gap-4 ${getAspectRatioConfig(videoRatio).isVertical
        ? 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5'
        : 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3'
      }`}
      onItemElement={(panel, _index, element) => {
        const panelKey = `${panel.storyboardId}-${panel.panelIndex}`
        if (element) panelRefs.current.set(panelKey, element)
        else panelRefs.current.delete(panelKey)
      }}
      cardClassName={(panel) => {
        const panelKey = `${panel.storyboardId}-${panel.panelIndex}`
        return `transition-all duration-500 ${highlightedPanelKey === panelKey
          ? 'ring-4 ring-[var(--glass-stroke-focus)] ring-offset-2 ring-offset-[var(--glass-bg-canvas)] rounded-2xl scale-[1.02]'
          : ''
        }`
      }}
      renderCard={(panel, idx) => {
          const panelKey = `${panel.storyboardId}-${panel.panelIndex}`
          const isLinked = linkedPanels.get(panelKey) || false
          const isLastFrame = isLinkedAsLastFrame(idx)
          const nextPanel = getNextPanel(idx)
          const frameLinkChoices = getFrameLinkChoices(idx)
          const prevPanel = getPreviousPanel(idx)
          const hasNext = !!nextPanel
          const promptField: PromptField = isLinked ? 'firstLastFramePrompt' : 'videoPrompt'
          const defaultFlPrompt = getDefaultFlPrompt(panel.textPanel?.video_prompt, nextPanel?.textPanel?.video_prompt)
          const externalPrompt = isLinked
            ? (panel.firstLastFramePrompt || defaultFlPrompt)
            : panel.textPanel?.video_prompt
          const localPrompt = getLocalPrompt(panelKey, externalPrompt, promptField)
          const isSavingPrompt = savingPrompts.has(`${promptField}:${panelKey}`)

          return (
            <VideoPanelCard
                panel={{
                  ...panel,
                  lipSyncTaskRunning: panel.lipSyncTaskRunning || false,
                }}
                panelIndex={idx}
                defaultVideoModel={defaultVideoModel}
                dialogueVideoModel={dialogueVideoModel}
                capabilityOverrides={capabilityOverrides}
                videoRatio={videoRatio}
                userVideoModels={userVideoModels}
                projectId={projectId}
                episodeId={episodeId}
                runningVoiceLineIds={runningVoiceLineIds}
                matchedVoiceLines={panelVoiceLines.get(panelKey) || []}
                onLipSync={onLipSync}
                showLipSyncVideo={panelVideoPreference.get(panelKey) ?? true}
                onToggleLipSyncVideo={onToggleLipSyncVideo}
                isLinked={isLinked}
                isLastFrame={isLastFrame}
                nextPanel={nextPanel}
                prevPanel={prevPanel}
                hasNext={hasNext}
                flModel={flModel}
                flModelOptions={flModelOptions}
                flGenerationOptions={flGenerationOptions}
                flCapabilityFields={flCapabilityFields}
                flMissingCapabilityFields={flMissingCapabilityFields}
                flModelSupportsFirstLastFrame={flModelSupportsFirstLastFrame}
                frameLinkChoices={frameLinkChoices}
                flCustomPrompt={flCustomPrompts.get(panelKey) || panel.firstLastFramePrompt || ''}
                defaultFlPrompt={defaultFlPrompt}
                localPrompt={localPrompt}
                isSavingPrompt={isSavingPrompt}
                onUpdateLocalPrompt={(value) => {
                  updateLocalPrompt(panelKey, value, promptField)
                  if (isLinked) onFlCustomPromptChange(panelKey, value)
                }}
                onSavePrompt={(value) => savePrompt(panel.storyboardId, panel.panelIndex, panelKey, value, promptField)}
                onGenerateVideo={onGenerateVideo}
                onUpdatePanelVideoModel={onUpdatePanelVideoModel}
                onToggleLink={onToggleLink}
                onUpdateFrameLink={onUpdateFrameLink}
                onFlModelChange={onFlModelChange}
                onFlCapabilityChange={onFlCapabilityChange}
                onFlCustomPromptChange={onFlCustomPromptChange}
                onResetFlPrompt={onResetFlPrompt}
                onGenerateFirstLastFrame={onGenerateFirstLastFrame}
                onPreviewImage={onPreviewImage}
            />
          )
      }}
    />
  )
}
