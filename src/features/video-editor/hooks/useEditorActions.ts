'use client'

import { useCallback } from 'react'
import { VideoClip, VideoEditorProject } from '../types/editor.types'
import { apiFetch } from '@/lib/api-fetch'

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
}

export interface EditorVoiceLineData {
    id: string
    speaker: string
    content: string
    audioUrl?: string | null
    lineType?: 'dialogue' | 'narration'
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
    voiceLines?: EditorVoiceLineData[]
): VideoEditorProject {
    // 过滤出有视频的面板
    const videoPanels = panels.filter(p => p.videoUrl)

    // 创建视频片段
    const timeline: VideoClip[] = videoPanels.map((panel, index) => {
        const nextPanel = videoPanels[index + 1]
        const matchedVoices = voiceLines?.filter((voiceLine) => {
            if (panel.id && voiceLine.matchedPanelId) {
                return voiceLine.matchedPanelId === panel.id
            }
            return voiceLine.matchedStoryboardId === panel.storyboardId
                && voiceLine.matchedPanelIndex === panel.panelIndex
        }) || []
        const subtitleText = matchedVoices
            .map((voiceLine) => voiceLine.content.trim())
            .filter(Boolean)
            .join('\n')
        const attachedVoice = matchedVoices.find((voiceLine) => (
            !!voiceLine.audioUrl
            && (voiceLine.lineType === 'narration' || !panel.hasEmbeddedDialogueAudio)
        ))

        return {
            id: `clip_${panel.id || panel.storyboardId}_${panel.panelIndex ?? index}`,
            src: panel.videoUrl!,
            durationInFrames: Math.round((panel.duration || 3) * 30), // 默认 3 秒，30fps
            attachment: {
                audio: attachedVoice?.audioUrl ? {
                    src: attachedVoice.audioUrl,
                    volume: 1,
                    voiceLineId: attachedVoice.id
                } : undefined,
                subtitle: subtitleText ? {
                    text: subtitleText,
                    style: 'default' as const
                } : undefined
            },
            transition: nextPanel ? {
                type: nextPanel.storyboardId === panel.storyboardId ? 'dissolve' as const : 'fade' as const,
                durationInFrames: 15 // 0.5s @ 30fps
            } : undefined,
            metadata: {
                panelId: panel.id || `${panel.storyboardId}-${panel.panelIndex ?? index}`,
                storyboardId: panel.storyboardId,
                description: panel.description || undefined
            }
        }
    })

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
        bgmTrack: []
    }
}

export function useEditorActions({ projectId, episodeId }: UseEditorActionsProps) {
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
    const startRender = useCallback(async (editorProjectId: string) => {
        const response = await apiFetch(`/api/novel-promotion/${projectId}/editor/render`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                editorProjectId,
                format: 'mp4',
                quality: 'high'
            })
        })

        if (!response.ok) {
            throw new Error('Failed to start render')
        }

        return response.json()
    }, [projectId])

    /**
     * 获取渲染状态
     */
    const getRenderStatus = useCallback(async (editorProjectId: string) => {
        const response = await apiFetch(
            `/api/novel-promotion/${projectId}/editor/render?id=${editorProjectId}`
        )

        if (!response.ok) {
            throw new Error('Failed to get render status')
        }

        return response.json()
    }, [projectId])

    return {
        saveProject,
        loadProject,
        startRender,
        getRenderStatus
    }
}
