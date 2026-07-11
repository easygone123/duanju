'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { apiFetch } from '@/lib/api-fetch'
import { CapsuleNav, EpisodeSelector } from '@/components/ui/CapsuleNav'
import { SettingsModal, WorldContextModal } from '@/components/ui/ConfigModals'
import WorkspaceTopActions from './WorkspaceTopActions'
import type { NovelPromotionPanel } from '@/types/project'
import type { CapabilitySelections, ModelCapabilities } from '@/lib/model-config-contract'
import { resolveEpisodeStageArtifacts } from '@/lib/novel-promotion/stage-readiness'

interface EpisodeSummary {
  id: string
  name: string
  episodeNumber?: number
  description?: string | null
  clips?: unknown[]
  storyboards?: Array<{
    panels?: NovelPromotionPanel[] | null
  }>
}

interface UserModelOption {
  value: string
  label: string
  provider?: string
  providerName?: string
  capabilities?: ModelCapabilities
}

interface UserModelsPayload {
  llm: UserModelOption[]
  image: UserModelOption[]
  video: UserModelOption[]
  audio: UserModelOption[]
}

interface WorkspaceHeaderShellProps {
  isSettingsModalOpen: boolean
  isWorldContextModalOpen: boolean
  onCloseSettingsModal: () => void
  onCloseWorldContextModal: () => void
  availableModels?: UserModelsPayload
  modelsLoaded: boolean
  artStyle: string | null | undefined
  analysisModel: string | null | undefined
  characterModel: string | null | undefined
  locationModel: string | null | undefined
  storyboardModel: string | null | undefined
  editModel: string | null | undefined
  videoModel: string | null | undefined
  audioModel: string | null | undefined
  capabilityOverrides: CapabilitySelections
  videoRatio: string | null | undefined
  ttsRate: string | null | undefined
  onUpdateConfig: (key: string, value: unknown) => Promise<void>
  globalAssetText: string
  projectName: string
  episodes: EpisodeSummary[]
  currentEpisodeId?: string
  onEpisodeSelect?: (episodeId: string) => void
  onEpisodeCreate?: () => void
  onEpisodeRename?: (episodeId: string, newName: string) => void
  onEpisodeDelete?: (episodeId: string) => void
  capsuleNavItems: Array<{
    id: string
    icon: string
    label: string
    status: 'empty' | 'active' | 'processing' | 'ready'
    disabled?: boolean
    disabledLabel?: string
  }>
  currentStage: string
  onStageChange: (stage: string) => void
  projectId: string
  episodeId?: string
  onOpenAssetLibrary: () => void
  onOpenSettingsModal: () => void
  onRefresh: () => void
  assetLibraryLabel: string
  settingsLabel: string
  refreshTitle: string
}

interface DefaultWorkflowOption {
  id: string
  name: string
  mediaType: 'image' | 'video'
  status: string
  currentVersion?: { lastSuccessfulTestAt?: string | null } | null
}

function ProjectComfyDefaults({ projectId, onUpdateConfig }: Pick<WorkspaceHeaderShellProps, 'projectId' | 'onUpdateConfig'>) {
  const t = useTranslations('comfyui.workflows')
  const [workflows, setWorkflows] = useState<DefaultWorkflowOption[]>([])
  const [comfyImageWorkflowId, setComfyImageWorkflowId] = useState('')
  const [comfyVideoWorkflowId, setComfyVideoWorkflowId] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    Promise.all([
      apiFetch('/api/comfyui/workflows', { signal: controller.signal }),
      apiFetch(`/api/novel-promotion/${encodeURIComponent(projectId)}`, { signal: controller.signal }),
    ]).then(async ([workflowResponse, projectResponse]) => {
      if (!workflowResponse.ok || !projectResponse.ok) return
      const workflowPayload = await workflowResponse.json() as { workflows?: DefaultWorkflowOption[] }
      const projectPayload = await projectResponse.json() as { comfyImageWorkflowId?: string | null; comfyVideoWorkflowId?: string | null }
      setWorkflows((workflowPayload.workflows ?? []).filter((workflow) => workflow.status === 'published' && !!workflow.currentVersion?.lastSuccessfulTestAt))
      setComfyImageWorkflowId(projectPayload.comfyImageWorkflowId ?? '')
      setComfyVideoWorkflowId(projectPayload.comfyVideoWorkflowId ?? '')
    }).catch(() => undefined)
    return () => controller.abort()
  }, [projectId])
  const selectClass = 'mt-1 w-full rounded-lg border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] px-3 py-2 text-sm'
  return <section aria-labelledby="project-comfy-defaults" className="mt-6 border-t border-[var(--glass-stroke-base)] pt-5">
    <h3 id="project-comfy-defaults" className="mb-3 text-sm font-semibold">{t('projectDefaults')}</h3>
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="text-sm">{t('defaultImageWorkflow')}<select className={selectClass} value={comfyImageWorkflowId} onChange={(event) => {
        const value = event.target.value; setComfyImageWorkflowId(value); void onUpdateConfig('comfyImageWorkflowId', value || null)
      }}><option value="">{t('noDefault')}</option>{workflows.filter((workflow) => workflow.mediaType === 'image').map((workflow) => <option key={workflow.id} value={workflow.id}>ComfyUI / {workflow.name}</option>)}</select></label>
      <label className="text-sm">{t('defaultVideoWorkflow')}<select className={selectClass} value={comfyVideoWorkflowId} onChange={(event) => {
        const value = event.target.value; setComfyVideoWorkflowId(value); void onUpdateConfig('comfyVideoWorkflowId', value || null)
      }}><option value="">{t('noDefault')}</option>{workflows.filter((workflow) => workflow.mediaType === 'video').map((workflow) => <option key={workflow.id} value={workflow.id}>ComfyUI / {workflow.name}</option>)}</select></label>
    </div>
    <p className="mt-2 text-xs text-[var(--glass-text-tertiary)]">{t('projectDefaultTestHint')}</p>
  </section>
}

export default function WorkspaceHeaderShell({
  isSettingsModalOpen,
  isWorldContextModalOpen,
  onCloseSettingsModal,
  onCloseWorldContextModal,
  availableModels,
  modelsLoaded,
  artStyle,
  analysisModel,
  characterModel,
  locationModel,
  storyboardModel,
  editModel,
  videoModel,
  audioModel,
  capabilityOverrides,
  videoRatio,
  ttsRate,
  onUpdateConfig,
  globalAssetText,
  projectName,
  episodes,
  currentEpisodeId,
  onEpisodeSelect,
  onEpisodeCreate,
  onEpisodeRename,
  onEpisodeDelete,
  capsuleNavItems,
  currentStage,
  onStageChange,
  projectId,
  episodeId,
  onOpenAssetLibrary,
  onOpenSettingsModal,
  onRefresh,
  assetLibraryLabel,
  settingsLabel,
  refreshTitle,
}: WorkspaceHeaderShellProps) {
  return (
    <>
      <SettingsModal
        isOpen={isSettingsModalOpen}
        onClose={onCloseSettingsModal}
        availableModels={availableModels}
        modelsLoaded={modelsLoaded}
        artStyle={artStyle ?? undefined}
        analysisModel={analysisModel ?? undefined}
        characterModel={characterModel ?? undefined}
        locationModel={locationModel ?? undefined}
        imageModel={storyboardModel ?? undefined}
        editModel={editModel ?? undefined}
        videoModel={videoModel ?? undefined}
        audioModel={audioModel ?? undefined}
        videoRatio={videoRatio ?? undefined}
        capabilityOverrides={capabilityOverrides}
        ttsRate={ttsRate ?? undefined}
        onArtStyleChange={(value) => { onUpdateConfig('artStyle', value) }}
        onAnalysisModelChange={(value) => { onUpdateConfig('analysisModel', value) }}
        onCharacterModelChange={(value) => { onUpdateConfig('characterModel', value) }}
        onLocationModelChange={(value) => { onUpdateConfig('locationModel', value) }}
        onImageModelChange={(value) => { onUpdateConfig('storyboardModel', value) }}
        onEditModelChange={(value) => { onUpdateConfig('editModel', value) }}
        onVideoModelChange={(value) => { onUpdateConfig('videoModel', value) }}
        onAudioModelChange={(value) => { onUpdateConfig('audioModel', value) }}
        onVideoRatioChange={(value) => { onUpdateConfig('videoRatio', value) }}
        onCapabilityOverridesChange={(value) => { onUpdateConfig('capabilityOverrides', value) }}
        onTTSRateChange={(value) => { onUpdateConfig('ttsRate', value) }}
        additionalSettings={<ProjectComfyDefaults projectId={projectId} onUpdateConfig={onUpdateConfig} />}
      />

      <WorldContextModal
        isOpen={isWorldContextModalOpen}
        onClose={onCloseWorldContextModal}
        text={globalAssetText}
        onChange={(value) => { onUpdateConfig('globalAssetText', value) }}
      />
      {episodes.length > 0 && currentEpisodeId && (() => {
        const getNum = (name: string) => { const m = name.match(/\d+/); return m ? parseInt(m[0], 10) : Infinity }
        const sorted = [...episodes].sort((a, b) => {
          const d = getNum(a.name) - getNum(b.name)
          return d !== 0 ? d : a.name.localeCompare(b.name, 'zh')
        })
        return (
          <EpisodeSelector
            projectName={projectName}
            episodes={sorted.map((ep) => {
              const stageArtifacts = resolveEpisodeStageArtifacts({
                novelText: null,
                clips: ep.clips || [],
                storyboards: ep.storyboards || [],
                voiceLines: [],
              })
              return {
                id: ep.id,
                title: ep.name,
                summary: ep.description ?? undefined,
                status: {
                  script: stageArtifacts.hasScript ? 'ready' as const : 'empty' as const,
                  visual: stageArtifacts.hasVideo ? 'ready' as const : 'empty' as const,
                },
              }
            })}
            currentId={currentEpisodeId}
            onSelect={(id) => onEpisodeSelect?.(id)}
            onAdd={onEpisodeCreate}
            onRename={(id, newName) => onEpisodeRename?.(id, newName)}
            onDelete={onEpisodeDelete}
          />
        )
      })()}



      <CapsuleNav
        items={capsuleNavItems}
        activeId={currentStage}
        onItemClick={onStageChange}
        projectId={projectId}
        episodeId={episodeId}
      />

      <WorkspaceTopActions
        onOpenAssetLibrary={onOpenAssetLibrary}
        onOpenSettings={onOpenSettingsModal}
        onRefresh={onRefresh}
        assetLibraryLabel={assetLibraryLabel}
        settingsLabel={settingsLabel}
        refreshTitle={refreshTitle}
      />
    </>
  )
}
