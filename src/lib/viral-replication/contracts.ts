import { z } from 'zod'

import { VIRAL_MAX_ANALYSIS_FRAMES, VIRAL_MAX_GENERATED_PANELS } from './constants'

const shortText = z.string().min(1).max(200)
const mediumText = z.string().min(1).max(2_000)
const longText = z.string().min(1).max(100_000)
const fingerprintValues = z.array(shortText).max(24)
const maxCharacters = 100
const maxStoryboards = 24
const maxPanelsPerStoryboard = 24

const viralAnalysisShotV1Schema = z
  .object({
    shotIndex: z.number().int().nonnegative(),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
    shotType: shortText,
    cameraAngle: shortText,
    cameraMove: shortText,
    composition: mediumText,
    actionBeat: mediumText,
    transition: shortText,
    subtitleSummary: mediumText.nullable(),
    narrativeFunction: mediumText,
  })
  .strict()

const viralAnalysisReportV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    overview: z
      .object({
        hook: mediumText,
        coreAppeal: mediumText,
        pacing: mediumText,
        emotionalArc: mediumText,
      })
      .strict(),
    styleFingerprint: z
      .object({
        composition: fingerprintValues,
        lighting: fingerprintValues,
        color: fingerprintValues,
        editing: fingerprintValues,
      })
      .strict(),
    shots: z.array(viralAnalysisShotV1Schema).min(1).max(VIRAL_MAX_ANALYSIS_FRAMES),
    originalAdaptationAdvice: z.array(mediumText).max(24),
  })
  .strict()

export type ViralAnalysisReportV1 = z.infer<typeof viralAnalysisReportV1Schema>

const viralStoryboardPanelV1Schema = z
  .object({
    panelIndex: z.number().int().nonnegative(),
    durationSeconds: z.number().finite().positive().max(180),
    shotType: shortText,
    cameraMove: shortText,
    description: mediumText,
    imagePrompt: mediumText,
    videoPrompt: mediumText,
    sourceNarrativeFunction: mediumText,
  })
  .strict()

const viralStoryboardV1Schema = z
  .object({
    sequence: z.number().int().nonnegative(),
    summary: mediumText,
    panels: z.array(viralStoryboardPanelV1Schema).min(1).max(maxPanelsPerStoryboard),
  })
  .strict()

const viralStoryboardGenerationV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    title: shortText,
    synopsis: mediumText,
    novelText: longText,
    characters: z
      .array(
        z
          .object({
            name: shortText,
            description: mediumText,
          })
          .strict(),
      )
      .max(maxCharacters),
    storyboards: z.array(viralStoryboardV1Schema).min(1).max(maxStoryboards),
  })
  .strict()

export type ViralStoryboardGenerationV1 = z.infer<typeof viralStoryboardGenerationV1Schema>

function throwValidationIssue(path: Array<string | number>, message: string): never {
  throw new z.ZodError([
    {
      code: z.ZodIssueCode.custom,
      path,
      message,
    },
  ])
}

export function parseViralAnalysisReport(
  value: unknown,
  durationMs: number,
): ViralAnalysisReportV1 {
  const report = viralAnalysisReportV1Schema.parse(value)
  const parsedDurationMs = z.number().int().positive().parse(durationMs)

  report.shots.forEach((shot, index) => {
    if (shot.shotIndex !== index) {
      throwValidationIssue(
        ['shots', index, 'shotIndex'],
        `shots[${index}].shotIndex must be ${index}`,
      )
    }
    if (shot.startMs >= shot.endMs) {
      throwValidationIssue(
        ['shots', index, 'endMs'],
        `shots[${index}] must satisfy startMs < endMs`,
      )
    }
    if (shot.endMs > parsedDurationMs) {
      throwValidationIssue(
        ['shots', index, 'endMs'],
        `shots[${index}].endMs must not exceed source duration`,
      )
    }
    if (index > 0 && shot.startMs < report.shots[index - 1].endMs) {
      throwValidationIssue(
        ['shots', index, 'startMs'],
        `shots[${index}] must follow nondecreasing timeline order`,
      )
    }
  })

  return report
}

export function parseViralStoryboardGeneration(value: unknown): ViralStoryboardGenerationV1 {
  const generation = viralStoryboardGenerationV1Schema.parse(value)

  generation.storyboards.forEach((storyboard, storyboardIndex) => {
    if (storyboard.sequence !== storyboardIndex) {
      throwValidationIssue(
        ['storyboards', storyboardIndex, 'sequence'],
        `storyboards[${storyboardIndex}].sequence must be ${storyboardIndex}`,
      )
    }
    storyboard.panels.forEach((panel, panelIndex) => {
      if (panel.panelIndex !== panelIndex) {
        throwValidationIssue(
          ['storyboards', storyboardIndex, 'panels', panelIndex, 'panelIndex'],
          `storyboards[${storyboardIndex}].panels[${panelIndex}].panelIndex must be ${panelIndex}`,
        )
      }
    })
  })

  const panelCount = generation.storyboards.reduce(
    (total, storyboard) => total + storyboard.panels.length,
    0,
  )
  if (panelCount > VIRAL_MAX_GENERATED_PANELS) {
    throwValidationIssue(
      ['storyboards'],
      `generated panel count must not exceed ${VIRAL_MAX_GENERATED_PANELS}`,
    )
  }

  return generation
}
