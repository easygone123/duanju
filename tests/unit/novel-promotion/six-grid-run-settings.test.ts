import { describe, expect, it } from 'vitest'
import {
  SIX_GRID_ASPECT_RATIO_UNSUPPORTED,
  STORYBOARD_RUN_SETTINGS_INVALID,
  parseStoryboardRunSettingsTask,
  resolveStoryboardRunSettings,
  shouldLockStoryboardRunSettings,
} from '@/lib/novel-promotion/six-grid/run-settings'

describe('resolveStoryboardRunSettings', () => {
  it('prefers explicit task mode and cell ratio over project defaults', () => {
    expect(resolveStoryboardRunSettings({
      task: {
        storyboardGenerationMode: 'six_grid',
        sixGridCellAspectRatio: '16:9',
      },
      project: {
        storyboardGenerationMode: 'individual',
        sixGridCellAspectRatio: '9:16',
        sixGridProcessingOrder: 'crop_then_panel_upscale',
        storyboardUpscaleModel: 'comfyui::upscale-v1',
        dialogueVideoModel: 'comfyui::dialogue-v1',
        videoRatio: '9:16',
      },
    })).toEqual({
      storyboardGenerationMode: 'six_grid',
      sixGridCellAspectRatio: '16:9',
      gridSpec: {
        mode: 'six_grid',
        columns: 3,
        rows: 2,
        panelCount: 6,
        cellAspectRatio: '16:9',
        sheetAspectRatio: '8:3',
      },
      sixGridProcessingOrder: 'crop_then_panel_upscale',
      storyboardUpscaleModel: 'comfyui::upscale-v1',
      dialogueVideoModel: 'comfyui::dialogue-v1',
    })
  })

  it.each([
    ['four_grid', '16:9'],
    ['four_grid', '9:16'],
    ['six_grid', '16:9'],
    ['six_grid', '9:16'],
  ] as const)(
    '%s mode inherits the supported project video ratio %s',
    (storyboardGenerationMode, videoRatio) => {
      expect(resolveStoryboardRunSettings({
        task: { storyboardGenerationMode },
        project: {
          storyboardGenerationMode: 'individual',
          sixGridCellAspectRatio: null,
          sixGridProcessingOrder: 'sheet_upscale_then_crop',
          storyboardUpscaleModel: null,
          dialogueVideoModel: null,
          videoRatio,
        },
      })).toMatchObject({
        storyboardGenerationMode,
        sixGridCellAspectRatio: videoRatio,
        gridSpec: {
          mode: storyboardGenerationMode,
          cellAspectRatio: videoRatio,
        },
      })
    },
  )

  it('blocks a six-grid run when the inherited video ratio is unsupported', () => {
    expect(() => resolveStoryboardRunSettings({
      task: { storyboardGenerationMode: 'six_grid' },
      project: {
        storyboardGenerationMode: 'individual',
        sixGridCellAspectRatio: null,
        sixGridProcessingOrder: 'crop_then_panel_upscale',
        storyboardUpscaleModel: null,
        dialogueVideoModel: null,
        videoRatio: '1:1',
      },
    })).toThrowError(SIX_GRID_ASPECT_RATIO_UNSUPPORTED)
  })

  it('keeps individual mode compatible with unsupported video ratios', () => {
    expect(resolveStoryboardRunSettings({
      task: { storyboardGenerationMode: 'individual' },
      project: {
        storyboardGenerationMode: 'six_grid',
        sixGridCellAspectRatio: null,
        sixGridProcessingOrder: 'crop_then_panel_upscale',
        storyboardUpscaleModel: null,
        dialogueVideoModel: null,
        videoRatio: '1:1',
      },
    })).toMatchObject({
      storyboardGenerationMode: 'individual',
      sixGridCellAspectRatio: null,
      gridSpec: null,
    })
  })

  it('keeps explicit null model selections immutable instead of rereading project defaults', () => {
    expect(resolveStoryboardRunSettings({
      task: {
        storyboardGenerationMode: 'individual',
        storyboardUpscaleModel: null,
        dialogueVideoModel: null,
      },
      project: {
        storyboardUpscaleModel: 'comfyui::changed-upscale',
        dialogueVideoModel: 'comfyui::changed-dialogue',
      },
    })).toMatchObject({
      storyboardUpscaleModel: null,
      dialogueVideoModel: null,
    })
  })
})

describe('parseStoryboardRunSettingsTask', () => {
  it('accepts four-grid mode', () => {
    expect(parseStoryboardRunSettingsTask({
      storyboardGenerationMode: 'four_grid',
    })).toEqual({
      storyboardGenerationMode: 'four_grid',
    })
  })

  it('rejects malformed auxiliary model keys', () => {
    expect(() => parseStoryboardRunSettingsTask({
      storyboardUpscaleModel: 'bad-key',
    })).toThrowError(STORYBOARD_RUN_SETTINGS_INVALID)
    expect(() => parseStoryboardRunSettingsTask({
      dialogueVideoModel: 'also-bad',
    })).toThrowError(STORYBOARD_RUN_SETTINGS_INVALID)
  })

  it('accepts null mode and processing order as explicit inheritance', () => {
    const task = parseStoryboardRunSettingsTask({
      storyboardGenerationMode: null,
      sixGridProcessingOrder: null,
    })
    expect(resolveStoryboardRunSettings({
      task,
      project: {
        storyboardGenerationMode: 'six_grid',
        sixGridCellAspectRatio: '16:9',
        sixGridProcessingOrder: 'sheet_upscale_then_crop',
      },
    })).toMatchObject({
      storyboardGenerationMode: 'six_grid',
      sixGridProcessingOrder: 'sheet_upscale_then_crop',
    })
  })
})

describe('shouldLockStoryboardRunSettings', () => {
  it('locks settings for a recovered active run after page reload', () => {
    expect(shouldLockStoryboardRunSettings({
      isStarting: false,
      isActiveRunning: true,
    })).toBe(true)
  })

  it('leaves settings editable when no launch or active run exists', () => {
    expect(shouldLockStoryboardRunSettings({
      isStarting: false,
      isActiveRunning: false,
    })).toBe(false)
  })
})
