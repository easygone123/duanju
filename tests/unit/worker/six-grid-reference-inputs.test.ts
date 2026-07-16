import { describe, expect, it, vi } from 'vitest'
import { COMFY_REFERENCE_UPLOAD_LIMIT } from '@/lib/comfyui/types'
import { collectSixGridReferenceInputs } from '@/lib/novel-promotion/six-grid/reference-inputs'

describe('six-grid reference input snapshot', () => {
  it('collects references in panel order, deduplicates assets, and enforces the upload limit', async () => {
    const projectData = { characters: [], locations: [] }
    const panels = Array.from({ length: 6 }, (_, index) => ({
      characters: `panel-${index}`,
    }))
    const collectPanel = vi.fn(async (_project: unknown, panel: { characters?: string | null }) => ([
      { source: 'images/shared.png', url: '/api/storage/sign?key=shared.png&expires=3600', kind: 'character' as const, name: 'Hero' },
      { source: `images/${panel.characters}.png`, url: `/api/storage/sign?key=${panel.characters}.png&expires=3600`, kind: 'location' as const, name: panel.characters || 'unknown' },
    ]))

    const result = await collectSixGridReferenceInputs({
      projectId: 'project-1',
      panels,
    }, {
      resolveProjectData: vi.fn(async () => projectData),
      collectPanel,
    })

    expect(collectPanel).toHaveBeenCalledTimes(6)
    expect(result[0]).toEqual({
      source: 'images/shared.png', kind: 'character', name: 'Hero',
    })
    expect(result.filter((item) => item.source.endsWith('shared.png'))).toHaveLength(1)
    expect(result).toHaveLength(Math.min(7, COMFY_REFERENCE_UPLOAD_LIMIT))
  })
})
