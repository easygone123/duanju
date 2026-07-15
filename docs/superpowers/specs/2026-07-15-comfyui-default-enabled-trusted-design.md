# ComfyUI Default Enabled and Trusted Design

## Goal

Make a fresh self-hosted installation able to add and use ComfyUI instances without requiring per-host allowlist configuration.

## Default behavior

- When `COMFYUI_ENABLED` is absent, ComfyUI is enabled.
- When `COMFYUI_NETWORK_MODE` is absent, the network mode is `trusted`.
- An explicit `COMFYUI_ENABLED=false` still disables the runtime.
- An explicit `COMFYUI_NETWORK_MODE=allowlist` still requires at least one allowed host or CIDR and fails closed when the allowlist is empty.
- Explicit environment values always override defaults.

## Security boundary

Trusted mode is not an unrestricted transport mode. The existing network policy must continue to:

- reject cloud metadata and credential endpoints;
- reject unsupported URL schemes and credentials embedded in URLs;
- validate every DNS answer;
- reject unsafe or cross-origin redirects;
- apply the same policy to connection probes, workflow tests, generation, cancellation, and recovery.

## Implementation shape

Use one shared environment-to-network-policy reader so runtime startup and on-demand ComfyUI operations cannot drift. Update Docker Compose, `.env.example`, and the Chinese and English deployment documentation to show the new defaults and the explicit hardened `allowlist` override.

## Compatibility

Existing deployments that already set either variable keep their current behavior. Operators of public or multi-user deployments can opt back into strict destination control with:

```env
COMFYUI_NETWORK_MODE=allowlist
COMFYUI_ALLOWED_HOSTS=comfy.example.com
COMFYUI_ALLOWED_CIDRS=192.168.1.0/24
```

## Verification

Automated coverage must prove:

1. Missing variables resolve to enabled plus trusted mode.
2. Explicit disable and explicit allowlist overrides still work.
3. Empty explicit allowlists fail closed.
4. Trusted mode still rejects protected metadata targets.
5. Connection probes and workflow execution use the same resolved policy.
6. Docker Compose defaults and both language documents match runtime behavior.
