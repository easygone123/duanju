import { randomUUID } from 'node:crypto'
import { prisma } from '@/lib/prisma'

export const CROP_CLAIM_LEASE_MS = 120_000

export type CropClaimOwner = {
  claimKey: string
  ownerToken: string
  leaseMs: number
}

export type CropClaimHeartbeat = {
  assertOwned(): void
  fence(): Promise<void>
  stop(): Promise<void>
}

export function cropClaimKey(sourceMediaId: string): string {
  return `six-grid-crop:${sourceMediaId}:v1`
}

export async function acquireCropClaim(input: {
  sourceMediaId: string
  leaseMs?: number
}): Promise<CropClaimOwner> {
  const leaseMs = normalizeLeaseMs(input.leaseMs)
  const owner: CropClaimOwner = {
    claimKey: cropClaimKey(input.sourceMediaId),
    ownerToken: randomUUID(),
    leaseMs,
  }
  const now = await databaseNow()
  try {
    await prisma.sixGridCropClaim.create({
      data: {
        claimKey: owner.claimKey,
        ownerToken: owner.ownerToken,
        leaseUntil: new Date(now.getTime() + leaseMs),
      },
    })
    return owner
  } catch (error) {
    if ((error as { code?: string }).code !== 'P2002') throw error
  }

  const takeoverNow = await databaseNow()
  const takeover = await prisma.sixGridCropClaim.updateMany({
    where: { claimKey: owner.claimKey, leaseUntil: { lte: takeoverNow } },
    data: {
      ownerToken: owner.ownerToken,
      leaseUntil: new Date(takeoverNow.getTime() + leaseMs),
    },
  })
  if (takeover.count !== 1) throw new Error('SIX_GRID_CROP_BUSY')
  return owner
}

export async function heartbeatCropClaim(owner: CropClaimOwner): Promise<boolean> {
  const now = await databaseNow()
  const result = await prisma.sixGridCropClaim.updateMany({
    where: {
      claimKey: owner.claimKey,
      ownerToken: owner.ownerToken,
      leaseUntil: { gt: now },
    },
    data: { leaseUntil: new Date(now.getTime() + owner.leaseMs) },
  })
  return result.count === 1
}

export async function releaseCropClaim(owner: CropClaimOwner): Promise<boolean> {
  const result = await prisma.sixGridCropClaim.deleteMany({
    where: { claimKey: owner.claimKey, ownerToken: owner.ownerToken },
  })
  return result.count === 1
}

export function startCropClaimHeartbeat(owner: CropClaimOwner): CropClaimHeartbeat {
  let lost = false
  let stopped = false
  let inFlight: Promise<void> | null = null

  const pulse = async () => {
    if (stopped || lost) return
    if (!inFlight) {
      inFlight = (async () => {
        try {
          if (!await heartbeatCropClaim(owner)) lost = true
        } catch {
          lost = true
        } finally {
          inFlight = null
        }
      })()
    }
    await inFlight
  }
  const intervalMs = Math.max(50, Math.floor(owner.leaseMs / 3))
  const timer = setInterval(() => { void pulse() }, intervalMs)
  timer.unref?.()

  return {
    assertOwned() {
      if (lost) throw new Error('SIX_GRID_CROP_CLAIM_LOST')
    },
    async fence() {
      this.assertOwned()
      await pulse()
      this.assertOwned()
    },
    async stop() {
      stopped = true
      clearInterval(timer)
      if (inFlight) await inFlight
    },
  }
}

async function databaseNow(): Promise<Date> {
  const sqlite = process.env.DATABASE_URL?.startsWith('file:')
  const rows = await prisma.$queryRawUnsafe<Array<{ now: Date | string }>>(
    sqlite ? 'SELECT CURRENT_TIMESTAMP AS now' : 'SELECT UTC_TIMESTAMP(3) AS now',
  )
  const value = rows[0]?.now
  const parsed = value instanceof Date ? value : new Date(`${value}Z`)
  if (!value || !Number.isFinite(parsed.getTime())) throw new Error('SIX_GRID_CROP_DB_TIME_INVALID')
  return parsed
}

function normalizeLeaseMs(value: number | undefined): number {
  if (value == null) return CROP_CLAIM_LEASE_MS
  if (!Number.isSafeInteger(value) || value < 300 || value > 10 * 60_000) {
    throw new Error('SIX_GRID_CROP_LEASE_INVALID')
  }
  return value
}
