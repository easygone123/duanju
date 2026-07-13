'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { logError as _ulogError } from '@/lib/logging/core'
import type { VideoPanel } from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video'
import {
  groupFrameLinkPanels,
  resolveFrameLinkChoices,
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

  const baseLinkedPanels = useMemo(() => {
    const map = new Map<string, boolean>()
    const storyboards = groupFrameLinkPanels(allPanels.map((panel) => ({
      ...panel,
      id: panel.panelId || `${panel.storyboardId}-${panel.panelIndex}`,
    })))
    allPanels.forEach((panel) => {
      const hasFrameMetadata = panel.firstFrameSourceMeta != null || panel.lastFrameSourceMeta != null
      const choices = resolveFrameLinkChoices({
        panelId: panel.panelId || `${panel.storyboardId}-${panel.panelIndex}`,
        storyboards,
      })
      if ((panel.layoutMode === 'six_grid' || hasFrameMetadata)
        ? !!choices.firstFrame && !!choices.lastFrame
        : panel.linkedToNextPanel) {
        map.set(`${panel.storyboardId}-${panel.panelIndex}`, true)
      }
    })
    return map
  }, [allPanels])

  const frameLinkChoices = useMemo(() => {
    const map = new Map<string, FrameLinkChoices>()
    const storyboards = groupFrameLinkPanels(allPanels.map((panel) => ({
      ...panel,
      id: panel.panelId || `${panel.storyboardId}-${panel.panelIndex}`,
    })))
    for (const panel of allPanels) {
      map.set(`${panel.storyboardId}-${panel.panelIndex}`, resolveFrameLinkChoices({
        panelId: panel.panelId || `${panel.storyboardId}-${panel.panelIndex}`,
        storyboards,
      }))
    }
    return map
  }, [allPanels])

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
    handleToggleLink,
    handleUpdateFrameLink,
  }
}
