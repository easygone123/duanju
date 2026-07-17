import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { REQUIREMENTS_MATRIX } from './requirements-matrix'

const SYSTEM_TEST = 'tests/system/six-grid-storyboard.system.test.ts'
const EXPECTED_IDS = Array.from(
  { length: 8 },
  (_, index) => `REQ-NP-SIX-GRID-${String(index + 1).padStart(2, '0')}`,
)

function expectExecutableTest(filename: string, testTitle: string) {
  const source = fs.readFileSync(path.resolve(process.cwd(), filename), 'utf8')
  const escaped = testTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const title = new RegExp(`(?:it|test)\\(\\s*'${escaped}'\\s*,`, 'g')
  expect([...source.matchAll(title)], `${filename} -> ${testTitle}`).toHaveLength(1)
}

describe('six-grid requirements matrix', () => {
  it('maps the original six-grid requirements to one executable system-test title', () => {
    const entries = REQUIREMENTS_MATRIX.filter((entry) => entry.id.startsWith('REQ-NP-SIX-GRID-'))
    expect(entries.map((entry) => entry.id)).toEqual(EXPECTED_IDS)
    for (const entry of entries.slice(0, 6)) {
      expect(entry.priority).toBe('P0')
      expect(entry.tests).toContain(SYSTEM_TEST)
      const source = fs.readFileSync(path.resolve(process.cwd(), SYSTEM_TEST), 'utf8')
      const title = source.match(new RegExp(`(?:it|test)\\(\\s*'(${entry.id}[^']*)'\\s*,`))?.[1]
      expect(title, entry.id).toBeDefined()
      expectExecutableTest(SYSTEM_TEST, title!)
    }
  })

  it('documents six-grid operation, migration, and safety limits for local and Compose installs', () => {
    for (const filename of ['README.md', 'README_en.md']) {
      const source = fs.readFileSync(path.resolve(process.cwd(), filename), 'utf8')
      for (const requiredText of [
        'six_grid',
        'sheet_upscale_then_crop',
        'crop_then_panel_upscale',
        'SIX_GRID_CROP_MAX_SOURCE_BYTES',
        'SIX_GRID_CROP_MAX_SOURCE_PIXELS',
        'npx prisma migrate deploy',
      ]) expect(source, `${filename} -> ${requiredText}`).toContain(requiredText)
    }

    for (const filename of ['.env.example', 'docker-compose.yml']) {
      const source = fs.readFileSync(path.resolve(process.cwd(), filename), 'utf8')
      expect(source).toContain('SIX_GRID_CROP_MAX_SOURCE_BYTES')
      expect(source).toContain('SIX_GRID_CROP_MAX_SOURCE_PIXELS')
    }
  })

  it('maps external upload, exact prompt copy, replacement invalidation, and both processing orders', () => {
    const upload = REQUIREMENTS_MATRIX.find((entry) => entry.id === 'REQ-NP-SIX-GRID-07')
    const lineage = REQUIREMENTS_MATRIX.find((entry) => entry.id === 'REQ-NP-SIX-GRID-08')

    expect(upload).toMatchObject({
      priority: 'P0',
      tests: expect.arrayContaining([
        'tests/unit/components/six-grid-external-upload.test.tsx',
        'tests/integration/six-grid/six-grid-upload-replacement.integration.test.ts',
      ]),
    })
    expect(upload?.userValue).toContain('生成前')
    expect(upload?.userValue).toContain('原样复制')
    expect(upload?.risk).toContain('血缘')
    expectExecutableTest(
      'tests/unit/components/six-grid-external-upload.test.tsx',
      'shows contextual stored text as readonly and copies the exact string',
    )
    expectExecutableTest(
      'tests/integration/six-grid/six-grid-upload-replacement.integration.test.ts',
      'replaces version 4 with 5 and clears stale sheet and panel image lineage',
    )

    expect(lineage).toMatchObject({
      priority: 'P0',
      tests: expect.arrayContaining([
        'tests/integration/six-grid/six-grid-crop-media.integration.test.ts',
        'tests/unit/worker/storyboard-sheet-task-handler.test.ts',
      ]),
    })
    expect(lineage?.userValue).toContain('crop_then_panel_upscale')
    expect(lineage?.userValue).toContain('sheet_upscale_then_crop')
    expect(lineage?.risk).toContain('旧任务')
    for (const title of [
      'directly crops the uploaded original at version 5',
      'crops the newly upscaled uploaded sheet instead of its original',
      'rejects a version-4 generation worker after an uploaded sheet advances the storyboard to version 5',
      'rejects a stale sheet upscale after upload replaces its snapshotted original',
      'rejects a stale panel upscale after upload clears the prior crop source',
      'rejects a stale crop after upload advances to version 5 and replaces the source',
    ]) expectExecutableTest('tests/unit/worker/storyboard-sheet-task-handler.test.ts', title)
    for (const title of [
      'directly crops the uploaded original sheet and records that media as the source',
      'crops the newly upscaled uploaded sheet instead of the original sheet',
    ]) expectExecutableTest('tests/integration/six-grid/six-grid-crop-media.integration.test.ts', title)
  })
})
