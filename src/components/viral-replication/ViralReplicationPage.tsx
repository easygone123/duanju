'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'

import { useRouter } from '@/i18n/navigation'
import { useSSE } from '@/lib/query/hooks/useSSE'
import {
  useGenerateViralReplication,
  usePatchViralReplicationBrief,
  useRetryViralReplication,
  useViralReplication,
} from '@/lib/query/hooks/useViralReplication'
import type { SSEEvent } from '@/lib/task/types'
import {
  VIRAL_ANALYSIS_FAILED,
  VIRAL_AUDIO_TRANSCRIPTION_FAILED,
  VIRAL_STORYBOARD_GENERATION_FAILED,
} from '@/lib/viral-replication/constants'
import {
  parseViralAnalysisReportForView,
  resolveViralReplicationViewState,
} from '@/lib/viral-replication/view-state'
import ViralAnalysisReport from './ViralAnalysisReport'
import ViralBriefEditor from './ViralBriefEditor'
import ViralGenerateAction from './ViralGenerateAction'
import ViralReplicationProgress from './ViralReplicationProgress'

function readProgress(event: SSEEvent, replicationId: string): number | null {
  const targetType = event.targetType || event.payload?.targetType
  const targetId = event.targetId || event.payload?.targetId
  if (targetType !== 'ViralReplication' || targetId !== replicationId) return null
  const progress = event.payload?.progress
  return typeof progress === 'number' && Number.isFinite(progress) ? progress : null
}

export default function ViralReplicationPage({
  projectId,
  replicationId,
}: {
  projectId: string
  replicationId: string
}) {
  const t = useTranslations('viralReplication')
  const router = useRouter()
  const query = useViralReplication(replicationId)
  const patchBrief = usePatchViralReplicationBrief(replicationId)
  const retry = useRetryViralReplication(replicationId)
  const generate = useGenerateViralReplication(replicationId)
  const [brief, setBrief] = useState('')
  const [progress, setProgress] = useState(0)
  const navigatedRef = useRef(false)
  const replication = query.data
  const replicationDetailId = replication?.id
  const replicationBrief = replication?.brief
  const viewState = replication ? resolveViralReplicationViewState(replication.status) : null
  const resolvedProjectId = replication?.project?.id || replication?.projectId || null
  const resolvedEpisodeId = replication?.episode?.id || replication?.episodeId || null
  const projectMatches = resolvedProjectId === projectId
  const failureMessage = replication?.errorMessage === VIRAL_STORYBOARD_GENERATION_FAILED
    ? t('errors.storyboardGeneration')
    : replication?.errorMessage === VIRAL_AUDIO_TRANSCRIPTION_FAILED
      ? t('errors.audioTranscription')
      : replication?.errorMessage === VIRAL_ANALYSIS_FAILED
        ? t('errors.analysis')
        : t('errors.generic')

  useEffect(() => {
    if (typeof replicationBrief === 'string') setBrief(replicationBrief)
  }, [replicationDetailId, replicationBrief])

  useEffect(() => {
    if (replication?.status === 'analyzing') setProgress((value) => value || 10)
    if (replication?.status === 'generating') setProgress((value) => value || 10)
  }, [replication?.status])

  const handleSseEvent = useCallback((event: SSEEvent) => {
    const nextProgress = readProgress(event, replicationId)
    if (nextProgress !== null) setProgress(Math.max(0, Math.min(100, nextProgress)))
  }, [replicationId])

  useSSE({
    projectId: resolvedProjectId,
    episodeId: resolvedEpisodeId,
    enabled: Boolean(viewState?.subscribeToSse && projectMatches),
    onEvent: handleSseEvent,
  })

  useEffect(() => {
    if (!replication || replication.status !== 'completed' || !projectMatches || navigatedRef.current) return
    navigatedRef.current = true
    router.replace({
      pathname: `/workspace/${projectId}`,
      query: {
        stage: 'storyboard',
        ...(resolvedEpisodeId ? { episode: resolvedEpisodeId } : {}),
      },
    })
  }, [projectId, projectMatches, replication, resolvedEpisodeId, router])

  if (query.isLoading) {
    return <PageShell><p className="text-[var(--glass-text-secondary)]">{t('states.loading')}</p></PageShell>
  }
  if (query.error || !replication) {
    return <PageShell><ErrorCard message={t('errors.generic')} /></PageShell>
  }
  if (!projectMatches) {
    return <PageShell><ErrorCard message={t('errors.projectMismatch')} /></PageShell>
  }

  const parsedReport = parseViralAnalysisReportForView(replication.reportJson, replication.durationMs)

  return (
    <PageShell title={replication.project?.name || t('title')}>
      {viewState?.kind === 'uploading' ? (
        <StatusCard title={t('states.uploading')} message={t('states.uploadingValidation')} />
      ) : null}

      {viewState?.kind === 'analyzing' ? (
        <ViralReplicationProgress status="analyzing" progress={progress} />
      ) : null}

      {viewState?.kind === 'failed' ? (
        <ErrorCard message={failureMessage}>
          <button
            type="button"
            disabled={retry.isPending}
            onClick={() => void retry.mutateAsync()}
            className="glass-btn-base glass-btn-primary mt-4 px-4 py-2 text-sm disabled:opacity-50"
          >
            {t('actions.retry')}
          </button>
        </ErrorCard>
      ) : null}

      {viewState?.kind === 'completed' ? (
        <StatusCard title={t('states.completed')} message={t('states.redirecting')} />
      ) : null}

      {viewState?.kind === 'review_ready' || viewState?.kind === 'generating' ? (
        <div className="space-y-6">
          {viewState.kind === 'generating' ? (
            <ViralReplicationProgress status="generating" progress={progress} />
          ) : null}
          {parsedReport ? <ViralAnalysisReport report={parsedReport} /> : <ErrorCard message={t('errors.invalidReport')} />}
          <ViralBriefEditor
            value={brief}
            disabled={!viewState.editable}
            saving={patchBrief.isPending}
            onChange={setBrief}
            onSave={() => void patchBrief.mutateAsync(brief.trim())}
          />
          {viewState.kind === 'review_ready' && parsedReport ? (
            <ViralGenerateAction
              disabled={!brief.trim()}
              pending={patchBrief.isPending || generate.isPending}
              onGenerate={() => {
                const nextBrief = brief.trim()
                void (async () => {
                  await patchBrief.mutateAsync(nextBrief)
                  await generate.mutateAsync(nextBrief)
                })()
              }}
            />
          ) : null}
        </div>
      ) : null}
    </PageShell>
  )
}

function PageShell({
  title,
  children,
}: {
  title?: string
  children: React.ReactNode
}) {
  const t = useTranslations('viralReplication')
  return (
    <main className="min-h-screen bg-[var(--glass-bg-canvas)] px-4 py-10 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl">
        <header className="mb-8">
          <p className="mb-2 text-sm font-medium text-[var(--glass-accent-from)]">{t('eyebrow')}</p>
          <h1 className="text-2xl font-bold text-[var(--glass-text-primary)]">{title || t('title')}</h1>
        </header>
        <div className="space-y-6">{children}</div>
      </div>
    </main>
  )
}

function StatusCard({ title, message }: { title: string; message: string }) {
  return (
    <section className="rounded-2xl border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] p-6">
      <h2 className="font-semibold text-[var(--glass-text-primary)]">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-[var(--glass-text-secondary)]">{message}</p>
    </section>
  )
}

function ErrorCard({ message, children }: { message: string; children?: React.ReactNode }) {
  return (
    <section role="alert" className="rounded-2xl border border-[var(--glass-tone-danger-fg)]/30 bg-[var(--glass-tone-danger-bg)] p-6">
      <p className="text-sm text-[var(--glass-tone-danger-fg)]">{message}</p>
      {children}
    </section>
  )
}
