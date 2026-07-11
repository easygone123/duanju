'use client'

import { useState, type FormEvent } from 'react'
import { useTranslations } from 'next-intl'

import type { ComfyConnectionView, ConnectionFormValues } from './hooks'

interface Props {
  connection?: ComfyConnectionView | null
  onSubmit(values: ConnectionFormValues): Promise<void>
  onCancel(): void
}

export default function ConnectionEditor({ connection, onSubmit, onCancel }: Props) {
  const t = useTranslations('comfyui')
  const [values, setValues] = useState<ConnectionFormValues>({
    name: connection?.name ?? '', baseUrl: connection?.baseUrl ?? '',
    authType: connection?.authType ?? 'none', token: '', username: '', password: '',
    enabled: connection?.enabled ?? true,
  })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const set = <K extends keyof ConnectionFormValues>(key: K, value: ConnectionFormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }))
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    try { await onSubmit(values) } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('requestFailed'))
    } finally { setSubmitting(false) }
  }

  return (
    <form onSubmit={submit} className="glass-surface-soft space-y-4 rounded-2xl border border-[var(--glass-stroke-base)] p-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1 text-sm text-[var(--glass-text-secondary)]">
          <span>{t('name')}</span>
          <input required maxLength={160} aria-label={t('name')} value={values.name}
            onChange={(event) => set('name', event.target.value)} className="glass-input w-full px-3 py-2" />
        </label>
        <label className="space-y-1 text-sm text-[var(--glass-text-secondary)]">
          <span>{t('baseUrl')}</span>
          <input required inputMode="url" maxLength={2048} aria-label={t('baseUrl')} value={values.baseUrl}
            placeholder="http://192.168.1.20:8188" onChange={(event) => set('baseUrl', event.target.value)}
            className="glass-input w-full px-3 py-2" />
        </label>
      </div>
      <label className="block space-y-1 text-sm text-[var(--glass-text-secondary)]">
        <span>{t('authType')}</span>
        <select aria-label={t('authType')} value={values.authType}
          onChange={(event) => set('authType', event.target.value as ConnectionFormValues['authType'])}
          className="glass-input w-full px-3 py-2">
          <option value="none">{t('authNone')}</option><option value="bearer">{t('authBearer')}</option>
          <option value="basic">{t('authBasic')}</option>
        </select>
      </label>
      {values.authType === 'bearer' && <label className="block space-y-1 text-sm text-[var(--glass-text-secondary)]">
        <span>{t('token')}</span>
        <input type="password" required={!connection} autoComplete="new-password" aria-label={t('token')}
          value={values.token} onChange={(event) => set('token', event.target.value)} className="glass-input w-full px-3 py-2" />
      </label>}
      {values.authType === 'basic' && <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1 text-sm text-[var(--glass-text-secondary)]"><span>{t('username')}</span>
          <input required={!connection} autoComplete="off" aria-label={t('username')} value={values.username}
            onChange={(event) => set('username', event.target.value)} className="glass-input w-full px-3 py-2" /></label>
        <label className="space-y-1 text-sm text-[var(--glass-text-secondary)]"><span>{t('password')}</span>
          <input type="password" required={!connection} autoComplete="new-password" aria-label={t('password')}
            value={values.password} onChange={(event) => set('password', event.target.value)} className="glass-input w-full px-3 py-2" /></label>
      </div>}
      {connection && values.authType !== 'none' && <p className="text-xs text-[var(--glass-text-tertiary)]">{t('preservedCredential')}</p>}
      {error && <p role="alert" className="text-sm text-[var(--glass-danger)]">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onCancel} className="glass-btn-base px-4 py-2">{t('cancel')}</button>
        <button type="submit" disabled={submitting} aria-busy={submitting}
          className="glass-btn-base glass-btn-tone-info px-4 py-2">{submitting ? t('saving') : t('save')}</button>
      </div>
    </form>
  )
}
