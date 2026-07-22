'use client'

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'

import { apiFetch } from '@/lib/api-fetch'
import { checkApiResponse } from '@/lib/error-handler'
import { invalidateEpisodeStageQueries } from '@/lib/query/episode-stage-cache'
import { queryKeys } from '@/lib/query/keys'
import type { NovelPromotionStoryboard } from '@/types/project'
import { AppIcon } from '@/components/ui/icons'
import { GlassButton } from '@/components/ui/primitives'

export default function LtxDirectorControls({
  projectId,
  episodeId,
  storyboard,
}: {
  projectId: string
  episodeId: string
  storyboard: NovelPromotionStoryboard
}) {
  const t = useTranslations('storyboard')
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: async () => {
      const response = await apiFetch(`/api/novel-promotion/${projectId}/storyboard-director`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storyboardId: storyboard.id, fps: 24 }),
      })
      await checkApiResponse(response)
      return response.json()
    },
    onMutate: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all(projectId), exact: false })
    },
    onSettled: async () => {
      await invalidateEpisodeStageQueries(queryClient, projectId, episodeId)
      await queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all(projectId), exact: false })
    },
  })
  const ready = (storyboard.panels || []).length > 0
    && (storyboard.panels || []).length <= 8
    && (storyboard.panels || []).every((panel) => Boolean(panel.imageUrl))
  const running = mutation.isPending || storyboard.directorTaskRunning === true
  const error = mutation.error instanceof Error
    ? mutation.error.message
    : storyboard.directorTaskError

  return (
    <div className="mb-4 rounded-xl border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium">LTX Director</div>
          <div className="mt-1 text-xs text-[var(--glass-text-tertiary)]">
            {t('director.description')}
          </div>
        </div>
        <GlassButton
          variant="secondary"
          size="sm"
          disabled={!ready || running}
          onClick={() => mutation.mutate()}
        >
          <AppIcon name={running ? 'loader' : 'play'} className={running ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          <span>{running ? t('director.generating') : t('director.generate')}</span>
        </GlassButton>
      </div>
      {!ready && (
        <p className="mt-2 text-xs text-[var(--glass-text-tertiary)]">{t('director.imagesRequired')}</p>
      )}
      {error && <p className="mt-2 text-xs text-[var(--glass-text-danger)]">{error}</p>}
      {storyboard.directorVideoUrl && (
        <video
          className="mt-3 max-h-[420px] w-full rounded-lg bg-black"
          src={storyboard.directorVideoUrl}
          controls
          preload="metadata"
        />
      )}
    </div>
  )
}
