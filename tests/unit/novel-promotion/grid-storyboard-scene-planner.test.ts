import { describe, expect, it, vi } from 'vitest'
import { resolveStoryboardGridSpec } from '@/lib/novel-promotion/grid-storyboard/spec'
import {
  GRID_NUMBERING_INVALID,
  GRID_PANEL_INVALID,
  GRID_REQUIRES_EXACT_PANEL_COUNT,
  validateGridEpisodePlan,
  validateGridSceneGroups,
} from '@/lib/novel-promotion/grid-storyboard/scene-planner'
import { runScriptToStoryboardOrchestrator } from '@/lib/novel-promotion/script-to-storyboard/orchestrator'
import { buildGridSheetPrompt } from '@/lib/novel-promotion/six-grid/prompt-builder'

function panels(location: string, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    panel_number: index + 1,
    description: `${location} visual beat ${index + 1}`,
    location,
    source_text: `${location} source ${index + 1}`,
    characters: [],
    duration: 2.5 + index,
  }))
}

function group(panelCount: number, clipId = 'clip-1') {
  return {
    sceneKey: 'room',
    clipId,
    incomingContinuity: 'start',
    outgoingContinuity: 'end',
    panels: panels('room', panelCount),
  }
}

function photographyRule(panel_number: number) {
  return {
    panel_number,
    composition: 'center',
    lighting: 'soft window light',
    color_palette: 'warm',
    atmosphere: 'calm',
    technical_notes: 'T4',
  }
}

describe('grid storyboard scene planner', () => {
  it.each([
    ['four_grid', 4],
    ['six_grid', 6],
  ] as const)('validates %s groups with exactly %i panels', (mode, panelCount) => {
    const spec = resolveStoryboardGridSpec(mode, '16:9')

    expect(validateGridSceneGroups([group(panelCount)], spec)[0].panels)
      .toHaveLength(panelCount)
    expect(() => validateGridSceneGroups([group(panelCount - 1)], spec))
      .toThrow(GRID_REQUIRES_EXACT_PANEL_COUNT)
    expect(() => validateGridSceneGroups([group(panelCount + 1)], spec))
      .toThrow(GRID_REQUIRES_EXACT_PANEL_COUNT)
  })

  it('requires four-grid panel numbers to be exactly 1 through 4', () => {
    const spec = resolveStoryboardGridSpec('four_grid', '16:9')
    const invalid = group(4)
    invalid.panels[3].panel_number = 5

    expect(() => validateGridSceneGroups([invalid], spec))
      .toThrow(GRID_NUMBERING_INVALID)
  })

  it('requires every grid panel to contain an analysis-model duration', () => {
    const spec = resolveStoryboardGridSpec('four_grid', '16:9')
    const invalid = group(4)
    delete (invalid.panels[1] as { duration?: number }).duration

    expect(() => validateGridSceneGroups([invalid], spec)).toThrow(GRID_PANEL_INVALID)
  })

  it('builds a four-grid sheet prompt with exact 2x2 layout and four ordered beats', () => {
    const gridSpec = resolveStoryboardGridSpec('four_grid', '9:16')
    const prompt = buildGridSheetPrompt(group(4), { locale: 'en', gridSpec })

    expect(prompt).toContain('exactly 2 columns x 2 rows')
    expect(prompt).toContain('All four cells depict one continuous story')
    expect(prompt.match(/^Beat [1-4]:/gm)).toHaveLength(4)
    expect(prompt).not.toContain('All six cells')
  })

  it.each([
    ['four_grid', 'four-grid:'],
    ['six_grid', 'six-grid:'],
  ] as const)('assigns the stable %s group ID prefix', (mode, expectedPrefix) => {
    const spec = resolveStoryboardGridSpec(mode, '16:9')
    const result = validateGridEpisodePlan([group(spec.panelCount)], ['clip-1'], spec)

    expect(result[0].groupId).toBe(`${expectedPrefix}1:clip-1:1`)
    expect(result[0].groupKey).toBe(result[0].groupId)
  })

  it('routes four-grid through one grid plan with exact 2x2/count and coverage instructions', async () => {
    const prompts: Array<{ stepId: string; action: string; prompt: string }> = []
    const runStep = vi.fn(async (meta, prompt: string, action: string) => {
      prompts.push({ stepId: String(meta.stepId), action, prompt })
      if (action === 'storyboard_six_grid_scene_plan') {
        return { text: JSON.stringify([group(4)]), reasoning: '' }
      }
      if (action === 'storyboard_phase2_cinematography') {
        return { text: JSON.stringify([1, 2, 3, 4].map(photographyRule)), reasoning: '' }
      }
      if (action === 'storyboard_phase2_acting') {
        return {
          text: JSON.stringify([1, 2, 3, 4].map((panel_number) => ({ panel_number, characters: [] }))),
          reasoning: '',
        }
      }
      return { text: JSON.stringify(panels('room', 4)), reasoning: '' }
    })

    const result = await runScriptToStoryboardOrchestrator({
      runSettings: {
        storyboardGenerationMode: 'four_grid',
        sixGridCellAspectRatio: '16:9',
        gridSpec: resolveStoryboardGridSpec('four_grid', '16:9'),
        sixGridProcessingOrder: 'crop_then_panel_upscale',
        storyboardUpscaleModel: null,
        dialogueVideoModel: null,
      },
      clips: [{
        id: 'clip-1',
        content: 'A short exchange in one room.',
        characters: '[]',
        location: 'room',
        screenplay: null,
      }],
      novelPromotionData: {
        characters: [],
        locations: [{ name: 'room', images: [] }],
      },
      promptTemplates: {
        phase1PlanTemplate: '{clip_content} {clip_json}',
        phase2CinematographyTemplate: '{panels_json} {panel_count}',
        phase2ActingTemplate: '{panels_json} {panel_count}',
        phase3DetailTemplate: '{panels_json}',
      },
      runStep,
    })

    expect(prompts[0].action).toBe('storyboard_six_grid_scene_plan')
    expect(prompts[0].prompt).toMatch(/2\s*[x×]\s*2/i)
    expect(prompts[0].prompt).toContain('exactly four panels')
    expect(prompts[0].prompt).toContain('1 through 4')
    expect(prompts[0].prompt).toMatch(/reaction|environment|insert|detail/i)
    expect(prompts[0].prompt).toMatch(/do not drop|complete.*coverage/i)
    expect(prompts.slice(1).every(({ prompt }) => prompt.includes('[1, 2, 3, 4]'))).toBe(true)
    expect(result.clipPanels[0].groupId).toBe('four-grid:1:clip-1:1')
    expect(result.clipPanels[0].finalPanels).toHaveLength(4)
    expect(result.summary.totalPanelCount).toBe(4)
  })

  it('retries the complete four-grid plan after an invalid panel count', async () => {
    let planAttempts = 0
    const planningPrompts: string[] = []
    const runStep = vi.fn(async (_meta, prompt: string, action: string) => {
      if (action === 'storyboard_six_grid_scene_plan') {
        planAttempts += 1
        planningPrompts.push(prompt)
        return { text: JSON.stringify([group(planAttempts === 1 ? 3 : 4)]), reasoning: '' }
      }
      if (action === 'storyboard_phase2_cinematography') {
        return { text: JSON.stringify([1, 2, 3, 4].map(photographyRule)), reasoning: '' }
      }
      if (action === 'storyboard_phase2_acting') {
        return {
          text: JSON.stringify([1, 2, 3, 4].map((panel_number) => ({ panel_number, characters: [] }))),
          reasoning: '',
        }
      }
      return { text: JSON.stringify(panels('room', 4)), reasoning: '' }
    })

    await runScriptToStoryboardOrchestrator({
      runSettings: {
        storyboardGenerationMode: 'four_grid',
        sixGridCellAspectRatio: '16:9',
        gridSpec: resolveStoryboardGridSpec('four_grid', '16:9'),
        sixGridProcessingOrder: 'crop_then_panel_upscale',
        storyboardUpscaleModel: null,
        dialogueVideoModel: null,
      },
      clips: [{ id: 'clip-1', content: 'room', characters: '[]', location: 'room', screenplay: null }],
      novelPromotionData: { characters: [], locations: [{ name: 'room', images: [] }] },
      promptTemplates: {
        phase1PlanTemplate: '{clip_content} {clip_json}',
        phase2CinematographyTemplate: '{panels_json} {panel_count}',
        phase2ActingTemplate: '{panels_json} {panel_count}',
        phase3DetailTemplate: '{panels_json}',
      },
      runStep,
    })

    expect(planAttempts).toBe(2)
    expect(planningPrompts[1]).toContain(GRID_REQUIRES_EXACT_PANEL_COUNT)
    expect(planningPrompts[1]).toContain('Correct the previous response')
  })
})
