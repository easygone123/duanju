import { createHash, timingSafeEqual } from 'node:crypto'

import { prisma } from '@/lib/prisma'

type McpEnvironment = Record<string, string | undefined>

export interface DuanjuMcpPrincipal {
  userId: string
  userName: string
}

export class DuanjuMcpAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'DuanjuMcpAuthError'
  }
}

function isEnabled(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value || '').trim().toLowerCase())
}

function safeTokenEquals(expected: string, provided: string): boolean {
  const expectedDigest = createHash('sha256').update(expected).digest()
  const providedDigest = createHash('sha256').update(provided).digest()
  return timingSafeEqual(expectedDigest, providedDigest)
}

function parseBearerToken(request: Request): string {
  const authorization = request.headers.get('authorization') || ''
  const match = authorization.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || ''
}

function validateOrigin(request: Request, env: McpEnvironment) {
  const origin = request.headers.get('origin')
  if (!origin) return

  const allowedOrigins = (env.DUANJU_MCP_ALLOWED_ORIGINS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  if (!allowedOrigins.includes(origin)) {
    throw new DuanjuMcpAuthError('MCP browser origin is not allowed', 403)
  }
}

export async function authorizeDuanjuMcpRequest(
  request: Request,
  env: McpEnvironment = process.env,
): Promise<DuanjuMcpPrincipal> {
  if (!isEnabled(env.DUANJU_MCP_ENABLED)) {
    throw new DuanjuMcpAuthError('Duanju MCP is disabled', 404)
  }

  const expectedToken = (env.DUANJU_MCP_TOKEN || '').trim()
  if (expectedToken.length < 32) {
    throw new DuanjuMcpAuthError('Duanju MCP token is not configured securely', 503)
  }
  const providedToken = parseBearerToken(request)
  if (!providedToken || !safeTokenEquals(expectedToken, providedToken)) {
    throw new DuanjuMcpAuthError('Invalid MCP bearer token', 401)
  }
  validateOrigin(request, env)

  const configuredUserId = (env.DUANJU_MCP_USER_ID || '').trim()
  const configuredUserName = (env.DUANJU_MCP_USER || '').trim()
  if (!configuredUserId && !configuredUserName) {
    throw new DuanjuMcpAuthError('Duanju MCP user is not configured', 503)
  }

  const user = await prisma.user.findFirst({
    where: configuredUserId
      ? { id: configuredUserId }
      : { name: configuredUserName },
    select: { id: true, name: true },
  })
  if (!user) {
    throw new DuanjuMcpAuthError('Configured Duanju MCP user does not exist', 503)
  }

  return {
    userId: user.id,
    userName: user.name,
  }
}
