'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { logError as _ulogError } from '@/lib/logging/core'
import type { VideoPanel } from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video'
import {
  buildFrameLinkResolutionIndex,
  groupFrameLinkPanels,
  type FrameLinkChoices,
} from '@/lib/novel-promotion/video/frame-link-resolver'

interface MutationLike<TInput = unknown> {
  mutateAsync: (input: TInput) => Promise<unknown>
}

interface UseVideoPanelLinkingParams {
  allPanels: VideoPanel[]
  updatePanelLinkMutation: MutationLike<{
    storyboardId: string
    panelIndex: number
    linked?: boolean
    action?: 'replace' | 'clear' | 'unlink' | 'restore-auto'
    frame?: 'first' | 'last'
    sourcePanelId?: string
  }>
}

export function useVideoPanelLinking({
  allPanels,
  updatePanelLinkMutation,
}: UseVideoPanelLinkingParams) {
  const [linkedOverrides, setLinkedOverrides] = useState<Map<string, boolean>>(new Map())

  const frameLinkResolution = useMemo(() => {
    const baseLinkedPanels = new Map<string, boolean>()
    const frameLinkChoices = new Map<string, FrameLinkChoices>()
    const automaticFrameLinkChoices = new Map<string, FrameLinkChoices>()
    const videoPanelById = new Map<string, VideoPanel>()
    const panelKeyById = new Map<string, string>()
    const storyboards = groupFrameLinkPanels(allPanels.map((panel) => ({
      ...panel,
      id: panel.panelId || `${panel.storyboardId}-${panel.panelIndex}`,
    })))
    const index = buildFrameLinkResolutionIndex({ storyboards })
    allPanels.forEach((panel) => {
      const panelKey = `${panel.storyboardId}-${panel.panelIndex}`
      const panelId = panel.panelId || panelKey
      const hasFrameMetadata = panel.firstFrameSourceMeta != null || panel.lastFrameSourceMeta != null
      const choices = index.choicesByPanelId.get(panelId) || { firstFrame: null, lastFrame: null }
      frameLinkChoices.set(panelKey, choices)
      automaticFrameLinkChoices.set(
        panelKey,
        index.automaticChoicesByPanelId.get(panelId) || { firstFrame: null, lastFrame: null },
      )
      videoPanelById.set(panelId, panel)
      panelKeyById.set(panelId, panelKey)
      if ((panel.layoutMode === 'four_grid' || panel.layoutMode === 'six_grid' || hasFrameMetadata)
        ? !!choices.firstFrame && !!choices.lastFrame
        : panel.linkedToNextPanel) {
        baseLinkedPanels.set(panelKey, true)
      }
    })
    return {
      baseLinkedPanels,
      frameLinkChoices,
      automaticFrameLinkChoices,
      videoPanelById,
      panelKeyById,
      incomingSourcePanelIdsByPanelId: index.incomingSourcePanelIdsByPanelId,
    }
  }, [allPanels])

  const {
    baseLinkedPanels,
    frameLinkChoices,
    automaticFrameLinkChoices,
    videoPanelById,
    panelKeyById,
    incomingSourcePanelIdsByPanelId,
  } = frameLinkResolution

  const panelKeys = useMemo(() => {
    const keys = new Set<string>()
    allPanels.forEach((panel) => {
      keys.add(`${panel.storyboardId}-${panel.panelIndex}`)
    })
    return keys
  }, [allPanels])

  const linkedPanels = useMemo(() => {
    const merged = new Map(baseLinkedPanels)
    linkedOverrides.forEach((value, key) => {
      if (value) merged.set(key, true)
      else merged.delete(key)
    })
    return merged
  }, [baseLinkedPanels, linkedOverrides])

  useEffect(() => {
    setLinkedOverrides((previous) => {
      if (previous.size === 0) return previous
      const next = new Map(previous)
      let changed = false
      previous.forEach((value, key) => {
        if (!panelKeys.has(key)) {
          next.delete(key)
          changed = true
          return
        }
        const baseValue = baseLinkedPanels.get(key) === true
        if (baseValue === value) {
          next.delete(key)
          changed = true
        }
      })
      return changed ? next : previous
    })
  }, [baseLinkedPanels, panelKeys])

  const applyOverride = useCallback((key: string, value: boolean) => {
    setLinkedOverrides((previous) => {
      const next = new Map(previous)
      const baseValue = baseLinkedPanels.get(key) === true
      if (baseValue === value) next.delete(key)
      else next.set(key, value)
      return next
    })
  }, [baseLinkedPanels])

  const handleToggleLink = useCallback(async (panelKey: string, storyboardId: string, panelIndex: number) => {
    const currentLinked = linkedPanels.get(panelKey) || false
    const newLinked = !currentLinked

    applyOverride(panelKey, newLinked)

    try {
      await updatePanelLinkMutation.mutateAsync({
        storyboardId,
        panelIndex,
        linked: newLinked,
      })
    } catch (error) {
      _ulogError('Failed to save link state:', error)
      applyOverride(panelKey, currentLinked)
    }
  }, [applyOverride, linkedPanels, updatePanelLinkMutation])

  const handleUpdateFrameLink = useCallback(async (
    panelKey: string,
    storyboardId: string,
    panelIndex: number,
    input: {
      action: 'replace' | 'clear' | 'unlink' | 'restore-auto'
      frame?: 'first' | 'last'
      sourcePanelId?: string
    },
  ) => {
    const wasLinked = linkedPanels.get(panelKey) || false
    const nextLinked = input.action !== 'clear' && input.action !== 'unlink'
    applyOverride(panelKey, nextLinked)
    try {
      await updatePanelLinkMutation.mutateAsync({ storyboardId, panelIndex, ...input })
    } catch (error) {
      _ulogError('Failed to update frame link:', error)
      applyOverride(panelKey, wasLinked)
    }
  }, [applyOverride, linkedPanels, updatePanelLinkMutation])

  return {
    linkedPanels,
    frameLinkChoices,
    automaticFrameLinkChoices,
    videoPanelById,
    panelKeyById,
    incomingSourcePanelIdsByPanelId,
    handleToggleLink,
    handleUpdateFrameLink,
  }
}
