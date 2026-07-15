import { ApiError } from '@/lib/api-errors'

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    throw new ApiError('INVALID_PARAMS', { code: 'INVALID_JSON_BODY', field: 'body' })
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError('INVALID_PARAMS', { code: 'INVALID_JSON_BODY', field: 'body' })
  }
  return body as Record<string, unknown>
}
