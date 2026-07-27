'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { logError as _ulogError } from '@/lib/logging/core'
import type { VideoEditorProject } from '../types/editor.types'

type RenderStatus = {
    status?: string
    downloadUrl?: string | null
}

interface EditorExportControlsProps {
    project: VideoEditorProject
    episodeId: string
    hasTransitions: boolean
    clearAllTransitions: () => void
    saveProject: (project: VideoEditorProject) => Promise<unknown>
    markSaved: () => void
    startRender: () => Promise<unknown>
    getRenderStatus: () => Promise<unknown>
}

export function EditorExportControls({
    project,
    episodeId,
    hasTransitions,
    clearAllTransitions,
    saveProject,
    markSaved,
    startRender,
    getRenderStatus,
}: EditorExportControlsProps) {
    const t = useTranslations('video')
    const [rendering, setRendering] = useState(false)
    const [renderMessage, setRenderMessage] = useState<string | null>(null)

    const handleExportProject = async () => {
        try {
            await saveProject(project)
            markSaved()
            const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' })
            const url = URL.createObjectURL(blob)
            const anchor = document.createElement('a')
            anchor.href = url
            anchor.download = `waoowaoo-edit-${episodeId}.json`
            document.body.appendChild(anchor)
            anchor.click()
            anchor.remove()
            URL.revokeObjectURL(url)
            alert(t('editor.alert.exportSuccess'))
        } catch (error) {
            _ulogError('Export failed:', error)
            alert(t('editor.alert.exportFailed'))
        }
    }

    const handleRenderVideo = async () => {
        if (project.timeline.length === 0 || rendering) return
        setRendering(true)
        setRenderMessage(t('editor.render.preparing'))
        try {
            await saveProject(project)
            markSaved()
            await startRender()
            for (let attempt = 0; attempt < 900; attempt += 1) {
                await new Promise((resolve) => setTimeout(resolve, 2_000))
                const status = await getRenderStatus() as RenderStatus
                if (status.status === 'completed' && status.downloadUrl) {
                    const anchor = document.createElement('a')
                    anchor.href = status.downloadUrl
                    anchor.download = `waoowaoo-${episodeId}.mp4`
                    document.body.appendChild(anchor)
                    anchor.click()
                    anchor.remove()
                    setRenderMessage(t('editor.render.completed'))
                    return
                }
                if (status.status === 'failed') throw new Error(t('editor.render.failed'))
                setRenderMessage(t('editor.render.rendering'))
            }
            throw new Error(t('editor.render.timeout'))
        } catch (error) {
            _ulogError('Render failed:', error)
            setRenderMessage(error instanceof Error ? error.message : t('editor.render.failed'))
        } finally {
            setRendering(false)
        }
    }

    return (
        <>
            <button
                onClick={clearAllTransitions}
                disabled={!hasTransitions}
                className="glass-btn-base glass-btn-secondary px-4 py-2 disabled:opacity-50"
            >
                {t('editor.toolbar.clearTransitions')}
            </button>
            <button
                onClick={handleRenderVideo}
                disabled={rendering || project.timeline.length === 0}
                className="glass-btn-base glass-btn-primary px-4 py-2 text-white disabled:opacity-50"
            >
                {rendering ? t('editor.toolbar.rendering') : t('editor.toolbar.exportVideo')}
            </button>
            <button
                onClick={handleExportProject}
                className="glass-btn-base glass-btn-tone-success px-4 py-2"
            >
                {t('editor.toolbar.exportProject')}
            </button>
            {renderMessage && (
                <span className="basis-full text-right text-xs text-[var(--glass-text-secondary)]">
                    {renderMessage}
                </span>
            )}
        </>
    )
}
