import { redis } from '@/lib/redis'

import { ApiError } from '@/lib/api-errors'

const RENEW_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0
`
const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`

export async function acquireComfyLease(
  connectionId: string,
  value: string,
  ttlMs: number,
) {
  const key = comfyLeaseKey(connectionId)
  const acquired = await redis.set(key, value, 'PX', ttlMs, 'NX')
  if (acquired !== 'OK') throw new ApiError('CONFLICT')
  return key
}

export async function renewComfyLease(key: string, value: string, ttlMs: number) {
  const result = await redis.eval(RENEW_SCRIPT, 1, key, value, ttlMs)
  if (result !== 1) throw new ApiError('CONFLICT')
}

export async function releaseComfyLease(key: string, value: string) {
  await redis.eval(RELEASE_SCRIPT, 1, key, value)
}

export function comfyLeaseKey(connectionId: string) {
  return `comfy:lease:${connectionId}`
}

export function startComfyLeaseGuard(options: {
  key: string
  value: string
  ttlMs: number
  timeoutMs: number
}) {
  const controller = new AbortController()
  let failure: unknown
  let renewal: Promise<void> | null = null
  const lose = (error: unknown) => {
    failure = error
    controller.abort()
  }
  const heartbeat = () => {
    if (renewal || failure) return
    renewal = renewComfyLease(options.key, options.value, options.ttlMs)
      .catch(lose)
      .finally(() => { renewal = null })
  }
  const heartbeatTimer = setInterval(heartbeat, Math.max(1000, Math.floor(options.ttlMs / 3)))
  const timeoutTimer = setTimeout(() => lose(new ApiError('GENERATION_TIMEOUT')), options.timeoutMs)
  return {
    signal: controller.signal,
    async assertOwned() {
      if (!failure) {
        try {
          await renewComfyLease(options.key, options.value, options.ttlMs)
        } catch (error) {
          lose(error)
        }
      }
      if (failure) throw failure
    },
    async stop() {
      clearInterval(heartbeatTimer)
      clearTimeout(timeoutTimer)
      controller.abort()
      if (renewal) await renewal.catch(() => undefined)
    },
  }
}
