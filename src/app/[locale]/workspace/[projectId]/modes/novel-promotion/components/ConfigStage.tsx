'use client'

import { useCallback, useState } from 'react'
import { useParams } from 'next/navigation'
import NovelInputStage from './NovelInputStage'
import SmartImportWizard from './SmartImportWizard'
import { useWorkspaceStageRuntime } from '../WorkspaceStageRuntimeContext'
import { useWorkspaceEpisodeStageData } from '../hooks/useWorkspaceEpisodeStageData'
import type { SplitEpisode } from './smart-import/types'
import { useTranslations } from 'next-intl'
import { useToast } from '@/contexts/ToastContext'
import { shouldLockStoryboardRunSettings } from '@/lib/novel-promotion/six-grid/run-settings'
import type { StoryboardConfigKey } from '../hooks/useWorkspaceConfigActions'
import { Link } from '@/i18n/navigation'

/**
 * 配置阶段 — 整合 NovelInputStage + 长文本智能分集
 * 
 * 当用户输入长文本（>1000字）并点击"开始创作"时，
 * 弹出引导卡片建议使用智能分集。
 * 选择"智能分集"后，直接进入 SmartImportWizard 的分析流程。
 */
export default function ConfigStage() {
  const t = useTranslations('novelPromotion.storyboardRunSettings')
  const { showToast } = useToast()
  const runtime = useWorkspaceStageRuntime()
  const { episodeName, novelText } = useWorkspaceEpisodeStageData('config')
  const params = useParams<{ projectId: string }>()
  const projectId = params?.projectId ?? ''
  const settingsLocked = shouldLockStoryboardRunSettings({
    isStarting: runtime.isStartingScriptToStoryboard
      || runtime.isConfirmingAssets
      || runtime.isTransitioning,
    isActiveRunning: runtime.isScriptToStoryboardRunning,
  })
  const displayedCellRatio = runtime.sixGridCellAspectRatio || runtime.videoRatio || ''
  const hasCurrentUpscaleModel = runtime.userUpscaleModels.some(
    (model) => model.value === runtime.storyboardUpscaleModel,
  )
  const hasCurrentDialogueModel = runtime.userVideoModels.some(
    (model) => model.value === runtime.dialogueVideoModel,
  )

  const handleStoryboardSettingChange = useCallback(async (
    key: StoryboardConfigKey,
    value: unknown,
  ) => {
    try {
      const saved = await runtime.onStoryboardConfigChange(key, value)
      if (!saved) showToast(t('saveFailed'), 'error')
    } catch {
      showToast(t('saveFailed'), 'error')
    }
  }, [runtime, showToast, t])

  // 智能分集模式
  const [smartSplitMode, setSmartSplitMode] = useState(false)
  const [smartSplitText, setSmartSplitText] = useState('')

  const handleSmartSplit = useCallback((text: string) => {
    setSmartSplitText(text)
    setSmartSplitMode(true)
  }, [])

  const handleSmartSplitComplete = useCallback((episodes: SplitEpisode[], triggerGlobalAnalysis?: boolean) => {
    // 分集完成后，刷新页面以加载新的剧集数据
    // 通过 window.location.reload 简单处理，因为分集会重新创建所有剧集
    void episodes
    void triggerGlobalAnalysis
    window.location.reload()
  }, [])

  // 如果已进入智能分集模式，显示 SmartImportWizard
  if (smartSplitMode) {
    return (
      <SmartImportWizard
        projectId={projectId}
        onManualCreate={() => setSmartSplitMode(false)}
        onImportComplete={handleSmartSplitComplete}
        initialRawContent={smartSplitText}
      />
    )
  }

  return (
    <div className="space-y-5">
      <section className="mx-auto max-w-5xl rounded-xl border border-[var(--glass-stroke)] bg-[var(--glass-bg)] p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-[var(--glass-text-primary)]">{t('title')}</h2>
            <p className="text-xs text-[var(--glass-text-tertiary)]">
              {t('summary', {
                mode: t(`mode.${runtime.storyboardGenerationMode}`),
                ratio: runtime.storyboardGenerationMode === 'six_grid' ? displayedCellRatio : t('notApplicable'),
              })}
            </p>
          </div>
          {settingsLocked && (
            <span className="text-xs text-[var(--glass-text-tertiary)]">{t('locked')}</span>
          )}
        </div>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          <label className="text-xs text-[var(--glass-text-secondary)]">
            <span className="mb-1 block">{t('modeLabel')}</span>
            <select
              value={runtime.storyboardGenerationMode}
              disabled={settingsLocked}
              onChange={(event) => void handleStoryboardSettingChange(
                'storyboardGenerationMode',
                event.target.value,
              )}
              className="glass-input-base w-full px-3 py-2"
            >
              <option value="individual">{t('mode.individual')}</option>
              <option value="six_grid">{t('mode.six_grid')}</option>
            </select>
          </label>
          {runtime.storyboardGenerationMode === 'six_grid' && (
            <label className="text-xs text-[var(--glass-text-secondary)]">
              <span className="mb-1 block">{t('cellRatioLabel')}</span>
              <select
                value={runtime.sixGridCellAspectRatio || ''}
                disabled={settingsLocked}
                onChange={(event) => void handleStoryboardSettingChange(
                  'sixGridCellAspectRatio',
                  event.target.value || null,
                )}
                className="glass-input-base w-full px-3 py-2"
              >
                <option value="">{t('inheritVideoRatio', { ratio: runtime.videoRatio || '-' })}</option>
                <option value="16:9">16:9</option>
                <option value="9:16">9:16</option>
              </select>
            </label>
          )}
          <label className="text-xs text-[var(--glass-text-secondary)]">
            <span className="mb-1 block">{t('processingOrderLabel')}</span>
            <select
              value={runtime.sixGridProcessingOrder}
              disabled={settingsLocked || runtime.storyboardGenerationMode !== 'six_grid'}
              onChange={(event) => void handleStoryboardSettingChange(
                'sixGridProcessingOrder',
                event.target.value,
              )}
              className="glass-input-base w-full px-3 py-2"
            >
              <option value="crop_then_panel_upscale">{t('processingOrder.crop_then_panel_upscale')}</option>
              <option value="sheet_upscale_then_crop">{t('processingOrder.sheet_upscale_then_crop')}</option>
            </select>
          </label>
          <label className="text-xs text-[var(--glass-text-secondary)]">
            <span className="mb-1 block">{t('upscaleModelLabel')}</span>
            <select
              value={runtime.storyboardUpscaleModel || ''}
              disabled={settingsLocked}
              onChange={(event) => void handleStoryboardSettingChange(
                'storyboardUpscaleModel',
                event.target.value || null,
              )}
              className="glass-input-base w-full px-3 py-2"
            >
              <option value="">{t('noUpscaleModel')}</option>
              {!hasCurrentUpscaleModel && runtime.storyboardUpscaleModel && (
                <option value={runtime.storyboardUpscaleModel}>{runtime.storyboardUpscaleModel}</option>
              )}
              {runtime.userUpscaleModels.map((model) => (
                <option key={model.value} value={model.value}>{model.label}</option>
              ))}
            </select>
            <span className="mt-1 block text-[11px] text-[var(--glass-text-tertiary)]">
              {runtime.userUpscaleModels.length === 0 ? t('comfyuiEmptyHint') : t('comfyuiManageHint')}{' '}
              <Link className="font-medium text-[var(--glass-tone-info-fg)] underline" href={{ pathname: '/profile', query: { section: 'comfyui' } }} title={t('comfyuiManageHint')}>
                {t('manageComfyui')}
              </Link>
            </span>
          </label>
          <label className="text-xs text-[var(--glass-text-secondary)]">
            <span className="mb-1 block">{t('dialogueVideoModelLabel')}</span>
            <select
              value={runtime.dialogueVideoModel || ''}
              disabled={settingsLocked}
              onChange={(event) => void handleStoryboardSettingChange(
                'dialogueVideoModel',
                event.target.value || null,
              )}
              className="glass-input-base w-full px-3 py-2"
            >
              <option value="">{t('useDefaultVideoModel')}</option>
              {!hasCurrentDialogueModel && runtime.dialogueVideoModel && (
                <option value={runtime.dialogueVideoModel}>{runtime.dialogueVideoModel}</option>
              )}
              {runtime.userVideoModels.map((model) => (
                <option key={model.value} value={model.value}>{model.label}</option>
              ))}
            </select>
          </label>
        </div>
      </section>
      <NovelInputStage
      novelText={novelText}
      episodeName={episodeName}
      onNovelTextChange={runtime.onNovelTextChange}
      isSubmittingTask={runtime.isSubmittingTTS || runtime.isStartingStoryToScript}
      isSwitchingStage={runtime.isTransitioning}
      videoRatio={runtime.videoRatio ?? undefined}
      artStyle={runtime.artStyle ?? undefined}
      onVideoRatioChange={runtime.onVideoRatioChange}
      onArtStyleChange={runtime.onArtStyleChange}
      onNext={runtime.onRunStoryToScript}
      onSmartSplit={handleSmartSplit}
      />
    </div>
  )
}
