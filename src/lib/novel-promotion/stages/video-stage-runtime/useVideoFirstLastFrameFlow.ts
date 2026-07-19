'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  VideoGenerationOptions,
  VideoModelOption,
  VideoPanel,
} from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video'
import {
  normalizeVideoGenerationSelections,
  resolveEffectiveVideoCapabilityDefinitions,
  resolveEffectiveVideoCapabilityFields,
} from '@/lib/model-capabilities/video-effective'
import { supportsFirstLastFrame } from '@/lib/model-capabilities/video-model-options'
import { projectVideoPricingTiersByFixedSelections } from '@/lib/model-pricing/video-tier'
import {
  resolveFrameLinkSubmission,
  type FrameLinkChoices,
} from '@/lib/novel-promotion/video/frame-link-resolver'
import { buildFirstLastFramePrompt } from '@/lib/novel-promotion/video/first-last-frame-prompt'

interface FirstLastFrameCapabilityField {
  field: string
  label: string
  options: VideoGenerationOptionValue[]
  disabledOptions?: VideoGenerationOptionValue[]
  value: VideoGenerationOptionValue | undefined
}

type VideoGenerationOptionValue = string | number | boolean

function parseByOptionType(
  input: string,
  sample: VideoGenerationOptionValue,
): VideoGenerationOptionValue {
  if (typeof sample === 'number') return Number(input)
  if (typeof sample === 'boolean') return input === 'true'
  return input
}

function toFieldLabel(field: string): string {
  return field.replace(/([A-Z])/g, ' $1').replace(/^./, (char) => char.toUpperCase())
}

interface UseVideoFirstLastFrameFlowParams {
  allPanels: VideoPanel[]
  linkedPanels: Map<string, boolean>
  frameLinkChoices: Map<string, FrameLinkChoices>
  automaticFrameLinkChoices: Map<string, FrameLinkChoices>
  videoPanelById: Map<string, VideoPanel>
  panelKeyById: Map<string, string>
  incomingSourcePanelIdsByPanelId: Map<string, string[]>
  videoModelOptions: VideoModelOption[]
  onGenerateVideo: (
    storyboardId: string,
    panelIndex: number,
    videoModel?: string,
    firstLastFrame?: {
      firstFrameSourcePanelId?: string
      lastFrameStoryboardId: string
      lastFramePanelIndex: number
      flModel: string
      customPrompt?: string
      supportsFirstLastFrame?: boolean
    },
    generationOptions?: VideoGenerationOptions,
    panelId?: string,
  ) => Promise<boolean>
}

export function useVideoFirstLastFrameFlow({
  allPanels,
  linkedPanels,
  frameLinkChoices,
  automaticFrameLinkChoices,
  videoPanelById,
  panelKeyById,
  incomingSourcePanelIdsByPanelId,
  videoModelOptions,
  onGenerateVideo,
}: UseVideoFirstLastFrameFlowParams) {
  const compatibleModelOptions = useMemo(
    () => videoModelOptions.filter((option) => supportsFirstLastFrame(option)),
    [videoModelOptions],
  )
  const [flModel, setFlModel] = useState(compatibleModelOptions[0]?.value || '')
  const [flGenerationOptions, setFlGenerationOptions] = useState<VideoGenerationOptions>({})
  const [flCustomPrompts, setFlCustomPrompts] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    setFlCustomPrompts((previous) => {
      const next = new Map(previous)
      const existingPanelKeys = new Set<string>()

      for (const panel of allPanels) {
        const panelKey = `${panel.storyboardId}-${panel.panelIndex}`
        existingPanelKeys.add(panelKey)
        if (!next.has(panelKey) && panel.firstLastFramePrompt?.trim()) {
          next.set(panelKey, panel.firstLastFramePrompt)
        }
      }

      for (const key of next.keys()) {
        if (!existingPanelKeys.has(key)) next.delete(key)
      }

      return next
    })
  }, [allPanels])

  useEffect(() => {
    if (!flModel && compatibleModelOptions.length > 0) {
      setFlModel(compatibleModelOptions[0].value)
      return
    }
    if (flModel && !videoModelOptions.some((option) => option.value === flModel)) {
      setFlModel(compatibleModelOptions[0]?.value || '')
    }
  }, [compatibleModelOptions, flModel, videoModelOptions])

  const selectedFlModelOption = useMemo(
    () => videoModelOptions.find((option) => option.value === flModel),
    [videoModelOptions, flModel],
  )
  const flModelSupportsFirstLastFrame = supportsFirstLastFrame(selectedFlModelOption || {})
  const flPricingTiers = useMemo(
    () => projectVideoPricingTiersByFixedSelections({
      tiers: selectedFlModelOption?.videoPricingTiers ?? [],
      fixedSelections: {
        generationMode: 'firstlastframe',
      },
    }),
    [selectedFlModelOption?.videoPricingTiers],
  )
  const flCapabilityDefinitions = useMemo(
    () => resolveEffectiveVideoCapabilityDefinitions({
      videoCapabilities: selectedFlModelOption?.capabilities?.video,
      pricingTiers: flPricingTiers,
    }),
    [flPricingTiers, selectedFlModelOption?.capabilities?.video],
  )

  useEffect(() => {
    setFlGenerationOptions((previous) => {
      return normalizeVideoGenerationSelections({
        definitions: flCapabilityDefinitions,
        pricingTiers: flPricingTiers,
        selection: previous,
      })
    })
  }, [flCapabilityDefinitions, flPricingTiers])

  const flEffectiveCapabilityFields = useMemo(
    () => resolveEffectiveVideoCapabilityFields({
      definitions: flCapabilityDefinitions,
      pricingTiers: flPricingTiers,
      selection: flGenerationOptions,
    }),
    [flCapabilityDefinitions, flGenerationOptions, flPricingTiers],
  )
  const flEffectiveFieldMap = useMemo(
    () => new Map(flEffectiveCapabilityFields.map((field) => [field.field, field])),
    [flEffectiveCapabilityFields],
  )
  const flDefinitionFieldMap = useMemo(
    () => new Map(flCapabilityDefinitions.map((definition) => [definition.field, definition])),
    [flCapabilityDefinitions],
  )

  const flCapabilityFields: FirstLastFrameCapabilityField[] = useMemo(() => {
    return flCapabilityDefinitions.map((definition) => {
      const effectiveField = flEffectiveFieldMap.get(definition.field)
      const enabledOptions = effectiveField?.options ?? []
      return {
        field: definition.field,
        label: toFieldLabel(definition.field),
        options: definition.options as VideoGenerationOptionValue[],
        disabledOptions: (definition.options as VideoGenerationOptionValue[])
          .filter((option) => !enabledOptions.includes(option)),
        value: effectiveField?.value as VideoGenerationOptionValue | undefined,
      }
    })
  }, [flCapabilityDefinitions, flEffectiveFieldMap])

  const flMissingCapabilityFields = useMemo(
    () => [
      ...(!flModelSupportsFirstLastFrame ? ['firstlastframe'] : []),
      ...flEffectiveCapabilityFields
      .filter((field) => field.options.length === 0 || field.value === undefined)
      .map((field) => field.field),
    ],
    [flEffectiveCapabilityFields, flModelSupportsFirstLastFrame],
  )

  const setFlCapabilityValue = useCallback((field: string, rawValue: string) => {
    const definitionField = flDefinitionFieldMap.get(field)
    if (!definitionField || definitionField.options.length === 0) return
    const parsedValue = parseByOptionType(rawValue, definitionField.options[0])
    if (!definitionField.options.includes(parsedValue)) return
    setFlGenerationOptions((previous) => ({
      ...normalizeVideoGenerationSelections({
        definitions: flCapabilityDefinitions,
        pricingTiers: flPricingTiers,
        selection: {
          ...previous,
          [field]: parsedValue,
        },
        pinnedFields: [field],
      }),
    }))
  }, [flCapabilityDefinitions, flDefinitionFieldMap, flPricingTiers])

  const setFlCustomPrompt = useCallback((panelKey: string, value: string) => {
    setFlCustomPrompts((previous) => new Map(previous).set(panelKey, value))
  }, [])

  const resetFlCustomPrompt = useCallback((panelKey: string) => {
    setFlCustomPrompts((previous) => {
      const next = new Map(previous)
      next.delete(panelKey)
      return next
    })
  }, [])

  const handleGenerateFirstLastFrame = useCallback(async (
    firstStoryboardId: string,
    firstPanelIndex: number,
    lastStoryboardId: string,
    lastPanelIndex: number,
    panelKey: string,
    generationOptions?: VideoGenerationOptions,
    firstPanelId?: string,
  ) => {
    const resolvedFrameLink = resolveFrameLinkSubmission({
      choices: frameLinkChoices.get(panelKey) || { firstFrame: null, lastFrame: null },
      supportsFirstLastFrame: flModelSupportsFirstLastFrame,
    })
    if (!resolvedFrameLink.submission) return
    const persistedCustomPrompt = allPanels.find(
      (panel) =>
        panel.storyboardId === firstStoryboardId
        && panel.panelIndex === firstPanelIndex,
    )?.firstLastFramePrompt
    const customPrompt = (flCustomPrompts.get(panelKey) ?? persistedCustomPrompt)?.trim() || undefined
    await onGenerateVideo(firstStoryboardId, firstPanelIndex, flModel, {
      firstFrameSourcePanelId: resolvedFrameLink.submission.firstFrameSourcePanelId,
      lastFrameStoryboardId: lastStoryboardId,
      lastFramePanelIndex: lastPanelIndex,
      flModel,
      customPrompt,
      supportsFirstLastFrame: flModelSupportsFirstLastFrame,
    }, generationOptions ?? flGenerationOptions, firstPanelId)
  }, [allPanels, flCustomPrompts, flGenerationOptions, flModel, flModelSupportsFirstLastFrame, frameLinkChoices, onGenerateVideo])

  const getDefaultFlPrompt = useCallback((firstPrompt?: string, lastPrompt?: string): string => {
    return buildFirstLastFramePrompt(firstPrompt, lastPrompt)
  }, [])

  const getNextPanel = useCallback((currentIndex: number): VideoPanel | null => {
    const current = allPanels[currentIndex]
    if (!current) return null
    const key = `${current.storyboardId}-${current.panelIndex}`
    const sourcePanelId = frameLinkChoices.get(key)?.lastFrame?.sourcePanelId
      || automaticFrameLinkChoices.get(key)?.lastFrame?.sourcePanelId
    if (!sourcePanelId) return null
    return videoPanelById.get(sourcePanelId) || null
  }, [allPanels, automaticFrameLinkChoices, frameLinkChoices, videoPanelById])

  const getPreviousPanel = useCallback((currentIndex: number): VideoPanel | null => {
    const current = allPanels[currentIndex]
    if (!current?.panelId) return null
    const sourcePanelId = incomingSourcePanelIdsByPanelId.get(current.panelId)?.[0]
    return sourcePanelId ? videoPanelById.get(sourcePanelId) || null : null
  }, [allPanels, incomingSourcePanelIdsByPanelId, videoPanelById])

  const isLinkedAsLastFrame = useCallback((currentIndex: number): boolean => {
    const current = allPanels[currentIndex]
    if (!current?.panelId) return false
    return (incomingSourcePanelIdsByPanelId.get(current.panelId) || []).some((sourcePanelId) => {
      const sourcePanelKey = panelKeyById.get(sourcePanelId)
      return !!sourcePanelKey && linkedPanels.get(sourcePanelKey) === true
    })
  }, [allPanels, incomingSourcePanelIdsByPanelId, linkedPanels, panelKeyById])

  const getFrameLinkChoices = useCallback((currentIndex: number): FrameLinkChoices => {
    const panel = allPanels[currentIndex]
    if (!panel) return { firstFrame: null, lastFrame: null }
    return frameLinkChoices.get(`${panel.storyboardId}-${panel.panelIndex}`)
      || { firstFrame: null, lastFrame: null }
  }, [allPanels, frameLinkChoices])

  return {
    flModel,
    flModelOptions: videoModelOptions,
    flModelSupportsFirstLastFrame,
    flGenerationOptions,
    flCapabilityFields,
    flMissingCapabilityFields,
    flCustomPrompts,
    setFlModel,
    setFlCapabilityValue,
    setFlCustomPrompt,
    resetFlCustomPrompt,
    handleGenerateFirstLastFrame,
    getDefaultFlPrompt,
    getNextPanel,
    getPreviousPanel,
    getFrameLinkChoices,
    isLinkedAsLastFrame,
  }
}
