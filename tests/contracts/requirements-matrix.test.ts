import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REQUIREMENTS_MATRIX } from './requirements-matrix'

function fileExists(repoPath: string) {
  return fs.existsSync(path.resolve(process.cwd(), repoPath))
}

describe('requirements matrix integrity', () => {
  it('requirement ids are unique', () => {
    const ids = REQUIREMENTS_MATRIX.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('all declared test files exist', () => {
    for (const entry of REQUIREMENTS_MATRIX) {
      expect(entry.tests.length, entry.id).toBeGreaterThan(0)
      for (const testPath of entry.tests) {
        expect(fileExists(testPath), `${entry.id} -> ${testPath}`).toBe(true)
      }
    }
  })

  it('maps every ComfyUI acceptance criterion to the end-to-end fake system test', () => {
    const expectedIds = Array.from(
      { length: 11 },
      (_, index) => `REQ-COMFYUI-AC-${String(index + 1).padStart(2, '0')}`,
    )
    const entries = REQUIREMENTS_MATRIX.filter((entry) => entry.id.startsWith('REQ-COMFYUI-AC-'))

    expect(entries.map((entry) => entry.id)).toEqual(expectedIds)
    for (const entry of entries) {
      expect(entry.tests).toContain('tests/system/comfyui-generation.system.test.ts')
      const escapedId = entry.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const executableTitle = new RegExp(`(?:it|test)\\(\\s*['\"\\\`]${escapedId}\\b`, 'g')
      const titleCount = entry.tests.reduce((count, testPath) => {
        const source = fs.readFileSync(path.resolve(process.cwd(), testPath), 'utf8')
        return count + [...source.matchAll(executableTitle)].length
      }, 0)
      expect(titleCount, `${entry.id} executable evidence`).toBe(1)
    }
  })

  it('keeps the real ComfyUI contract check opt-in', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(packageJson.scripts['check:comfyui-contract']).toBe('tsx scripts/comfyui-contract-check.ts')
    expect(packageJson.scripts['test:system']).not.toContain('check:comfyui-contract')
    expect(packageJson.scripts['test:all']).not.toContain('check:comfyui-contract')
  })

  it('documents the complete ComfyUI operating contract in both READMEs', () => {
    for (const filename of ['README.md', 'README_en.md']) {
      const readme = fs.readFileSync(path.resolve(process.cwd(), filename), 'utf8')
      for (const requiredText of [
        'COMFYUI_ENABLED', 'COMFYUI_NETWORK_MODE', 'allowlist', 'trusted',
        'host.docker.internal', 'API Format', 'online_busy_external',
        'COMFYUI_CONTRACT_WORKFLOW_FILE', 'npm run check:comfyui-contract',
        'CC BY-NC-SA 4.0',
      ]) expect(readme, `${filename} -> ${requiredText}`).toContain(requiredText)
    }
  })
})
