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
  buildConnectionUpdate,
  connectionEditorKey,
  initialConnectionValues,
  safelyRunConnectionAction,
  resolveConnectionRequestError,
  statusPollingInterval,
  validateConnectionCredentials,
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
    editConnection: 'Edit Studio GPU', testConnection: 'Test Studio GPU',
    enableConnection: 'Enable Studio GPU', disableConnection: 'Disable Studio GPU',
    deleteConnection: 'Delete Studio GPU',
    credentialsRequired: 'Enter credentials', basicCredentialsPair: 'Enter both username and password',
    preservedCredential: 'Leave blank to keep the saved credential',
    states: {
      online_idle: 'Idle', online_busy_owned: 'Busy · waoowaoo',
      online_busy_external: 'Busy · external', offline: 'Offline',
      auth_failed: 'Authentication failed', workflow_incompatible: 'Workflow incompatible',
      disabled: 'Disabled', checking: 'Checking status',
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
      token: '', username: '', password: '',
    }, connection)).toEqual({})
  })

  it('builds only actual edit deltas and never rolls back enabled state', () => {
    expect(buildConnectionPayload({
      name: 'Renamed GPU', baseUrl: connection.baseUrl, authType: connection.authType,
      token: '', username: '', password: '',
    }, connection)).toEqual({ name: 'Renamed GPU' })
    expect(JSON.stringify(buildConnectionPayload({
      name: connection.name, baseUrl: connection.baseUrl, authType: connection.authType,
      token: 'replacement', username: '', password: '',
    }, connection))).not.toContain('enabled')
    expect(buildConnectionPayload({
      name: 'New GPU', baseUrl: '10.0.0.9:8188', authType: 'none',
      token: '', username: '', password: '',
    }, null)).toEqual({
      name: 'New GPU', baseUrl: '10.0.0.9:8188', authType: 'none', enabled: true,
    })
  })

  it('requires complete new credentials but preserves a completely blank same-auth edit', () => {
    const base = { name: connection.name, baseUrl: connection.baseUrl, token: '', username: '', password: '' }
    expect(validateConnectionCredentials({ ...base, authType: 'bearer' }, connection)).toBeNull()
    expect(validateConnectionCredentials({ ...base, authType: 'basic', username: 'alice' }, connection))
      .toBe('basicCredentialsPair')
    expect(validateConnectionCredentials({ ...base, authType: 'basic' }, connection))
      .toBe('credentialsRequired')
    expect(validateConnectionCredentials({ ...base, authType: 'bearer' }, { ...connection, authType: 'none' }))
      .toBe('credentialsRequired')
    expect(validateConnectionCredentials({ ...base, authType: 'none' }, connection)).toBeNull()
  })

  it('uses a distinct remount key and initial values when switching editor targets', () => {
    const second = { ...connection, id: 'connection-2', name: 'Second GPU', baseUrl: 'http://10.0.0.9:8188' }
    expect(connectionEditorKey(connection)).toBe('mode:connection-1')
    expect(connectionEditorKey(second)).toBe('mode:connection-2')
    expect(connectionEditorKey(null)).toBe('mode:new')
    expect(initialConnectionValues(second)).toMatchObject({
      name: 'Second GPU', baseUrl: 'http://10.0.0.9:8188', token: '', username: '', password: '',
    })
    expect(initialConnectionValues(null)).toMatchObject({ name: '', baseUrl: '', authType: 'none' })
    expect(buildConnectionUpdate(second, {
      ...initialConnectionValues(second), name: 'Second GPU renamed',
    })).toEqual({ id: 'connection-2', payload: { name: 'Second GPU renamed' } })
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
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('aria-atomic="true"')
    expect(html).toContain('aria-label="Edit Studio GPU"')
    expect(html).toContain('aria-label="Test Studio GPU"')
    expect(html).toContain('aria-label="Disable Studio GPU"')
    expect(html).toContain('aria-label="Delete Studio GPU"')
  })

  it('polls every five seconds only while the document is visible', () => {
    expect(statusPollingInterval('visible')).toBe(5_000)
    expect(statusPollingInterval('hidden')).toBe(false)
  })

  it('shows owned work but leaves deletion to the server-side live lease check', () => {
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
    expect(html).toMatch(/aria-label="Delete Studio GPU"(?![^>]*disabled)/)
    expect(html).toMatch(/aria-label="Disable Studio GPU"(?![^>]*disabled)/)
  })

  it('allows deletion attempts even when node status is missing or stale', () => {
    const disabled = { ...connection, enabled: false, lastHealthCode: 'online_busy_owned' }
    const missing = render(createElement(ConnectionCard, {
      connection: disabled, onEdit: () => undefined, onProbe: async () => undefined,
      onToggle: async () => undefined, onDelete: async () => undefined,
    }))
    expect(missing).toContain('Disabled')
    expect(missing).toMatch(/aria-label="Delete Studio GPU"(?![^>]*disabled)/)

    const activeStatus: ComfyStatusView = {
      connectionId: disabled.id, state: 'disabled', checkedAt: null,
      runningCount: 0, pendingCount: 0,
      ownedTask: { requestId: 'request-1', taskId: 'task-42', status: 'running' },
    }
    const active = render(createElement(ConnectionCard, {
      connection: disabled, status: activeStatus, onEdit: () => undefined,
      onProbe: async () => undefined, onToggle: async () => undefined, onDelete: async () => undefined,
    }))
    expect(active).toContain('task-42 · running')
    expect(active).toMatch(/aria-label="Delete Studio GPU"(?![^>]*disabled)/)

    const completed = render(createElement(ConnectionCard, {
      connection: disabled, status: { ...activeStatus, ownedTask: null }, onEdit: () => undefined,
      onProbe: async () => undefined, onToggle: async () => undefined, onDelete: async () => undefined,
    }))
    expect(completed).toMatch(/aria-label="Delete Studio GPU"(?![^>]*disabled)/)
    expect(completed).not.toContain('Active owned generation')
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

  it('shows the owned-work message when delete hits a live connection lease', async () => {
    const errors: Array<string | null> = []
    await safelyRunConnectionAction(
      () => Promise.reject({ status: 409, code: 'CONFLICT' }),
      (error) => errors.push(error),
      { conflictError: 'deleteBlockedOwned' },
    )
    expect(errors).toEqual([null, 'deleteBlockedOwned'])
  })

  it('maps connection request failures to specific safe messages without exposing server details', () => {
    expect(resolveConnectionRequestError({ status: 401, code: 'UNAUTHORIZED' })).toBe('requestUnauthorized')
    expect(resolveConnectionRequestError({ status: 409, code: 'CONFLICT' })).toBe('connectionConflict')
    expect(resolveConnectionRequestError({ status: 400, code: 'INVALID_PARAMS' })).toBe('connectionInvalid')
    expect(resolveConnectionRequestError({ status: 500, code: 'INTERNAL_ERROR' })).toBe('serverUnavailable')
    expect(resolveConnectionRequestError(
      new Error('Authorization: Bearer top-secret server trace'),
    )).toBe('requestFailed')
  })

  it('uses responsive profile navigation and content layout on narrow screens', () => {
    const source = readFileSync('src/app/[locale]/profile/page.tsx', 'utf8')
    expect(source).toContain('flex-col md:flex-row')
    expect(source).toContain('w-full md:w-64')
    expect(source).toContain('overflow-x-auto md:overflow-visible')
    expect(source).toContain('min-w-0')
  })
})
