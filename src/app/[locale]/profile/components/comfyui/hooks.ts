'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { apiFetch } from '@/lib/api-fetch'
import type { ComfyAuthType, ComfyDeviceSummary, ComfyHealthState } from '@/lib/comfyui/types'

export interface ComfyConnectionView {
  id: string
  name: string
  baseUrl: string
  authType: ComfyAuthType
  enabled: boolean
  hasCredentials: boolean
  lastHealthAt: string | null
  lastHealthCode: string | null
  lastHealthMessage: string | null
  lastSeenVersion: string | null
  deviceSummary: ComfyDeviceSummary[]
  lastAssignedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface ComfyStatusView {
  connectionId: string
  state: ComfyHealthState | 'disabled'
  checkedAt: string | null
  runningCount: number
  pendingCount: number
  version?: string
  devices?: ComfyDeviceSummary[]
  message?: string
  ownedTask: { requestId: string; taskId: string; status: string } | null
}

export interface ConnectionFormValues {
  name: string
  baseUrl: string
  authType: ComfyAuthType
  token: string
  username: string
  password: string
}

type ConnectionPayload = Partial<{
  name: string
  baseUrl: string
  authType: ComfyAuthType
  enabled: boolean
  credentials?: { token: string } | { username: string; password: string }
}>

export type ConnectionCredentialError = 'credentialsRequired' | 'basicCredentialsPair'
export type ConnectionRequestError =
  | 'requestUnauthorized'
  | 'connectionConflict'
  | 'connectionInvalid'
  | 'serverUnavailable'
  | 'requestFailed'
export type ConnectionActionError = ConnectionRequestError | 'deleteBlockedOwned'

type ConnectionRequestFailure = Error & { status?: number; code?: string }

export function resolveConnectionRequestError(error: unknown): ConnectionRequestError {
  if (!error || typeof error !== 'object') return 'requestFailed'
  const failure = error as { status?: unknown; code?: unknown }
  if (failure.status === 401 || failure.code === 'UNAUTHORIZED') return 'requestUnauthorized'
  if (failure.status === 409 || failure.code === 'CONFLICT') return 'connectionConflict'
  if (failure.status === 400 || failure.code === 'INVALID_PARAMS') return 'connectionInvalid'
  if (typeof failure.status === 'number' && failure.status >= 500) return 'serverUnavailable'
  return 'requestFailed'
}

export function initialConnectionValues(connection?: ComfyConnectionView | null): ConnectionFormValues {
  return {
    name: connection?.name ?? '', baseUrl: connection?.baseUrl ?? '',
    authType: connection?.authType ?? 'none', token: '', username: '', password: '',
  }
}

export function connectionEditorKey(connection?: ComfyConnectionView | null) {
  return `mode:${connection?.id ?? 'new'}`
}

export function validateConnectionCredentials(
  values: ConnectionFormValues,
  original?: ComfyConnectionView | null,
): ConnectionCredentialError | null {
  if (values.authType === 'none') return null
  const authChanged = values.authType !== original?.authType
  if (values.authType === 'bearer') {
    if (values.token.trim()) return null
    return original && !authChanged ? null : 'credentialsRequired'
  }
  const hasUsername = values.username.trim().length > 0
  const hasPassword = values.password.length > 0
  if (hasUsername !== hasPassword) return 'basicCredentialsPair'
  if (hasUsername && hasPassword) return null
  return original && !authChanged ? null : 'credentialsRequired'
}

export function buildConnectionPayload(
  values: ConnectionFormValues,
  original?: ComfyConnectionView | null,
): ConnectionPayload {
  const validationError = validateConnectionCredentials(values, original)
  if (validationError) throw new Error(validationError)
  const name = values.name.trim()
  const baseUrl = values.baseUrl.trim()
  const payload: ConnectionPayload = original ? {} : {
    name, baseUrl, authType: values.authType, enabled: true,
  }
  if (original) {
    if (name !== original.name) payload.name = name
    if (baseUrl !== original.baseUrl) payload.baseUrl = baseUrl
    if (values.authType !== original.authType) payload.authType = values.authType
  }
  if (values.authType === 'bearer' && values.token.trim()) {
    payload.credentials = { token: values.token.trim() }
  }
  if (values.authType === 'basic' && values.username.trim() && values.password) {
    payload.credentials = { username: values.username.trim(), password: values.password }
  }
  return payload
}

export function buildConnectionUpdate(
  connection: ComfyConnectionView,
  values: ConnectionFormValues,
) {
  return { id: connection.id, payload: buildConnectionPayload(values, connection) }
}

export function statusPollingInterval(visibility: DocumentVisibilityState | undefined) {
  return visibility === 'visible' ? 5_000 : false
}

export async function safelyRunConnectionAction(
  action: () => Promise<unknown>,
  setError: (error: ConnectionActionError | null) => void,
  options?: { conflictError?: ConnectionActionError },
): Promise<void> {
  setError(null)
  try {
    await action()
  } catch (error) {
    const resolved = resolveConnectionRequestError(error)
    setError(resolved === 'connectionConflict' && options?.conflictError
      ? options.conflictError
      : resolved)
  }
}

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(url, init)
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as {
      code?: unknown
      error?: { code?: unknown }
    }
    const error = new Error(`ComfyUI request failed (${response.status})`) as ConnectionRequestFailure
    error.status = response.status
    const code = typeof payload.error?.code === 'string'
      ? payload.error.code
      : typeof payload.code === 'string' ? payload.code : undefined
    if (code) error.code = code
    throw error
  }
  return response.json() as Promise<T>
}

export function useComfyConnections() {
  return useQuery({
    queryKey: ['comfyui', 'connections'],
    queryFn: () => readJson<{ connections: ComfyConnectionView[] }>('/api/comfyui/connections'),
  })
}

export function useComfyStatuses(enabled = true) {
  return useQuery({
    queryKey: ['comfyui', 'connection-statuses'],
    queryFn: () => readJson<{ statuses: ComfyStatusView[] }>('/api/comfyui/connections/status'),
    enabled,
    refetchInterval: () => statusPollingInterval(
      typeof document === 'undefined' ? undefined : document.visibilityState,
    ),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  })
}

export function useComfyConnectionActions() {
  const queryClient = useQueryClient()
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['comfyui', 'connections'] }),
      queryClient.invalidateQueries({ queryKey: ['comfyui', 'connection-statuses'] }),
    ])
  }
  const create = useMutation({
    mutationFn: (payload: ConnectionPayload) => readJson('/api/comfyui/connections', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    }),
    onSuccess: refresh,
  })
  const update = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Partial<ConnectionPayload> }) =>
      readJson(`/api/comfyui/connections/${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      }),
    onSuccess: refresh,
  })
  const remove = useMutation({
    mutationFn: (id: string) => readJson(`/api/comfyui/connections/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
    onSuccess: refresh,
  })
  const probe = useMutation({
    mutationFn: (id: string) => readJson(`/api/comfyui/connections/${encodeURIComponent(id)}/probe`, {
      method: 'POST',
    }),
    onSuccess: refresh,
  })
  return { create, update, remove, probe }
}
