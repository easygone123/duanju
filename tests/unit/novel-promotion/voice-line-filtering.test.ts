import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { resolveEpisodeStageArtifacts } from '@/lib/novel-promotion/stage-readiness'
import { buildVoiceLineTargets } from '@/lib/novel-promotion/stages/video-stage-runtime/task-targets'
import type { VoiceLine } from '@/lib/novel-promotion/stages/video-stage-runtime/types'

function voiceLine(overrides: Partial<VoiceLine> = {}): VoiceLine {
  return {
    id: 'line-1',
    lineIndex: 1,
    lineType: 'dialogue',
    enabled: true,
    sourceKey: null,
    speaker: 'Hero',
    content: 'Ready.',
    audioUrl: '/m/voice.wav',
    matchedStoryboardId: 'storyboard-1',
    matchedPanelIndex: 0,
    ...overrides,
  }
}

describe('disabled voice-line filtering', () => {
  it('excludes disabled rows from video task targets even when audio still exists', () => {
    const targets = buildVoiceLineTargets([
      voiceLine({ id: 'enabled-line' }),
      voiceLine({ id: 'disabled-line', enabled: false }),
    ])

    expect(targets.map((target) => target.targetId)).toEqual(['enabled-line'])
  })

  it('does not count disabled narration toward voice readiness', () => {
    expect(resolveEpisodeStageArtifacts({
      voiceLines: [{ enabled: false }],
    }).hasVoice).toBe(false)
  })

  it('filters every server boundary and rejects direct disabled generation', () => {
    const voiceLinesRoute = readFileSync(
      'src/app/api/novel-promotion/[projectId]/voice-lines/route.ts',
      'utf8',
    )
    const generationRoute = readFileSync(
      'src/app/api/novel-promotion/[projectId]/voice-generate/route.ts',
      'utf8',
    )
    const downloadRoute = readFileSync(
      'src/app/api/novel-promotion/[projectId]/download-voices/route.ts',
      'utf8',
    )
    const stageRoute = readFileSync(
      'src/app/api/novel-promotion/[projectId]/episodes/[episodeId]/stage/[stage]/route.ts',
      'utf8',
    )
    const episodeRoute = readFileSync(
      'src/app/api/novel-promotion/[projectId]/episodes/[episodeId]/route.ts',
      'utf8',
    )

    expect(voiceLinesRoute).toContain('where: { episodeId, enabled: true }')
    expect(voiceLinesRoute).toMatch(/enabled: true,[\s\S]*distinct: \['speaker'\]/)
    expect(voiceLinesRoute).toContain("code: 'NARRATION_IDENTITY_IMMUTABLE'")
    expect(voiceLinesRoute).toContain("code: 'NARRATION_DELETE_UNSUPPORTED'")
    expect(generationRoute).toContain("code: 'VOICE_LINE_DISABLED'")
    expect(generationRoute).toMatch(/episodeId,\s+enabled: true,\s+audioUrl: null/)
    expect(downloadRoute).toMatch(/enabled: true,\s+audioUrl: \{ not: null \}/)
    expect(stageRoute).toContain('count({ where: { episodeId, enabled: true } })')
    expect(episodeRoute).toMatch(/voiceLines: \{\s+where: \{ enabled: true \}/)
  })

  it('keeps defensive disabled filters at client submission and video mapping boundaries', () => {
    const generationActions = readFileSync(
      'src/lib/novel-promotion/stages/voice-stage-runtime/useVoiceGenerationActions.ts',
      'utf8',
    )
    const taskState = readFileSync(
      'src/lib/novel-promotion/stages/voice-stage-runtime/useVoiceTaskState.ts',
      'utf8',
    )
    const videoVoiceLines = readFileSync(
      'src/lib/novel-promotion/stages/video-stage-runtime/useVideoVoiceLines.ts',
      'utf8',
    )

    expect(generationActions).toContain('line.enabled === false')
    expect(taskState).toContain('line.enabled !== false')
    expect(videoVoiceLines).toContain('.filter((line) => line.enabled !== false)')
  })
})
