'use client'

import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import Image from 'next/image'

import type {
  Clip,
  Storyboard,
  VideoModelOption,
} from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video'
import { GlassButton, GlassInput, GlassTextarea } from '@/components/ui/primitives'
import { apiFetch } from '@/lib/api-fetch'
import {
  LTX_DIRECTOR_TIMELINE_VERSION,
  parseLtxDirectorTimelineSpec,
  type LtxDirectorTimelineSpec,
} from '@/lib/comfyui/ltx-director'
import { checkApiResponse } from '@/lib/error-handler'
import { invalidateEpisodeStageQueries } from '@/lib/query/episode-stage-cache'
import { useStoryboardTaskPresentation } from '@/lib/query/hooks/useTaskPresentation'
import { queryKeys } from '@/lib/query/keys'

interface LtxDirectorWorkspaceProps {
  projectId: string
  episodeId: string
  storyboards: Storyboard[]
  clips: Clip[]
  videoModels: VideoModelOption[]
}

function panelDuration(panel: NonNullable<Storyboard['panels']>[number]) {
  const values = [panel.durationOverride, panel.estimatedDuration, panel.duration]
  return values.find((value): value is number => (
    typeof value === 'number' && Number.isFinite(value) && value > 0
  )) ?? 3
}

function buildDefaultSpec(
  storyboard: Storyboard,
  clips: Clip[],
  defaultModel: string,
): LtxDirectorTimelineSpec {
  const saved = parseLtxDirectorTimelineSpec(storyboard.directorConfigJson)
  const panels = storyboard.panels || []
  const savedMatchesPanels = saved
    && saved.segments.length === panels.length
    && saved.segments.every((segment, index) => !segment.panelId || segment.panelId === panels[index]?.id)
  if (savedMatchesPanels) {
    return {
      ...saved,
      videoModel: saved.videoModel || defaultModel,
      segments: saved.segments.map((segment, index) => ({
        ...segment,
        panelId: panels[index]?.id,
      })),
    }
  }
  const clip = clips.find((candidate) => candidate.id === storyboard.clipId)
  return {
    version: LTX_DIRECTOR_TIMELINE_VERSION,
    fps: 24,
    globalPrompt: [storyboard.continuityAnchor, clip?.summary]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join('\n'),
    videoModel: defaultModel,
    segments: panels.map((panel) => ({
      panelId: panel.id,
      prompt: panel.videoPrompt?.trim() || panel.description?.trim() || panel.imagePrompt?.trim() || '',
      durationSeconds: panelDuration(panel),
      guideStrength: 1,
    })),
  }
}

function DirectorStoryboardEditor({
  projectId,
  episodeId,
  storyboard,
  displayNumber,
  clips,
  models,
}: {
  projectId: string
  episodeId: string
  storyboard: Storyboard
  displayNumber: number
  clips: Clip[]
  models: VideoModelOption[]
}) {
  const t = useTranslations('video.director')
  const queryClient = useQueryClient()
  const defaultSpec = useMemo(
    () => buildDefaultSpec(storyboard, clips, models[0]?.value || ''),
    [clips, models, storyboard],
  )
  const [spec, setSpec] = useState(defaultSpec)
  const [dirty, setDirty] = useState(false)
  const panels = storyboard.panels || []
  const taskTargets = useMemo(() => [{
    key: `storyboard-director:${storyboard.id}`,
    targetType: 'NovelPromotionStoryboard',
    targetId: storyboard.id,
    types: ['storyboard_director_video'],
    resource: 'video' as const,
    hasOutput: Boolean(storyboard.directorVideoUrl),
  }], [storyboard.directorVideoUrl, storyboard.id])
  const taskPresentation = useStoryboardTaskPresentation(projectId, taskTargets)
  const taskState = taskPresentation.getTaskState(`storyboard-director:${storyboard.id}`)
  const taskRunning = taskState?.phase === 'queued' || taskState?.phase === 'processing'

  useEffect(() => {
    if (!dirty) setSpec(defaultSpec)
  }, [defaultSpec, dirty])

  const saveMutation = useMutation({
    mutationFn: async (generate: boolean) => {
      const response = await apiFetch(`/api/novel-promotion/${projectId}/storyboard-director`, {
        method: generate ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          storyboardId: storyboard.id,
          videoModel: spec.videoModel,
          timelineSpec: spec,
        }),
      })
      await checkApiResponse(response)
      return response.json()
    },
    onSettled: async (_data, error) => {
      await invalidateEpisodeStageQueries(queryClient, projectId, episodeId)
      await queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all(projectId), exact: false })
      if (!error) setDirty(false)
    },
  })

  const totalDuration = spec.segments.reduce((sum, segment) => sum + segment.durationSeconds, 0)
  const ready = panels.length > 0
    && panels.length <= 8
    && panels.every((panel) => Boolean(panel.imageUrl))
    && Boolean(spec.videoModel)
    && spec.segments.length === panels.length
  const error = saveMutation.error instanceof Error
    ? saveMutation.error.message
    : taskState?.phase === 'failed'
      ? taskState.lastError?.message || taskState.lastError?.code
      : null

  function patchSpec(patch: Partial<LtxDirectorTimelineSpec>) {
    setSpec((current) => ({ ...current, ...patch }))
    setDirty(true)
  }

  function patchSegment(index: number, patch: Partial<LtxDirectorTimelineSpec['segments'][number]>) {
    setSpec((current) => ({
      ...current,
      segments: current.segments.map((segment, segmentIndex) => (
        segmentIndex === index ? { ...segment, ...patch } : segment
      )),
    }))
    setDirty(true)
  }

  return (
    <section className="glass-surface rounded-2xl p-4 md:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-[var(--glass-text-primary)]">
            {t('groupTitle', { number: displayNumber })}
          </h3>
          <p className="mt-1 text-xs text-[var(--glass-text-tertiary)]">
            {t('groupMeta', { count: panels.length, duration: totalDuration.toFixed(1) })}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <GlassButton
            size="sm"
            variant="ghost"
            disabled={saveMutation.isPending || taskRunning}
            onClick={() => {
              setSpec(buildDefaultSpec({ ...storyboard, directorConfigJson: null }, clips, models[0]?.value || ''))
              setDirty(true)
            }}
          >
            {t('reset')}
          </GlassButton>
          <GlassButton
            size="sm"
            disabled={!ready || !dirty || saveMutation.isPending || taskRunning}
            loading={saveMutation.isPending && saveMutation.variables === false}
            onClick={() => saveMutation.mutate(false)}
          >
            {t('save')}
          </GlassButton>
          <GlassButton
            size="sm"
            variant="primary"
            disabled={!ready || saveMutation.isPending || taskRunning}
            loading={taskRunning || (saveMutation.isPending && saveMutation.variables === true)}
            onClick={() => saveMutation.mutate(true)}
          >
            {taskRunning ? t('generating') : t('generate')}
          </GlassButton>
        </div>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-[minmax(0,1fr)_150px]">
        <label className="space-y-1.5 text-xs text-[var(--glass-text-secondary)]">
          <span>{t('model')}</span>
          <select
            className="glass-input-base h-9 w-full rounded-lg px-3 text-sm"
            value={spec.videoModel || ''}
            onChange={(event) => patchSpec({ videoModel: event.target.value })}
          >
            <option value="">{t('selectModel')}</option>
            {models.map((model) => (
              <option key={model.value} value={model.value}>{model.label}</option>
            ))}
          </select>
        </label>
        <label className="space-y-1.5 text-xs text-[var(--glass-text-secondary)]">
          <span>{t('fps')}</span>
          <GlassInput
            type="number"
            min={1}
            max={240}
            step={1}
            value={spec.fps}
            onChange={(event) => patchSpec({ fps: Math.max(1, Number(event.target.value) || 24) })}
          />
        </label>
      </div>

      <label className="mt-4 block space-y-1.5 text-xs text-[var(--glass-text-secondary)]">
        <span>{t('globalPrompt')}</span>
        <GlassTextarea
          rows={3}
          value={spec.globalPrompt}
          placeholder={t('globalPromptPlaceholder')}
          onChange={(event) => patchSpec({ globalPrompt: event.target.value })}
        />
      </label>

      <div className="mt-4 overflow-hidden rounded-xl border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-muted)] p-2">
        <div className="flex min-w-[520px] gap-1">
          {spec.segments.map((segment, index) => (
            <div
              key={segment.panelId || index}
              className="min-w-[58px] rounded-md bg-[var(--glass-bg-surface)] px-2 py-2 text-center text-[11px] text-[var(--glass-text-secondary)]"
              style={{ flexGrow: segment.durationSeconds, flexBasis: 0 }}
            >
              <div>{t('shot', { number: index + 1 })}</div>
              <div className="mt-0.5 font-medium text-[var(--glass-text-primary)]">{segment.durationSeconds.toFixed(1)}s</div>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-4 space-y-3">
        {spec.segments.map((segment, index) => {
          const panel = panels[index]
          return (
            <article
              key={segment.panelId || index}
              className="grid gap-3 rounded-xl border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-muted)] p-3 md:grid-cols-[150px_minmax(0,1fr)]"
            >
              <div>
                <div className="relative aspect-video overflow-hidden rounded-lg bg-black/60">
                  {panel?.imageUrl ? (
                    <Image
                      src={panel.imageUrl}
                      alt={t('shot', { number: index + 1 })}
                      fill
                      sizes="150px"
                      unoptimized
                      className="object-cover"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-xs text-[var(--glass-text-tertiary)]">
                      {t('imageMissing')}
                    </div>
                  )}
                </div>
                <div className="mt-2 flex items-center justify-between text-xs">
                  <span className="font-medium text-[var(--glass-text-primary)]">{t('shot', { number: index + 1 })}</span>
                  <label className="flex items-center gap-1.5 text-[var(--glass-text-secondary)]">
                    <input
                      type="checkbox"
                      checked={segment.isEndFrame === true}
                      onChange={(event) => patchSegment(index, { isEndFrame: event.target.checked })}
                    />
                    {t('endFrame')}
                  </label>
                </div>
              </div>
              <div className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1 text-xs text-[var(--glass-text-secondary)]">
                    <span>{t('duration')}</span>
                    <GlassInput
                      type="number"
                      min={0.1}
                      max={60}
                      step={0.1}
                      value={segment.durationSeconds}
                      onChange={(event) => patchSegment(index, {
                        durationSeconds: Math.max(0.1, Number(event.target.value) || 0.1),
                      })}
                    />
                  </label>
                  <label className="space-y-1 text-xs text-[var(--glass-text-secondary)]">
                    <span>{t('guideStrengthValue', { value: (segment.guideStrength ?? 1).toFixed(2) })}</span>
                    <input
                      className="h-9 w-full accent-[var(--glass-accent-from)]"
                      type="range"
                      min={0}
                      max={2}
                      step={0.05}
                      value={segment.guideStrength ?? 1}
                      onChange={(event) => patchSegment(index, { guideStrength: Number(event.target.value) })}
                    />
                  </label>
                </div>
                <label className="block space-y-1 text-xs text-[var(--glass-text-secondary)]">
                  <span>{t('shotPrompt')}</span>
                  <GlassTextarea
                    rows={4}
                    value={segment.prompt}
                    onChange={(event) => patchSegment(index, { prompt: event.target.value })}
                  />
                </label>
              </div>
            </article>
          )
        })}
      </div>

      {!ready && (
        <p className="mt-3 text-xs text-[var(--glass-text-danger)]">
          {models.length === 0 ? t('modelRequired') : t('imagesRequired')}
        </p>
      )}
      {error && <p className="mt-3 text-xs text-[var(--glass-text-danger)]">{error}</p>}
      {storyboard.directorVideoUrl && (
        <div className="mt-4">
          <div className="mb-2 text-xs font-medium text-[var(--glass-text-secondary)]">{t('preview')}</div>
          <video
            className="max-h-[560px] w-full rounded-xl bg-black"
            src={storyboard.directorVideoUrl}
            controls
            preload="metadata"
          />
        </div>
      )}
    </section>
  )
}

export default function LtxDirectorWorkspace({
  projectId,
  episodeId,
  storyboards,
  clips,
  videoModels,
}: LtxDirectorWorkspaceProps) {
  const t = useTranslations('video.director')
  const directorModels = useMemo(
    () => videoModels.filter((model) => model.workflowFeatures?.ltxDirector === true),
    [videoModels],
  )

  return (
    <div className="space-y-4">
      <div className="glass-surface-soft rounded-xl p-4">
        <h2 className="text-base font-semibold text-[var(--glass-text-primary)]">LTX Director</h2>
        <p className="mt-1 text-sm text-[var(--glass-text-tertiary)]">{t('description')}</p>
      </div>
      {storyboards.map((storyboard, index) => (
        <DirectorStoryboardEditor
          key={storyboard.id}
          projectId={projectId}
          episodeId={episodeId}
          storyboard={storyboard}
          displayNumber={storyboard.groupSequence ?? (index + 1)}
          clips={clips}
          models={directorModels}
        />
      ))}
    </div>
  )
}
