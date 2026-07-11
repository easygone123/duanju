import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

import { COMFY_ERROR_CODE, ComfyError } from './errors'

export interface ComfyNetworkPolicyConfig {
  mode: 'allowlist' | 'trusted'
  allowedHosts: string[]
  allowedCidrs: string[]
}

export interface AuthorizedComfyTarget {
  url: URL
  address: string
  family: 4 | 6
}

export interface ComfyResolvedAddress {
  address: string
  family: 4 | 6
}

export type ComfyResolver = (hostname: string) => Promise<ComfyResolvedAddress[]>

// Exact well-known cloud credential endpoints. Trusted mode still blocks these addresses.
const CLOUD_CREDENTIAL_ENDPOINTS = [
  '169.254.169.254', // AWS EC2 IMDS, GCP metadata, Azure IMDS
  '169.254.170.2', // AWS ECS task credentials
  '169.254.170.23', // AWS EKS Pod Identity
  '100.100.100.200', // Alibaba Cloud metadata
  '192.0.0.192', // Oracle Cloud metadata
  'fd00:ec2::254', // AWS EC2 IMDS IPv6
  'fd00:ec2::23', // AWS EKS Pod Identity IPv6
] as const

export const resolveComfyHost: ComfyResolver = async (hostname) => {
  const answers = await lookup(hostname, { all: true, verbatim: true })
  return answers.map(({ address, family }) => ({ address, family: family as 4 | 6 }))
}

export async function authorizeComfyTarget(
  rawUrl: string | URL,
  config: ComfyNetworkPolicyConfig,
  resolveHost: ComfyResolver = resolveComfyHost,
): Promise<AuthorizedComfyTarget> {
  const url = parseTargetUrl(rawUrl)
  const hostname = normalizeHostname(url.hostname)
  const answers = await resolveAnswers(hostname, resolveHost)
  const allowedCidrs = config.allowedCidrs.map(parseCidr)
  const hostAllowed = config.allowedHosts.some((entry) => hostMatches(hostname, entry))

  for (const answer of answers) {
    const address = parseAddress(answer.address)
    if (address.family !== answer.family || isAlwaysBlocked(address)) {
      throw blockedTarget()
    }

    if (config.mode === 'allowlist') {
      const cidrAllowed = allowedCidrs.some((cidr) => addressInCidr(address, cidr))
      if ((!hostAllowed && !cidrAllowed) || (isSensitive(address) && !cidrAllowed)) {
        throw blockedTarget()
      }
    }
  }

  const selected = answers[0]
  return { url, address: selected.address, family: selected.family }
}

function parseTargetUrl(rawUrl: string | URL): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw blockedTarget()
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw blockedTarget()
  }
  return url
}

async function resolveAnswers(hostname: string, resolver: ComfyResolver) {
  let answers: ComfyResolvedAddress[]
  try {
    answers = await resolver(hostname)
  } catch (cause) {
    throw new ComfyError(COMFY_ERROR_CODE.NETWORK_TARGET_BLOCKED, 'Target resolution failed', {
      cause,
    })
  }
  if (answers.length === 0) throw blockedTarget()
  return answers
}

function normalizeHostname(hostname: string): string {
  const normalized = hostname.toLowerCase().replace(/\.$/, '')
  return normalized.startsWith('[') && normalized.endsWith(']')
    ? normalized.slice(1, -1)
    : normalized
}

function hostMatches(hostname: string, allowedEntry: string): boolean {
  const allowed = normalizeHostname(allowedEntry.trim())
  if (allowed.startsWith('*.')) {
    const suffix = allowed.slice(1)
    return hostname.endsWith(suffix) && hostname.length > suffix.length
  }
  return hostname === allowed
}

interface ParsedAddress {
  family: 4 | 6
  value: bigint
  bits: 32 | 128
  mappedIpv4?: ParsedAddress
}

interface ParsedCidr extends ParsedAddress {
  prefix: number
}

function parseAddress(rawAddress: string): ParsedAddress {
  const address = rawAddress.split('%')[0].toLowerCase()
  const family = isIP(address)
  if (family === 4) {
    return { family: 4, value: parseIpv4(address), bits: 32 }
  }
  if (family === 6) {
    const value = parseIpv6(address)
    const mappedPrefix = BigInt('0xffff')
    const isMapped = value >> BigInt(32) === mappedPrefix
    return {
      family: 6,
      value,
      bits: 128,
      mappedIpv4: isMapped
        ? { family: 4, value: value & BigInt('0xffffffff'), bits: 32 }
        : undefined,
    }
  }
  throw blockedTarget()
}

function parseIpv4(address: string): bigint {
  return address
    .split('.')
    .map(Number)
    .reduce((value, octet) => (value << BigInt(8)) | BigInt(octet), BigInt(0))
}

function parseIpv6(address: string): bigint {
  const [headRaw, tailRaw] = address.split('::')
  const head = parseIpv6Parts(headRaw)
  const tail = parseIpv6Parts(tailRaw)
  const missing = 8 - head.length - tail.length
  if (missing < 0 || (!address.includes('::') && missing !== 0)) throw blockedTarget()
  const parts = [...head, ...Array<number>(missing).fill(0), ...tail]
  return parts.reduce((value, part) => (value << BigInt(16)) | BigInt(part), BigInt(0))
}

function parseIpv6Parts(input: string | undefined): number[] {
  if (!input) return []
  const parts = input.split(':')
  const last = parts.at(-1)
  if (last && isIP(last) === 4) {
    parts.pop()
    const ipv4 = parseIpv4(last)
    parts.push(
      ((ipv4 >> BigInt(16)) & BigInt('0xffff')).toString(16),
      (ipv4 & BigInt('0xffff')).toString(16),
    )
  }
  return parts.map((part) => Number.parseInt(part, 16))
}

function parseCidr(rawCidr: string): ParsedCidr {
  const [rawAddress, rawPrefix] = rawCidr.split('/')
  const address = parseAddress(rawAddress)
  const prefix = Number(rawPrefix)
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > address.bits) throw blockedTarget()
  return { ...address, prefix }
}

function addressInCidr(address: ParsedAddress, cidr: ParsedCidr): boolean {
  if (address.family !== cidr.family) return false
  const shift = BigInt(address.bits - cidr.prefix)
  return address.value >> shift === cidr.value >> shift
}

function isAlwaysBlocked(address: ParsedAddress): boolean {
  if (address.mappedIpv4) return true
  return (
    inCidr(address, '0.0.0.0/8') ||
    inCidr(address, '224.0.0.0/4') ||
    inCidr(address, '::/128') ||
    inCidr(address, 'ff00::/8') ||
    CLOUD_CREDENTIAL_ENDPOINTS.some(
      (metadataAddress) => sameAddress(address, parseAddress(metadataAddress)),
    )
  )
}

function sameAddress(left: ParsedAddress, right: ParsedAddress): boolean {
  return left.family === right.family && left.value === right.value
}

function isSensitive(address: ParsedAddress): boolean {
  return [
    '10.0.0.0/8',
    '100.64.0.0/10',
    '127.0.0.0/8',
    '169.254.0.0/16',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '::1/128',
    'fc00::/7',
    'fe80::/10',
  ].some((cidr) => inCidr(address, cidr))
}

function inCidr(address: ParsedAddress, cidr: string): boolean {
  return addressInCidr(address, parseCidr(cidr))
}

function blockedTarget(): ComfyError {
  return new ComfyError(COMFY_ERROR_CODE.NETWORK_TARGET_BLOCKED, 'Network target is not permitted')
}
