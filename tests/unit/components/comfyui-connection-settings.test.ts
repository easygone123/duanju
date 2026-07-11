import * as React from 'react'
import { createElement } from 'react'
import type { ComponentProps } from 'react'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'

import ConnectionCard from '@/app/[locale]/profile/components/comfyui/ConnectionCard'
import ConnectionEditor from '@/app/[locale]/profile/components/comfyui/ConnectionEditor'
import {
  buildConnectionPayload,
  safelyRunConnectionAction,
  statusPollingInterval,
  type ComfyConnectionView,
  type ComfyStatusView,
} from '@/app/[locale]/profile/components/comfyui/hooks'

const messages = {
  comfyui: {
    name: 'Name', baseUrl: 'IP or URL', authType: 'Authentication', authNone: 'None',
    authBearer: 'Bearer token', authBasic: 'Username and password', token: 'Token',
    username: 'Username', password: 'Password', save: 'Save', cancel: 'Cancel',
    addConnection: 'Add connection', edit: 'Edit', test: 'Test', delete: 'Delete',
    enable: 'Enable', disable: 'Disable', lastCheck: 'Last check', never: 'Never',
    queue: 'Queue', running: 'running', pending: 'pending', device: 'Device', vram: 'VRAM',
    version: 'Version', unknownVersion: '—',
    ownedTask: 'Current waoowaoo task', ownedTaskActive: 'Active owned generation',
    deleteBlockedOwned: 'Owned work is active',
    preservedCredential: 'Leave blank to keep the saved credential',
    states: {
      online_idle: 'Idle', online_busy_owned: 'Busy · waoowaoo',
      online_busy_external: 'Busy · external', offline: 'Offline',
      auth_failed: 'Authentication failed', workflow_incompatible: 'Workflow incompatible',
    },
  },
}

const connection: ComfyConnectionView = {
  id: 'connection-1', name: 'Studio GPU', baseUrl: 'http://10.0.0.8:8188',
  authType: 'bearer', enabled: true, hasCredentials: true,
  lastHealthAt: null, lastHealthCode: null, lastHealthMessage: null,
  lastSeenVersion: null, deviceSummary: [], lastAssignedAt: null,
  createdAt: '2026-07-11T00:00:00.000Z', updatedAt: '2026-07-11T00:00:00.000Z',
}

function render(node: React.ReactNode) {
  Reflect.set(globalThis, 'React', React)
  const providerProps: ComponentProps<typeof NextIntlClientProvider> = {
    locale: 'en', messages, timeZone: 'UTC', children: node,
  }
  return renderToStaticMarkup(createElement(NextIntlClientProvider, providerProps))
}

describe('ComfyUI connection settings', () => {
  it('adds ComfyUI to profile navigation and renders its section', () => {
    const source = readFileSync('src/app/[locale]/profile/page.tsx', 'utf8')
    expect(source).toContain("'comfyui'")
    expect(source).toContain("t('comfyui')")
    expect(source).toContain('<ComfyUiSettings />')
  })

  it('renders name, URL, authentication, and secret fields without hydrating a saved secret', () => {
    const html = render(createElement(ConnectionEditor, {
      connection, onSubmit: async () => undefined, onCancel: () => undefined,
    }))
    expect(html).toContain('value="Studio GPU"')
    expect(html).toContain('value="http://10.0.0.8:8188"')
    expect(html).toContain('aria-label="Authentication"')
    expect(html).toContain('aria-label="Token"')
    expect(html).not.toContain('value="secret')
    expect(html).toContain('Leave blank to keep the saved credential')
  })

  it('accepts a bare IP address as well as a complete URL', () => {
    const html = render(createElement(ConnectionEditor, {
      onSubmit: async () => undefined, onCancel: () => undefined,
    }))
    expect(html).toContain('inputMode="url"')
    expect(html).not.toContain('type="url"')
  })

  it('omits an empty credential during edit so the server preserves the saved value', () => {
    expect(buildConnectionPayload({
      name: 'Studio GPU', baseUrl: 'http://10.0.0.8:8188', authType: 'bearer',
      token: '', username: '', password: '', enabled: true,
    }, true)).toEqual({
      name: 'Studio GPU', baseUrl: 'http://10.0.0.8:8188', authType: 'bearer', enabled: true,
    })
  })

  it.each([
    ['online_idle', 'Idle'], ['online_busy_owned', 'Busy · waoowaoo'],
    ['online_busy_external', 'Busy · external'], ['offline', 'Offline'],
    ['auth_failed', 'Authentication failed'],
    ['workflow_incompatible', 'Workflow incompatible'],
  ] as const)('renders the approved %s state', (state, label) => {
    const status: ComfyStatusView = {
      connectionId: connection.id, state, checkedAt: '2026-07-11T08:00:00.000Z',
      runningCount: state.includes('busy') ? 1 : 0, pendingCount: 2,
      ownedTask: null,
      devices: [{ name: 'RTX 4090', vramTotalBytes: 24 * 1024 ** 3, vramFreeBytes: 16 * 1024 ** 3 }],
    }
    const html = render(createElement(ConnectionCard, {
      connection, status, onEdit: () => undefined, onProbe: async () => undefined,
      onToggle: async () => undefined, onDelete: async () => undefined,
    }))
    expect(html).toContain(label)
    expect(html).toContain('http://10.0.0.8:8188')
    expect(html).toContain('RTX 4090')
    expect(html).toContain('16.0 GB / 24.0 GB')
    expect(html).toContain(`${state.includes('busy') ? 1 : 0} running · 2 pending`)
  })

  it('polls every five seconds only while the document is visible', () => {
    expect(statusPollingInterval('visible')).toBe(5_000)
    expect(statusPollingInterval('hidden')).toBe(false)
  })

  it('shows owned work and disables deletion while waoowaoo owns the instance', () => {
    const html = render(createElement(ConnectionCard, {
      connection,
      status: {
        connectionId: connection.id, state: 'online_busy_owned',
        checkedAt: '2026-07-11T08:00:00.000Z', runningCount: 1, pendingCount: 0,
        version: '0.3.50', ownedTask: { requestId: 'request-9', taskId: 'task-42', status: 'running' },
      },
      onEdit: () => undefined, onProbe: async () => undefined,
      onToggle: async () => undefined, onDelete: async () => undefined,
    }))
    expect(html).toContain('task-42')
    expect(html).toContain('running')
    expect(html).toContain('0.3.50')
    expect(html).toMatch(/disabled=""[^>]*aria-label="Delete"/)
  })

  it('catches rejected card actions and reports only a localized safe error', async () => {
    const errors: Array<string | null> = []
    await expect(safelyRunConnectionAction(
      () => Promise.reject(new Error('Authorization: Bearer top-secret server trace')),
      (error) => errors.push(error),
    )).resolves.toBeUndefined()
    expect(errors).toEqual([null, 'requestFailed'])
    expect(JSON.stringify(errors)).not.toContain('top-secret')
  })

  it('uses responsive profile navigation and content layout on narrow screens', () => {
    const source = readFileSync('src/app/[locale]/profile/page.tsx', 'utf8')
    expect(source).toContain('flex-col md:flex-row')
    expect(source).toContain('w-full md:w-64')
    expect(source).toContain('overflow-x-auto md:overflow-visible')
    expect(source).toContain('min-w-0')
  })
})
