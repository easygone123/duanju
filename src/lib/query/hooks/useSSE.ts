'use client'
import { logError as _ulogError } from '@/lib/logging/core'

import { useEffect, useMemo, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../keys'
import { TASK_EVENT_TYPE, TASK_SSE_EVENT_TYPE, type SSEEvent } from '@/lib/task/types'
import { applyTaskLifecycleToOverlay } from '../task-target-overlay'
import { isTaskIntent, resolveTaskIntent } from '@/lib/task/intent'
import { applyWorkspaceTaskCompletion } from '../cache/task-event-patcher'
import { isEpisodeStage, type EpisodeStage } from '@/lib/novel-promotion/episode-stage-data'

type UseSSEOptions = {
  projectId?: string | null
  episodeId?: string | null
  enabled?: boolean
  onEvent?: (event: SSEEvent) => void
}

export function useSSE({ projectId, episodeId, enabled = true, onEvent }: UseSSEOptions) {
  const queryClient = useQueryClient()
  const sourceRef = useRef<EventSource | null>(null)
  const targetStatesInvalidateTimerRef = useRef<number | null>(null)
  const stageRecoveryTimerRef = useRef<number | null>(null)
  const pendingStageRecoveriesRef = useRef(new Set<string>())
  const viralReplicationInvalidateTimersRef = useRef(new Map<string, number>())
  const isGlobalAssetProject = projectId === 'global-asset-hub'

  const url = useMemo(() => {
    if (!projectId) return null
    const params = new URLSearchParams({ projectId })
    if (episodeId) params.set('episodeId', episodeId)
    return `/api/sse?${params}`
  }, [projectId, episodeId])

  useEffect(() => {
    if (!enabled || !url || !projectId) return

    const source = new EventSource(url)
    sourceRef.current = source
    const pendingStageRecoveries = pendingStageRecoveriesRef.current
    const viralReplicationInvalidateTimers = viralReplicationInvalidateTimersRef.current

    const invalidateViralReplication = (replicationId: string, immediate: boolean) => {
      const existingTimer = viralReplicationInvalidateTimers.get(replicationId)
      if (immediate) {
        if (existingTimer !== undefined) window.clearTimeout(existingTimer)
        viralReplicationInvalidateTimers.delete(replicationId)
        queryClient.invalidateQueries({
          queryKey: queryKeys.viralReplication.detail(replicationId),
          exact: true,
        })
        return
      }
      if (existingTimer !== undefined) return
      const timer = window.setTimeout(() => {
        viralReplicationInvalidateTimers.delete(replicationId)
        queryClient.invalidateQueries({
          queryKey: queryKeys.viralReplication.detail(replicationId),
          exact: true,
        })
      }, 250)
      viralReplicationInvalidateTimers.set(replicationId, timer)
    }

    const scheduleStageRecovery = (
      resolvedEpisodeId: string | null,
      stages: EpisodeStage[],
    ) => {
      if (!resolvedEpisodeId) return
      const recoveryStages = stages.length > 0 ? stages : ['config', 'script', 'storyboard', 'videos', 'voice']
      for (const stage of recoveryStages) {
        pendingStageRecoveries.add(`${resolvedEpisodeId}:${stage}`)
      }
      if (stageRecoveryTimerRef.current !== null) return
      stageRecoveryTimerRef.current = window.setTimeout(() => {
        const episodeIds = new Set<string>()
        for (const recovery of pendingStageRecoveries) {
          const separator = recovery.indexOf(':')
          const recoveryEpisodeId = recovery.slice(0, separator)
          const stage = recovery.slice(separator + 1)
          if (!isEpisodeStage(stage)) continue
          episodeIds.add(recoveryEpisodeId)
          queryClient.invalidateQueries({
            queryKey: queryKeys.episodeStage(projectId, recoveryEpisodeId, stage),
          })
        }
        for (const recoveryEpisodeId of episodeIds) {
          queryClient.invalidateQueries({
            queryKey: queryKeys.episodeData(projectId, recoveryEpisodeId),
          })
        }
        pendingStageRecoveries.clear()
        stageRecoveryTimerRef.current = null
      }, 250)
    }

    const inferStageRecovery = (
      targetType: string | null,
      taskType: string | null,
      eventPayload: Record<string, unknown> | null,
    ): EpisodeStage[] => {
      if (isEpisodeStage(eventPayload?.workspaceStage)) return [eventPayload.workspaceStage]
      if (targetType === 'NovelPromotionVoiceLine') return ['voice']
      if (targetType === 'NovelPromotionPanel') {
        if (taskType === 'video_panel' || taskType === 'lip_sync') return ['videos']
        return ['storyboard', 'videos']
      }
      if (targetType === 'NovelPromotionStoryboard' || targetType === 'NovelPromotionShot') {
        return ['storyboard', 'videos']
      }
      if (taskType === 'story_to_script_run' || taskType === 'clips_build') return ['script']
      if (taskType === 'script_to_storyboard_run') return ['storyboard', 'videos']
      if (taskType === 'voice_analyze' || taskType === 'voice_line') return ['voice']
      return []
    }

    const recoverByTarget = (
      targetType: string | null,
      targetId: string | null,
      taskType: string | null,
      resolvedEpisodeId: string | null,
      eventPayload: Record<string, unknown> | null,
    ) => {
      if (targetType === 'ViralReplication' && targetId) {
        invalidateViralReplication(targetId, true)
        return
      }
      if (isGlobalAssetProject) {
        if (targetType?.startsWith('GlobalCharacter')) {
          queryClient.invalidateQueries({ queryKey: queryKeys.globalAssets.characters() })
          return
        }
        if (targetType?.startsWith('GlobalLocation')) {
          queryClient.invalidateQueries({ queryKey: queryKeys.globalAssets.locations() })
          return
        }
        if (targetType?.startsWith('GlobalVoice')) {
          queryClient.invalidateQueries({ queryKey: queryKeys.globalAssets.voices() })
          return
        }
        queryClient.invalidateQueries({ queryKey: queryKeys.globalAssets.all() })
        return
      }

      if (targetType === 'CharacterAppearance' || targetType === 'NovelPromotionCharacter') {
        queryClient.invalidateQueries({ queryKey: queryKeys.projectAssets.characters(projectId) })
        queryClient.invalidateQueries({ queryKey: queryKeys.projectAssets.all(projectId) })
        return
      }
      if (targetType === 'LocationImage' || targetType === 'NovelPromotionLocation') {
        queryClient.invalidateQueries({ queryKey: queryKeys.projectAssets.locations(projectId) })
        queryClient.invalidateQueries({ queryKey: queryKeys.projectAssets.all(projectId) })
        return
      }
      if (targetType === 'NovelPromotionVoiceLine') {
        scheduleStageRecovery(resolvedEpisodeId, ['voice'])
        if (resolvedEpisodeId) {
          queryClient.invalidateQueries({ queryKey: queryKeys.voiceLines.all(resolvedEpisodeId) })
          queryClient.invalidateQueries({ queryKey: queryKeys.voiceLines.matched(projectId, resolvedEpisodeId) })
        }
        return
      }
      if (
        targetType === 'NovelPromotionPanel' ||
        targetType === 'NovelPromotionStoryboard' ||
        targetType === 'NovelPromotionShot'
      ) {
        scheduleStageRecovery(
          resolvedEpisodeId,
          inferStageRecovery(targetType, taskType, eventPayload),
        )
        return
      }
      if (targetType === 'NovelPromotionEpisode') {
        scheduleStageRecovery(
          resolvedEpisodeId,
          inferStageRecovery(targetType, taskType, eventPayload),
        )
        queryClient.invalidateQueries({ queryKey: queryKeys.projectData(projectId) })
        return
      }

      scheduleStageRecovery(
        resolvedEpisodeId,
        inferStageRecovery(targetType, taskType, eventPayload),
      )
    }

    const handleEvent = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data || '{}')
        if (!payload || !payload.type) return
        onEvent?.(payload as SSEEvent)
        const eventType = payload.type as string
        const targetType = typeof payload.targetType === 'string'
          ? payload.targetType
          : typeof payload?.payload?.targetType === 'string'
            ? payload.payload.targetType
            : null
        const targetId = typeof payload.targetId === 'string'
          ? payload.targetId
          : typeof payload?.payload?.targetId === 'string'
            ? payload.payload.targetId
            : null
        const eventEpisodeId = typeof payload.episodeId === 'string'
          ? payload.episodeId
          : typeof payload?.payload?.episodeId === 'string'
            ? payload.payload.episodeId
            : null
        const resolvedEpisodeId = eventEpisodeId || episodeId || null

        const eventPayload = payload?.payload && typeof payload.payload === 'object'
          ? (payload.payload as Record<string, unknown>)
          : null
        const rawLifecycleType =
          eventType === TASK_SSE_EVENT_TYPE.LIFECYCLE
            ? typeof eventPayload?.lifecycleType === 'string'
              ? eventPayload.lifecycleType
              : null
            : null
        const normalizedLifecycleType =
          rawLifecycleType === TASK_EVENT_TYPE.PROGRESS
            ? TASK_EVENT_TYPE.PROCESSING
            : rawLifecycleType
        const isLifecycleEvent = eventType === TASK_SSE_EVENT_TYPE.LIFECYCLE
        const shouldInvalidateTasksList =
          normalizedLifecycleType === TASK_EVENT_TYPE.CREATED ||
          normalizedLifecycleType === TASK_EVENT_TYPE.COMPLETED ||
          normalizedLifecycleType === TASK_EVENT_TYPE.FAILED ||
          (normalizedLifecycleType === TASK_EVENT_TYPE.PROCESSING &&
            typeof eventPayload?.progress !== 'number')
        const shouldInvalidateTargetStates =
          normalizedLifecycleType === TASK_EVENT_TYPE.COMPLETED ||
          normalizedLifecycleType === TASK_EVENT_TYPE.FAILED

        if (
          isLifecycleEvent
          && targetType === 'ViralReplication'
          && targetId
          && (
            normalizedLifecycleType === TASK_EVENT_TYPE.CREATED
            || normalizedLifecycleType === TASK_EVENT_TYPE.PROCESSING
          )
        ) {
          invalidateViralReplication(targetId, false)
        }

        if (isLifecycleEvent && shouldInvalidateTasksList) {
          queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all(projectId) })
        }
        if (isLifecycleEvent && shouldInvalidateTargetStates) {
          if (targetStatesInvalidateTimerRef.current === null) {
            targetStatesInvalidateTimerRef.current = window.setTimeout(() => {
              queryClient.invalidateQueries({ queryKey: queryKeys.tasks.targetStatesAll(projectId), exact: false })
              targetStatesInvalidateTimerRef.current = null
            }, 800)
          }
        }

        const payloadIntent = isTaskIntent(eventPayload?.intent)
          ? eventPayload.intent
          : resolveTaskIntent(typeof payload.taskType === 'string' ? payload.taskType : null)
        const payloadUi =
          eventPayload?.ui && typeof eventPayload.ui === 'object' && !Array.isArray(eventPayload.ui)
            ? (eventPayload.ui as Record<string, unknown>)
            : null
        const hasOutputAtStart =
          typeof payloadUi?.hasOutputAtStart === 'boolean'
            ? payloadUi.hasOutputAtStart
            : null

        applyTaskLifecycleToOverlay(queryClient, {
          projectId,
          lifecycleType: normalizedLifecycleType,
          targetType,
          targetId,
          taskId: typeof payload.taskId === 'string' ? payload.taskId : null,
          taskType: typeof payload.taskType === 'string' ? payload.taskType : null,
          intent: payloadIntent,
          hasOutputAtStart,
          progress: typeof eventPayload?.progress === 'number' ? Math.floor(eventPayload.progress) : null,
          stage: typeof eventPayload?.stage === 'string' ? eventPayload.stage : null,
          stageLabel: typeof eventPayload?.stageLabel === 'string' ? eventPayload.stageLabel : null,
          eventTs: typeof payload.ts === 'string' ? payload.ts : null,
        })

        if (
          normalizedLifecycleType === TASK_EVENT_TYPE.CREATED ||
          normalizedLifecycleType === TASK_EVENT_TYPE.PROCESSING
        ) {
          return
        }

        if (
          normalizedLifecycleType === TASK_EVENT_TYPE.COMPLETED ||
          normalizedLifecycleType === TASK_EVENT_TYPE.FAILED
        ) {
          if (
            normalizedLifecycleType === TASK_EVENT_TYPE.COMPLETED &&
            resolvedEpisodeId &&
            targetType !== 'ViralReplication'
          ) {
            const result = applyWorkspaceTaskCompletion(queryClient, {
              projectId,
              episodeId: resolvedEpisodeId,
              targetType,
              targetId,
              taskType: typeof payload.taskType === 'string' ? payload.taskType : null,
              payload: eventPayload,
            })
            if (result.handled) return
          }
          recoverByTarget(
            targetType,
            targetId,
            typeof payload.taskType === 'string' ? payload.taskType : null,
            resolvedEpisodeId,
            eventPayload,
          )
        }
      } catch (error) {
        _ulogError('[useSSE] failed to parse event', error)
      }
    }

    source.onmessage = handleEvent
    const namedEvents = [
      TASK_SSE_EVENT_TYPE.LIFECYCLE,
      TASK_SSE_EVENT_TYPE.STREAM,
    ] as const
    const listeners: Array<{ type: string; handler: EventListener }> = []
    for (const type of namedEvents) {
      const handler: EventListener = (event) => handleEvent(event as MessageEvent)
      source.addEventListener(type, handler)
      listeners.push({ type, handler })
    }
    source.onerror = (error) => {
      _ulogError('[useSSE] stream error', error)
    }

    return () => {
      if (targetStatesInvalidateTimerRef.current !== null) {
        window.clearTimeout(targetStatesInvalidateTimerRef.current)
        targetStatesInvalidateTimerRef.current = null
      }
      if (stageRecoveryTimerRef.current !== null) {
        window.clearTimeout(stageRecoveryTimerRef.current)
        stageRecoveryTimerRef.current = null
      }
      pendingStageRecoveries.clear()
      for (const timer of viralReplicationInvalidateTimers.values()) {
        window.clearTimeout(timer)
      }
      viralReplicationInvalidateTimers.clear()
      for (const listener of listeners) {
        source.removeEventListener(listener.type, listener.handler)
      }
      source.close()
      sourceRef.current = null
    }
  }, [enabled, url, projectId, episodeId, queryClient, isGlobalAssetProject, onEvent])

  return {
    connected: !!sourceRef.current && sourceRef.current.readyState === EventSource.OPEN,
  }
}
