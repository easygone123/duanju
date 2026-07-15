import { z } from 'zod'

import type { Locale } from '@/i18n/routing'
import { buildPrompt, PROMPT_IDS } from '@/lib/prompt-i18n'
import { safeParseJson } from '@/lib/json-repair'
import type { PreprocessedViralShot } from './preprocess'

const analyzedShotSchema = z.object({
  shotIndex: z.number().int().nonnegative(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  shotType: z.string().min(1).max(200),
  cameraAngle: z.string().min(1).max(200),
  cameraMove: z.string().min(1).max(200),
  composition: z.string().min(1).max(2_000),
  actionBeat: z.string().min(1).max(2_000),
  transition: z.string().min(1).max(200),
  subtitleSummary: z.string().min(1).max(2_000).nullable(),
  narrativeFunction: z.string().min(1).max(2_000),
}).strict()

const shotBatchSchema = z.object({
  shots: z.array(analyzedShotSchema).min(1).max(10),
}).strict()

export type ViralShotAnalysisBatch = z.infer<typeof shotBatchSchema>

export const VIRAL_REPORT_SCHEMA_JSON = JSON.stringify({
  schemaVersion: 1,
  overview: {
    hook: 'string',
    coreAppeal: 'string',
    pacing: 'string',
    emotionalArc: 'string',
  },
  styleFingerprint: {
    composition: ['string'],
    lighting: ['string'],
    color: ['string'],
    editing: ['string'],
  },
  shots: [{
    shotIndex: 0,
    startMs: 0,
    endMs: 1000,
    shotType: 'string',
    cameraAngle: 'string',
    cameraMove: 'string',
    composition: 'string',
    actionBeat: 'string',
    transition: 'string',
    subtitleSummary: 'string|null',
    narrativeFunction: 'string',
  }],
  originalAdaptationAdvice: ['string'],
})

export function buildViralShotAnalysisPrompt(input: {
  locale: Locale
  brief: string
  videoMetadata: Record<string, unknown>
  shots: PreprocessedViralShot[]
  subtitleContext: string | null
}): string {
  return buildPrompt({
    promptId: PROMPT_IDS.VIRAL_SHOT_ANALYSIS,
    locale: input.locale,
    variables: {
      brief: input.brief,
      video_metadata: JSON.stringify(input.videoMetadata),
      shot_timeline: JSON.stringify(input.shots.map((shot) => ({
        shotIndex: shot.shotIndex,
        startMs: shot.startMs,
        endMs: shot.endMs,
        representativeMs: shot.representativeMs,
      }))),
      subtitle_context: input.subtitleContext || 'None',
    },
  })
}

export function buildViralReportAggregationPrompt(input: {
  locale: Locale
  brief: string
  durationMs: number
  batchResults: ViralShotAnalysisBatch[]
}): string {
  return buildPrompt({
    promptId: PROMPT_IDS.VIRAL_REPORT_AGGREGATION,
    locale: input.locale,
    variables: {
      brief: input.brief,
      duration_ms: String(input.durationMs),
      batch_results_json: JSON.stringify(input.batchResults),
      report_schema_json: VIRAL_REPORT_SCHEMA_JSON,
    },
  })
}

export function parseViralShotAnalysisBatch(
  completionText: string,
  expectedShots: PreprocessedViralShot[],
): ViralShotAnalysisBatch {
  const result = shotBatchSchema.parse(safeParseJson(completionText))
  if (result.shots.length !== expectedShots.length) {
    throw new z.ZodError([{
      code: z.ZodIssueCode.custom,
      path: ['shots'],
      message: `Expected ${expectedShots.length} analyzed shots, received ${result.shots.length}`,
    }])
  }
  result.shots.forEach((shot, index) => {
    const expected = expectedShots[index]
    if (
      !expected
      || shot.shotIndex !== expected.shotIndex
      || shot.startMs !== expected.startMs
      || shot.endMs !== expected.endMs
    ) {
      throw new z.ZodError([{
        code: z.ZodIssueCode.custom,
        path: ['shots', index],
        message: 'Analyzed shot identity and timeline must match the requested frame order',
      }])
    }
  })
  return result
}
