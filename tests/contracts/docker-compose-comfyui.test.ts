import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const defaults: Readonly<Record<string, string>> = {
  COMFYUI_ENABLED: 'true',
  COMFYUI_NETWORK_MODE: 'trusted',
  COMFYUI_ALLOWED_HOSTS: '',
  COMFYUI_ALLOWED_CIDRS: '',
  COMFYUI_HEALTH_INTERVAL_MS: '10000',
  COMFYUI_DISPATCH_INTERVAL_MS: '1000',
  COMFYUI_RECONCILE_INTERVAL_MS: '15000',
  COMFYUI_LEASE_TTL_MS: '30000',
  COMFYUI_IMAGE_TIMEOUT_MS: '300000',
  COMFYUI_VIDEO_TIMEOUT_MS: '1200000',
  COMFYUI_WORKFLOW_MAX_BYTES: '2097152',
  COMFYUI_INPUT_MAX_BYTES: '26214400',
  COMFYUI_OUTPUT_MAX_BYTES: '536870912',
  COMFYUI_DISPATCH_CONCURRENCY: '8',
  COMFYUI_PAGE_SIZE: '100',
  COMFYUI_FAILURE_BACKOFF_BASE_MS: '1000',
  COMFYUI_FAILURE_BACKOFF_MAX_MS: '60000',
}

describe('Docker Compose ComfyUI environment contract', () => {
  it('builds the app from the checked-out source instead of silently running only the remote image', () => {
    const compose = fs.readFileSync(path.resolve(process.cwd(), 'docker-compose.yml'), 'utf8')
    expect(compose).toContain('  app:\n    build:\n      context: .\n      dockerfile: Dockerfile')
  })

  it('uses safe shell interpolation for every ComfyUI setting without hardcoding deployment values', () => {
    const compose = fs.readFileSync(path.resolve(process.cwd(), 'docker-compose.yml'), 'utf8')
    for (const [name, fallback] of Object.entries(defaults)) {
      expect(compose).toContain(`${name}: "\${${name}:-${fallback}}"`)
    }
  })

  it('expands explicit ComfyUI deployment values through docker compose config when CLI is available', () => {
    try {
      execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' })
    } catch {
      return
    }
    const rendered = execFileSync('docker', ['compose', 'config'], {
      cwd: process.cwd(), encoding: 'utf8',
      env: {
        ...process.env,
        COMFYUI_ENABLED: 'true',
        COMFYUI_NETWORK_MODE: 'trusted',
        COMFYUI_ALLOWED_HOSTS: 'gpu.example.test',
        COMFYUI_ALLOWED_CIDRS: '10.20.0.0/16',
        COMFYUI_LEASE_TTL_MS: '45678',
      },
    })
    expect(rendered).toContain('COMFYUI_ENABLED: "true"')
    expect(rendered).toContain('COMFYUI_NETWORK_MODE: trusted')
    expect(rendered).toContain('COMFYUI_ALLOWED_HOSTS: gpu.example.test')
    expect(rendered).toContain('COMFYUI_ALLOWED_CIDRS: 10.20.0.0/16')
    expect(rendered).toContain('COMFYUI_LEASE_TTL_MS: "45678"')
  })
})
