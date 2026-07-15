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

export const MAX_VIRAL_TRANSCRIPT_PROMPT_CHARS = 50_000
export const MAX_VIRAL_MODEL_PROMPT_CHARS = 100_000

function truncateUntrustedText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}\n[TRUNCATED]`
}

function serializeUntrusted(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&]/g, (character) => {
    if (character === '<') return '\\u003c'
    if (character === '>') return '\\u003e'
    return '\\u0026'
  })
}

function delimitUntrusted(label: string, value: unknown): string {
  return `<<<BEGIN_UNTRUSTED_${label}>>>\n${serializeUntrusted(value)}\n<<<END_UNTRUSTED_${label}>>>`
}

function assertPromptLength(prompt: string): string {
  if (prompt.length > MAX_VIRAL_MODEL_PROMPT_CHARS) {
    throw new Error(`Viral model prompt length exceeds ${MAX_VIRAL_MODEL_PROMPT_CHARS} characters`)
  }
  return prompt
}

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
  const subtitleContext = truncateUntrustedText(
    input.subtitleContext || 'None',
    MAX_VIRAL_TRANSCRIPT_PROMPT_CHARS,
  )
  return assertPromptLength(buildPrompt({
    promptId: PROMPT_IDS.VIRAL_SHOT_ANALYSIS,
    locale: input.locale,
    variables: {
      brief: delimitUntrusted('BRIEF', input.brief),
      video_metadata: JSON.stringify(input.videoMetadata),
      shot_timeline: JSON.stringify(input.shots.map((shot) => ({
        shotIndex: shot.shotIndex,
        startMs: shot.startMs,
        endMs: shot.endMs,
        representativeMs: shot.representativeMs,
      }))),
      subtitle_context: delimitUntrusted('SUBTITLE_CONTEXT', subtitleContext),
    },
  }))
}

export function buildViralReportAggregationPrompt(input: {
  locale: Locale
  brief: string
  durationMs: number
  batchResults: ViralShotAnalysisBatch[]
}): string {
  return assertPromptLength(buildPrompt({
    promptId: PROMPT_IDS.VIRAL_REPORT_AGGREGATION,
    locale: input.locale,
    variables: {
      brief: delimitUntrusted('BRIEF', input.brief),
      duration_ms: String(input.durationMs),
      batch_results_json: delimitUntrusted(
        'BATCH_RESULTS',
        input.batchResults,
      ),
      report_schema_json: VIRAL_REPORT_SCHEMA_JSON,
    },
  }))
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
