# ComfyUI Default Enabled and Trusted Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable ComfyUI and trusted network mode by default while retaining explicit overrides and protected-target blocking.

**Architecture:** Centralize environment-to-network-policy resolution and make runtime startup plus on-demand ComfyUI operations share it. Then align Docker, examples, documentation, and executable requirement contracts with the new defaults.

**Tech Stack:** TypeScript, Next.js, Vitest, Docker Compose

---

### Task 1: Runtime and on-demand policy defaults

**Files:**
- Modify: `src/lib/comfyui/network-policy.ts`
- Modify: `src/lib/comfyui/runtime.ts`
- Modify: `src/lib/comfyui/connection-service.ts`
- Modify: `src/lib/comfyui/workflow-test-service.ts`
- Modify: `src/app/api/comfyui/requests/[requestId]/cancel/route.ts`
- Test: `tests/unit/comfyui/runtime.test.ts`
- Test: `tests/unit/comfyui/network-policy.test.ts`
- Test: `tests/integration/api/specific/comfyui-connections-route.test.ts`

- [ ] **Step 1: Write failing default tests**

Add assertions equivalent to:

```ts
expect(readComfyRuntimeConfig({})).toMatchObject({
  enabled: true,
  networkPolicy: { mode: 'trusted', allowedHosts: [], allowedCidrs: [] },
})
expect(readComfyRuntimeConfig({ COMFYUI_ENABLED: 'false' }).enabled).toBe(false)
expect(() => readComfyRuntimeConfig({
  COMFYUI_NETWORK_MODE: 'allowlist',
})).toThrow('Invalid COMFYUI_ALLOWED_HOSTS/COMFYUI_ALLOWED_CIDRS')
```

Add a connection-route test proving absent network variables call `authorizeComfyTarget` with `mode: 'trusted'`. Keep all existing metadata-endpoint rejection tests.

- [ ] **Step 2: Run the tests and verify RED**

```bash
npx vitest run tests/unit/comfyui/runtime.test.ts tests/unit/comfyui/network-policy.test.ts tests/integration/api/specific/comfyui-connections-route.test.ts
```

Expected: failures show the old disabled/allowlist defaults.

- [ ] **Step 3: Implement one shared policy reader**

Export a process-environment resolver from `network-policy.ts` with the effective behavior:

```ts
export function readComfyNetworkPolicy(
  env: Record<string, string | undefined>,
): ComfyNetworkPolicyConfig {
  return {
    mode: env.COMFYUI_NETWORK_MODE === 'allowlist' ? 'allowlist' : 'trusted',
    allowedHosts: parseCommaList(env.COMFYUI_ALLOWED_HOSTS),
    allowedCidrs: parseCommaList(env.COMFYUI_ALLOWED_CIDRS),
  }
}
```

The actual implementation must retain the runtime parser's rejection of invalid mode names, hosts, CIDRs, and explicit empty allowlists. Change missing `COMFYUI_ENABLED` to `true` and missing mode to `trusted`.

- [ ] **Step 4: Replace divergent readers**

Make connection probing, workflow live tests, and request cancellation use the shared reader. Remove local `trusted ? trusted : allowlist` fallbacks only where replaced.

- [ ] **Step 5: Run the tests and verify GREEN**

Run the Step 2 command. Expected: all pass, including cloud metadata and redirect protections.

- [ ] **Step 6: Commit**

```bash
git add src/lib/comfyui/network-policy.ts src/lib/comfyui/runtime.ts src/lib/comfyui/connection-service.ts src/lib/comfyui/workflow-test-service.ts 'src/app/api/comfyui/requests/[requestId]/cancel/route.ts' tests/unit/comfyui/runtime.test.ts tests/unit/comfyui/network-policy.test.ts tests/integration/api/specific/comfyui-connections-route.test.ts
git commit -m "feat: enable trusted ComfyUI by default"
```

### Task 2: Deployment defaults and documentation

**Files:**
- Modify: `.env.example`
- Modify: `docker-compose.yml`
- Modify: `README.md`
- Modify: `README_en.md`
- Modify: `tests/contracts/docker-compose-comfyui.test.ts`
- Modify: `tests/contracts/requirements-matrix.ts`
- Modify: `tests/contracts/requirements-matrix.test.ts`

- [ ] **Step 1: Write failing deployment assertions**

Assert effective Compose defaults include:

```ts
expect(environment).toMatchObject({
  COMFYUI_ENABLED: 'true',
  COMFYUI_NETWORK_MODE: 'trusted',
})
```

Update the requirements assertion to retain protected-target blocking while describing `allowlist` as the explicit hardened override.

- [ ] **Step 2: Run contract tests and verify RED**

```bash
npx vitest run tests/contracts/docker-compose-comfyui.test.ts tests/contracts/requirements-matrix.test.ts
```

Expected: old default assertions fail.

- [ ] **Step 3: Update deployment files and both README languages**

Set `.env.example` and Compose fallbacks to enabled/trusted. Document the opt-back-in configuration exactly:

```env
COMFYUI_NETWORK_MODE=allowlist
COMFYUI_ALLOWED_HOSTS=comfy.example.com
COMFYUI_ALLOWED_CIDRS=192.168.1.0/24
```

State that trusted mode still blocks cloud credential endpoints and unsafe redirects.

- [ ] **Step 4: Run contract tests and verify GREEN**

Run the Step 2 command. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add .env.example docker-compose.yml README.md README_en.md tests/contracts/docker-compose-comfyui.test.ts tests/contracts/requirements-matrix.ts tests/contracts/requirements-matrix.test.ts
git commit -m "docs: align ComfyUI trusted defaults"
```

### Task 3: Verification

**Files:**
- Verify only

- [ ] **Step 1: Run focused ComfyUI and contract suites**

```bash
npx vitest run tests/unit/comfyui tests/integration/api/specific/comfyui-connections-route.test.ts tests/contracts/docker-compose-comfyui.test.ts tests/contracts/requirements-matrix.test.ts
```

Expected: all pass.

- [ ] **Step 2: Run the repository gate**

```bash
npm run verify:commit
```

Expected: lint has no errors, typecheck passes, and all tests pass.

- [ ] **Step 3: Confirm a clean diff**

```bash
git diff --check
git status --short
```

Expected: no whitespace errors and no uncommitted task files.
