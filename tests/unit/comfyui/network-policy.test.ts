import { describe, expect, it, vi } from 'vitest'

import {
  authorizeComfyTarget,
  readComfyNetworkPolicy,
  type ComfyNetworkPolicyConfig,
  type ComfyResolver,
} from '@/lib/comfyui/network-policy'

const allowlist: ComfyNetworkPolicyConfig = {
  mode: 'allowlist',
  allowedHosts: ['comfy.example.com'],
  allowedCidrs: [],
}

function resolver(...addresses: string[]): ComfyResolver {
  return vi.fn(async () =>
    addresses.map((address) => ({
      address,
      family: (address.includes(':') ? 6 : 4) as 4 | 6,
    })),
  )
}

describe('readComfyNetworkPolicy', () => {
  it('uses trusted mode without requiring per-instance allowlist entries', () => {
    expect(readComfyNetworkPolicy({})).toEqual({
      mode: 'trusted',
      allowedHosts: [],
      allowedCidrs: [],
    })
  })

  it('retains an explicitly configured allowlist', () => {
    expect(readComfyNetworkPolicy({
      COMFYUI_NETWORK_MODE: 'allowlist',
      COMFYUI_ALLOWED_HOSTS: 'gpu.local, *.example.com',
      COMFYUI_ALLOWED_CIDRS: '192.168.1.0/24',
    })).toEqual({
      mode: 'allowlist',
      allowedHosts: ['gpu.local', '*.example.com'],
      allowedCidrs: ['192.168.1.0/24'],
    })
  })

  it('rejects invalid and empty explicit allowlists', () => {
    expect(() => readComfyNetworkPolicy({ COMFYUI_NETWORK_MODE: 'open' }))
      .toThrow('Invalid COMFYUI_NETWORK_MODE')
    expect(() => readComfyNetworkPolicy({ COMFYUI_NETWORK_MODE: 'allowlist' }))
      .toThrow('Invalid COMFYUI_ALLOWED_HOSTS/COMFYUI_ALLOWED_CIDRS')
  })
})

describe('authorizeComfyTarget', () => {
  it('accepts an allowlisted HTTP host and returns a pinned DNS answer', async () => {
    const target = await authorizeComfyTarget(
      'https://comfy.example.com/proxy/comfy',
      allowlist,
      resolver('203.0.113.10'),
    )

    expect(target.url.href).toBe('https://comfy.example.com/proxy/comfy')
    expect(target.address).toBe('203.0.113.10')
    expect(target.family).toBe(4)
  })

  it.each([
    'ftp://comfy.example.com',
    'https://user:secret@comfy.example.com',
    'https://not-allowed.example.com',
  ])('rejects unsupported or unapproved targets: %s', async (url) => {
    await expect(authorizeComfyTarget(url, allowlist, resolver('203.0.113.10'))).rejects.toMatchObject({
      code: 'COMFY_NETWORK_TARGET_BLOCKED',
    })
  })

  it('validates every DNS answer instead of authorizing only the first', async () => {
    await expect(
      authorizeComfyTarget(
        'https://comfy.example.com',
        allowlist,
        resolver('203.0.113.10', '127.0.0.1'),
      ),
    ).rejects.toMatchObject({ code: 'COMFY_NETWORK_TARGET_BLOCKED' })
  })

  it.each(['10.0.0.8', '169.254.1.2', '224.0.0.1', '0.0.0.0', '::ffff:127.0.0.1']) (
    'blocks sensitive address %s in allowlist mode when its CIDR is not approved',
    async (address) => {
      await expect(
        authorizeComfyTarget('https://comfy.example.com', allowlist, resolver(address)),
      ).rejects.toMatchObject({ code: 'COMFY_NETWORK_TARGET_BLOCKED' })
    },
  )

  it('permits an explicitly allowlisted private CIDR', async () => {
    await expect(
      authorizeComfyTarget(
        'http://10.20.30.40:8188',
        { mode: 'allowlist', allowedHosts: [], allowedCidrs: ['10.20.0.0/16'] },
        resolver('10.20.30.40'),
      ),
    ).resolves.toMatchObject({ address: '10.20.30.40', family: 4 })
  })

  it('allows loopback and LAN addresses in explicitly trusted mode', async () => {
    const config: ComfyNetworkPolicyConfig = { mode: 'trusted', allowedHosts: [], allowedCidrs: [] }

    await expect(
      authorizeComfyTarget('http://localhost:8188', config, resolver('127.0.0.1')),
    ).resolves.toMatchObject({ address: '127.0.0.1' })
    await expect(
      authorizeComfyTarget('http://comfy.lan:8188', config, resolver('192.168.1.20')),
    ).resolves.toMatchObject({ address: '192.168.1.20' })
  })

  it.each([
    '169.254.169.254',
    '169.254.170.2',
    '169.254.170.23',
    '100.100.100.200',
    '192.0.0.192',
    'fd00:ec2::254',
    'fd00:ec2::23',
    '::ffff:169.254.169.254',
  ]) (
    'blocks cloud metadata and mapped metadata targets even in trusted mode: %s',
    async (address) => {
      await expect(
        authorizeComfyTarget(
          `http://${address.includes(':') ? `[${address}]` : address}`,
          { mode: 'trusted', allowedHosts: [], allowedCidrs: [] },
          resolver(address),
        ),
      ).rejects.toMatchObject({ code: 'COMFY_NETWORK_TARGET_BLOCKED' })
    },
  )

  it('blocks EKS Pod Identity in every DNS answer and despite an explicit CIDR allowlist', async () => {
    await expect(
      authorizeComfyTarget(
        'https://comfy.example.com',
        allowlist,
        resolver('203.0.113.10', '169.254.170.23'),
      ),
    ).rejects.toMatchObject({ code: 'COMFY_NETWORK_TARGET_BLOCKED' })

    await expect(
      authorizeComfyTarget(
        'http://[fd00:ec2::23]',
        { mode: 'allowlist', allowedHosts: [], allowedCidrs: ['fd00:ec2::/64'] },
        resolver('fd00:ec2::23'),
      ),
    ).rejects.toMatchObject({ code: 'COMFY_NETWORK_TARGET_BLOCKED' })
  })

  it('rejects empty DNS results', async () => {
    await expect(
      authorizeComfyTarget('https://comfy.example.com', allowlist, resolver()),
    ).rejects.toMatchObject({ code: 'COMFY_NETWORK_TARGET_BLOCKED' })
  })
})
