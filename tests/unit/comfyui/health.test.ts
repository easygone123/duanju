import { describe, expect, it } from 'vitest'

import { deriveComfyHealth, sanitizeComfyHealthDiagnostic } from '@/lib/comfyui/health'
import { COMFY_ERROR_CODE, ComfyError } from '@/lib/comfyui/errors'

describe('deriveComfyHealth', () => {
  const checkedAt = new Date('2026-07-11T08:00:00.000Z')

  it('reports an empty queue without owned work as exactly online_idle', () => {
    expect(deriveComfyHealth({
      checkedAt,
      systemStats: {
        system: { comfyui_version: '0.3.50' },
        devices: [{ name: 'RTX 4090', type: 'cuda', vram_total: 24, vram_free: 20 }],
      },
      queue: { running: [], pending: [] },
      ownedNonterminalCount: 0,
    })).toEqual({
      state: 'online_idle',
      checkedAt: checkedAt.toISOString(),
      version: '0.3.50',
      devices: [{ name: 'RTX 4090', type: 'cuda', vramTotalBytes: 24, vramFreeBytes: 20 }],
      runningCount: 0,
      pendingCount: 0,
    })
  })

  it('reports an owned nonterminal request as exactly online_busy_owned', () => {
    expect(deriveComfyHealth({
      checkedAt,
      systemStats: {},
      queue: { running: [['owned']], pending: [] },
      ownedNonterminalCount: 1,
    }).state).toBe('online_busy_owned')
  })

  it('reports a nonempty queue without owned work as exactly online_busy_external', () => {
    expect(deriveComfyHealth({
      checkedAt,
      systemStats: {},
      queue: { running: [], pending: [['manual']] },
      ownedNonterminalCount: 0,
    }).state).toBe('online_busy_external')
  })

  it('reports authentication errors as exactly auth_failed', () => {
    expect(deriveComfyHealth({
      checkedAt,
      error: new ComfyError(COMFY_ERROR_CODE.AUTH_FAILED, 'secret must not persist'),
      ownedNonterminalCount: 0,
    })).toEqual({
      state: 'auth_failed',
      checkedAt: checkedAt.toISOString(),
      code: COMFY_ERROR_CODE.AUTH_FAILED,
      message: 'Authentication failed',
      runningCount: 0,
      pendingCount: 0,
    })
  })

  it('reports all other failures as exactly offline with a sanitized diagnostic', () => {
    const result = deriveComfyHealth({
      checkedAt,
      error: new Error('connect ECONNREFUSED bearer super-secret'),
      ownedNonterminalCount: 0,
    })
    expect(result).toEqual({
      state: 'offline',
      checkedAt: checkedAt.toISOString(),
      code: COMFY_ERROR_CODE.CONNECTION_OFFLINE,
      message: 'Connection unavailable',
      runningCount: 0,
      pendingCount: 0,
    })
    expect(JSON.stringify(result)).not.toContain('super-secret')
  })
})

describe('sanitizeComfyHealthDiagnostic', () => {
  it('persists only stable projected fields and bounded device text', () => {
    expect(sanitizeComfyHealthDiagnostic({
      state: 'online_idle',
      checkedAt: '2026-07-11T08:00:00.000Z',
      version: '0.3.50',
      devices: [{ name: 'x'.repeat(300), type: 'cuda', vramTotalBytes: 24, vramFreeBytes: 20 }],
      runningCount: 0,
      pendingCount: 0,
    })).toEqual({
      lastHealthAt: new Date('2026-07-11T08:00:00.000Z'),
      lastHealthCode: 'online_idle',
      lastHealthMessage: null,
      lastSeenVersion: '0.3.50',
      deviceSummary: [{ name: 'x'.repeat(160), type: 'cuda', vramTotalBytes: 24, vramFreeBytes: 20 }],
    })
  })
})
