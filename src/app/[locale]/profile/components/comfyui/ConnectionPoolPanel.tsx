'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'

import ConnectionCard from './ConnectionCard'
import ConnectionEditor from './ConnectionEditor'
import {
  buildConnectionPayload,
  useComfyConnectionActions,
  useComfyConnections,
  useComfyStatuses,
  type ComfyConnectionView,
  type ConnectionFormValues,
} from './hooks'

export default function ConnectionPoolPanel() {
  const t = useTranslations('comfyui')
  const connectionsQuery = useComfyConnections()
  const statusesQuery = useComfyStatuses(!connectionsQuery.isLoading)
  const actions = useComfyConnectionActions()
  const [editing, setEditing] = useState<ComfyConnectionView | 'new' | null>(null)
  const connections = connectionsQuery.data?.connections ?? []
  const statuses = new Map((statusesQuery.data?.statuses ?? []).map((status) => [status.connectionId, status]))
  const mutating = actions.create.isPending || actions.update.isPending
    || actions.remove.isPending || actions.probe.isPending

  const submit = async (values: ConnectionFormValues) => {
    if (editing === 'new') await actions.create.mutateAsync(buildConnectionPayload(values, false))
    else if (editing) await actions.update.mutateAsync({ id: editing.id, payload: buildConnectionPayload(values, true) })
    setEditing(null)
  }
  const remove = async (connection: ComfyConnectionView) => {
    if (!window.confirm(t('deleteConfirm', { name: connection.name }))) return
    await actions.remove.mutateAsync(connection.id)
  }

  return (
    <section aria-labelledby="comfyui-pool-heading" className="flex h-full flex-col overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--glass-stroke-base)] px-5 py-4 sm:px-6">
        <div><h2 id="comfyui-pool-heading" className="text-lg font-semibold text-[var(--glass-text-primary)]">{t('title')}</h2>
          <p className="mt-1 text-sm text-[var(--glass-text-secondary)]">{t('description')}</p></div>
        <button type="button" onClick={() => setEditing('new')} className="glass-btn-base glass-btn-tone-info px-4 py-2 text-sm">{t('addConnection')}</button>
      </header>
      <div className="flex-1 space-y-4 overflow-y-auto p-5 sm:p-6">
        {editing && <ConnectionEditor connection={editing === 'new' ? null : editing} onSubmit={submit} onCancel={() => setEditing(null)} />}
        {connectionsQuery.isLoading && <p role="status" className="text-sm text-[var(--glass-text-secondary)]">{t('loading')}</p>}
        {connectionsQuery.isError && <div role="alert" className="glass-surface-soft rounded-xl p-4 text-sm text-[var(--glass-danger)]">
          <p>{t('loadFailed')}</p><button type="button" onClick={() => void connectionsQuery.refetch()} className="mt-2 underline">{t('retry')}</button>
        </div>}
        {!connectionsQuery.isLoading && !connectionsQuery.isError && connections.length === 0 && !editing &&
          <div className="glass-surface-soft rounded-2xl border border-dashed border-[var(--glass-stroke-base)] p-10 text-center">
            <p className="text-[var(--glass-text-secondary)]">{t('empty')}</p>
          </div>}
        <div className="grid gap-4 xl:grid-cols-2">
          {connections.map((connection) => <ConnectionCard key={connection.id} connection={connection} status={statuses.get(connection.id)} busy={mutating}
            onEdit={() => setEditing(connection)} onProbe={async () => { await actions.probe.mutateAsync(connection.id) }}
            onToggle={async () => { await actions.update.mutateAsync({ id: connection.id, payload: { enabled: !connection.enabled } }) }}
            onDelete={() => remove(connection)} />)}
        </div>
        {statusesQuery.isError && <p role="alert" className="text-sm text-[var(--glass-danger)]">{t('statusFailed')}</p>}
      </div>
    </section>
  )
}
