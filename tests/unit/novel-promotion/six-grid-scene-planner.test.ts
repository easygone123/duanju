import { describe, expect, it, vi } from 'vitest'
import {
  SIX_GRID_CLIP_COVERAGE_INVALID,
  SIX_GRID_CLIP_ORDER_INVALID,
  SIX_GRID_CONTINUITY_MISMATCH,
  SIX_GRID_NUMBERING_INVALID,
  SIX_GRID_PANEL_INVALID,
  SIX_GRID_REQUIRES_EXACTLY_SIX_PANELS,
  SIX_GRID_SCENE_BOUNDARY_VIOLATION,
  SixGridValidationError,
  validateSixGridActingDirections,
  validateSixGridEpisodePlan,
  validateSixGridPhotographyRules,
  validateAndNormalizeSixGridGroups,
} from '@/lib/novel-promotion/six-grid/scene-planner'
import {
  getScriptToStoryboardStepErrorCode,
  runScriptToStoryboardOrchestrator,
} from '@/lib/novel-promotion/script-to-storyboard/orchestrator'

function panels(location: string, count = 6) {
  return Array.from({ length: count }, (_, index) => ({
    panel_number: index + 1,
    description: `${location}-${index + 1}`,
    location,
    source_text: `${location} source ${index + 1}`,
    characters: [],
  }))
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

function group(input: {
  sceneKey: string
  clipId?: string
  incomingContinuity: string
  outgoingContinuity: string
  panelCount?: number
  panelLocation?: string
}) {
  return {
    sceneKey: input.sceneKey,
    clipId: input.clipId || `clip-${input.sceneKey}`,
    incomingContinuity: input.incomingContinuity,
    outgoingContinuity: input.outgoingContinuity,
    panels: panels(input.panelLocation || input.sceneKey, input.panelCount),
  }
}

const promptTemplates = {
  phase1PlanTemplate: '{clip_content} {clip_json}',
  phase2CinematographyTemplate: '{panels_json} {panel_count}',
  phase2ActingTemplate: '{panels_json} {panel_count}',
  phase3DetailTemplate: '{panels_json}',
}

const novelPromotionData = {
  characters: [],
  locations: [{ name: 'room-a', images: [] }, { name: 'street', images: [] }],
}

describe('six-grid continuous scene planner', () => {
  it('keeps room-a and street in separate six-shot groups', () => {
    const result = validateAndNormalizeSixGridGroups([
      group({ sceneKey: 'room-a', incomingContinuity: 'room start', outgoingContinuity: 'room end' }),
      group({ sceneKey: 'street', incomingContinuity: 'street start', outgoingContinuity: 'street end' }),
    ])

    expect(result).toHaveLength(2)
    expect(result.map((item) => new Set(item.panels.map((panel) => panel.location)).size)).toEqual([1, 1])
    expect(result.map((item) => item.panels.length)).toEqual([6, 6])
  })

  it.each([5, 7])('rejects a group containing %i panels', (panelCount) => {
    expect(() => validateAndNormalizeSixGridGroups([
      group({
        sceneKey: 'room-a',
        incomingContinuity: 'start',
        outgoingContinuity: 'end',
        panelCount,
      }),
    ])).toThrow(SIX_GRID_REQUIRES_EXACTLY_SIX_PANELS)
  })

  it('preserves the legacy exact-count rawContext shape', () => {
    try {
      validateAndNormalizeSixGridGroups([
        group({
          sceneKey: 'room-a',
          incomingContinuity: 'start',
          outgoingContinuity: 'end',
          panelCount: 5,
        }),
      ])
      throw new Error('expected validation to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(SixGridValidationError)
      expect((error as SixGridValidationError).rawContext).toEqual({
        groupIndex: 0,
        panelCount: 5,
      })
    }
  })

  it('strips generic-only fields from other legacy six-grid rawContext objects', () => {
    const invalidNumbering = group({
      sceneKey: 'room-a',
      incomingContinuity: 'start',
      outgoingContinuity: 'end',
    })
    invalidNumbering.panels[1].panel_number = 1

    try {
      validateAndNormalizeSixGridGroups([invalidNumbering])
      throw new Error('expected validation to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(SixGridValidationError)
      expect((error as SixGridValidationError).rawContext).toEqual({
        groupIndex: 0,
        rowIndex: 1,
      })
    }

    try {
      validateSixGridPhotographyRules([1, 2, 3, 4, 5].map(photographyRule))
      throw new Error('expected validation to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(SixGridValidationError)
      expect((error as SixGridValidationError).rawContext).toEqual({
        scope: 'photography',
        rowCount: 5,
      })
    }
  })

  it('rejects a group that crosses a hard location boundary', () => {
    const mixedPanels = [
      ...panels('room-a').slice(0, 5),
      { ...panels('street')[5], panel_number: 6 },
    ]
    expect(() => validateAndNormalizeSixGridGroups([{
      sceneKey: 'room-a',
      clipId: 'clip-room-a',
      incomingContinuity: 'start',
      outgoingContinuity: 'end',
      panels: mixedPanels,
    }])).toThrow(SIX_GRID_SCENE_BOUNDARY_VIOLATION)
  })

  it('passes the previous outgoing anchor into the next group of a long scene', () => {
    const result = validateAndNormalizeSixGridGroups([
      group({ sceneKey: 'room-a', incomingContinuity: 'start', outgoingContinuity: 'same coat, lamp on' }),
      group({ sceneKey: 'room-a', incomingContinuity: 'same coat, lamp on', outgoingContinuity: 'same coat, lamp off' }),
    ])

    expect(result[1].incomingContinuity).toBe(result[0].outgoingContinuity)
  })

  it('rejects a broken continuity anchor in adjacent groups of the same scene', () => {
    expect(() => validateAndNormalizeSixGridGroups([
      group({ sceneKey: 'room-a', incomingContinuity: 'start', outgoingContinuity: 'same coat, lamp on' }),
      group({ sceneKey: 'room-a', incomingContinuity: 'different coat', outgoingContinuity: 'end' }),
    ])).toThrow(SIX_GRID_CONTINUITY_MISMATCH)
  })

  it.each([
    ['empty description', (rows: ReturnType<typeof panels>) => { rows[0].description = '' }],
    ['invalid characters', (rows: ReturnType<typeof panels>) => { rows[0].characters = 'hero' as unknown as never[] }],
  ])('rejects strict panel shape: %s', (_label, mutate) => {
    const rows = panels('room-a')
    mutate(rows)
    expect(() => validateAndNormalizeSixGridGroups([{
      ...group({ sceneKey: 'room-a', incomingContinuity: 'start', outgoingContinuity: 'end' }),
      panels: rows,
    }])).toThrow(SIX_GRID_PANEL_INVALID)
  })

  it('rejects props entries that are not non-empty strings', () => {
    const rows = panels('room-a').map((panel) => ({ ...panel, props: ['lamp'] }))
    rows[0].props = ['lamp', '']
    expect(() => validateAndNormalizeSixGridGroups([{
      ...group({ sceneKey: 'room-a', incomingContinuity: 'start', outgoingContinuity: 'end' }),
      panels: rows,
    }])).toThrow(SIX_GRID_PANEL_INVALID)
  })

  it('normalizes the real Chinese cinematography shape into canonical rules', () => {
    const rows = [1, 2, 3, 4, 5, 6].map((panel_number) => ({
      panel_number,
      scene_summary: '寝殿，白天',
      lighting: { direction: '右侧窗光', quality: '柔和自然光' },
      characters: [{
        name: '李凤华',
        screen_position: '画面左侧',
        posture: '站立',
        facing: '面向右侧',
      }],
      depth_of_field: '浅景深（T2.8）',
      color_tone: '暖色调',
    }))

    const result = validateSixGridPhotographyRules(rows)

    expect(result[0]).toMatchObject({
      panel_number: 1,
      composition: expect.stringContaining('李凤华'),
      lighting: expect.stringContaining('右侧窗光'),
      color_palette: '暖色调',
      atmosphere: '寝殿，白天',
      technical_notes: '浅景深（T2.8）',
    })
  })

  it('accepts and strictly validates the real English cinematography shape', () => {
    const rows = [1, 2, 3, 4, 5, 6].map((panel_number) => ({
      panel_number,
      composition: 'centered two-shot',
      lighting: 'soft window light',
      color_palette: 'warm amber',
      atmosphere: 'intimate',
      technical_notes: 'T2.8 shallow depth',
    }))

    expect(validateSixGridPhotographyRules(rows)[0]).toEqual(rows[0])
  })

  it.each([
    ['English lighting', { composition: 'center', lighting: { direction: 'left' }, color_palette: 'warm', atmosphere: 'calm', technical_notes: 'T4' }],
    ['Chinese lighting quality', { scene_summary: 'room', lighting: { direction: 'left', quality: 42 }, characters: [], depth_of_field: 'T4', color_tone: 'warm' }],
  ])('rejects invalid %s field types', (_label, invalidRow) => {
    const rows = [1, 2, 3, 4, 5, 6].map((panel_number) => ({ panel_number, ...invalidRow }))
    expect(() => validateSixGridPhotographyRules(rows)).toThrow('SIX_GRID_RULES_INVALID')
  })

  it('validates the real zh/en acting character shape', () => {
    const rows = [1, 2, 3, 4, 5, 6].map((panel_number) => ({
      panel_number,
      characters: [{ name: '李凤华', acting: '轻轻眨眼并看向右侧' }],
    }))
    expect(validateSixGridActingDirections(rows)).toEqual(rows)

    rows[0].characters = [{ name: '李凤华', acting: '' }]
    expect(() => validateSixGridActingDirections(rows)).toThrow('SIX_GRID_RULES_INVALID')
  })

  it('preserves the stable six-grid validation code in retry logs', () => {
    expect(getScriptToStoryboardStepErrorCode(
      new SixGridValidationError(SIX_GRID_PANEL_INVALID),
      'INTERNAL_ERROR',
    )).toBe(SIX_GRID_PANEL_INVALID)
  })

  it.each([
    ['duplicate', [1, 2, 2, 4, 5, 6]],
    ['out of order', [2, 1, 3, 4, 5, 6]],
  ])('rejects %s panel numbering', (_label, numbering) => {
    const rows = panels('room-a').map((panel, index) => ({
      ...panel,
      panel_number: numbering[index],
    }))
    expect(() => validateAndNormalizeSixGridGroups([{
      ...group({ sceneKey: 'room-a', incomingContinuity: 'start', outgoingContinuity: 'end' }),
      panels: rows,
    }])).toThrow(SIX_GRID_NUMBERING_INVALID)
  })

  it('assigns stable identities and preserves consecutive multi-groups for one clip', () => {
    const result = validateSixGridEpisodePlan([
      group({ clipId: 'clip-1', sceneKey: 'room-a', incomingContinuity: 'start', outgoingContinuity: 'anchor' }),
      group({ clipId: 'clip-1', sceneKey: 'room-a', incomingContinuity: 'anchor', outgoingContinuity: 'end' }),
      group({ clipId: 'clip-2', sceneKey: 'street', incomingContinuity: 'start', outgoingContinuity: 'end' }),
    ], ['clip-1', 'clip-2'])

    expect(result.map((item) => item.groupSequence)).toEqual([1, 2, 3])
    expect(new Set(result.map((item) => item.groupId)).size).toBe(3)
    expect(result[0].groupKey).not.toBe(result[1].groupKey)
  })

  it.each([
    ['omitted clip', [group({ clipId: 'clip-1', sceneKey: 'room-a', incomingContinuity: 'start', outgoingContinuity: 'end' })], SIX_GRID_CLIP_COVERAGE_INVALID],
    ['unknown clip', [
      group({ clipId: 'clip-1', sceneKey: 'room-a', incomingContinuity: 'start', outgoingContinuity: 'end' }),
      group({ clipId: 'clip-x', sceneKey: 'street', incomingContinuity: 'start', outgoingContinuity: 'end' }),
    ], SIX_GRID_CLIP_COVERAGE_INVALID],
    ['reverse order', [
      group({ clipId: 'clip-2', sceneKey: 'street', incomingContinuity: 'start', outgoingContinuity: 'end' }),
      group({ clipId: 'clip-1', sceneKey: 'room-a', incomingContinuity: 'start', outgoingContinuity: 'end' }),
    ], SIX_GRID_CLIP_ORDER_INVALID],
    ['non-consecutive repeated clip', [
      group({ clipId: 'clip-1', sceneKey: 'room-a', incomingContinuity: 'start', outgoingContinuity: 'end' }),
      group({ clipId: 'clip-2', sceneKey: 'street', incomingContinuity: 'start', outgoingContinuity: 'end' }),
      group({ clipId: 'clip-1', sceneKey: 'room-a', incomingContinuity: 'again', outgoingContinuity: 'end' }),
    ], SIX_GRID_CLIP_ORDER_INVALID],
  ])('rejects invalid episode coverage: %s', (_label, groups, errorCode) => {
    expect(() => validateSixGridEpisodePlan(groups, ['clip-1', 'clip-2'])).toThrow(errorCode)
  })

  it('preserves the individual per-clip planning branch', async () => {
    const actions: string[] = []
    const runStep = vi.fn(async (_meta, _prompt, action: string) => {
      actions.push(action)
      if (action === 'storyboard_phase1_plan' || action === 'storyboard_phase3_detail') {
        return { text: JSON.stringify(panels('room-a', 1)), reasoning: '' }
      }
      if (action === 'storyboard_phase2_cinematography') {
        return { text: JSON.stringify([{ panel_number: 1, composition: 'center' }]), reasoning: '' }
      }
      return { text: JSON.stringify([{ panel_number: 1, characters: [] }]), reasoning: '' }
    })

    await runScriptToStoryboardOrchestrator({
      runSettings: {
        storyboardGenerationMode: 'individual',
        sixGridCellAspectRatio: null,
        sixGridProcessingOrder: 'crop_then_panel_upscale',
        storyboardUpscaleModel: null,
        dialogueVideoModel: null,
      },
      clips: [{ id: 'clip-room-a', content: 'room', characters: '[]', location: 'room-a', screenplay: null }],
      novelPromotionData,
      promptTemplates,
      runStep,
    })

    expect(actions[0]).toBe('storyboard_phase1_plan')
    expect(actions).not.toContain('storyboard_six_grid_scene_plan')
  })

  it('plans the whole episode before any per-group cinematography', async () => {
    const actions: string[] = []
    const plannedGroups = [
      group({ sceneKey: 'room-a', incomingContinuity: 'room start', outgoingContinuity: 'room end' }),
      group({ sceneKey: 'street', incomingContinuity: 'street start', outgoingContinuity: 'street end' }),
    ]
    const runStep = vi.fn(async (_meta, prompt: string, action: string) => {
      actions.push(action)
      if (action === 'storyboard_six_grid_scene_plan') {
        expect(prompt).toContain('clip-room-a')
        expect(prompt).toContain('clip-street')
        return { text: JSON.stringify(plannedGroups), reasoning: '' }
      }
      const currentPanels = prompt.includes('street-1') ? panels('street') : panels('room-a')
      if (action === 'storyboard_phase2_cinematography') {
        return {
          text: JSON.stringify(currentPanels.map((panel) => photographyRule(panel.panel_number || 0))),
          reasoning: '',
        }
      }
      if (action === 'storyboard_phase2_acting') {
        return {
          text: JSON.stringify(currentPanels.map((panel) => ({ panel_number: panel.panel_number, characters: [] }))),
          reasoning: '',
        }
      }
      return { text: JSON.stringify(currentPanels), reasoning: '' }
    })

    const result = await runScriptToStoryboardOrchestrator({
      runSettings: {
        storyboardGenerationMode: 'six_grid',
        sixGridCellAspectRatio: '16:9',
        sixGridProcessingOrder: 'crop_then_panel_upscale',
        storyboardUpscaleModel: null,
        dialogueVideoModel: null,
      },
      clips: [
        { id: 'clip-room-a', content: 'room', characters: '[]', location: 'room-a', screenplay: null },
        { id: 'clip-street', content: 'street', characters: '[]', location: 'street', screenplay: null },
      ],
      novelPromotionData,
      promptTemplates,
      runStep,
    })

    expect(actions[0]).toBe('storyboard_six_grid_scene_plan')
    expect(actions.indexOf('storyboard_six_grid_scene_plan'))
      .toBeLessThan(actions.indexOf('storyboard_phase2_cinematography'))
    expect(result.clipPanels).toHaveLength(2)
    expect(result.clipPanels.every((item) => item.finalPanels.length === 6)).toBe(true)
    expect(result.clipPanels.map((item) => item.groupId)).toEqual([
      'six-grid:1:clip-room-a:1',
      'six-grid:2:clip-street:1',
    ])
    expect(result.sixGridGroups?.map((item) => item.groupSequence)).toEqual([1, 2])
  })

  it('tells the model the exact episode-plan contract enforced by the validator', async () => {
    let planningPrompt = ''
    const runStep = vi.fn(async (_meta, prompt: string, action: string) => {
      if (action === 'storyboard_six_grid_scene_plan') {
        planningPrompt = prompt
        return { text: JSON.stringify([group({ sceneKey: 'room-a', incomingContinuity: 'start', outgoingContinuity: 'end' })]), reasoning: '' }
      }
      if (action === 'storyboard_phase2_cinematography') {
        return { text: JSON.stringify([1, 2, 3, 4, 5, 6].map(photographyRule)), reasoning: '' }
      }
      if (action === 'storyboard_phase2_acting') {
        return { text: JSON.stringify([1, 2, 3, 4, 5, 6].map((panel_number) => ({ panel_number, characters: [] }))), reasoning: '' }
      }
      return { text: JSON.stringify(panels('room-a')), reasoning: '' }
    })

    await runScriptToStoryboardOrchestrator(buildSixGridInput(runStep))

    for (const requiredField of ['panel_number', 'description', 'location', 'source_text', 'characters']) {
      expect(planningPrompt).toContain(requiredField)
    }
    expect(planningPrompt).toContain('panel.location must exactly equal its group sceneKey')
    expect(planningPrompt).toContain('JSON only')
  })

  it('retries a malformed whole-episode plan and succeeds with corrected output', async () => {
    let planAttempts = 0
    const planningPrompts: string[] = []
    const validGroup = group({ sceneKey: 'room-a', incomingContinuity: 'start', outgoingContinuity: 'end' })
    const runStep = vi.fn(async (_meta, prompt: string, action: string) => {
      if (action === 'storyboard_six_grid_scene_plan') {
        planAttempts += 1
        planningPrompts.push(prompt)
        return {
          text: JSON.stringify(planAttempts === 1 ? [{ ...validGroup, panels: panels('room-a', 5) }] : [validGroup]),
          reasoning: '',
        }
      }
      if (action === 'storyboard_phase2_cinematography') {
        return { text: JSON.stringify(panels('room-a').map(({ panel_number }) => photographyRule(panel_number))), reasoning: '' }
      }
      if (action === 'storyboard_phase2_acting') {
        return { text: JSON.stringify(panels('room-a').map(({ panel_number }) => ({ panel_number, characters: [] }))), reasoning: '' }
      }
      expect(prompt).toContain('room-a')
      return { text: JSON.stringify(panels('room-a')), reasoning: '' }
    })

    await runScriptToStoryboardOrchestrator(buildSixGridInput(runStep))
    expect(planAttempts).toBe(2)
    expect(planningPrompts[1]).toContain(SIX_GRID_REQUIRES_EXACTLY_SIX_PANELS)
    expect(planningPrompts[1]).toContain('Correct the previous response')
    expect(planningPrompts[1]).not.toBe(planningPrompts[0])
  })

  it.each(['missing', 'duplicate'])('retries invalid %s cinematography numbering', async (kind) => {
    let cineAttempts = 0
    const runStep = vi.fn(async (_meta, _prompt, action: string) => {
      if (action === 'storyboard_six_grid_scene_plan') {
        return { text: JSON.stringify([group({ sceneKey: 'room-a', incomingContinuity: 'start', outgoingContinuity: 'end' })]), reasoning: '' }
      }
      if (action === 'storyboard_phase2_cinematography') {
        cineAttempts += 1
        const numbers = cineAttempts === 1
          ? (kind === 'missing' ? [1, 2, 3, 4, 5] : [1, 2, 2, 4, 5, 6])
          : [1, 2, 3, 4, 5, 6]
        return { text: JSON.stringify(numbers.map((panel_number) => photographyRule(panel_number))), reasoning: '' }
      }
      if (action === 'storyboard_phase2_acting') {
        return { text: JSON.stringify([1, 2, 3, 4, 5, 6].map((panel_number) => ({ panel_number, characters: [] }))), reasoning: '' }
      }
      return { text: JSON.stringify(panels('room-a')), reasoning: '' }
    })

    await runScriptToStoryboardOrchestrator(buildSixGridInput(runStep))
    expect(cineAttempts).toBe(2)
  })

  it.each(['missing', 'duplicate'])('retries invalid %s acting numbering', async (kind) => {
    let actingAttempts = 0
    const runStep = vi.fn(async (_meta, _prompt, action: string) => {
      if (action === 'storyboard_six_grid_scene_plan') {
        return { text: JSON.stringify([group({ sceneKey: 'room-a', incomingContinuity: 'start', outgoingContinuity: 'end' })]), reasoning: '' }
      }
      if (action === 'storyboard_phase2_cinematography') {
        return { text: JSON.stringify([1, 2, 3, 4, 5, 6].map(photographyRule)), reasoning: '' }
      }
      if (action === 'storyboard_phase2_acting') {
        actingAttempts += 1
        const numbers = actingAttempts === 1
          ? (kind === 'missing' ? [1, 2, 3, 4, 5] : [1, 2, 2, 4, 5, 6])
          : [1, 2, 3, 4, 5, 6]
        return { text: JSON.stringify(numbers.map((panel_number) => ({ panel_number, characters: [] }))), reasoning: '' }
      }
      return { text: JSON.stringify(panels('room-a')), reasoning: '' }
    })

    await runScriptToStoryboardOrchestrator(buildSixGridInput(runStep))
    expect(actingAttempts).toBe(2)
  })

  it('keeps two real orchestrator outputs for consecutive groups from the same clip', async () => {
    const plannedGroups = [
      group({ clipId: 'clip-room-a', sceneKey: 'room-a', incomingContinuity: 'start', outgoingContinuity: 'anchor' }),
      group({ clipId: 'clip-room-a', sceneKey: 'room-a', incomingContinuity: 'anchor', outgoingContinuity: 'end' }),
    ]
    const runStep = vi.fn(async (_meta, _prompt, action: string) => {
      if (action === 'storyboard_six_grid_scene_plan') {
        return { text: JSON.stringify(plannedGroups), reasoning: '' }
      }
      if (action === 'storyboard_phase2_cinematography') {
        return { text: JSON.stringify([1, 2, 3, 4, 5, 6].map(photographyRule)), reasoning: '' }
      }
      if (action === 'storyboard_phase2_acting') {
        return { text: JSON.stringify([1, 2, 3, 4, 5, 6].map((panel_number) => ({ panel_number, characters: [] }))), reasoning: '' }
      }
      return { text: JSON.stringify(panels('room-a')), reasoning: '' }
    })

    const result = await runScriptToStoryboardOrchestrator(buildSixGridInput(runStep))

    expect(result.sixGridGroups?.map((item) => item.groupId)).toEqual([
      'six-grid:1:clip-room-a:1',
      'six-grid:2:clip-room-a:2',
    ])
    expect(Object.keys(result.sixGridPhase1PanelsByGroupId || {})).toEqual([
      'six-grid:1:clip-room-a:1',
      'six-grid:2:clip-room-a:2',
    ])
  })

  it('resets panel numbering to 1..6 for the third six-grid group in every refinement prompt', async () => {
    const plannedGroups = [1, 2, 3].map((sequence) => group({
      clipId: 'clip-room-a',
      sceneKey: 'room-a',
      incomingContinuity: sequence === 1 ? 'start' : `anchor-${sequence - 1}`,
      outgoingContinuity: sequence === 3 ? 'end' : `anchor-${sequence}`,
    }))
    const thirdGroupPrompts: string[] = []
    const runStep = vi.fn(async (meta, prompt: string, action: string) => {
      if (action === 'storyboard_six_grid_scene_plan') {
        return { text: JSON.stringify(plannedGroups), reasoning: '' }
      }
      if (String(meta.stepId).startsWith('six_grid_group_3_')) thirdGroupPrompts.push(prompt)
      if (action === 'storyboard_phase2_cinematography') {
        return { text: JSON.stringify([1, 2, 3, 4, 5, 6].map(photographyRule)), reasoning: '' }
      }
      if (action === 'storyboard_phase2_acting') {
        return { text: JSON.stringify([1, 2, 3, 4, 5, 6].map((panel_number) => ({ panel_number, characters: [] }))), reasoning: '' }
      }
      return { text: JSON.stringify(panels('room-a')), reasoning: '' }
    })

    await runScriptToStoryboardOrchestrator(buildSixGridInput(runStep))

    expect(thirdGroupPrompts).toHaveLength(3)
    for (const prompt of thirdGroupPrompts) {
      expect(prompt).toContain('For this group, panel_number must restart at 1')
      expect(prompt).toContain('[1, 2, 3, 4, 5, 6]')
      expect(prompt).toContain('Do not continue numbering from any previous group')
    }
  })

  it('fails with a stable code after every scene-plan attempt is malformed', async () => {
    let attempts = 0
    const runStep = vi.fn(async (_meta, _prompt, action: string) => {
      if (action === 'storyboard_six_grid_scene_plan') {
        attempts += 1
        return {
          text: JSON.stringify([{
            ...group({ sceneKey: 'room-a', incomingContinuity: 'start', outgoingContinuity: 'end' }),
            panels: panels('room-a', 7),
          }]),
          reasoning: '',
        }
      }
      throw new Error(`unexpected action ${action}`)
    })

    await expect(runScriptToStoryboardOrchestrator(buildSixGridInput(runStep)))
      .rejects.toMatchObject({ code: SIX_GRID_REQUIRES_EXACTLY_SIX_PANELS })
    expect(attempts).toBe(3)
  })
})

function buildSixGridInput(runStep: ReturnType<typeof vi.fn>) {
  return {
    runSettings: {
      storyboardGenerationMode: 'six_grid' as const,
      sixGridCellAspectRatio: '16:9' as const,
      sixGridProcessingOrder: 'crop_then_panel_upscale' as const,
      storyboardUpscaleModel: null,
      dialogueVideoModel: null,
    },
    clips: [{ id: 'clip-room-a', content: 'room', characters: '[]', location: 'room-a', screenplay: null }],
    novelPromotionData,
    promptTemplates,
    runStep,
  }
}
