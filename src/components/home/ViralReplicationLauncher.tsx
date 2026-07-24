'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'

import { AppIcon } from '@/components/ui/icons'
import ViralReplicationUploadField from '@/components/viral-replication/ViralReplicationUploadField'
import { ART_STYLES, VIDEO_RATIOS } from '@/lib/constants'
import { useRouter } from '@/i18n/navigation'
import type { StoryboardGenerationMode } from '@/lib/novel-promotion/six-grid/contracts'
import type { ViralTranscriptionMode } from '@/lib/viral-replication/transcription-mode'
import {
  createViralReplicationSession,
  getViralReplicationAvailability,
  uploadViralReplicationVideo,
} from '@/lib/viral-replication/client'

export const VIRAL_REPLICATION_MAX_FILE_BYTES = 500 * 1024 * 1024

export function validateViralReplicationVideoFile(file: File): 'formatError' | 'sizeError' | null {
  const extension = file.name.toLowerCase().split('.').pop()
  const supportedType = file.type === 'video/mp4' || file.type === 'video/quicktime'
  const supportedExtension = extension === 'mp4' || extension === 'mov'
  if (!supportedType && !supportedExtension) return 'formatError'
  if (file.size > VIRAL_REPLICATION_MAX_FILE_BYTES) return 'sizeError'
  return null
}

function resolveUploadErrorKey(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : ''
  if (code === 'ANALYSIS_MODEL_REQUIRED') return 'uploadErrors.analysisModelRequired'
  if (code === 'INVALID_VIDEO_DURATION') return 'uploadErrors.duration'
  if (code === 'VIRAL_VIDEO_TOO_LARGE') return 'uploadErrors.size'
  if (['INVALID_MEDIA_HEADER', 'UNSUPPORTED_MEDIA_TYPE', 'UNSUPPORTED_CONTAINER', 'UNSUPPORTED_CONTAINER_BRAND'].includes(code)) {
    return 'uploadErrors.format'
  }
  if (code === 'VIRAL_UPLOAD_CONFLICT' || code === 'VIRAL_UPLOAD_NOT_ALLOWED') return 'uploadErrors.conflict'
  if (code === 'UNAUTHORIZED') return 'uploadErrors.unauthorized'
  if (code === 'VIRAL_VIDEO_UPLOAD_NETWORK_FAILED') return 'uploadErrors.network'
  return 'genericError'
}

export default function ViralReplicationLauncher() {
  const t = useTranslations('home.viralReplication')
  const router = useRouter()
  const abortControllerRef = useRef<AbortController | null>(null)
  const [available, setAvailable] = useState<boolean | null>(null)
  const [open, setOpen] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [brief, setBrief] = useState('')
  const [videoRatio, setVideoRatio] = useState('9:16')
  const [artStyle, setArtStyle] = useState('realistic')
  const [storyboardGenerationMode, setStoryboardGenerationMode] = useState<StoryboardGenerationMode | ''>('')
  const [transcriptionMode, setTranscriptionMode] = useState<ViralTranscriptionMode>('auto')
  const [progress, setProgress] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [validationError, setValidationError] = useState<'formatError' | 'sizeError' | null>(null)
  const [submitErrorKey, setSubmitErrorKey] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void getViralReplicationAvailability()
      .then((result) => { if (active) setAvailable(result.available) })
      .catch(() => { if (active) setAvailable(false) })
    return () => {
      active = false
      abortControllerRef.current?.abort()
    }
  }, [])

  const reset = () => {
    abortControllerRef.current?.abort()
    abortControllerRef.current = null
    setFile(null)
    setBrief('')
    setVideoRatio('9:16')
    setArtStyle('realistic')
    setStoryboardGenerationMode('')
    setTranscriptionMode('auto')
    setProgress(0)
    setSubmitting(false)
    setValidationError(null)
    setSubmitErrorKey(null)
  }

  const close = () => {
    if (submitting) return
    setOpen(false)
    reset()
  }

  const selectFile = (nextFile: File | null) => {
    setSubmitErrorKey(null)
    if (!nextFile) {
      setFile(null)
      setValidationError(null)
      return
    }
    const issue = validateViralReplicationVideoFile(nextFile)
    setValidationError(issue)
    setFile(issue ? null : nextFile)
  }

  const submit = async () => {
    const normalizedBrief = brief.trim()
    if (!file || !normalizedBrief || !storyboardGenerationMode || submitting) return
    setSubmitting(true)
    setSubmitErrorKey(null)
    setProgress(0)
    const controller = new AbortController()
    abortControllerRef.current = controller
    try {
      const session = await createViralReplicationSession({
        brief: normalizedBrief,
        videoRatio,
        artStyle,
        storyboardGenerationMode,
        transcriptionMode,
      })
      const uploaded = await uploadViralReplicationVideo(session.id, file, {
        signal: controller.signal,
        onProgress: setProgress,
      })
      if (!uploaded.projectId) throw new Error('VIRAL_PROJECT_ID_MISSING')
      router.push({
        pathname: `/workspace/${uploaded.projectId}/viral-replication/${session.id}`,
      })
    } catch (error: unknown) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setSubmitErrorKey(resolveUploadErrorKey(error))
      }
    } finally {
      if (abortControllerRef.current === controller) abortControllerRef.current = null
      setSubmitting(false)
    }
  }

  return (
    <>
      <button
        type="button"
        disabled={available !== true}
        onClick={() => setOpen(true)}
        className="glass-btn-base flex h-10 items-center gap-1.5 border border-fuchsia-500/30 px-3 text-sm font-medium text-fuchsia-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <AppIcon name="sparkles" className="h-4 w-4" />
        {t('trigger')}
      </button>
      {available === false ? <span className="ml-2 text-xs text-[var(--glass-text-tertiary)]">{t('unavailable')}</span> : null}
      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm" onClick={close}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="viral-replication-title"
            className="glass-surface-modal max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl p-6"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <h2 id="viral-replication-title" className="text-lg font-bold text-[var(--glass-text-primary)]">{t('title')}</h2>
                <p className="mt-1 text-xs text-[var(--glass-text-tertiary)]">{t('subtitle')}</p>
              </div>
              <button type="button" disabled={submitting} onClick={close} aria-label={t('close')} className="glass-icon-btn-sm">
                <AppIcon name="close" className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-4">
              <ViralReplicationUploadField file={file} disabled={submitting} onFileChange={selectFile} />
              {validationError ? <p className="text-sm text-red-600">{t(validationError)}</p> : null}

              <div>
                <label htmlFor="viral-brief" className="mb-2 block text-sm font-medium text-[var(--glass-text-secondary)]">{t('briefLabel')}</label>
                <input
                  id="viral-brief"
                  value={brief}
                  maxLength={2_000}
                  disabled={submitting}
                  onChange={(event) => { setBrief(event.target.value); setSubmitErrorKey(null) }}
                  placeholder={t('briefPlaceholder')}
                  className="glass-input-base w-full px-4 py-3 text-sm"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="text-sm text-[var(--glass-text-secondary)]">
                  <span className="mb-2 block">{t('ratioLabel')}</span>
                  <select value={videoRatio} disabled={submitting} onChange={(event) => setVideoRatio(event.target.value)} className="glass-input-base w-full px-3 py-2">
                    {VIDEO_RATIOS.map((ratio) => <option key={ratio.value} value={ratio.value}>{ratio.label}</option>)}
                  </select>
                </label>
                <label className="text-sm text-[var(--glass-text-secondary)]">
                  <span className="mb-2 block">{t('styleLabel')}</span>
                  <select value={artStyle} disabled={submitting} onChange={(event) => setArtStyle(event.target.value)} className="glass-input-base w-full px-3 py-2">
                    {ART_STYLES.map((style) => <option key={style.value} value={style.value}>{t(`styles.${style.value}`)}</option>)}
                  </select>
                </label>
              </div>

              <label
                htmlFor="viral-storyboard-mode"
                className="block text-sm text-[var(--glass-text-secondary)]"
              >
                <span className="mb-2 block">{t('storyboardModeLabel')}</span>
                <select
                  id="viral-storyboard-mode"
                  value={storyboardGenerationMode}
                  disabled={submitting}
                  onChange={(event) => {
                    setStoryboardGenerationMode(event.target.value as StoryboardGenerationMode | '')
                    setSubmitErrorKey(null)
                  }}
                  className="glass-input-base w-full px-3 py-2"
                >
                  <option value="" disabled>{t('storyboardModePlaceholder')}</option>
                  <option value="individual">{t('storyboardModes.individual')}</option>
                  <option value="four_grid">{t('storyboardModes.four_grid')}</option>
                  <option value="six_grid">{t('storyboardModes.six_grid')}</option>
                </select>
              </label>

              <label
                htmlFor="viral-transcription-mode"
                className="block text-sm text-[var(--glass-text-secondary)]"
              >
                <span className="mb-2 block">{t('transcriptionModeLabel')}</span>
                <select
                  id="viral-transcription-mode"
                  aria-label={t('transcriptionModeLabel')}
                  value={transcriptionMode}
                  disabled={submitting}
                  onChange={(event) => setTranscriptionMode(event.target.value as ViralTranscriptionMode)}
                  className="glass-input-base w-full px-3 py-2"
                >
                  <option value="auto">{t('transcriptionModes.auto')}</option>
                  <option value="full_audio">{t('transcriptionModes.fullAudio')}</option>
                </select>
                <span className="mt-1 block text-xs text-[var(--glass-text-tertiary)]">
                  {t(`transcriptionModeHints.${transcriptionMode}`)}
                </span>
              </label>

              {submitting ? (
                <div data-testid="viral-upload-progress" className="text-sm text-[var(--glass-text-secondary)]">
                  {t('uploadProgress')} {progress}%
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--glass-bg-muted)]">
                    <div className="h-full bg-gradient-to-r from-blue-500 to-fuchsia-500 transition-[width]" style={{ width: `${progress}%` }} />
                  </div>
                </div>
              ) : null}
              {submitErrorKey ? (
                <div className="flex items-center justify-between gap-3 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-600">
                  <span>{t(submitErrorKey)}</span>
                  <button type="button" onClick={() => void submit()} className="font-semibold underline">{t('retry')}</button>
                </div>
              ) : null}

              <div className="flex justify-end gap-3 pt-2">
                <button type="button" disabled={submitting} onClick={close} className="glass-btn-base glass-btn-secondary px-4 py-2 text-sm">{t('cancel')}</button>
                <button
                  type="button"
                  disabled={!file || !brief.trim() || !storyboardGenerationMode || !!validationError || submitting}
                  onClick={() => void submit()}
                  className="glass-btn-base glass-btn-primary px-5 py-2 text-sm disabled:opacity-50"
                >
                  {t('start')}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
