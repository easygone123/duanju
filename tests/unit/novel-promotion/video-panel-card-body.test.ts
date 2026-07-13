import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import VideoPanelCardBody from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video/panel-card/VideoPanelCardBody'
import type { VideoPanelRuntime } from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video/panel-card/hooks/useVideoPanelActions'

vi.mock('@/components/task/TaskStatusInline', () => ({
  default: () => React.createElement('span', null, 'task-status'),
}))

vi.mock('@/components/ui/config-modals/ModelCapabilityDropdown', () => ({
  ModelCapabilityDropdown: () => React.createElement('div', null, 'model-dropdown'),
}))

vi.mock('@/components/ui/icons', () => ({
  AppIcon: ({ name }: { name: string }) => React.createElement('span', null, name),
}))

function createRuntime(overrides: Partial<VideoPanelRuntime> = {}): VideoPanelRuntime {
  const translate = (key: string, values?: Record<string, unknown>) => {
    if (key === 'firstLastFrame.asLastFrameFor') {
      return `作为镜头 ${String(values?.number ?? '')} 的尾帧`
    }
    if (key === 'firstLastFrame.asFirstFrameFor') {
      return `作为镜头 ${String(values?.number ?? '')} 的首帧`
    }
    if (key === 'firstLastFrame.generate') return '生成首尾帧视频'
    if (key === 'firstLastFrame.generated') return '首尾帧视频已生成'
    if (key === 'promptModal.promptLabel') return '视频提示词'
    if (key === 'promptModal.placeholder') return '输入首尾帧视频提示词...'
    if (key === 'panelCard.clickToEditPrompt') return '点击编辑提示词...'
    if (key === 'panelCard.selectModel') return '选择模型'
    if (key === 'panelCard.generateVideo') return '生成视频'
    if (key === 'panelCard.unknownShotType') return '未知镜头'
    if (key === 'stage.hasSynced') return '已生成'
    if (key === 'promptModal.duration') return '秒'
    if (key === 'dialogue.badge') return '含台词'
    if (key === 'dialogue.duration.estimated') return `自动估算 ${String(values?.seconds ?? '')} 秒`
    if (key === 'dialogue.duration.override') return `手动覆盖 ${String(values?.seconds ?? '')} 秒`
    if (key === 'dialogue.duration.effective') return `实际提交 ${String(values?.seconds ?? '')} 秒`
    if (key === 'dialogue.duration.input') return '视频时长覆盖'
    if (key === 'dialogue.duration.reset') return '恢复自动'
    if (key === 'dialogue.model.fallback') return '未配置台词专用模型，使用普通模型'
    if (key === 'dialogue.includeInVideoPrompt') return '将台词加入视频提示词'
    if (key === 'dialogue.saveSettings') return '保存设置'
    return key
  }

  const runtime = {
    t: translate,
    tCommon: (key: string) => key,
    panel: {
      storyboardId: 'sb-1',
      panelIndex: 2,
      panelId: 'panel-2',
      imageUrl: 'https://example.com/frame-2.jpg',
      videoUrl: null,
      videoGenerationMode: null,
      lipSyncVideoUrl: null,
      textPanel: {
        shot_type: '平视中景',
        description: '谢俞站在宴席中央',
        duration: 3,
      },
    },
    panelIndex: 2,
    panelKey: 'sb-1-2',
    media: {
      showLipSyncVideo: true,
      onToggleLipSyncVideo: () => undefined,
      onPreviewImage: () => undefined,
      baseVideoUrl: undefined,
      currentVideoUrl: undefined,
    },
    taskStatus: {
      isVideoTaskRunning: false,
      isLipSyncTaskRunning: false,
      taskRunningVideoLabel: '生成中',
      lipSyncInlineState: null,
    },
    videoModel: {
      selectedModel: 'veo-3.1',
      setSelectedModel: () => undefined,
      capabilityFields: [],
      generationOptions: {},
      setCapabilityValue: () => undefined,
      missingCapabilityFields: [],
      videoModelOptions: [],
    },
    player: {
      isPlaying: false,
    },
    promptEditor: {
      isEditing: false,
      editingPrompt: '',
      setEditingPrompt: () => undefined,
      handleStartEdit: () => undefined,
      handleSave: () => undefined,
      handleCancelEdit: () => undefined,
      isSavingPrompt: false,
      localPrompt: '人物从席间回身，接到下一镜头',
    },
    voiceManager: {
      hasMatchedAudio: false,
      hasMatchedVoiceLines: false,
      audioGenerateError: null,
      localVoiceLines: [],
      isVoiceLineTaskRunning: () => false,
      handlePlayVoiceLine: () => undefined,
      handleGenerateAudio: async () => undefined,
      playingVoiceLineId: null,
    },
    lipSync: {
      handleStartLipSync: () => undefined,
      executingLipSync: false,
    },
    layout: {
      isLinked: true,
      isLastFrame: true,
      nextPanel: {
        storyboardId: 'sb-1',
        panelIndex: 3,
        imageUrl: 'https://example.com/frame-3.jpg',
      },
      prevPanel: {
        storyboardId: 'sb-1',
        panelIndex: 1,
        imageUrl: 'https://example.com/frame-1.jpg',
      },
      hasNext: true,
      flModel: 'veo-3.1',
      flModelOptions: [],
      flGenerationOptions: {},
      flCapabilityFields: [],
      flMissingCapabilityFields: [],
      flCustomPrompt: '',
      defaultFlPrompt: '',
      videoRatio: '9:16',
    },
    actions: {
      onGenerateVideo: () => undefined,
      onUpdatePanelVideoModel: () => undefined,
      onToggleLink: () => undefined,
      onFlModelChange: () => undefined,
      onFlCapabilityChange: () => undefined,
      onFlCustomPromptChange: () => undefined,
      onResetFlPrompt: () => undefined,
      onGenerateFirstLastFrame: () => undefined,
    },
    computed: {
      showLipSyncSection: false,
      canLipSync: false,
      hasVisibleBaseVideo: false,
    },
  }

  return {
    ...runtime,
    ...overrides,
  } as unknown as VideoPanelRuntime
}

describe('VideoPanelCardBody', () => {
  it('renders incoming and outgoing first-last-frame UI for chained panel', () => {
    const markup = renderToStaticMarkup(
      React.createElement(VideoPanelCardBody, {
        runtime: createRuntime(),
      }),
    )

    expect(markup).toContain('作为镜头 2 的尾帧')
    expect(markup).toContain('作为镜头 4 的首帧')
    expect(markup).toContain('视频提示词')
    expect(markup).toContain('生成首尾帧视频')
  })

  it('offers replace and clear controls for a manual first-frame source', () => {
    const base = createRuntime()
    const markup = renderToStaticMarkup(React.createElement(VideoPanelCardBody, {
      runtime: createRuntime({
        layout: {
          ...base.layout,
          frameLinkChoices: {
            firstFrame: { mode: 'manual', sourcePanelId: 'manual-first-panel' },
            lastFrame: { mode: 'automatic', sourcePanelId: 'panel-3' },
          },
          flModelSupportsFirstLastFrame: true,
        },
        actions: {
          ...base.actions,
          onUpdateFrameLink: () => undefined,
        },
      }),
    }))

    expect(markup).toContain('first · manual')
    expect(markup).toContain('replace first')
    expect(markup).toContain('clear first')
  })

  it('shows accessible dialogue routing and duration controls without relying on color', () => {
    const base = createRuntime()
    const markup = renderToStaticMarkup(
      React.createElement(VideoPanelCardBody, {
        runtime: createRuntime({
          panel: {
            ...base.panel,
            hasDialogue: true,
            estimatedDuration: 7.2,
            durationOverride: null,
          },
          videoModel: {
            ...base.videoModel,
            modelReason: 'dialogue_model_not_configured_fallback',
            effectiveDuration: 10,
            durationOverride: null,
            setDurationOverride: () => undefined,
            resetDurationOverride: () => undefined,
            validationError: null,
            includeDialogueInVideoPrompt: true,
            setIncludeDialogueInVideoPrompt: () => undefined,
            hasSettingsChanges: true,
            isSavingSettings: false,
            saveVideoSettings: async () => undefined,
          },
        }),
      }),
    )

    expect(markup).toContain('aria-label="含台词"')
    expect(markup).toContain('含台词')
    expect(markup).toContain('自动估算 7.2 秒')
    expect(markup).toContain('实际提交 10 秒')
    expect(markup).toContain('未配置台词专用模型，使用普通模型')
    expect(markup).toContain('aria-label="视频时长覆盖"')
    expect(markup).toContain('恢复自动')
    expect(markup).toContain('将台词加入视频提示词')
    expect(markup).toContain('type="checkbox"')
    expect(markup).toContain('保存设置')
  })

  it('disables duration editing while video generation is running', () => {
    const base = createRuntime()
    const markup = renderToStaticMarkup(
      React.createElement(VideoPanelCardBody, {
        runtime: createRuntime({
          panel: { ...base.panel, estimatedDuration: 5, durationOverride: 8 },
          taskStatus: { ...base.taskStatus, isVideoTaskRunning: true },
          videoModel: {
            ...base.videoModel,
            modelReason: 'normal_project_model',
            effectiveDuration: 10,
            durationOverride: 8,
            setDurationOverride: () => undefined,
            resetDurationOverride: () => undefined,
            validationError: null,
          },
        }),
      }),
    )

    expect(markup).toContain('手动覆盖 8 秒')
    expect(markup).toMatch(/aria-label="视频时长覆盖"[^>]*disabled=""/)
  })
})
