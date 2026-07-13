import { useEffect, useMemo, useState } from 'react'
import type { VideoModelOption, VideoGenerationOptionValue, VideoGenerationOptions, VideoPanel } from '../../../types'
import type { CapabilitySelections } from '@/lib/model-config-contract'
import {
  normalizeVideoGenerationSelections,
  resolveEffectiveVideoCapabilityDefinitions,
  resolveEffectiveVideoCapabilityFields,
} from '@/lib/model-capabilities/video-effective'
import { projectVideoPricingTiersByFixedSelections } from '@/lib/model-pricing/video-tier'
import {
  resolvePanelVideoSubmission,
  type AvailablePanelVideoModel,
  type VideoModelReason,
} from '@/lib/novel-promotion/video/panel-video-submission'

interface UsePanelVideoModelParams {
  defaultVideoModel: string
  capabilityOverrides?: CapabilitySelections
  userVideoModels?: VideoModelOption[]
  dialogueVideoModel?: string | null
  panel: VideoPanel
  onSaveSettings?: (settings: {
    durationOverride?: number | null
    includeDialogueInVideoPrompt?: boolean
  }) => Promise<void>
}

interface CapabilityField {
  field: string
  label: string
  labelKey?: string
  unitKey?: string
  optionLabelKeys?: Record<string, string>
  options: VideoGenerationOptionValue[]
  disabledOptions?: VideoGenerationOptionValue[]
  value: VideoGenerationOptionValue | undefined
}

function toFieldLabel(field: string): string {
  return field.replace(/([A-Z])/g, ' $1').replace(/^./, (char) => char.toUpperCase())
}

function parseByOptionType(
  input: string,
  sample: VideoGenerationOptionValue,
): VideoGenerationOptionValue {
  if (typeof sample === 'number') return Number(input)
  if (typeof sample === 'boolean') return input === 'true'
  return input
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isGenerationOptionValue(value: unknown): value is VideoGenerationOptionValue {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function readSelectionForModel(
  capabilityOverrides: CapabilitySelections | undefined,
  modelKey: string,
): VideoGenerationOptions {
  if (!modelKey || !capabilityOverrides) return {}
  const rawSelection = capabilityOverrides[modelKey]
  if (!isRecord(rawSelection)) return {}

  const selection: VideoGenerationOptions = {}
  for (const [field, value] of Object.entries(rawSelection)) {
    if (field === 'aspectRatio') continue
    if (!isGenerationOptionValue(value)) continue
    selection[field] = value
  }
  return selection
}

export function usePanelVideoModel({
  defaultVideoModel,
  capabilityOverrides,
  userVideoModels,
  dialogueVideoModel,
  panel,
  onSaveSettings,
}: UsePanelVideoModelParams) {
  const automaticModel = panel.hasDialogue && dialogueVideoModel
    ? dialogueVideoModel
    : defaultVideoModel || ''
  const [selectedModel, setSelectedModelState] = useState(automaticModel)
  const [hasExplicitSelection, setHasExplicitSelection] = useState(false)
  const [durationOverride, setDurationOverrideState] = useState<number | null>(panel.durationOverride ?? null)
  const [durationOverrideDirty, setDurationOverrideDirty] = useState(false)
  const [includeDialogueInVideoPrompt, setIncludeDialogueInVideoPromptState] = useState(
    panel.includeDialogueInVideoPrompt ?? true,
  )
  const [dialogueInclusionDirty, setDialogueInclusionDirty] = useState(false)
  const [isSavingSettings, setIsSavingSettings] = useState(false)
  const [generationOptions, setGenerationOptions] = useState<VideoGenerationOptions>(() =>
    readSelectionForModel(capabilityOverrides, defaultVideoModel || ''),
  )
  const videoModelOptions = useMemo(() => userVideoModels ?? [], [userVideoModels])
  const selectedOption = videoModelOptions.find((option) => option.value === selectedModel)
  const pricingTiers = useMemo(
    () => projectVideoPricingTiersByFixedSelections({
      tiers: selectedOption?.videoPricingTiers ?? [],
      fixedSelections: {
        generationMode: 'normal',
      },
    }),
    [selectedOption?.videoPricingTiers],
  )

  useEffect(() => {
    if (!hasExplicitSelection) setSelectedModelState(automaticModel)
  }, [automaticModel, hasExplicitSelection])

  useEffect(() => {
    setDurationOverrideState(panel.durationOverride ?? null)
    setDurationOverrideDirty(false)
    setIncludeDialogueInVideoPromptState(panel.includeDialogueInVideoPrompt ?? true)
    setDialogueInclusionDirty(false)
  }, [panel.panelId, panel.durationOverride, panel.includeDialogueInVideoPrompt])

  useEffect(() => {
    if (!selectedModel) {
      if (videoModelOptions.length > 0) {
        setSelectedModelState(videoModelOptions[0].value)
      }
      return
    }
    if (videoModelOptions.some((option) => option.value === selectedModel)) return
    if (!panel.hasDialogue || !dialogueVideoModel) setSelectedModelState(videoModelOptions[0]?.value || '')
  }, [dialogueVideoModel, panel.hasDialogue, selectedModel, videoModelOptions])

  const capabilityDefinitions = useMemo(
    () => resolveEffectiveVideoCapabilityDefinitions({
      videoCapabilities: selectedOption?.capabilities?.video,
      pricingTiers,
    }),
    [pricingTiers, selectedOption?.capabilities?.video],
  )

  const selectedModelOverrides = useMemo(
    () => readSelectionForModel(capabilityOverrides, selectedModel),
    [capabilityOverrides, selectedModel],
  )
  const selectedModelOverridesSignature = useMemo(
    () => JSON.stringify(selectedModelOverrides),
    [selectedModelOverrides],
  )

  useEffect(() => {
    setGenerationOptions(normalizeVideoGenerationSelections({
      definitions: capabilityDefinitions,
      pricingTiers,
      selection: selectedModelOverrides,
    }))
  }, [selectedModel, selectedModelOverridesSignature, capabilityDefinitions, pricingTiers, selectedModelOverrides])

  useEffect(() => {
    setGenerationOptions((previous) => normalizeVideoGenerationSelections({
      definitions: capabilityDefinitions,
      pricingTiers,
      selection: previous,
    }))
  }, [capabilityDefinitions, pricingTiers])

  const effectiveFields = useMemo(
    () => resolveEffectiveVideoCapabilityFields({
      definitions: capabilityDefinitions,
      pricingTiers,
      selection: generationOptions,
    }),
    [capabilityDefinitions, generationOptions, pricingTiers],
  )
  const missingCapabilityFields = useMemo(
    () => effectiveFields
      .filter((field) => field.options.length === 0 || field.value === undefined)
      .map((field) => field.field),
    [effectiveFields],
  )
  const effectiveFieldMap = useMemo(
    () => new Map(effectiveFields.map((field) => [field.field, field])),
    [effectiveFields],
  )
  const definitionFieldMap = useMemo(
    () => new Map(capabilityDefinitions.map((definition) => [definition.field, definition])),
    [capabilityDefinitions],
  )
  const capabilityFields: CapabilityField[] = useMemo(() => {
    return capabilityDefinitions.map((definition) => {
      const effectiveField = effectiveFieldMap.get(definition.field)
      const enabledOptions = effectiveField?.options ?? []
      return {
        field: definition.field,
        label: toFieldLabel(definition.field),
        labelKey: definition.fieldI18n?.labelKey,
        unitKey: definition.fieldI18n?.unitKey,
        optionLabelKeys: definition.fieldI18n?.optionLabelKeys,
        options: definition.options as VideoGenerationOptionValue[],
        disabledOptions: (definition.options as VideoGenerationOptionValue[])
          .filter((option) => !enabledOptions.includes(option)),
        value: effectiveField?.value as VideoGenerationOptionValue | undefined,
      }
    })
  }, [capabilityDefinitions, effectiveFieldMap])

  const setCapabilityValue = (field: string, rawValue: string) => {
    const definitionField = definitionFieldMap.get(field)
    if (!definitionField || definitionField.options.length === 0) return
    const parsedValue = parseByOptionType(rawValue, definitionField.options[0])
    if (!definitionField.options.includes(parsedValue)) return
    setGenerationOptions((previous) => ({
      ...normalizeVideoGenerationSelections({
        definitions: capabilityDefinitions,
        pricingTiers,
        selection: {
          ...previous,
          [field]: parsedValue,
        },
        pinnedFields: [field],
      }),
    }))
  }

  const setSelectedModel = (modelKey: string) => {
    setHasExplicitSelection(true)
    setSelectedModelState(modelKey)
  }
  const setDurationOverride = (value: number | null) => {
    setDurationOverrideState(value)
    setDurationOverrideDirty(true)
  }
  const resetDurationOverride = () => setDurationOverride(null)
  const setIncludeDialogueInVideoPrompt = (value: boolean) => {
    setIncludeDialogueInVideoPromptState(value)
    setDialogueInclusionDirty(true)
  }
  const saveVideoSettings = async () => {
    if (!onSaveSettings || (!durationOverrideDirty && !dialogueInclusionDirty)) return
    setIsSavingSettings(true)
    try {
      await onSaveSettings({
        ...(durationOverrideDirty ? { durationOverride } : {}),
        ...(dialogueInclusionDirty ? { includeDialogueInVideoPrompt } : {}),
      })
      setDurationOverrideDirty(false)
      setDialogueInclusionDirty(false)
    } finally {
      setIsSavingSettings(false)
    }
  }

  const submissionPreview = useMemo(() => {
    const models: AvailablePanelVideoModel[] = videoModelOptions.map((option) => {
      const fixed = option.capabilities?.video?.durationOptions
      const range = option.capabilities?.video?.durationRange
      const requestedDefault = typeof generationOptions.duration === 'number'
        ? generationOptions.duration
        : durationOverride ?? panel.estimatedDuration ?? panel.textPanel?.duration ?? 5
      return {
        modelKey: option.value,
        available: option.disabled !== true,
        comfyWorkflowVersionId: option.workflowVersionId,
        duration: fixed?.length
          ? { kind: 'fixed' as const, options: fixed }
          : range
            ? { kind: 'range' as const, ...range }
          : { kind: 'provider_default' as const, duration: requestedDefault },
      }
    })
    try {
      return {
        result: resolvePanelVideoSubmission({
          panel: {
            ...panel,
            includeDialogueInVideoPrompt,
            videoPrompt: panel.textPanel?.video_prompt,
            durationOverride,
            legacyDuration: panel.textPanel?.duration,
          },
          project: { videoModel: defaultVideoModel, dialogueVideoModel },
          explicitModelSelection: hasExplicitSelection ? selectedModel : null,
          models,
        }),
        error: null,
      }
    } catch (error) {
      return { result: null, error: error instanceof Error ? error.message : String(error) }
    }
  }, [
    defaultVideoModel,
    dialogueVideoModel,
    durationOverride,
    generationOptions.duration,
    hasExplicitSelection,
    panel,
    includeDialogueInVideoPrompt,
    selectedModel,
    videoModelOptions,
  ])
  const modelReason: VideoModelReason | null = submissionPreview.result?.modelReason ?? null
  const durationRange = selectedOption?.capabilities?.video?.durationRange
  const fixedDurations = selectedOption?.capabilities?.video?.durationOptions ?? []
  const durationInput = durationRange ?? {
    min: fixedDurations.length ? Math.min(...fixedDurations) : 0.1,
    max: fixedDurations.length ? Math.max(...fixedDurations) : 360,
    step: 0.1,
  }

  return {
    selectedModel,
    setSelectedModel,
    generationOptions,
    capabilityFields,
    setCapabilityValue,
    missingCapabilityFields,
    videoModelOptions,
    modelReason,
    effectiveDuration: submissionPreview.result?.effectiveDuration ?? null,
    validationError: submissionPreview.error,
    durationOverride,
    setDurationOverride,
    resetDurationOverride,
    durationOverrideDirty,
    hasExplicitSelection,
    durationInput,
    includeDialogueInVideoPrompt,
    setIncludeDialogueInVideoPrompt,
    dialogueInclusionDirty,
    isSavingSettings,
    saveVideoSettings,
    hasSettingsChanges: durationOverrideDirty || dialogueInclusionDirty,
  }
}
