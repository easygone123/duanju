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
      allowLipSyncFallbackWhenBasePreferred: true,
    })).toEqual({ videoUrl: 'base.mp4', isLipSync: false })
  })

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
      expect(source).not.toContain('panel.lipSyncVideoUrl || panel.videoUrl')
    }
    expect(urls).toMatch(/matchedVoiceLines:[\s\S]*lineType: 'narration'/)
    expect(download).toMatch(/matchedVoiceLines:[\s\S]*lineType: 'narration'/)
    expect(stageRoute).toMatch(/matchedVoiceLines:[\s\S]*lineType: 'narration'/)
    expect(cardPlayer).toContain('selectPanelVideo({')
  })
})
