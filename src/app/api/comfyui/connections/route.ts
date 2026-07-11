import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'

import { isErrorResponse, requireUserAuth } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'
import {
  createOwnedConnection,
  listOwnedConnections,
  probeOwnedConnection,
} from '@/lib/comfyui/connection-service'

const credentialsSchema = z.union([
  z.object({ token: z.string().trim().min(1).max(8192) }).strict(),
  z.object({
    username: z.string().trim().min(1).max(512),
    password: z.string().min(1).max(8192),
  }).strict(),
])

const createSchema = z.object({
  name: z.string().trim().min(1).max(160),
  baseUrl: z.string().trim().min(1).max(2048),
  authType: z.enum(['none', 'bearer', 'basic']),
  credentials: credentialsSchema.optional(),
  enabled: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  if (value.authType === 'none' && value.credentials !== undefined) {
    context.addIssue({ code: 'custom', message: 'Credentials are not allowed for auth type none' })
  }
  if (value.authType === 'bearer' && (!value.credentials || !('token' in value.credentials))) {
    context.addIssue({ code: 'custom', message: 'Bearer credentials are required' })
  }
  if (value.authType === 'basic' && (!value.credentials || !('username' in value.credentials))) {
    context.addIssue({ code: 'custom', message: 'Basic credentials are required' })
  }
})

export const GET = apiHandler(async () => {
  const authResult = await requireUserAuth()
  if (isErrorResponse(authResult)) return authResult
  const connections = await listOwnedConnections(authResult.session.user.id)
  return NextResponse.json({ connections })
})

export const POST = apiHandler(async (request: NextRequest) => {
  const authResult = await requireUserAuth()
  if (isErrorResponse(authResult)) return authResult
  const parsed = createSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) throw new ApiError('INVALID_PARAMS')
  const connection = await createOwnedConnection(authResult.session.user.id, parsed.data)
  const health = await probeOwnedConnection(authResult.session.user.id, connection.id)
  return NextResponse.json({ connection, health }, { status: 201 })
})
