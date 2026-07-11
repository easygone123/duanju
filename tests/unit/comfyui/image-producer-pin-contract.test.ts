import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('project image producer Comfy version pin contract', () => {
  it.each([
    'src/app/api/novel-promotion/[projectId]/panel-variant/route.ts',
    'src/app/api/novel-promotion/[projectId]/modify-storyboard-image/route.ts',
    'src/app/api/novel-promotion/[projectId]/regenerate-group/route.ts',
    'src/app/api/novel-promotion/[projectId]/regenerate-panel-image/route.ts',
    'src/app/api/novel-promotion/[projectId]/regenerate-single-image/route.ts',
  ])('%s uses the central payload builder with its resolved project snapshot', (path) => {
    const source = readFileSync(path, 'utf8')
    expect(source).toContain('buildImageBillingPayload({')
    expect(source).toMatch(/buildImageBillingPayload\(\{[\s\S]*?projectModelConfig,[\s\S]*?basePayload:/)
  })

  it('project asset actions pass the resolved project snapshot to both image builders', () => {
    const source = readFileSync('src/lib/assets/services/asset-actions.ts', 'utf8')
    const calls = source.match(/buildImageBillingPayload\(\{[\s\S]*?projectModelConfig,[\s\S]*?basePayload:/g)
    expect(calls).toHaveLength(2)
  })
})
