'use client'

import { useTranslations } from 'next-intl'

import type { ComfyConnectionView, ComfyStatusView } from './hooks'

interface Props {
  connection: ComfyConnectionView
  status?: ComfyStatusView
  busy?: boolean
  onEdit(): void
  onProbe(): Promise<void>
  onToggle(): Promise<void>
  onDelete(): Promise<void>
}

function formatBytes(value: number | undefined) {
  if (value === undefined) return '—'
  return `${(value / 1024 ** 3).toFixed(1)} GB`
}

export default function ConnectionCard({ connection, status, busy, onEdit, onProbe, onToggle, onDelete }: Props) {
  const t = useTranslations('comfyui')
  const state = status?.state ?? (connection.lastHealthCode || 'offline')
  const devices = status?.devices?.length ? status.devices : connection.deviceSummary
  const owned = state === 'online_busy_owned'
  const checkedAt = status?.checkedAt ?? connection.lastHealthAt

  return (
    <article className="glass-surface-soft rounded-2xl border border-[var(--glass-stroke-base)] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0"><h3 className="font-semibold text-[var(--glass-text-primary)]">{connection.name}</h3>
          <p className="mt-1 break-all text-xs text-[var(--glass-text-tertiary)]">{connection.baseUrl}</p></div>
        <span className="glass-badge rounded-full px-3 py-1 text-xs font-medium">{t(`states.${state}`)}</span>
      </div>
      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <div><dt className="text-[var(--glass-text-tertiary)]">{t('lastCheck')}</dt>
          <dd className="text-[var(--glass-text-secondary)]">{checkedAt ? new Date(checkedAt).toLocaleString() : t('never')}</dd></div>
        <div><dt className="text-[var(--glass-text-tertiary)]">{t('queue')}</dt>
          <dd className="text-[var(--glass-text-secondary)]">{status?.runningCount ?? 0} {t('running')} · {status?.pendingCount ?? 0} {t('pending')}</dd></div>
        {devices?.map((device, index) => <div key={`${device.name ?? 'device'}-${index}`}>
          <dt className="text-[var(--glass-text-tertiary)]">{t('device')}</dt>
          <dd className="text-[var(--glass-text-secondary)]">{device.name ?? device.type ?? '—'}</dd>
          <dd className="text-xs text-[var(--glass-text-tertiary)]">{t('vram')}: {formatBytes(device.vramFreeBytes)} / {formatBytes(device.vramTotalBytes)}</dd>
        </div>)}
        {owned && <div><dt className="text-[var(--glass-text-tertiary)]">{t('ownedTask')}</dt>
          <dd className="text-[var(--glass-text-secondary)]">{status?.ownedTask?.taskId ?? t('ownedTaskActive')}</dd></div>}
      </dl>
      {status?.message && <p className="mt-3 text-xs text-[var(--glass-text-tertiary)]">{status.message}</p>}
      <div className="mt-5 flex flex-wrap gap-2">
        <button type="button" onClick={onEdit} disabled={busy} aria-label={t('edit')} className="glass-btn-base px-3 py-2 text-sm">{t('edit')}</button>
        <button type="button" onClick={() => void onProbe()} disabled={busy} aria-label={t('test')} className="glass-btn-base px-3 py-2 text-sm">{t('test')}</button>
        <button type="button" onClick={() => void onToggle()} disabled={busy} aria-label={connection.enabled ? t('disable') : t('enable')}
          className="glass-btn-base px-3 py-2 text-sm">{connection.enabled ? t('disable') : t('enable')}</button>
        <button type="button" onClick={() => void onDelete()} disabled={busy || owned} aria-label={t('delete')}
          title={owned ? t('deleteBlockedOwned') : undefined} className="glass-btn-base glass-btn-tone-danger px-3 py-2 text-sm">{t('delete')}</button>
      </div>
    </article>
  )
}
