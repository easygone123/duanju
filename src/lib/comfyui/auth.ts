import type { ComfyConnectionAuth } from './types'

export function buildComfyAuthorization(auth: ComfyConnectionAuth): string | undefined {
  if (auth.type === 'none') return undefined
  if (auth.type === 'bearer') return `Bearer ${auth.token}`
  return `Basic ${Buffer.from(`${auth.username}:${auth.password}`, 'utf8').toString('base64')}`
}

export function comfyAuthSecrets(auth: ComfyConnectionAuth): string[] {
  if (auth.type === 'none') return []
  if (auth.type === 'bearer') return [auth.token, `Bearer ${auth.token}`]
  return [auth.username, auth.password, `${auth.username}:${auth.password}`, buildComfyAuthorization(auth)!]
}
