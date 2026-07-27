'use client'

import { useCallback } from 'react'
import { VideoClip, VideoEditorProject } from '../types/editor.types'
import { apiFetch } from '@/lib/api-fetch'
import { resolveTaskResponse } from '@/lib/task/client'
import {
    applyEditorAutoCutPlan,
    type EditorAutoCutPlan,
    type EditorAutoCutSourceClip,
} from '@/lib/novel-promotion/editor-auto-cut'

interface UseEditorActionsProps {
    projectId: string
    episodeId: string
}

/**
 * 面板数据类型（灵活接受各种格式）
 */
export interface PanelData {
    id?: string
    panelIndex?: number
    storyboardId: string
    videoUrl?: string
    description?: string
    duration?: number
    hasEmbeddedDialogueAudio?: boolean
    subtitleText?: string
}

export interface EditorVoiceLineData {
    id: string
    speaker: string
    content: string
    audioUrl?: string | null
    matchedPanelId?: string | null
    matchedStoryboardId?: string | null
    matchedPanelIndex?: number | null
}

/**
 * 从已生成的视频面板创建编辑器项目
 */
export function createProjectFromPanels(
    episodeId: string,
    panels: PanelData[],
    voiceLines?: EditorVoiceLineData[],
    options?: {
        originalAudioUrl?: string | null
        originalAudioDurationSeconds?: number | null
    },
): VideoEditorProject {
    // 过滤出有视频的面板
    const videoPanels = panels.filter(p => p.videoUrl)

    // 创建视频片段
    const timeline: VideoClip[] = videoPanels.map((panel, index) => {
        const matchedVoices = voiceLines?.filter((voiceLine) => {
            if (panel.id && voiceLine.matchedPanelId) {
                return voiceLine.matchedPanelId === panel.id
            }
            return voiceLine.matchedStoryboardId === panel.storyboardId
                && voiceLine.matchedPanelIndex === panel.panelIndex
        }) || []
        const subtitleText = panel.subtitleText?.trim() || matchedVoices
            .map((voiceLine) => voiceLine.content.trim())
            .filter(Boolean)
            .join('\n')
        const attachedVoice = matchedVoices.find((voiceLine) => (
            !!voiceLine.audioUrl
            && !panel.hasEmbeddedDialogueAudio
        ))

        return {
            id: `clip_${panel.id || panel.storyboardId}_${panel.panelIndex ?? index}`,
            src: panel.videoUrl!,
            muted: !!options?.originalAudioUrl,
            durationInFrames: Math.round((panel.duration || 3) * 30), // 默认 3 秒，30fps
            attachment: {
                audio: !options?.originalAudioUrl && attachedVoice?.audioUrl ? {
                    src: attachedVoice.audioUrl,
                    volume: 1,
                    voiceLineId: attachedVoice.id
                } : undefined,
                subtitle: subtitleText ? {
                    text: subtitleText,
                    style: 'default' as const
                } : undefined
            },
            metadata: {
                panelId: panel.id || `${panel.storyboardId}-${panel.panelIndex ?? index}`,
                storyboardId: panel.storyboardId,
                description: panel.description || undefined
            }
        }
    })

    const timelineDurationInFrames = timeline.reduce(
        (total, clip) => total + clip.durationInFrames,
        0,
    )
    const originalAudioDurationInFrames = options?.originalAudioDurationSeconds
        ? Math.round(options.originalAudioDurationSeconds * 30)
        : timelineDurationInFrames

    return {
        id: `editor_${episodeId}_${Date.now()}`,
        episodeId,
        schemaVersion: '1.0',
        config: {
            fps: 30,
            width: 1920,
            height: 1080
        },
        timeline,
        bgmTrack: options?.originalAudioUrl ? [{
            id: 'source-original-audio',
            src: options.originalAudioUrl,
            startFrame: 0,
            durationInFrames: Math.max(1, originalAudioDurationInFrames),
            volume: 1,
        }] : [],
    }
}

/**
 * 保存的剪辑工程可能包含已经过期的签名媒体 URL。按 panelId 用当前分镜
 * 数据刷新视频、配音和字幕来源，同时保留用户的排序、裁剪和转场设置。
 */
export function refreshEditorProjectMedia(
    savedProject: VideoEditorProject,
    sourceProject: VideoEditorProject,
): VideoEditorProject {
    const currentByPanelId = new Map(
        sourceProject.timeline.map((clip) => [clip.metadata.panelId, clip]),
    )

    const timeline = savedProject.timeline.map((savedClip) => {
        const currentClip = currentByPanelId.get(savedClip.metadata.panelId)
        if (!currentClip) return savedClip

        const currentAudio = currentClip.attachment?.audio
        const savedAudio = savedClip.attachment?.audio
        const currentSubtitle = currentClip.attachment?.subtitle
        const savedSubtitle = savedClip.attachment?.subtitle

        return {
            ...savedClip,
            src: currentClip.src,
            muted: currentClip.muted,
            attachment: currentAudio || currentSubtitle || savedAudio || savedSubtitle ? {
                audio: currentAudio ? {
                    ...currentAudio,
                    volume: savedAudio?.volume ?? currentAudio.volume,
                } : savedAudio,
                subtitle: currentSubtitle ? {
                    ...currentSubtitle,
                    style: savedSubtitle?.style ?? currentSubtitle.style,
                } : savedSubtitle,
            } : undefined,
            metadata: {
                ...currentClip.metadata,
                ...savedClip.metadata,
                description: currentClip.metadata.description || savedClip.metadata.description,
            },
        }
    })
    const legacyAutoCut = !savedProject.autoCut
        && timeline.some((clip) => !!clip.metadata.autoCutReason)

    const currentOriginalAudio = sourceProject.bgmTrack.find(
        (track) => track.id === 'source-original-audio',
    )
    const savedNonOriginalTracks = savedProject.bgmTrack.filter(
        (track) => track.id !== 'source-original-audio',
    )

    return {
        ...savedProject,
        timeline,
        bgmTrack: currentOriginalAudio
            ? [currentOriginalAudio, ...savedNonOriginalTracks]
            : savedProject.bgmTrack,
        autoCut: savedProject.autoCut || (legacyAutoCut ? {
            status: 'completed',
            completedAt: '',
            summary: '',
            sourceClipCount: sourceProject.timeline.length,
            outputClipCount: timeline.length,
            durationInFrames: timeline.reduce((total, clip) => total + clip.durationInFrames, 0),
        } : undefined),
    }
}

export function useEditorActions({ projectId, episodeId }: UseEditorActionsProps) {
    const autoCutProject = useCallback(async (
        sourceProject: VideoEditorProject,
        instruction: string,
        targetProjectId?: string,
    ): Promise<{ project: VideoEditorProject; plan: EditorAutoCutPlan }> => {
        const clips: EditorAutoCutSourceClip[] = sourceProject.timeline.map((clip, sourceOrder) => ({
            clipId: clip.id,
            panelId: clip.metadata.panelId,
            storyboardId: clip.metadata.storyboardId,
            sourceOrder,
            durationSeconds: clip.durationInFrames / sourceProject.config.fps,
            description: clip.metadata.description || '',
            subtitleText: clip.attachment?.subtitle?.text || '',
            hasVoiceAudio: !!clip.attachment?.audio,
        }))

        const response = await apiFetch(`/api/novel-promotion/${projectId}/editor/auto-cut`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ episodeId, instruction, clips })
        })
        const result = await resolveTaskResponse<{ plan?: EditorAutoCutPlan }>(response)
        if (!result.plan) throw new Error('自动剪辑没有返回有效方案')

        return {
            plan: result.plan,
            project: applyEditorAutoCutPlan(sourceProject, result.plan, targetProjectId),
        }
    }, [episodeId, projectId])

    /**
     * 保存项目到服务器
     */
    const saveProject = useCallback(async (project: VideoEditorProject) => {
        const response = await apiFetch(`/api/novel-promotion/${projectId}/editor`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ episodeId, projectData: project })
        })

        if (!response.ok) {
            throw new Error('Failed to save project')
        }

        return response.json()
    }, [episodeId, projectId])

    /**
     * 加载项目
     */
    const loadProject = useCallback(async (): Promise<VideoEditorProject | null> => {
        const response = await apiFetch(`/api/novel-promotion/${projectId}/editor?episodeId=${episodeId}`)

        if (!response.ok) {
            if (response.status === 404) return null
            throw new Error('Failed to load project')
        }

        const data = await response.json()
        return data.projectData
    }, [projectId, episodeId])

    /**
     * 发起渲染导出
     */
    const startRender = useCallback(async () => {
        const response = await apiFetch(`/api/novel-promotion/${projectId}/editor/render`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                episodeId,
            })
        })

        if (!response.ok) {
            throw new Error('Failed to start render')
        }

        return response.json()
    }, [episodeId, projectId])

    /**
     * 获取渲染状态
     */
    const getRenderStatus = useCallback(async () => {
        const response = await apiFetch(
            `/api/novel-promotion/${projectId}/editor/render?episodeId=${encodeURIComponent(episodeId)}`
        )

        if (!response.ok) {
            throw new Error('Failed to get render status')
        }

        return response.json()
    }, [episodeId, projectId])

    return {
        autoCutProject,
        saveProject,
        loadProject,
        startRender,
        getRenderStatus
    }
}
