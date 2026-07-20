'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'

import { useVirtualCardRetention } from '@/components/virtualization/VirtualCardRange'
import { apiFetch } from '@/lib/api-fetch'
import type { PanelNarrationMode } from '@/lib/novel-promotion/narration/state'
import { queryKeys } from '@/lib/query/keys'
import type { StoryboardPanel } from './useStoryboardState'

const narrationSnapshotSchema = z.object({
  narrationMode: z.enum(['auto', 'on', 'off']),
  narrationRecommended: z.boolean(),
  narrationSuggestedText: z.string().nullable(),
  narrationSuggestedEmotion: z.string().nullable(),
  narrationText: z.string().nullable(),
  narrationEmotion: z.string().nullable(),
  updatedAt: z.string().datetime({ offset: true }),
}).strict()

const narrationResponseSchema = z.object({
  success: z.literal(true),
  narration: narrationSnapshotSchema,
}).strict()

export type NarrationSnapshot = z.infer<typeof narrationSnapshotSchema>

type NarrationPatchBody = {
  mode: PanelNarrationMode; locale: 'zh' | 'en'; expectedPanelUpdatedAt: string
  manualText?: string | null; manualEmotion?: string | null
}

type NarrationPatchResult = { ok: true; narration: NarrationSnapshot }
  | { ok: false; message: string; recoverCanonical: boolean }

interface NarrationControlState {
  canonical: NarrationSnapshot | null
  draftMode: PanelNarrationMode
  manualText: string | null
  manualEmotion: string | null
  modeDirty: boolean
  manualTextDirty: boolean
  manualEmotionDirty: boolean
  saving: boolean
  errorMessage: string | null
}

interface UsePanelNarrationControlArgs { projectId: string; episodeId: string; panel: StoryboardPanel }

function parsePanelSnapshot(panel: StoryboardPanel): NarrationSnapshot | null {
  const parsed = narrationSnapshotSchema.safeParse({
    narrationMode: panel.narrationMode,
    narrationRecommended: panel.narrationRecommended,
    narrationSuggestedText: panel.narrationSuggestedText,
    narrationSuggestedEmotion: panel.narrationSuggestedEmotion,
    narrationText: panel.narrationText,
    narrationEmotion: panel.narrationEmotion,
    updatedAt: panel.updatedAt,
  })
  return parsed.success ? parsed.data : null
}

function normalizeDraftValue(value: string | null) { return value?.trim() || null }

function timestamp(value: string) { return Date.parse(value) }

function newestSnapshot(
  first: NarrationSnapshot,
  second: NarrationSnapshot | null,
): NarrationSnapshot {
  if (!second) return first
  return timestamp(second.updatedAt) > timestamp(first.updatedAt) ? second : first
}

function hasDirtyFields(state: NarrationControlState) {
  return state.modeDirty || state.manualTextDirty || state.manualEmotionDirty
}

function mergeCanonical(
  current: NarrationControlState,
  incoming: NarrationSnapshot,
): NarrationControlState {
  const modeDirty = current.modeDirty && current.draftMode !== incoming.narrationMode
  const manualTextDirty = current.manualTextDirty
    && normalizeDraftValue(current.manualText) !== normalizeDraftValue(incoming.narrationText)
  const manualEmotionDirty = current.manualEmotionDirty
    && normalizeDraftValue(current.manualEmotion) !== normalizeDraftValue(incoming.narrationEmotion)
  return {
    ...current,
    canonical: incoming,
    draftMode: modeDirty ? current.draftMode : incoming.narrationMode,
    manualText: manualTextDirty ? current.manualText : incoming.narrationText,
    manualEmotion: manualEmotionDirty ? current.manualEmotion : incoming.narrationEmotion,
    modeDirty,
    manualTextDirty,
    manualEmotionDirty,
  }
}

function adoptCanonical(canonical: NarrationSnapshot, saving: boolean): NarrationControlState {
  return {
    canonical,
    draftMode: canonical.narrationMode,
    manualText: canonical.narrationText,
    manualEmotion: canonical.narrationEmotion,
    modeDirty: false,
    manualTextDirty: false,
    manualEmotionDirty: false,
    saving,
    errorMessage: null,
  }
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

function initialState(panel: StoryboardPanel): NarrationControlState {
  const canonical = parsePanelSnapshot(panel)
  return {
    canonical,
    draftMode: canonical?.narrationMode ?? 'auto',
    manualText: canonical?.narrationText ?? null,
    manualEmotion: canonical?.narrationEmotion ?? null,
    modeDirty: false,
    manualTextDirty: false,
    manualEmotionDirty: false,
    saving: false,
    errorMessage: null,
  }
}

export function usePanelNarrationControl({
  projectId,
  episodeId,
  panel,
}: UsePanelNarrationControlArgs) {
  const t = useTranslations('storyboard.sixGrid.panel.narration')
  const locale = useLocale()
  const queryClient = useQueryClient()
  const [state, setReactState] = useState<NarrationControlState>(() => initialState(panel))
  const stateRef = useRef(state)
  const canonicalRef = useRef(state.canonical)
  const queuedCanonicalRef = useRef<NarrationSnapshot | null>(null)
  const savingRef = useRef(false)

  const setState = useCallback(
    (update: (current: NarrationControlState) => NarrationControlState) => {
      const next = update(stateRef.current)
      stateRef.current = next
      setReactState(next)
    },
    [],
  )

  useEffect(() => {
    const incoming = parsePanelSnapshot(panel)
    if (!incoming) return
    if (
      canonicalRef.current
      && timestamp(incoming.updatedAt) <= timestamp(canonicalRef.current.updatedAt)
    ) return

    canonicalRef.current = incoming
    if (savingRef.current) queuedCanonicalRef.current = incoming
    setState((current) => mergeCanonical(current, incoming))
  }, [panel.narrationEmotion, panel.narrationMode, panel.narrationRecommended,
    panel.narrationSuggestedEmotion, panel.narrationSuggestedText, panel.narrationText,
    panel.updatedAt, setState])

  const initializeManualDraft = useCallback((current: NarrationControlState) => ({
    text: current.manualText === null
      ? current.canonical?.narrationSuggestedText ?? null
      : current.manualText,
    emotion: current.manualEmotion === null
      ? current.canonical?.narrationSuggestedEmotion ?? null
      : current.manualEmotion,
  }), [])

  const selectMode = useCallback((mode: PanelNarrationMode) => {
    if (savingRef.current) return
    setState((current) => {
      const draft = current.draftMode === 'auto' && mode !== 'auto'
        ? initializeManualDraft(current)
        : { text: current.manualText, emotion: current.manualEmotion }
      return {
        ...current,
        draftMode: mode,
        manualText: draft.text,
        manualEmotion: draft.emotion,
        modeDirty: mode !== current.canonical?.narrationMode,
        errorMessage: null,
      }
    })
  }, [initializeManualDraft, setState])

  const editText = useCallback((value: string) => {
    if (savingRef.current) return
    setState((current) => {
      const draft = current.draftMode === 'auto'
        ? initializeManualDraft(current)
        : { text: current.manualText, emotion: current.manualEmotion }
      return {
        ...current,
        draftMode: current.draftMode === 'auto' ? 'on' : current.draftMode,
        manualText: value,
        manualEmotion: draft.emotion,
        modeDirty: current.draftMode === 'auto'
          ? current.canonical?.narrationMode !== 'on'
          : current.modeDirty,
        manualTextDirty: normalizeDraftValue(value)
          !== normalizeDraftValue(current.canonical?.narrationText ?? null),
        errorMessage: null,
      }
    })
  }, [initializeManualDraft, setState])

  const editEmotion = useCallback((value: string) => {
    if (savingRef.current) return
    setState((current) => {
      const draft = current.draftMode === 'auto'
        ? initializeManualDraft(current)
        : { text: current.manualText, emotion: current.manualEmotion }
      return {
        ...current,
        draftMode: current.draftMode === 'auto' ? 'on' : current.draftMode,
        manualText: draft.text,
        manualEmotion: value,
        modeDirty: current.draftMode === 'auto'
          ? current.canonical?.narrationMode !== 'on'
          : current.modeDirty,
        manualEmotionDirty: normalizeDraftValue(value)
          !== normalizeDraftValue(current.canonical?.narrationEmotion ?? null),
        errorMessage: null,
      }
    })
  }, [initializeManualDraft, setState])

  const invalidateDependentQueries = useCallback(() => {
    void Promise.all([
      queryClient.invalidateQueries({
        queryKey: queryKeys.episodeStage(projectId, episodeId, 'storyboard'),
      }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.episodeStage(projectId, episodeId, 'videos'),
      }),
      queryClient.invalidateQueries({ queryKey: queryKeys.episodeData(projectId, episodeId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.voiceLines.all(episodeId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.voiceLines.matched(projectId, episodeId) }),
    ]).catch(() => undefined)
  }, [episodeId, projectId, queryClient])

  const refreshCanonicalQueries = useCallback(async () => {
    const storyboardKey = queryKeys.episodeStage(projectId, episodeId, 'storyboard')
    const videosKey = queryKeys.episodeStage(projectId, episodeId, 'videos')
    const episodeKey = queryKeys.episodeData(projectId, episodeId)
    const allVoiceLinesKey = queryKeys.voiceLines.all(episodeId)
    const matchedVoiceLinesKey = queryKeys.voiceLines.matched(projectId, episodeId)
    try {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: storyboardKey, refetchType: 'none' }),
        queryClient.invalidateQueries({ queryKey: videosKey, refetchType: 'none' }),
        queryClient.invalidateQueries({ queryKey: episodeKey, refetchType: 'none' }),
        queryClient.invalidateQueries({ queryKey: allVoiceLinesKey, refetchType: 'none' }),
        queryClient.invalidateQueries({ queryKey: matchedVoiceLinesKey, refetchType: 'none' }),
      ])
      await Promise.all([
        queryClient.refetchQueries({ queryKey: storyboardKey }),
        queryClient.refetchQueries({ queryKey: episodeKey }),
      ])
    } catch {
      // Keep the local draft and original save error available for a later retry.
    }
  }, [episodeId, projectId, queryClient])

  const patchNarration = useCallback(async (
    body: NarrationPatchBody,
  ): Promise<NarrationPatchResult> => {
    try {
      const response = await apiFetch(
        `/api/novel-promotion/${projectId}/panels/${panel.id}/narration`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
      const payload: unknown = await response.json().catch(() => null)
      if (!response.ok) {
        const stale = isStaleError(payload)
        return {
          ok: false,
          message: stale ? t('stale') : t('failure'),
          recoverCanonical: stale,
        }
      }
      const parsed = narrationResponseSchema.safeParse(payload)
      if (!parsed.success || parsed.data.narration.narrationMode !== body.mode) {
        return { ok: false, message: t('failure'), recoverCanonical: true }
      }
      return { ok: true, narration: parsed.data.narration }
    } catch {
      return { ok: false, message: t('failure'), recoverCanonical: true }
    }
  }, [panel.id, projectId, t])

  const save = useCallback(async () => {
    if (savingRef.current) return
    const current = stateRef.current
    const canonical = canonicalRef.current
    if (!canonical) return

    const normalizedText = normalizeDraftValue(current.manualText)
    const normalizedEmotion = normalizeDraftValue(current.manualEmotion)
    if (current.draftMode === 'on' && !normalizedText) {
      setState((value) => ({ ...value, errorMessage: t('required') }))
      return
    }

    const body: NarrationPatchBody = {
      mode: current.draftMode,
      locale: locale.toLowerCase().startsWith('zh') ? 'zh' : 'en',
      expectedPanelUpdatedAt: canonical.updatedAt,
      ...(current.manualTextDirty
        && normalizedText !== normalizeDraftValue(canonical.narrationText)
        ? { manualText: normalizedText }
        : {}),
      ...(current.manualEmotionDirty
        && normalizedEmotion !== normalizeDraftValue(canonical.narrationEmotion)
        ? { manualEmotion: normalizedEmotion }
        : {}),
    }

    savingRef.current = true
    setState((value) => ({ ...value, saving: true, errorMessage: null }))
    let recognizedSuccess = false
    try {
      const result = await patchNarration(body)
      if (!result.ok) {
        setState((value) => ({ ...value, errorMessage: result.message }))
        if (result.recoverCanonical) await refreshCanonicalQueries()
        return
      }

      recognizedSuccess = true
      const latestProp = queuedCanonicalRef.current ?? canonicalRef.current
      const adopted = newestSnapshot(result.narration, latestProp)
      canonicalRef.current = adopted
      queuedCanonicalRef.current = null
      setState(() => adoptCanonical(adopted, true))
      invalidateDependentQueries()
    } finally {
      savingRef.current = false
      const queued = queuedCanonicalRef.current
      if (queued) {
        canonicalRef.current = canonicalRef.current
          ? newestSnapshot(canonicalRef.current, queued)
          : queued
      }
      queuedCanonicalRef.current = null
      setState((value) => {
        const latest = canonicalRef.current
        if (!latest) return { ...value, saving: false }
        if (recognizedSuccess) return adoptCanonical(latest, false)
        return { ...mergeCanonical(value, latest), saving: false }
      })
    }
  }, [invalidateDependentQueries, locale, patchNarration, refreshCanonicalQueries, setState, t])

  useVirtualCardRetention(hasDirtyFields(state) || state.saving || state.errorMessage !== null)

  const canonical = state.canonical
  return {
    available: canonical !== null,
    canonical,
    draftMode: state.draftMode,
    manualText: state.manualText,
    manualEmotion: state.manualEmotion,
    saving: state.saving,
    errorMessage: state.errorMessage,
    showFields: canonical !== null
      && ((state.draftMode === 'auto' && canonical.narrationRecommended) || state.draftMode === 'on'),
    displayedText: state.draftMode === 'auto'
      ? canonical?.narrationSuggestedText ?? null
      : state.manualText,
    displayedEmotion: state.draftMode === 'auto'
      ? canonical?.narrationSuggestedEmotion ?? null
      : state.manualEmotion,
    selectMode,
    editText,
    editEmotion,
    save,
  }
}
