'use client'
import { logError as _ulogError } from '@/lib/logging/core'
import { useTranslations } from 'next-intl'

import React, { useState } from 'react'
import { AppIcon } from '@/components/ui/icons'
import { useEditorState } from '../hooks/useEditorState'
import { useEditorActions } from '../hooks/useEditorActions'
import { VideoEditorProject } from '../types/editor.types'
import { calculateTimelineDuration, framesToTime } from '../utils/time-utils'
import { RemotionPreview } from './Preview'
import { Timeline } from './Timeline'
import { TransitionPicker, TransitionType } from './TransitionPicker'

interface VideoEditorStageProps {
    projectId: string
    episodeId: string
    initialProject?: VideoEditorProject
    sourceProject?: VideoEditorProject
    onBack?: () => void
}

/**
 * 视频编辑器主页面
 * 
 * 布局:
 * ┌──────────────────────────────────────────────────────────┐
 * │ Toolbar (返回 | 保存 | 导出)                              │
 * ├──────────────┬───────────────────────────────────────────┤
 * │  素材库       │       Preview (Remotion Player)           │
 * │              │                                           │
 * │              ├───────────────────────────────────────────┤
 * │              │       Properties Panel                    │
 * ├──────────────┴───────────────────────────────────────────┤
 * │                      Timeline                            │
 * └──────────────────────────────────────────────────────────┘
 */
export function VideoEditorStage({
    projectId,
    episodeId,
    initialProject,
    sourceProject,
    onBack
}: VideoEditorStageProps) {
    const t = useTranslations('video')
    const {
        project,
        timelineState,
        isDirty,
        addClip,
        removeClip,
        updateClip,
        reorderClips,
        play,
        pause,
        seek,
        selectClip,
        setZoom,
        markSaved,
        loadProject
    } = useEditorState({ episodeId, initialProject })

    const { saveProject, autoCutProject } = useEditorActions({ projectId, episodeId })
    const [autoCutInstruction, setAutoCutInstruction] = useState('')
    const [autoCutLoading, setAutoCutLoading] = useState(false)
    const [autoCutSummary, setAutoCutSummary] = useState<string | null>(null)
    const [autoCutError, setAutoCutError] = useState<string | null>(null)

    const totalDuration = calculateTimelineDuration(project.timeline)
    const totalTime = framesToTime(totalDuration, project.config.fps)
    const currentTime = framesToTime(timelineState.currentFrame, project.config.fps)

    const handleSave = async () => {
        try {
            await saveProject(project)
            markSaved()
            alert(t('editor.alert.saveSuccess'))
        } catch (error) {
            _ulogError('Save failed:', error)
            alert(t('editor.alert.saveFailed'))
        }
    }

    const handleExport = async () => {
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

    const handleAutoCut = async () => {
        if (!sourceProject) return
        if (isDirty && !confirm(t('editor.toolbar.autoArrangeConfirm'))) return
        setAutoCutLoading(true)
        setAutoCutError(null)
        try {
            const result = await autoCutProject(sourceProject, autoCutInstruction, project.id)
            await saveProject(result.project)
            loadProject(result.project)
            markSaved()
            setAutoCutSummary([result.plan.summary, result.plan.rhythm].filter(Boolean).join(' · '))
        } catch (error) {
            _ulogError('Auto cut failed:', error)
            setAutoCutError(error instanceof Error ? error.message : t('editor.autoCut.failed'))
        } finally {
            setAutoCutLoading(false)
        }
    }

    const includedPanelIds = new Set(project.timeline.map((clip) => clip.metadata.panelId))

    const handleAddSourceClip = (sourceClip: VideoEditorProject['timeline'][number]) => {
        if (includedPanelIds.has(sourceClip.metadata.panelId)) return
        const { id: _sourceId, ...clip } = sourceClip
        void _sourceId
        addClip(clip)
    }

    const selectedClip = project.timeline.find(c => c.id === timelineState.selectedClipId)

    return (
        <div className="video-editor-stage" style={{
            display: 'flex',
            flexDirection: 'column',
            height: 'calc(100vh - 7rem)',
            minHeight: '680px',
            background: 'var(--glass-bg-canvas)',
            color: 'var(--glass-text-primary)'
        }}>
            {/* Toolbar */}
            <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '12px 16px',
                borderBottom: '1px solid var(--glass-stroke-base)',
                background: 'var(--glass-bg-surface)'
            }}>
                <button
                    onClick={onBack}
                    className="glass-btn-base glass-btn-secondary px-4 py-2"
                >
                    {t('editor.toolbar.back')}
                </button>

                <div>
                    <div className="text-sm font-semibold text-[var(--glass-text-primary)]">
                        {t('editor.toolbar.brand')}
                    </div>
                    <div className="text-[11px] text-[var(--glass-text-tertiary)]">
                        {t('editor.toolbar.importedCount', {
                            current: project.timeline.length,
                            total: sourceProject?.timeline.length || 0,
                        })}
                    </div>
                </div>

                <div style={{ flex: 1 }} />

                <span style={{ color: 'var(--glass-text-secondary)', fontSize: '14px' }}>
                    {currentTime} / {totalTime}
                </span>

                <button
                    onClick={handleSave}
                    className={`glass-btn-base px-4 py-2 ${isDirty ? 'glass-btn-primary text-white' : 'glass-btn-secondary'}`}
                >
                    {isDirty ? t('editor.toolbar.saveDirty') : t('editor.toolbar.saved')}
                </button>

                <button
                    onClick={handleExport}
                    className="glass-btn-base glass-btn-tone-success px-4 py-2"
                >
                    {t('editor.toolbar.exportProject')}
                </button>
            </div>

            <div className="flex flex-wrap items-center gap-3 border-b border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface-strong)] px-4 py-3">
                <div className="min-w-[190px]">
                    <div className="text-sm font-semibold text-[var(--glass-text-primary)]">
                        {t('editor.autoCut.title')}
                    </div>
                    <div className="text-[11px] text-[var(--glass-text-tertiary)]">
                        {t('editor.autoCut.description')}
                    </div>
                </div>
                <textarea
                    value={autoCutInstruction}
                    onChange={(event) => setAutoCutInstruction(event.target.value)}
                    disabled={autoCutLoading}
                    rows={2}
                    maxLength={4000}
                    placeholder={t('editor.autoCut.placeholder')}
                    className="min-w-[260px] flex-1 resize-none rounded-lg border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] px-3 py-2 text-xs text-[var(--glass-text-primary)] outline-none focus:border-[var(--glass-focus-ring)] disabled:opacity-60"
                />
                <button
                    type="button"
                    onClick={handleAutoCut}
                    disabled={autoCutLoading || !sourceProject || sourceProject.timeline.length === 0}
                    className="glass-btn-base glass-btn-primary px-5 py-2.5 text-white disabled:opacity-50"
                >
                    {autoCutLoading ? t('editor.autoCut.running') : t('editor.autoCut.start')}
                </button>
                {(autoCutSummary || autoCutError) && (
                    <div className={`basis-full text-xs ${autoCutError ? 'text-[var(--glass-tone-danger-fg)]' : 'text-[var(--glass-tone-success-fg)]'}`}>
                        {autoCutError || autoCutSummary}
                    </div>
                )}
            </div>

            {/* Main Content */}
            <div style={{
                display: 'flex',
                flex: 1,
                overflow: 'hidden'
            }}>
                {/* Left Panel - Media Library */}
                <div style={{
                    width: '260px',
                    borderRight: '1px solid var(--glass-stroke-base)',
                    padding: '12px',
                    background: 'var(--glass-bg-surface-strong)'
                }}>
                    <h3 style={{ margin: '0 0 12px 0', fontSize: '14px', color: 'var(--glass-text-secondary)' }}>
                        {t('editor.left.title')}
                    </h3>
                    <p style={{ fontSize: '12px', color: 'var(--glass-text-tertiary)' }}>
                        {t('editor.left.description')}
                    </p>
                    <div className="mt-3 flex max-h-[calc(100vh-20rem)] flex-col gap-2 overflow-y-auto pr-1">
                        {(sourceProject?.timeline || []).map((clip, index) => {
                            const included = includedPanelIds.has(clip.metadata.panelId)
                            return (
                                <button
                                    key={clip.metadata.panelId}
                                    type="button"
                                    disabled={included}
                                    onClick={() => handleAddSourceClip(clip)}
                                    className={`rounded-lg border px-3 py-2 text-left transition-colors ${included
                                        ? 'border-[var(--glass-stroke-base)] bg-[var(--glass-bg-muted)] opacity-60'
                                        : 'border-[var(--glass-focus-ring)] bg-[var(--glass-bg-surface)] hover:bg-[var(--glass-bg-muted)]'
                                        }`}
                                >
                                    <div className="text-xs font-medium text-[var(--glass-text-primary)]">
                                        {t('editor.left.clipName', { index: index + 1 })}
                                    </div>
                                    <div className="mt-1 line-clamp-2 text-[11px] text-[var(--glass-text-tertiary)]">
                                        {clip.metadata.description || t('editor.left.noDescription')}
                                    </div>
                                    <div className="mt-1 text-[10px] text-[var(--glass-text-secondary)]">
                                        {included ? t('editor.left.added') : t('editor.left.clickToAdd')}
                                    </div>
                                </button>
                            )
                        })}
                        {(!sourceProject || sourceProject.timeline.length === 0) && (
                            <div className="rounded-lg border border-dashed border-[var(--glass-stroke-base)] p-3 text-xs text-[var(--glass-text-tertiary)]">
                                {t('editor.left.noGeneratedVideos')}
                            </div>
                        )}
                    </div>
                </div>

                {/* Center - Preview + Properties */}
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                    {/* Preview */}
                    <div style={{
                        flex: 1,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: 'var(--glass-bg-muted)',
                        padding: '20px'
                    }}>
                        <RemotionPreview
                            project={project}
                            currentFrame={timelineState.currentFrame}
                            playing={timelineState.playing}
                            onFrameChange={seek}
                            onPlayingChange={(playing) => playing ? play() : pause()}
                        />
                    </div>

                    {/* Playback Controls */}
                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '16px',
                        padding: '12px',
                        background: 'var(--glass-bg-surface-strong)',
                        borderTop: '1px solid var(--glass-stroke-base)'
                    }}>
                        <button
                            onClick={() => seek(0)}
                            className="glass-btn-base glass-btn-ghost px-3 py-1.5"
                        >
                            <AppIcon name="chevronLeft" className="w-4 h-4" />
                        </button>
                        <button
                            onClick={() => timelineState.playing ? pause() : play()}
                            style={{
                                background: 'var(--glass-accent-from)',
                                border: 'none',
                                color: 'var(--glass-text-on-accent)',
                                cursor: 'pointer',
                                width: '40px',
                                height: '40px',
                                borderRadius: '50%',
                                fontSize: '18px'
                            }}
                        >
                            {timelineState.playing
                                ? <AppIcon name="pause" className="w-4 h-4" />
                                : <AppIcon name="play" className="w-4 h-4" />}
                        </button>
                        <button
                            onClick={() => seek(totalDuration)}
                            className="glass-btn-base glass-btn-ghost px-3 py-1.5"
                        >
                            <AppIcon name="chevronRight" className="w-4 h-4" />
                        </button>
                    </div>
                </div>

                {/* Right Panel - Properties */}
                <div style={{
                    width: '280px',
                    borderLeft: '1px solid var(--glass-stroke-base)',
                    padding: '12px',
                    background: 'var(--glass-bg-surface-strong)',
                    overflowY: 'auto'
                }}>
                    <h3 style={{ margin: '0 0 12px 0', fontSize: '14px', color: 'var(--glass-text-secondary)' }}>
                        {t('editor.right.title')}
                    </h3>
                    {selectedClip ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                            {/* 基础信息 */}
                            <div style={{ fontSize: '12px' }}>
                                <p style={{ margin: '0 0 8px 0' }}>
                                    <span style={{ color: 'var(--glass-text-secondary)' }}>{t('editor.right.clipLabel')}</span> {selectedClip.metadata?.description || t('editor.right.clipFallback', { index: project.timeline.findIndex(c => c.id === selectedClip.id) + 1 })}
                                </p>
                                <p style={{ margin: '0 0 8px 0' }}>
                                    <span style={{ color: 'var(--glass-text-secondary)' }}>{t('editor.right.durationLabel')}</span> {framesToTime(selectedClip.durationInFrames, project.config.fps)}
                                </p>
                                {selectedClip.metadata.autoCutReason && (
                                    <p style={{ margin: '0 0 8px 0' }}>
                                        <span style={{ color: 'var(--glass-text-secondary)' }}>{t('editor.right.autoCutReasonLabel')}</span> {selectedClip.metadata.autoCutReason}
                                    </p>
                                )}
                            </div>

                            {/* 转场设置 */}
                            <div>
                                <h4 style={{ margin: '0 0 8px 0', fontSize: '13px', color: 'var(--glass-text-secondary)' }}>
                                    {t('editor.right.transitionLabel')}
                                </h4>
                                <TransitionPicker
                                    value={(selectedClip.transition?.type as TransitionType) || 'none'}
                                    duration={selectedClip.transition?.durationInFrames || 15}
                                    onChange={(type, duration) => {
                                        updateClip(selectedClip.id, {
                                            transition: type === 'none' ? undefined : { type, durationInFrames: duration }
                                        })
                                    }}
                                />
                            </div>

                            {/* 删除按钮 */}
                            <button
                                onClick={() => {
                                    if (confirm(t('editor.right.deleteConfirm'))) {
                                        removeClip(selectedClip.id)
                                        selectClip(null)
                                    }
                                }}
                                className="glass-btn-base glass-btn-tone-danger mt-2 px-3 py-2 text-xs"
                            >
                                {t('editor.right.deleteClip')}
                            </button>
                        </div>
                    ) : (
                        <p style={{ fontSize: '12px', color: 'var(--glass-text-tertiary)' }}>
                            {t('editor.right.selectClipHint')}
                        </p>
                    )}
                </div>
            </div>

            {/* Timeline */}
            <div style={{
                height: '220px',
                borderTop: '1px solid var(--glass-stroke-base)'
            }}>
                <Timeline
                    clips={project.timeline}
                    timelineState={timelineState}
                    config={project.config}
                    onReorder={reorderClips}
                    onSelectClip={selectClip}
                    onZoomChange={setZoom}
                    onSeek={seek}
                />
            </div>
        </div>
    )
}

export default VideoEditorStage
