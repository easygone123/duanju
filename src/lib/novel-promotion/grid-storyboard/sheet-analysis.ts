import { z } from 'zod'

import { executeAiVisionStep } from '@/lib/ai-runtime/client'
import { safeParseJsonArray } from '@/lib/json-repair'

const FOUR_GRID_PANEL_COUNT = 4
const MAX_PROMPT_LENGTH = 12_000

const analysisRowSchema = z.object({
  panel_number: z.number().int().min(1).max(FOUR_GRID_PANEL_COUNT),
  description: z.string().trim().min(1).max(MAX_PROMPT_LENGTH),
  image_prompt: z.string().trim().min(1).max(MAX_PROMPT_LENGTH),
  video_prompt: z.string().trim().min(1).max(MAX_PROMPT_LENGTH),
  duration: z.number().finite().positive().max(120),
  shot_type: z.string().trim().min(1).max(200),
  camera_move: z.string().trim().min(1).max(500),
  narration_recommended: z.boolean(),
  narration_text: z.string().trim().min(1).max(MAX_PROMPT_LENGTH).nullable(),
  narration_emotion: z.string().trim().min(1).max(200).nullable(),
}).strict()

export type FourGridSheetAnalysisRow = z.infer<typeof analysisRowSchema>

export type FourGridPlannedPanel = {
  panelIndex: number
  description: string | null
  imagePrompt: string | null
  videoPrompt: string | null
  shotType: string | null
  cameraMove: string | null
  location: string | null
  characters: string | null
  props: string | null
  srtSegment: string | null
  dialogueSpeaker: string | null
  dialogueText: string | null
  dialogueEmotion: string | null
  duration: number | null
  estimatedDuration: number | null
}

type VisionRunner = typeof executeAiVisionStep

function invalid(cause?: unknown): never {
  throw Object.assign(new Error('FOUR_GRID_SHEET_ANALYSIS_INVALID'), { cause })
}

function orderedPlannedPanels(panels: FourGridPlannedPanel[]) {
  if (panels.length !== FOUR_GRID_PANEL_COUNT) invalid()
  const orderedPanels = [...panels].sort((left, right) => left.panelIndex - right.panelIndex)
  if (orderedPanels.some((panel, index) => panel.panelIndex !== index)) invalid()
  return orderedPanels
}

export function parseFourGridSheetAnalysis(
  text: string,
  panels: FourGridPlannedPanel[],
): FourGridSheetAnalysisRow[] {
  try {
    const parsed = safeParseJsonArray(text, 'panels')
    const rows = z.array(analysisRowSchema).length(FOUR_GRID_PANEL_COUNT).parse(parsed)
    const numbers = new Set(rows.map((row) => row.panel_number))
    if (numbers.size !== FOUR_GRID_PANEL_COUNT
      || Array.from({ length: FOUR_GRID_PANEL_COUNT }, (_, index) => index + 1)
        .some((panelNumber) => !numbers.has(panelNumber))) invalid()
    const orderedRows = [...rows].sort((left, right) => left.panel_number - right.panel_number)
    const orderedPanels = orderedPlannedPanels(panels)
    orderedRows.forEach((row, index) => {
      const hasNarrationText = Boolean(row.narration_text?.trim())
      if (row.narration_recommended !== hasNarrationText) invalid()
      if (orderedPanels[index].dialogueText?.trim() && row.narration_recommended) invalid()
      if (!row.narration_recommended && row.narration_emotion !== null) invalid()
    })
    return orderedRows
  } catch (error) {
    if (error instanceof Error && error.message === 'FOUR_GRID_SHEET_ANALYSIS_INVALID') throw error
    return invalid(error)
  }
}

function safeJson(value: string | null) {
  if (!value?.trim()) return null
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function plannedDuration(panel: FourGridPlannedPanel) {
  return panel.duration && panel.duration > 0
    ? panel.duration
    : panel.estimatedDuration && panel.estimatedDuration > 0
      ? panel.estimatedDuration
      : null
}

export function buildFourGridSheetAnalysisPrompt(input: {
  locale: 'zh' | 'en'
  panels: FourGridPlannedPanel[]
}) {
  const orderedPanels = orderedPlannedPanels(input.panels)
  const plotPlan = orderedPanels.map((panel) => ({
    panel_number: panel.panelIndex + 1,
    plot_description: panel.description,
    planned_image_prompt: panel.imagePrompt,
    planned_video_prompt: panel.videoPrompt,
    shot_type: panel.shotType,
    camera_move: panel.cameraMove,
    location: panel.location,
    characters: safeJson(panel.characters),
    props: safeJson(panel.props),
    source_text: panel.srtSegment,
    dialogue: panel.dialogueText?.trim()
      ? {
          speaker: panel.dialogueSpeaker,
          text: panel.dialogueText,
          emotion: panel.dialogueEmotion,
        }
      : null,
    planned_duration: plannedDuration(panel),
  }))
  const targetDuration = plotPlan.reduce((total, panel) => (
    total + (typeof panel.planned_duration === 'number' ? panel.planned_duration : 0)
  ), 0)
  const language = input.locale === 'zh' ? 'Simplified Chinese' : 'English'
  const jsonExample = {
    panels: Array.from({ length: FOUR_GRID_PANEL_COUNT }, (_, index) => ({
      panel_number: index + 1,
      description: '...',
      image_prompt: '...',
      video_prompt: '...',
      duration: 3.5,
      shot_type: '...',
      camera_move: '...',
      narration_recommended: false,
      narration_text: null,
      narration_emotion: null,
    })),
  }

  return [
    'Analyze the attached complete 2x2 storyboard sheet before it is cropped.',
    'Read cells in row-major order: 1 top-left, 2 top-right, 3 bottom-left, 4 bottom-right.',
    'The plot plan is authoritative for story events, identities, dialogue, and continuity.',
    'The image is authoritative only for visible composition, pose, expression, wardrobe, lighting, and spatial placement.',
    'Do not rewrite the plot to justify an incorrect generated image. Keep every requested plot beat recognizable.',
    'For each cell, produce a grounded still-image prompt and a video prompt whose starting state exactly matches that cell.',
    'Narration is allowed only on panels whose authoritative dialogue is empty after trimming; never add narration to a dialogue panel.',
    'Set narration_recommended to true only for a time/location transition, inner thought, off-screen background information, or necessary causal context not clear from the image or action.',
    'Never use narration to restate visible action.',
    'When narration_recommended is true, provide non-empty narration_text; otherwise set narration_text and narration_emotion to null.',
    'Allocate duration from dialogue length, action complexity, and camera movement. Every duration must be a positive number of seconds.',
    'Include narration speaking time in duration allocation.',
    targetDuration > 0
      ? `The four durations should total approximately ${targetDuration.toFixed(2)} seconds.`
      : 'Choose a concise positive duration for every cell.',
    `Write all natural-language fields in ${language}.`,
    'Return JSON only in this exact shape:',
    JSON.stringify(jsonExample),
    'Return exactly four unique panels numbered 1, 2, 3, and 4.',
    `AUTHORITATIVE_PLOT_PLAN=${JSON.stringify(plotPlan)}`,
  ].join('\n')
}

export async function analyzeFourGridSheet(input: {
  userId: string
  projectId: string
  model: string
  imageDataUrl: string
  locale: 'zh' | 'en'
  panels: FourGridPlannedPanel[]
}, dependencies: { runVision?: VisionRunner } = {}) {
  const runVision = dependencies.runVision ?? executeAiVisionStep
  const result = await runVision({
    userId: input.userId,
    projectId: input.projectId,
    model: input.model,
    prompt: buildFourGridSheetAnalysisPrompt({ locale: input.locale, panels: input.panels }),
    imageUrls: [input.imageDataUrl],
    temperature: 0.1,
    reasoning: true,
    action: 'four_grid_sheet_analysis',
    meta: {
      stepId: 'four_grid_sheet_analysis',
      stepTitle: input.locale === 'zh' ? '分析四宫格分镜' : 'Analyze four-grid storyboard',
      stepIndex: 1,
      stepTotal: 1,
    },
  })
  return parseFourGridSheetAnalysis(result.text, input.panels)
}
