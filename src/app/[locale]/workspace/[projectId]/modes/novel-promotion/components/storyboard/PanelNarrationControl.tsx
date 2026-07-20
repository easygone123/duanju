'use client'

import { useEffect, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { useQueryClient } from '@tanstack/react-query'

import { apiFetch } from '@/lib/api-fetch'
import type { PanelNarrationMode } from '@/lib/novel-promotion/narration/state'
import { queryKeys } from '@/lib/query/keys'
import type { StoryboardPanel } from './hooks/useStoryboardState'

type NarrationSnapshot = Pick<
  StoryboardPanel,
  | 'narrationMode'
  | 'narrationRecommended'
  | 'narrationSuggestedText'
  | 'narrationSuggestedEmotion'
  | 'narrationText'
  | 'narrationEmotion'
  | 'updatedAt'
>

interface PanelNarrationControlProps {
  projectId: string
  episodeId: string
  panel: StoryboardPanel
}

interface NarrationResponse {
  success: true
  narration: NarrationSnapshot
}

const modes: PanelNarrationMode[] = ['auto', 'on', 'off']

function snapshotFromPanel(panel: StoryboardPanel): NarrationSnapshot {
  return {
    narrationMode: panel.narrationMode,
    narrationRecommended: panel.narrationRecommended,
    narrationSuggestedText: panel.narrationSuggestedText,
    narrationSuggestedEmotion: panel.narrationSuggestedEmotion,
    narrationText: panel.narrationText,
    narrationEmotion: panel.narrationEmotion,
    updatedAt: panel.updatedAt,
  }
}

function timestamp(value: string) {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY
}

function isNarrationResponse(value: unknown): value is NarrationResponse {
  if (!value || typeof value !== 'object') return false
  const payload = value as { success?: unknown; narration?: unknown }
  if (payload.success !== true || !payload.narration || typeof payload.narration !== 'object') return false
  const narration = payload.narration as Record<string, unknown>
  return modes.includes(narration.narrationMode as PanelNarrationMode)
    && typeof narration.narrationRecommended === 'boolean'
    && typeof narration.updatedAt === 'string'
}

function isStaleError(value: unknown) {
  if (!value || typeof value !== 'object') return false
  const payload = value as {
    code?: unknown
    error?: { code?: unknown; details?: { code?: unknown } }
  }
  return payload.code === 'PANEL_NARRATION_STALE'
    || payload.error?.code === 'PANEL_NARRATION_STALE'
    || payload.error?.details?.code === 'PANEL_NARRATION_STALE'
}

export default function PanelNarrationControl({
  projectId,
  episodeId,
  panel,
}: PanelNarrationControlProps) {
  const t = useTranslations('storyboard.sixGrid.panel.narration')
  const locale = useLocale()
  const queryClient = useQueryClient()
  const initialSnapshot = snapshotFromPanel(panel)
  const canonicalRef = useRef(initialSnapshot)
  const [canonical, setCanonical] = useState(initialSnapshot)
  const [draftMode, setDraftMode] = useState<PanelNarrationMode>(initialSnapshot.narrationMode)
  const [manualText, setManualText] = useState<string | null>(initialSnapshot.narrationText)
  const [manualEmotion, setManualEmotion] = useState<string | null>(initialSnapshot.narrationEmotion)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    if (savingRef.current) return
    const incoming = snapshotFromPanel(panel)
    if (timestamp(incoming.updatedAt) <= timestamp(canonicalRef.current.updatedAt)) return
    canonicalRef.current = incoming
    setCanonical(incoming)
    setDraftMode(incoming.narrationMode)
    setManualText(incoming.narrationText)
    setManualEmotion(incoming.narrationEmotion)
    setErrorMessage(null)
  }, [
    panel.narrationEmotion,
    panel.narrationMode,
    panel.narrationRecommended,
    panel.narrationSuggestedEmotion,
    panel.narrationSuggestedText,
    panel.narrationText,
    panel.updatedAt,
  ])

  if (panel.hasDialogue) return null

  const initializeManualDraft = () => {
    const text = manualText === null ? canonical.narrationSuggestedText : manualText
    const emotion = manualEmotion === null ? canonical.narrationSuggestedEmotion : manualEmotion
    setManualText(text)
    setManualEmotion(emotion)
    return { text, emotion }
  }

  const selectMode = (mode: PanelNarrationMode) => {
    if (saving) return
    if (draftMode === 'auto' && mode !== 'auto') initializeManualDraft()
    setDraftMode(mode)
    setErrorMessage(null)
  }

  const editText = (value: string) => {
    if (draftMode === 'auto') {
      const draft = initializeManualDraft()
      setManualEmotion(draft.emotion)
      setDraftMode('on')
    }
    setManualText(value)
    setErrorMessage(null)
  }

  const editEmotion = (value: string) => {
    if (draftMode === 'auto') {
      const draft = initializeManualDraft()
      setManualText(draft.text)
      setDraftMode('on')
    }
    setManualEmotion(value)
    setErrorMessage(null)
  }

  const adoptCanonical = (next: NarrationSnapshot) => {
    canonicalRef.current = next
    setCanonical(next)
    setDraftMode(next.narrationMode)
    setManualText(next.narrationText)
    setManualEmotion(next.narrationEmotion)
    setErrorMessage(null)
  }

  const save = async () => {
    if (savingRef.current) return
    const normalizedText = manualText?.trim() || ''
    if (draftMode === 'on' && !normalizedText) {
      setErrorMessage(t('required'))
      return
    }

    savingRef.current = true
    setSaving(true)
    setErrorMessage(null)
    try {
      const apiLocale = locale.toLowerCase().startsWith('zh') ? 'zh' : 'en'
      const body = draftMode === 'on'
        ? {
            mode: draftMode,
            text: normalizedText,
            emotion: manualEmotion?.trim() || null,
            locale: apiLocale,
            expectedPanelUpdatedAt: canonicalRef.current.updatedAt,
          }
        : {
            mode: draftMode,
            locale: apiLocale,
            expectedPanelUpdatedAt: canonicalRef.current.updatedAt,
          }

      const response = await apiFetch(
        `/api/novel-promotion/${projectId}/panels/${panel.id}/narration`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
      const payload: unknown = await response.json().catch(() => null)
      if (!response.ok || !isNarrationResponse(payload)) {
        setErrorMessage(isStaleError(payload) ? t('stale') : t('failure'))
        return
      }

      adoptCanonical(payload.narration)
      void Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.episodeStage(projectId, episodeId, 'storyboard'),
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.episodeData(projectId, episodeId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.voiceLines.all(episodeId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.voiceLines.matched(projectId, episodeId) }),
      ])
    } catch {
      setErrorMessage(t('failure'))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const showFields = (draftMode === 'auto' && canonical.narrationRecommended) || draftMode === 'on'
  const displayedText = draftMode === 'auto' ? canonical.narrationSuggestedText : manualText
  const displayedEmotion = draftMode === 'auto' ? canonical.narrationSuggestedEmotion : manualEmotion

  return (
    <section
      data-testid="panel-narration-control"
      className="glass-surface-soft mb-3 rounded-lg border border-[var(--glass-stroke-base)] p-2.5"
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-semibold text-[var(--glass-text-primary)]">{t('title')}</span>
        <span
          className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${canonical.narrationRecommended
            ? 'border-[var(--glass-tone-success-fg)]/40 text-[var(--glass-tone-success-fg)]'
            : 'border-[var(--glass-stroke-base)] text-[var(--glass-text-tertiary)]'}`}
        >
          {canonical.narrationRecommended ? t('aiRecommended') : t('aiNotRecommended')}
        </span>
      </div>

      <div className="mb-2 flex rounded-lg border border-[var(--glass-stroke-base)] p-0.5" aria-label={t('title')}>
        {modes.map((mode) => (
          <button
            key={mode}
            type="button"
            aria-pressed={draftMode === mode}
            disabled={saving}
            onClick={() => selectMode(mode)}
            className={`min-w-0 flex-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${draftMode === mode
              ? 'bg-[var(--glass-accent-from)] text-white'
              : 'text-[var(--glass-text-secondary)] hover:bg-[var(--glass-bg-surface)]'}`}
          >
            {t(mode)}
          </button>
        ))}
      </div>

      <p className="mb-2 text-[10px] text-[var(--glass-text-tertiary)]">
        {draftMode === 'auto' ? t('aiHint') : t('manualHint')}
      </p>

      {showFields && (
        <div className="space-y-2">
          <label className="block text-[11px] font-medium text-[var(--glass-text-secondary)]">
            <span className="mb-1 block">{t('text')}</span>
            <textarea
              aria-label={t('text')}
              value={displayedText ?? ''}
              disabled={saving}
              rows={2}
              onChange={(event) => editText(event.target.value)}
              className="glass-textarea-base w-full resize-y px-2 py-1.5 text-xs leading-5 disabled:cursor-not-allowed disabled:opacity-50"
            />
          </label>
          <label className="block text-[11px] font-medium text-[var(--glass-text-secondary)]">
            <span className="mb-1 block">{t('emotion')}</span>
            <input
              aria-label={t('emotion')}
              value={displayedEmotion ?? ''}
              disabled={saving}
              onChange={(event) => editEmotion(event.target.value)}
              className="glass-input-base h-8 w-full px-2 text-xs disabled:cursor-not-allowed disabled:opacity-50"
            />
          </label>
        </div>
      )}

      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="min-h-4 flex-1" aria-live="polite">
          {errorMessage && <p role="alert" className="text-[11px] text-[var(--glass-tone-danger-fg)]">{errorMessage}</p>}
        </div>
        <button
          type="button"
          disabled={saving}
          onClick={() => void save()}
          className="glass-btn-base glass-btn-primary rounded-md px-3 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? t('saving') : t('save')}
        </button>
      </div>
    </section>
  )
}
