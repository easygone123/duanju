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
  enabled: boolean
}

type ConnectionPayload = {
  name: string
  baseUrl: string
  authType: ComfyAuthType
  enabled: boolean
  credentials?: { token: string } | { username: string; password: string }
}

export function buildConnectionPayload(values: ConnectionFormValues, editing: boolean): ConnectionPayload {
  const payload: ConnectionPayload = {
    name: values.name.trim(),
    baseUrl: values.baseUrl.trim(),
    authType: values.authType,
    enabled: values.enabled,
  }
  if (values.authType === 'bearer' && values.token.trim()) {
    payload.credentials = { token: values.token.trim() }
  }
  if (values.authType === 'basic' && values.username.trim() && values.password) {
    payload.credentials = { username: values.username.trim(), password: values.password }
  }
  if (!editing && values.authType !== 'none' && !payload.credentials) {
    throw new Error('Credentials are required')
  }
  return payload
}

export function statusPollingInterval(visibility: DocumentVisibilityState | undefined) {
  return visibility === 'visible' ? 5_000 : false
}

export async function safelyRunConnectionAction(
  action: () => Promise<unknown>,
  setError: (error: 'requestFailed' | null) => void,
): Promise<void> {
  setError(null)
  try {
    await action()
  } catch {
    setError('requestFailed')
  }
}

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(url, init)
  if (!response.ok) throw new Error(`ComfyUI request failed (${response.status})`)
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
