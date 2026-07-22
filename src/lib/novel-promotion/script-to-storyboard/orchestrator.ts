import { safeParseJsonArray } from '@/lib/json-repair'
import { buildCharactersIntroduction } from '@/lib/constants'
import { normalizeAnyError } from '@/lib/errors/normalize'
import { createScopedLogger } from '@/lib/logging/core'
import { mapWithConcurrency } from '@/lib/async/map-with-concurrency'
import {
  type ActingDirection,
  type CharacterAsset,
  type ClipCharacterRef,
  type LocationAsset,
  type PropAsset,
  type PhotographyRule,
  type StoryboardPanel,
  formatClipId,
  getFilteredAppearanceList,
  getFilteredFullDescription,
  getFilteredLocationsDescription,
} from '@/lib/storyboard-phases'
import {
  buildPromptAssetContext,
  compileAssetPromptFragments,
} from '@/lib/assets/services/asset-prompt-context'
import {
  DEFAULT_ANALYSIS_WORKFLOW_CONCURRENCY,
  normalizeWorkflowConcurrencyValue,
} from '@/lib/workflow-concurrency'
import type { ResolvedStoryboardRunSettings } from '@/lib/novel-promotion/six-grid/run-settings'
import {
  GRID_CLIP_COVERAGE_INVALID,
  GridStoryboardValidationError,
  validateGridActingDirections,
  validateGridEpisodePlan,
  validateGridPhotographyRules,
  validateGridSceneGroups,
  type PlannedGridSceneGroup,
} from '@/lib/novel-promotion/grid-storyboard/scene-planner'
import {
  isGridStoryboardMode,
  resolveStoryboardGridSpec,
  type StoryboardGridSpec,
} from '@/lib/novel-promotion/grid-storyboard/spec'
import {
  SixGridValidationError,
  validateSixGridActingDirections,
  validateSixGridEpisodePlan,
  validateSixGridPhotographyRules,
  validateAndNormalizeSixGridGroups,
  type PlannedSixGridSceneGroup,
} from '@/lib/novel-promotion/six-grid/scene-planner'

type JsonRecord = Record<string, unknown>
const orchestratorLogger = createScopedLogger({ module: 'worker.orchestrator.script_to_storyboard' })

export type ScriptToStoryboardStepMeta = {
  stepId: string
  stepAttempt?: number
  stepTitle: string
  stepIndex: number
  stepTotal: number
  dependsOn?: string[]
  groupId?: string
  parallelKey?: string
  retryable?: boolean
  blockedBy?: string[]
}

export type ScriptToStoryboardStepOutput = {
  text: string
  reasoning: string
}

type ClipInput = {
  id: string
  content: string | null
  characters: string | null
  location: string | null
  props?: string | null
  screenplay: string | null
}

export type ScriptToStoryboardPromptTemplates = {
  phase1PlanTemplate: string
  phase2CinematographyTemplate: string
  phase2ActingTemplate: string
  phase3DetailTemplate: string
}

export type ClipStoryboardPanels = {
  clipId: string
  clipIndex: number
  finalPanels: StoryboardPanel[]
  groupId?: string
  groupKey?: string
  groupSequence?: number
  sceneKey?: string
  incomingContinuity?: string
  outgoingContinuity?: string
}

export type ScriptToStoryboardOrchestratorInput = {
  concurrency?: number
  locale?: 'zh' | 'en'
  runSettings?: ResolvedStoryboardRunSettings
  clips: ClipInput[]
  novelPromotionData: {
    characters: CharacterAsset[]
    locations: LocationAsset[]
    props?: PropAsset[]
  }
  promptTemplates: ScriptToStoryboardPromptTemplates
  runStep: (
    meta: ScriptToStoryboardStepMeta,
    prompt: string,
    action: string,
    maxOutputTokens: number,
  ) => Promise<ScriptToStoryboardStepOutput>
}

export type ScriptToStoryboardOrchestratorResult = {
  clipPanels: ClipStoryboardPanels[]
  sixGridGroups?: ClipStoryboardPanels[]
  phase1PanelsByClipId: Record<string, StoryboardPanel[]>
  phase2CinematographyByClipId: Record<string, PhotographyRule[]>
  phase2ActingByClipId: Record<string, ActingDirection[]>
  phase3PanelsByClipId: Record<string, StoryboardPanel[]>
  sixGridPhase1PanelsByGroupId?: Record<string, StoryboardPanel[]>
  sixGridPhase2CinematographyByGroupId?: Record<string, PhotographyRule[]>
  sixGridPhase2ActingByGroupId?: Record<string, ActingDirection[]>
  sixGridPhase3PanelsByGroupId?: Record<string, StoryboardPanel[]>
  summary: {
    clipCount: number
    totalPanelCount: number
    totalStepCount: number
  }
}


export class JsonParseError extends Error {
  rawText: string
  constructor(message: string, rawText: string) {
    super(message)
    this.name = 'JsonParseError'
    this.rawText = rawText
  }
}

function parseJsonArray<T extends JsonRecord>(responseText: string, label: string): T[] {
  const rows = safeParseJsonArray(responseText)
  if (rows.length === 0) {
    throw new JsonParseError(`${label}: empty result`, responseText)
  }
  return rows as T[]
}


function parseClipCharacters(raw: string | null): ClipCharacterRef[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      throw new Error('characters field must be JSON array')
    }
    return parsed as ClipCharacterRef[]
  } catch (error) {
    throw new Error(`Invalid clip characters JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function parseClipProps(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      throw new Error('props field must be JSON array')
    }
    return parsed.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
  } catch (error) {
    throw new Error(`Invalid clip props JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function parseScreenplay(raw: string | null): unknown {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`Invalid clip screenplay JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function withStepMeta(
  stepId: string,
  stepTitle: string,
  stepIndex: number,
  stepTotal: number,
  extra?: Pick<ScriptToStoryboardStepMeta, 'dependsOn' | 'groupId' | 'parallelKey' | 'retryable' | 'blockedBy'>,
): ScriptToStoryboardStepMeta {
  return {
    stepId,
    stepTitle,
    stepIndex,
    stepTotal,
    ...extra,
  }
}

function mergePanelsWithRules(params: {
  finalPanels: StoryboardPanel[]
  photographyRules: PhotographyRule[]
  actingDirections: ActingDirection[]
}) {
  const { finalPanels, photographyRules, actingDirections } = params
  return finalPanels.map((panel, index) => {
    const rules = photographyRules.find((rule) => rule.panel_number === panel.panel_number)
    if (!rules) {
      throw new Error(`Missing photography rule for panel_number=${String(panel.panel_number)} at index=${index}`)
    }
    const acting = actingDirections.find((item) => item.panel_number === panel.panel_number)
    if (!acting) {
      throw new Error(`Missing acting direction for panel_number=${String(panel.panel_number)} at index=${index}`)
    }

    return {
      ...panel,
      photographyPlan: {
        composition: rules.composition,
        lighting: rules.lighting,
        colorPalette: rules.color_palette,
        atmosphere: rules.atmosphere,
        technicalNotes: rules.technical_notes,
      },
      actingNotes: acting.characters,
    }
  })
}

function requireAnalyzedDurations(panels: StoryboardPanel[], label: string): StoryboardPanel[] {
  if (panels.some((panel) => (
    typeof panel.duration !== 'number'
    || !Number.isFinite(panel.duration)
    || panel.duration <= 0
  ))) {
    throw new Error(`${label}: STORYBOARD_DURATION_INVALID`)
  }
  return panels
}

const MAX_STEP_ATTEMPTS = 3
const MAX_RETRY_DELAY_MS = 10_000

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function computeRetryDelayMs(attempt: number) {
  const base = Math.min(1_000 * Math.pow(2, Math.max(0, attempt - 1)), MAX_RETRY_DELAY_MS)
  const jitter = Math.floor(Math.random() * 300)
  return base + jitter
}

function shouldRetryStepError(error: unknown, message: string, retryable: boolean) {
  if (error instanceof JsonParseError) return true
  if (error instanceof GridStoryboardValidationError) return true
  if (error instanceof SixGridValidationError) return true
  if (retryable) return true
  const lowerMessage = message.toLowerCase()
  if (lowerMessage.includes('ark responses 调用失败')) return false
  if (lowerMessage.includes('invalidparameter')) return false
  if (lowerMessage.includes('unknown field')) return false
  return lowerMessage.includes('unexpected token')
    || lowerMessage.includes('unexpected end of json input')
    || lowerMessage.includes('json format invalid')
    || lowerMessage.includes('invalid json output')
    || lowerMessage.includes('parse')
}

export function getScriptToStoryboardStepErrorCode(error: unknown, fallbackCode: string): string {
  return error instanceof GridStoryboardValidationError || error instanceof SixGridValidationError
    ? error.code
    : fallbackCode
}

async function runStepWithRetry<T>(
  runStep: ScriptToStoryboardOrchestratorInput['runStep'],
  baseMeta: ScriptToStoryboardStepMeta,
  prompt: string,
  action: string,
  maxOutputTokens: number,
  parse: (text: string) => T,
): Promise<{ output: ScriptToStoryboardStepOutput; parsed: T }> {
  let lastError: Error | null = null
  let currentPrompt = prompt
  let previousOutputText = ''
  for (let attempt = 1; attempt <= MAX_STEP_ATTEMPTS; attempt++) {
    const meta = attempt === 1
      ? baseMeta
      : {
        ...baseMeta,
        stepId: baseMeta.stepId,
        stepAttempt: attempt,
        stepTitle: baseMeta.stepTitle,
      }
    try {
      const output = await runStep(meta, currentPrompt, action, maxOutputTokens)
      previousOutputText = output.text
      const parsed = parse(output.text)
      return { output, parsed }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      const normalizedError = normalizeAnyError(error, { context: 'worker' })
      const shouldRetry = attempt < MAX_STEP_ATTEMPTS
        && shouldRetryStepError(error, normalizedError.message, normalizedError.retryable)

      orchestratorLogger.error({
        action: 'orchestrator.step.retry',
        message: shouldRetry ? 'step failed, retrying' : 'step failed, no more retry',
        errorCode: getScriptToStoryboardStepErrorCode(error, normalizedError.code),
        retryable: normalizedError.retryable,
        details: {
          stepId: baseMeta.stepId,
          action,
          attempt,
          maxAttempts: MAX_STEP_ATTEMPTS,
        },
        error: {
          name: lastError.name,
          message: lastError.message,
          stack: lastError.stack,
        },
      })

      if (!shouldRetry) {
        break
      }
      if (error instanceof JsonParseError
        || error instanceof GridStoryboardValidationError
        || error instanceof SixGridValidationError) {
        const errorCode = getScriptToStoryboardStepErrorCode(error, normalizedError.code)
        currentPrompt = [
          prompt,
          'Correct the previous response. Return the complete corrected JSON only; do not explain the correction.',
          `Validation error code: ${errorCode}`,
          `Previous response (may be truncated): ${previousOutputText.slice(0, 4_000)}`,
        ].join('\n\n')
      }
      const retryDelayMs = computeRetryDelayMs(attempt)
      await wait(retryDelayMs)
    }
  }
  throw lastError!
}

async function runGridScriptToStoryboardOrchestrator(
  input: ScriptToStoryboardOrchestratorInput,
  concurrency: number,
  gridSpec: StoryboardGridSpec,
): Promise<ScriptToStoryboardOrchestratorResult> {
  const { clips, novelPromotionData, promptTemplates, runStep } = input
  const orderedClipIds = clips
    .filter((clip) => typeof clip.content === 'string' && !!clip.content.trim())
    .map((clip) => clip.id)
  const panelNumbers = Array.from({ length: gridSpec.panelCount }, (_, index) => index + 1)
  const formattedPanelNumbers = `[${panelNumbers.join(', ')}]`
  const panelCountWord = gridSpec.panelCount === 4 ? 'four' : 'six'
  const layout = `${gridSpec.columns}x${gridSpec.rows}`
  const episodePlanningPrompt = [
    `Plan the complete episode into continuous ${panelCountWord}-shot scene groups for a ${layout} storyboard layout.`,
    'Return JSON only: one array with no markdown fences or commentary.',
    `Every group must contain sceneKey, clipId, incomingContinuity, outgoingContinuity, and exactly ${panelCountWord} panels for the ${layout} layout.`,
    `Every panel must contain panel_number, description, location, source_text, characters, and duration. panel_number must be the integers 1 through ${gridSpec.panelCount} in order; description, location, and source_text must be non-empty strings; characters must be an array; duration must be a positive number of seconds. Optional props must be an array of non-empty strings.`,
    'Each panel.location must exactly equal its group sceneKey. sceneKey is the canonical location identity, not a free-form scene description.',
    'Never cross a hard location boundary to fill a group. Adjacent groups in the same scene must copy the previous outgoingContinuity exactly into incomingContinuity.',
    'Continuity anchors must preserve characters, clothing, props, lighting, and emotion.',
    `If source material is sparse, fill the ${gridSpec.panelCount} distinct panels with grounded reaction, environment, insert, or detail shots that remain faithful to the source; never use blank or duplicate panels.`,
    'If source material is dense, split it into additional consecutive groups. Preserve complete story coverage and do not drop any source event merely to fit a group.',
    'Allocate each panel duration independently from natural dialogue or narration speaking time, sequential action complexity, camera movement, pauses, and reactions. Never assign every panel a mechanical two seconds or one uniform duration.',
    'A panel must have enough duration to finish its story beat. If one beat would exceed a practical shot, split it across consecutive panels or groups instead of truncating dialogue or action.',
    `Immutable run settings: ${JSON.stringify(input.runSettings)}`,
    `Immutable grid spec: ${JSON.stringify(gridSpec)}`,
    `Complete episode clips: ${JSON.stringify(clips, null, 2)}`,
  ].join('\n\n')

  const { parsed: plannedGroups } = await runStepWithRetry(
    runStep,
    withStepMeta(
      'six_grid_episode_plan',
      'progress.streamStep.storyboardPlan',
      1,
      clips.length * 3 + 2,
      { groupId: 'six_grid_episode', parallelKey: 'phase1', retryable: true },
    ),
    episodePlanningPrompt,
    'storyboard_six_grid_scene_plan',
    8000,
    (text) => validateGridEpisodePlanForMode(
      parseJsonArray<JsonRecord>(text, 'grid-scene-plan'),
      orderedClipIds,
      gridSpec,
    ),
  )

  const totalStepCount = plannedGroups.length * 3 + 2
  const phase1PanelsByClipId = new Map<string, StoryboardPanel[]>()
  const phase2CinematographyByClipId = new Map<string, PhotographyRule[]>()
  const phase2ActingByClipId = new Map<string, ActingDirection[]>()
  const phase3PanelsByClipId = new Map<string, StoryboardPanel[]>()

  const clipPanels = await mapWithConcurrency(
    plannedGroups,
    concurrency,
    async (group, index): Promise<ClipStoryboardPanels> => {
      const clip = clips.find((candidate) => candidate.id === group.clipId)
      if (!clip) {
        if (gridSpec.mode === 'six_grid') {
          throw new SixGridValidationError('SIX_GRID_CLIP_COVERAGE_INVALID')
        }
        throw new GridStoryboardValidationError(GRID_CLIP_COVERAGE_INVALID, {
          mode: gridSpec.mode,
          expectedPanelCount: gridSpec.panelCount,
        })
      }
      const groupNumber = group.groupSequence
      const stepPrefix = `six_grid_group_${groupNumber}`
      phase1PanelsByClipId.set(group.groupId, group.panels)

      const clipCharacters = parseClipCharacters(clip.characters)
      const clipProps = parseClipProps(clip.props ?? null)
      const filteredFullDescription = getFilteredFullDescription(
        novelPromotionData.characters || [],
        clipCharacters,
      )
      const filteredLocationsDescription = getFilteredLocationsDescription(
        novelPromotionData.locations || [],
        group.sceneKey,
        input.locale ?? 'zh',
      )
      const filteredPropsDescription = compileAssetPromptFragments(buildPromptAssetContext({
        characters: [],
        locations: [],
        props: novelPromotionData.props || [],
        clipCharacters: [],
        clipLocation: null,
        clipProps,
      })).propsDescriptionText

      const phase2Meta = withStepMeta(
        `${stepPrefix}_phase2_cinematography`,
        'progress.streamStep.cinematographyRules',
        1 + index * 3 + 1,
        totalStepCount,
        {
          dependsOn: ['six_grid_episode_plan'],
          groupId: stepPrefix,
          parallelKey: 'phase2',
          retryable: true,
        },
      )
      const phase2ActingMeta = withStepMeta(
        `${stepPrefix}_phase2_acting`,
        'progress.streamStep.actingDirection',
        1 + index * 3 + 2,
        totalStepCount,
        {
          dependsOn: ['six_grid_episode_plan'],
          groupId: stepPrefix,
          parallelKey: 'phase2',
          retryable: true,
        },
      )
      const phase3Meta = withStepMeta(
        `${stepPrefix}_phase3_detail`,
        'progress.streamStep.storyboardDetailRefine',
        1 + index * 3 + 3,
        totalStepCount,
        {
          dependsOn: [phase2Meta.stepId, phase2ActingMeta.stepId],
          groupId: stepPrefix,
          parallelKey: 'phase3',
          retryable: true,
        },
      )

      const groupNumberingConstraint = [
        `For this group, panel_number must restart at 1 and contain exactly ${formattedPanelNumbers} in that order.`,
        `This group is arranged as a ${layout} storyboard.`,
        'Do not continue numbering from any previous group and do not use 0-based or episode-global numbering.',
        `Return exactly ${gridSpec.panelCount} distinct panels. Never add blanks or duplicate a panel to reach the required count.`,
        'Every panel must retain a positive duration calculated for its own complete dialogue, action, camera movement, pauses, and reaction. Do not normalize all durations to two seconds or a single value.',
        'Return the complete JSON array only.',
      ].join('\n')

      const phase2Prompt = `${promptTemplates.phase2CinematographyTemplate
        .replace('{panels_json}', JSON.stringify(group.panels, null, 2))
        .replace(/\{panel_count\}/g, String(gridSpec.panelCount))
        .replace('{locations_description}', filteredLocationsDescription)
        .replace('{characters_info}', filteredFullDescription)
        .replace('{props_description}', filteredPropsDescription)}\n\n${groupNumberingConstraint}`
      const phase2ActingPrompt = `${promptTemplates.phase2ActingTemplate
        .replace('{panels_json}', JSON.stringify(group.panels, null, 2))
        .replace(/\{panel_count\}/g, String(gridSpec.panelCount))
        .replace('{characters_info}', filteredFullDescription)}\n\n${groupNumberingConstraint}`
      const phase3Prompt = `${promptTemplates.phase3DetailTemplate
        .replace('{panels_json}', JSON.stringify(group.panels, null, 2))
        .replace('{characters_age_gender}', filteredFullDescription)
        .replace('{locations_description}', filteredLocationsDescription)
        .replace('{props_description}', filteredPropsDescription)}\n\n${groupNumberingConstraint}`

      const [{ parsed: photographyRules }, { parsed: actingDirections }] = await Promise.all([
        runStepWithRetry(
          runStep, phase2Meta, phase2Prompt, 'storyboard_phase2_cinematography', 2400,
          (text) => validateGridPhotographyRulesForMode(
            parseJsonArray<PhotographyRule>(text, `grid-cine:${groupNumber}`),
            gridSpec,
          ),
        ),
        runStepWithRetry(
          runStep, phase2ActingMeta, phase2ActingPrompt, 'storyboard_phase2_acting', 2400,
          (text) => validateGridActingDirectionsForMode(
            parseJsonArray<ActingDirection>(text, `grid-acting:${groupNumber}`),
            gridSpec,
          ),
        ),
      ])
      const { parsed: finalPanels } = await runStepWithRetry(
        runStep, phase3Meta, phase3Prompt, 'storyboard_phase3_detail', 2600,
        (text) => validateFinalGroup(
          group,
          parseJsonArray<StoryboardPanel>(text, `grid-detail:${groupNumber}`),
          gridSpec,
        ),
      )

      phase2CinematographyByClipId.set(group.groupId, photographyRules)
      phase2ActingByClipId.set(group.groupId, actingDirections)
      phase3PanelsByClipId.set(group.groupId, finalPanels)
      return {
        clipId: group.clipId,
        clipIndex: clips.findIndex((candidate) => candidate.id === group.clipId) + 1,
        groupId: group.groupId,
        groupKey: group.groupKey,
        groupSequence: group.groupSequence,
        sceneKey: group.sceneKey,
        incomingContinuity: group.incomingContinuity,
        outgoingContinuity: group.outgoingContinuity,
        finalPanels: mergePanelsWithRules({ finalPanels, photographyRules, actingDirections }),
      }
    },
  )

  const phase1ByGroupId = mapToRecord(phase1PanelsByClipId)
  const phase2CinematographyByGroupId = mapToRecord(phase2CinematographyByClipId)
  const phase2ActingByGroupId = mapToRecord(phase2ActingByClipId)
  const phase3ByGroupId = mapToRecord(phase3PanelsByClipId)
  return {
    clipPanels,
    sixGridGroups: clipPanels,
    phase1PanelsByClipId: phase1ByGroupId,
    phase2CinematographyByClipId: phase2CinematographyByGroupId,
    phase2ActingByClipId: phase2ActingByGroupId,
    phase3PanelsByClipId: phase3ByGroupId,
    sixGridPhase1PanelsByGroupId: phase1ByGroupId,
    sixGridPhase2CinematographyByGroupId: phase2CinematographyByGroupId,
    sixGridPhase2ActingByGroupId: phase2ActingByGroupId,
    sixGridPhase3PanelsByGroupId: phase3ByGroupId,
    summary: {
      clipCount: clips.length,
      totalPanelCount: clipPanels.length * gridSpec.panelCount,
      totalStepCount,
    },
  }
}

function validateGridEpisodePlanForMode(
  value: unknown,
  orderedClipIds: readonly string[],
  gridSpec: StoryboardGridSpec,
): Array<PlannedGridSceneGroup | PlannedSixGridSceneGroup> {
  return gridSpec.mode === 'six_grid'
    ? validateSixGridEpisodePlan(value, orderedClipIds)
    : validateGridEpisodePlan(value, orderedClipIds, gridSpec)
}

function validateGridPhotographyRulesForMode(
  value: unknown,
  gridSpec: StoryboardGridSpec,
): PhotographyRule[] {
  return gridSpec.mode === 'six_grid'
    ? validateSixGridPhotographyRules(value)
    : validateGridPhotographyRules(value, gridSpec)
}

function validateGridActingDirectionsForMode(
  value: unknown,
  gridSpec: StoryboardGridSpec,
): ActingDirection[] {
  return gridSpec.mode === 'six_grid'
    ? validateSixGridActingDirections(value)
    : validateGridActingDirections(value, gridSpec)
}

function validateFinalGroup(
  group: PlannedGridSceneGroup | PlannedSixGridSceneGroup,
  panels: StoryboardPanel[],
  gridSpec: StoryboardGridSpec,
): StoryboardPanel[] {
  const value = [{ ...group, panels }]
  return gridSpec.mode === 'six_grid'
    ? validateAndNormalizeSixGridGroups(value)[0].panels
    : validateGridSceneGroups(value, gridSpec)[0].panels
}

function mapToRecord<T>(source: Map<string, T>): Record<string, T> {
  const output: Record<string, T> = {}
  for (const [key, value] of source.entries()) output[key] = value
  return output
}

export async function runScriptToStoryboardOrchestrator(
  input: ScriptToStoryboardOrchestratorInput,
): Promise<ScriptToStoryboardOrchestratorResult> {
  const { clips, novelPromotionData, promptTemplates, runStep, concurrency: rawConcurrency } = input
  if (!Array.isArray(clips) || clips.length === 0) {
    throw new Error('No clips found')
  }
  const concurrency = normalizeWorkflowConcurrencyValue(
    rawConcurrency,
    DEFAULT_ANALYSIS_WORKFLOW_CONCURRENCY,
  )

  const storyboardGenerationMode = input.runSettings?.storyboardGenerationMode
  if (isGridStoryboardMode(storyboardGenerationMode)) {
    const ratio = input.runSettings?.sixGridCellAspectRatio
    const gridSpec = input.runSettings?.gridSpec
      || resolveStoryboardGridSpec(storyboardGenerationMode, ratio)
    return runGridScriptToStoryboardOrchestrator(input, concurrency, gridSpec)
  }

  const totalStepCount = clips.length * 4 + 2
  const charactersLibName = (novelPromotionData.characters || []).map((c) => c.name).join(', ') || '无'
  const locationsLibName = (novelPromotionData.locations || []).map((l) => l.name).join(', ') || '无'
  const charactersIntroduction = buildCharactersIntroduction(novelPromotionData.characters || [])

  const phase1PanelsByClipId = new Map<string, StoryboardPanel[]>()
  const phase2CinematographyByClipId = new Map<string, PhotographyRule[]>()
  const phase2ActingByClipId = new Map<string, ActingDirection[]>()
  const phase3PanelsByClipId = new Map<string, StoryboardPanel[]>()

  const clipPanels = await mapWithConcurrency(
    clips,
    concurrency,
    async (clip, index): Promise<ClipStoryboardPanels> => {
      const clipIndex = index + 1
      const clipContent = typeof clip.content === 'string' ? clip.content.trim() : ''
      if (!clipContent) {
        throw new Error(`Clip ${formatClipId(clip)} content is empty`)
      }
      const clipCharacters = parseClipCharacters(clip.characters)
      const clipLocation = clip.location || null
      const clipProps = parseClipProps(clip.props ?? null)
      const filteredAppearanceList = getFilteredAppearanceList(novelPromotionData.characters || [], clipCharacters)
      const filteredFullDescription = getFilteredFullDescription(novelPromotionData.characters || [], clipCharacters)
      const filteredLocationsDescription = getFilteredLocationsDescription(
        novelPromotionData.locations || [],
        clipLocation,
        input.locale ?? 'zh',
      )
      const filteredPropsDescription = compileAssetPromptFragments(buildPromptAssetContext({
        characters: [],
        locations: [],
        props: novelPromotionData.props || [],
        clipCharacters: [],
        clipLocation: null,
        clipProps,
      })).propsDescriptionText
      const clipJson = JSON.stringify(
        {
          id: clip.id,
          content: clipContent,
          characters: clipCharacters,
          location: clip.location || null,
          props: clipProps,
        },
        null,
        2,
      )

      let phase1Prompt = promptTemplates.phase1PlanTemplate
        .replace('{characters_lib_name}', charactersLibName)
        .replace('{locations_lib_name}', locationsLibName)
        .replace('{characters_introduction}', charactersIntroduction)
        .replace('{characters_appearance_list}', filteredAppearanceList)
        .replace('{characters_full_description}', filteredFullDescription)
        .replace('{props_description}', filteredPropsDescription)
        .replace('{clip_json}', clipJson)

      const screenplay = parseScreenplay(clip.screenplay)
      if (screenplay) {
        phase1Prompt = phase1Prompt.replace('{clip_content}', `【剧本格式】\n${JSON.stringify(screenplay, null, 2)}`)
      } else {
        phase1Prompt = phase1Prompt.replace('{clip_content}', clipContent)
      }

      const phase1Meta = withStepMeta(
        `clip_${clip.id}_phase1`,
        'progress.streamStep.storyboardPlan',
        clipIndex,
        totalStepCount,
        {
          groupId: `clip_${clip.id}`,
          parallelKey: 'phase1',
          retryable: true,
        },
      )
      const { parsed: planPanels } = await runStepWithRetry(
        runStep, phase1Meta, phase1Prompt, 'storyboard_phase1_plan', 2600,
        (text) => {
          const panels = parseJsonArray<StoryboardPanel>(text, `phase1:${formatClipId(clip)}`)
          if (panels.length === 0) {
            throw new Error(`Phase 1 returned empty panels for clip ${formatClipId(clip)}`)
          }
          return requireAnalyzedDurations(panels, `phase1:${formatClipId(clip)}`)
        },
      )
      phase1PanelsByClipId.set(clip.id, planPanels)

      const phase2Meta = withStepMeta(
        `clip_${clip.id}_phase2_cinematography`,
        'progress.streamStep.cinematographyRules',
        clips.length + index * 3 + 1,
        totalStepCount,
        {
          dependsOn: [`clip_${clip.id}_phase1`],
          groupId: `clip_${clip.id}`,
          parallelKey: 'phase2',
          retryable: true,
        },
      )
      const phase2ActingMeta = withStepMeta(
        `clip_${clip.id}_phase2_acting`,
        'progress.streamStep.actingDirection',
        clips.length + index * 3 + 2,
        totalStepCount,
        {
          dependsOn: [`clip_${clip.id}_phase1`],
          groupId: `clip_${clip.id}`,
          parallelKey: 'phase2',
          retryable: true,
        },
      )
      const phase3Meta = withStepMeta(
        `clip_${clip.id}_phase3_detail`,
        'progress.streamStep.storyboardDetailRefine',
        clips.length + index * 3 + 3,
        totalStepCount,
        {
          dependsOn: [
            `clip_${clip.id}_phase2_cinematography`,
            `clip_${clip.id}_phase2_acting`,
          ],
          groupId: `clip_${clip.id}`,
          parallelKey: 'phase3',
          retryable: true,
        },
      )

      const phase2Prompt = promptTemplates.phase2CinematographyTemplate
        .replace('{panels_json}', JSON.stringify(planPanels, null, 2))
        .replace(/\{panel_count\}/g, String(planPanels.length))
        .replace('{locations_description}', filteredLocationsDescription)
        .replace('{characters_info}', filteredFullDescription)
        .replace('{props_description}', filteredPropsDescription)

      const phase2ActingPrompt = promptTemplates.phase2ActingTemplate
        .replace('{panels_json}', JSON.stringify(planPanels, null, 2))
        .replace(/\{panel_count\}/g, String(planPanels.length))
        .replace('{characters_info}', filteredFullDescription)

      const phase3Prompt = promptTemplates.phase3DetailTemplate
        .replace('{panels_json}', JSON.stringify(planPanels, null, 2))
        .replace('{characters_age_gender}', filteredFullDescription)
        .replace('{locations_description}', filteredLocationsDescription)
        .replace('{props_description}', filteredPropsDescription)

      const [
        { parsed: photographyRules },
        { parsed: actingDirections },
      ] = await Promise.all([
        runStepWithRetry(
          runStep, phase2Meta, phase2Prompt, 'storyboard_phase2_cinematography', 2400,
          (text) => parseJsonArray<PhotographyRule>(text, `phase2:${formatClipId(clip)}`),
        ),
        runStepWithRetry(
          runStep, phase2ActingMeta, phase2ActingPrompt, 'storyboard_phase2_acting', 2400,
          (text) => parseJsonArray<ActingDirection>(text, `phase2-acting:${formatClipId(clip)}`),
        ),
      ])
      const { parsed: filteredPhase3Panels } = await runStepWithRetry(
        runStep, phase3Meta, phase3Prompt, 'storyboard_phase3_detail', 2600,
        (text) => {
          const panels = parseJsonArray<StoryboardPanel>(text, `phase3:${formatClipId(clip)}`)
          const filtered = panels.filter(
            (panel) => panel.description && panel.description !== '无' && panel.location !== '无',
          )
          if (filtered.length === 0) {
            throw new Error(`Phase 3 returned empty valid panels for clip ${formatClipId(clip)}`)
          }
          return requireAnalyzedDurations(filtered, `phase3:${formatClipId(clip)}`)
        },
      )

      phase2CinematographyByClipId.set(clip.id, photographyRules)
      phase2ActingByClipId.set(clip.id, actingDirections)
      phase3PanelsByClipId.set(clip.id, filteredPhase3Panels)

      return {
        clipId: clip.id,
        clipIndex,
        finalPanels: mergePanelsWithRules({
          finalPanels: filteredPhase3Panels,
          photographyRules,
          actingDirections,
        }),
      }
    },
  )

  const totalPanelCount = clipPanels.reduce((sum, item) => sum + item.finalPanels.length, 0)

  return {
    clipPanels,
    phase1PanelsByClipId: mapToRecord(phase1PanelsByClipId),
    phase2CinematographyByClipId: mapToRecord(phase2CinematographyByClipId),
    phase2ActingByClipId: mapToRecord(phase2ActingByClipId),
    phase3PanelsByClipId: mapToRecord(phase3PanelsByClipId),
    summary: {
      clipCount: clips.length,
      totalPanelCount,
      totalStepCount,
    },
  }
}
