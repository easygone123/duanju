import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  resolveNarrationVoiceEnabled,
  selectPanelVideo,
} from '@/lib/novel-promotion/video/select-panel-video'

describe('final video selection with disabled narration', () => {
  it('falls back to the base panel video without deleting preserved lip-sync media', () => {
    const narrationVoiceEnabled = resolveNarrationVoiceEnabled([
      { lineType: 'narration', enabled: false },
    ])

    expect(selectPanelVideo({
      videoUrl: 'base.mp4',
      lipSyncVideoUrl: 'preserved-narration-lip.mp4',
      preferLipSync: true,
      hasDialogue: false,
      narrationVoiceEnabled,
    })).toEqual({ videoUrl: 'base.mp4', isLipSync: false })
  })

  it.each([
    {
      name: 'uses lip-sync when preferred and available',
      input: { videoUrl: 'base.mp4', lipSyncVideoUrl: 'lip.mp4', preferLipSync: true },
      expected: { videoUrl: 'lip.mp4', isLipSync: true },
    },
    {
      name: 'falls back to base when lip-sync is preferred but absent',
      input: { videoUrl: 'base.mp4', lipSyncVideoUrl: null, preferLipSync: true },
      expected: { videoUrl: 'base.mp4', isLipSync: false },
    },
    {
      name: 'uses base when preferred and available',
      input: { videoUrl: 'base.mp4', lipSyncVideoUrl: 'lip.mp4', preferLipSync: false },
      expected: { videoUrl: 'base.mp4', isLipSync: false },
    },
    {
      name: 'falls back to lip-sync when base is preferred but absent',
      input: { videoUrl: null, lipSyncVideoUrl: 'lip.mp4', preferLipSync: false },
      expected: { videoUrl: 'lip.mp4', isLipSync: true },
    },
    {
      name: 'returns no video when neither variant exists',
      input: { videoUrl: null, lipSyncVideoUrl: null, preferLipSync: false },
      expected: { videoUrl: null, isLipSync: false },
    },
  ])('$name', ({ input, expected }) => {
    expect(selectPanelVideo(input)).toEqual(expected)
  })

  it.each([true, false])(
    'never exposes disabled narration lip-sync when preferLipSync=%s',
    (preferLipSync) => {
      expect(selectPanelVideo({
        videoUrl: null,
        lipSyncVideoUrl: 'stale-narration-lip.mp4',
        preferLipSync,
        hasDialogue: false,
        narrationVoiceEnabled: false,
      })).toEqual({ videoUrl: null, isLipSync: false })
    },
  )

  it('does not suppress lip-sync for a normal dialogue panel', () => {
    expect(selectPanelVideo({
      videoUrl: 'base.mp4',
      lipSyncVideoUrl: 'dialogue-lip.mp4',
      preferLipSync: true,
      hasDialogue: true,
      narrationVoiceEnabled: false,
    })).toEqual({ videoUrl: 'dialogue-lip.mp4', isLipSync: true })
  })

  it('uses the shared guarded selection in preview, URL export, and ZIP export', () => {
    const preview = readFileSync('src/lib/novel-promotion/video/combined-preview.ts', 'utf8')
    const urls = readFileSync(
      'src/app/api/novel-promotion/[projectId]/video-urls/route.ts',
      'utf8',
    )
    const download = readFileSync(
      'src/app/api/novel-promotion/[projectId]/download-videos/route.ts',
      'utf8',
    )
    const stageRoute = readFileSync(
      'src/app/api/novel-promotion/[projectId]/episodes/[episodeId]/stage/[stage]/route.ts',
      'utf8',
    )
    const cardPlayer = readFileSync(
      'src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video/panel-card/runtime/hooks/usePanelPlayer.ts',
      'utf8',
    )

    for (const source of [preview, urls, download]) {
      expect(source).toContain('selectPanelVideo({')
      expect(source).toContain('narrationVoiceEnabled:')
      expect(source).not.toContain('allowLipSyncFallbackWhenBasePreferred')
      expect(source).not.toContain('panel.lipSyncVideoUrl || panel.videoUrl')
    }
    expect(urls).toMatch(/matchedVoiceLines:[\s\S]*lineType: 'narration'/)
    expect(download).toMatch(/matchedVoiceLines:[\s\S]*lineType: 'narration'/)
    expect(stageRoute).toMatch(/matchedVoiceLines:[\s\S]*lineType: 'narration'/)
    expect(cardPlayer).toContain('selectPanelVideo({')
    expect(cardPlayer).not.toContain('allowLipSyncFallbackWhenBasePreferred')
    expect(cardPlayer).not.toMatch(/const currentVideoUrl = videoUrl\s*\?/)
  })
})
