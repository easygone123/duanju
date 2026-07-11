# ComfyUI Provider Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add user-private ComfyUI pools and arbitrary image/video API-workflow execution as a native waoowaoo provider without changing existing providers.

**Architecture:** Persist immutable workflows and durable generation requests in MySQL, cache health and hold concurrency-one leases in Redis, and run a dispatcher beside existing workers. Published workflows become strict `comfyui::<workflowId>` models; requests wait for an idle compatible instance, execute, then copy mapped outputs into existing storage.

**Tech Stack:** Next.js 15, React 19, TypeScript, Prisma/MySQL, Redis/ioredis, BullMQ runtime, undici, ws, Zod, Vitest, Tailwind, next-intl.

---

## File structure

New backend code is isolated under `src/lib/comfyui/`: contracts, workflow compiler, network/client, owned services, health/compatibility, lease/scheduler, dispatcher/runtime, and provider adapter. New routes live under `src/app/api/comfyui/`; new settings UI lives under `src/app/[locale]/profile/components/comfyui/`. Existing strict model, worker, billing, project, progress, and localization files change only at listed integration points.

## Task 1: Schema and domain contracts

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260711090000_add_comfyui_provider/migration.sql`
- Create: `src/lib/comfyui/types.ts`, `errors.ts`, `external-id.ts`
- Test: `tests/unit/comfyui/domain-contract.test.ts`

- [ ] **Step 1: Capture baseline**

```bash
npm ci
npm run typecheck
npm run test:behavior:provider
```

Expected: all exit 0.

- [ ] **Step 2: Write failing test**

```ts
import { describe, expect, it } from 'vitest'
import { COMFY_REQUEST_STATUS } from '@/lib/comfyui/types'
import { formatComfyExternalId, parseComfyExternalId } from '@/lib/comfyui/external-id'

describe('ComfyUI domain contract', () => {
  it('round-trips ids', () => {
    expect(parseComfyExternalId(formatComfyExternalId('image', 'req-1')))
      .toEqual({ mediaType: 'image', requestId: 'req-1' })
  })
  it('declares durable waiting', () => {
    expect(COMFY_REQUEST_STATUS.WAITING_CAPACITY).toBe('waiting_capacity')
    expect(COMFY_REQUEST_STATUS.RECONCILING).toBe('reconciling')
  })
  it('rejects malformed ids', () => {
    expect(() => parseComfyExternalId('COMFY:AUDIO:req-1'))
      .toThrow('COMFY_EXTERNAL_ID_INVALID')
  })
})
```

- [ ] **Step 3: Verify red**

Run `npx vitest run tests/unit/comfyui/domain-contract.test.ts`.

Expected: FAIL because modules do not exist.

- [ ] **Step 4: Add contracts and persistence**

Define media/auth/health/request types, typed variables, bindings, outputs, events, and refs. IDs are exactly `COMFY:IMAGE:<requestId>` or `COMFY:VIDEO:<requestId>`. Add `ComfyConnection`, `ComfyWorkflow`, `ComfyWorkflowVersion`, `ProjectComfyBinding`, and `ComfyGenerationRequest` plus User/Project/Task relations. Require:

```prisma
@@unique([userId, normalizedBaseUrl])
@@unique([workflowId, version])
@@index([userId, status, queuedAt])
@@index([connectionId, status])
@@index([promptId])
```

`invocationKey` is unique; executable snapshots and outputs use JSON.

- [ ] **Step 5: Generate, verify, commit**

```bash
npx prisma migrate dev --name add_comfyui_provider --create-only
npx prisma generate
npx prisma validate
npx vitest run tests/unit/comfyui/domain-contract.test.ts
npm run typecheck
git add prisma src/lib/comfyui tests/unit/comfyui/domain-contract.test.ts
git commit -m "feat: add ComfyUI domain schema"
```

## Task 2: API Format workflow compiler

**Files:**
- Create: `src/lib/comfyui/workflow-schema.ts`
- Create: `src/lib/comfyui/workflow-renderer.ts`
- Create: `src/lib/comfyui/workflow-output.ts`
- Create: `src/lib/comfyui/workflow-requirements.ts`
- Test: `tests/unit/comfyui/workflow-compiler.test.ts`

- [ ] **Step 1: Write failing compiler tests**

```ts
const graph = {
  '1': { class_type: 'CLIPTextEncode', inputs: { text: '${prompt}' } },
  '2': { class_type: 'EmptyLatentImage', inputs: { width: '${width}', height: 512 } },
  '3': { class_type: 'SaveImage', inputs: { images: ['2', 0], filename_prefix: 'shot-${seed}' } },
}
const rendered = renderComfyWorkflow({
  graph,
  variables: { prompt: 'rain', width: 768, seed: 42 },
  variableDefinitions: [
    { name: 'prompt', type: 'string', required: true },
    { name: 'width', type: 'number', required: true },
    { name: 'seed', type: 'number', required: true },
  ],
  bindings: [{ nodeId: '2', inputPath: 'height', variable: 'width', valueType: 'number' }],
  uploads: {},
})
expect(rendered['1'].inputs.text).toBe('rain')
expect(rendered['2'].inputs).toMatchObject({ width: 768, height: 768 })
expect(rendered['3'].inputs.filename_prefix).toBe('shot-42')
```

Also test missing required variables, invalid node refs, mapping precedence, one primary output, and requirements.

- [ ] **Step 2: Verify red**

Run `npx vitest run tests/unit/comfyui/workflow-compiler.test.ts`; expect missing exports.

- [ ] **Step 3: Implement exact boundary**

```ts
validateComfyApiWorkflow(raw: unknown): ComfyApiWorkflow
discoverComfyPlaceholders(graph: ComfyApiWorkflow): string[]
validateWorkflowContract(input: WorkflowContractInput): WorkflowValidationIssue[]
renderComfyWorkflow(input: RenderWorkflowInput): ComfyApiWorkflow
extractComfyOutputs(history: unknown, spec: ComfyOutputBinding[]): ComfyOutputRef[]
deriveComfyRequirements(graph: ComfyApiWorkflow): ComfyWorkflowRequirements
```

Whole-value placeholders preserve types; embedded placeholders stringify. Explicit mappings apply last. Restrict paths beneath `inputs`; reject prototype keys. Only transforms `filename`, `image_ref`, `filename_list` are allowed. Never guess outputs.

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run tests/unit/comfyui/workflow-compiler.test.ts
npm run check:file-line-count
npm run typecheck
git add src/lib/comfyui tests/unit/comfyui/workflow-compiler.test.ts
git commit -m "feat: compile ComfyUI API workflows"
```

## Task 3: SSRF policy and ComfyUI client

**Files:**
- Modify: `package.json`, `package-lock.json`
- Create: `src/lib/comfyui/network-policy.ts`, `auth.ts`, `client.ts`
- Create: `tests/helpers/fakes/comfyui-server.ts`
- Test: `tests/unit/comfyui/network-policy.test.ts`
- Test: `tests/integration/provider/comfyui-client.contract.test.ts`

- [ ] **Step 1: Add ws and failing policy tests**

```bash
npm install ws@^8.18.0
npm install -D @types/ws@^8.5.13
```

Test allowlist rejection of loopback/private/link-local/metadata/IPv4-mapped IPv6, embedded credentials, non-HTTP, unapproved DNS, cross-origin redirects. Trusted mode permits localhost but still rejects `file:` and embedded credentials.

- [ ] **Step 2: Verify red**

Run `npx vitest run tests/unit/comfyui/network-policy.test.ts`; expect missing `authorizeComfyTarget`.

- [ ] **Step 3: Implement pinned authorization**

```ts
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
export async function authorizeComfyTarget(
  rawUrl: string,
  config: ComfyNetworkPolicyConfig,
  resolveHost = resolveComfyHost,
): Promise<AuthorizedComfyTarget>
```

Authorize every DNS answer. Pin the approved address through undici Agent and ws lookup. Use manual redirects; reauthorize same-origin only and never forward auth cross-origin.

- [ ] **Step 4: Implement fake server and client**

Fake routes: `/system_stats`, `/queue`, `/object_info`, `/models/checkpoints`, `/upload/image`, `/prompt`, `/history/:promptId`, `/view`, POST `/queue`, `/ws`. A fake global `/interrupt` sentinel may exist only to prove production never calls it.

```ts
class ComfyClient {
  getSystemStats(): Promise<ComfySystemStats>
  getQueue(): Promise<ComfyQueueSnapshot>
  getObjectInfo(): Promise<Record<string, unknown>>
  getModels(folder: string): Promise<string[]>
  uploadImage(input: ComfyUploadInput): Promise<ComfyUploadedFile>
  submitPrompt(graph: ComfyApiWorkflow, clientId: string): Promise<{ promptId: string }>
  watchPrompt(promptId: string, clientId: string, signal: AbortSignal):
    AsyncIterable<ComfyExecutionEvent>
  getHistory(promptId: string): Promise<unknown>
  downloadOutput(ref: ComfyOutputRef): Promise<Buffer>
  deleteQueuedPrompt(promptId: string): Promise<void>
}
```

Centralize auth, timeouts, byte limits, and sanitized errors.

- [ ] **Step 5: Verify and commit**

```bash
npx vitest run tests/unit/comfyui/network-policy.test.ts tests/integration/provider/comfyui-client.contract.test.ts
npm run typecheck
git add package.json package-lock.json src/lib/comfyui tests/helpers/fakes/comfyui-server.ts tests
git commit -m "feat: add secure ComfyUI client"
```

## Task 4: Private connection CRUD and status

**Files:**
- Create: `src/lib/comfyui/connection-service.ts`, `health.ts`
- Create: `src/app/api/comfyui/connections/route.ts`
- Create: `src/app/api/comfyui/connections/[connectionId]/route.ts`
- Create: `src/app/api/comfyui/connections/[connectionId]/probe/route.ts`
- Create: `src/app/api/comfyui/connections/status/route.ts`
- Test: `tests/unit/comfyui/health.test.ts`
- Test: `tests/integration/api/specific/comfyui-connections-route.test.ts`

- [ ] **Step 1: Write failing tests**

Assert auth 401, owner list, normalized duplicate 409, encrypted secret, `hasCredentials` without secret, cross-user 404, probe, enabled/disabled, and exact idle/external-busy/owned-busy/offline/auth states.

- [ ] **Step 2: Verify red**

Run both suites; expect missing routes/services.

- [ ] **Step 3: Implement**

Normalize scheme/host/default port/path/trailing slash. Encrypt credential JSON with `encryptApiKey`. Scope every DB operation by owner. Reject delete with nonterminal work; allow disable. Routes use `apiHandler`, `requireUserAuth`, Zod. Probe authorizes before client construction and persists sanitized diagnostics only.

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run tests/unit/comfyui/health.test.ts tests/integration/api/specific/comfyui-connections-route.test.ts
npm run check:api-handler
npm run typecheck
git add src/lib/comfyui src/app/api/comfyui tests
git commit -m "feat: manage private ComfyUI connections"
```

## Task 5: Workflow library, versions, publication, live test

**Files:**
- Create: `src/lib/comfyui/workflow-service.ts`
- Create: `src/app/api/comfyui/workflows/route.ts`
- Create: `src/app/api/comfyui/workflows/[workflowId]/route.ts`
- Create: `src/app/api/comfyui/workflows/[workflowId]/versions/route.ts`
- Create: `src/app/api/comfyui/workflows/[workflowId]/publish/route.ts`
- Create: `src/app/api/comfyui/workflows/[workflowId]/test-run/route.ts`
- Test: `tests/integration/api/specific/comfyui-workflows-route.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Cover draft, file/paste equivalence at service level, monotonic versions, canonical hash, validation details, publish, archive, isolation, successful test metadata, untested default rejection.

- [ ] **Step 2: Verify red**

Run the suite; expect missing routes.

- [ ] **Step 3: Implement immutable service**

```ts
listOwnedWorkflows(userId: string): Promise<ComfyWorkflowSummary[]>
createWorkflowDraft(userId: string, input: CreateWorkflowInput): Promise<ComfyWorkflowDetail>
createWorkflowVersion(userId: string, workflowId: string, input: CreateVersionInput):
  Promise<ComfyWorkflowVersionDetail>
publishWorkflowVersion(userId: string, workflowId: string, versionId: string): Promise<void>
recordSuccessfulWorkflowTest(userId: string, versionId: string, connectionId: string):
  Promise<void>
archiveWorkflow(userId: string, workflowId: string): Promise<void>
```

Hash canonical graph/variables/bindings/outputs; never mutate executable version content.

- [ ] **Step 4: Implement live test and verify**

Test route owns workflow/version/connection, requires compatibility, empty Comfy queue, no lease, then takes a test lease, executes once, records success, releases in `finally`. Static-valid drafts may publish; project default additionally requires a successful current-version test.

```bash
npx vitest run tests/integration/api/specific/comfyui-workflows-route.test.ts
npm run check:api-handler
npm run typecheck
git add src/lib/comfyui src/app/api/comfyui tests
git commit -m "feat: add ComfyUI workflow library"
```

## Task 6: Compatibility and health cache

**Files:**
- Create: `src/lib/comfyui/compatibility.ts`
- Modify: `src/lib/comfyui/health.ts`
- Test: `tests/unit/comfyui/compatibility.test.ts`
- Test: `tests/integration/provider/comfyui-health-monitor.contract.test.ts`

- [ ] **Step 1: Write failing tests**

Test missing node/model, complete match, fingerprint invalidation, auth/offline/external busy/local lease. Assert exact missing arrays.

- [ ] **Step 2: Verify red**

Run both suites; expect missing implementation.

- [ ] **Step 3: Implement**

```ts
export interface ComfyCompatibilityResult {
  compatible: boolean
  missingNodes: string[]
  missingModels: Array<{ nodeId: string; field: string; value: string }>
  workflowHash: string
  capabilityFingerprint: string
}
```

Use `/object_info` enums as authority and `/models/{folder}` only for identified model fields. Cache by connection, workflow hash, fingerprint. Store sanitized health at `comfy:health:<connectionId>` with TTL; check policy, stats, queue, lease, fingerprint in that order.

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run tests/unit/comfyui/compatibility.test.ts tests/integration/provider/comfyui-health-monitor.contract.test.ts
npm run typecheck
git add src/lib/comfyui tests
git commit -m "feat: monitor ComfyUI capacity"
```

## Task 7: Durable requests, leases, idle-first scheduler

**Files:**
- Create: `src/lib/comfyui/lease.ts`, `request-service.ts`, `scheduler.ts`
- Test: `tests/unit/comfyui/request-state-machine.test.ts`
- Test: `tests/concurrency/comfyui/scheduler.concurrency.test.ts`

- [ ] **Step 1: Write failing state/race tests**

Assert transitions, pinned workflow snapshot, idempotent invocation, owner-only release, heartbeat compare/expire, FIFO user queue, LRU idle choice, busy wait, incompatible block, and two schedulers with one winner.

- [ ] **Step 2: Verify red**

Run both suites; expect missing services.

- [ ] **Step 3: Implement explicit transitions**

```ts
const ALLOWED_TRANSITIONS: Record<ComfyRequestStatus, readonly ComfyRequestStatus[]> = {
  waiting_capacity: ['blocked_no_compatible_instance', 'leased', 'canceled'],
  blocked_no_compatible_instance: ['waiting_capacity', 'canceled'],
  leased: ['uploading', 'waiting_capacity', 'reconciling', 'failed', 'canceled'],
  uploading: ['submitted', 'waiting_capacity', 'reconciling', 'failed', 'canceled'],
  submitted: ['running', 'transferring', 'reconciling', 'failed', 'canceled'],
  running: ['transferring', 'reconciling', 'failed', 'canceled'],
  transferring: ['completed', 'reconciling', 'failed', 'canceled'],
  reconciling: ['submitted', 'running', 'transferring', 'completed', 'failed', 'canceled'],
  completed: [], failed: [], canceled: [],
}
```

Use compare-and-set updates; duplicate invocation returns existing request.

- [ ] **Step 4: Implement claim and verify**

Use Redis `SET NX PX` at `comfy:lease:<connectionId>`. Heartbeat/release are Lua compare-by-lease-ID. After Redis claim, DB `updateMany` confirms request eligibility; otherwise owner-release. Candidates are owned, enabled, cached idle, compatible, sorted by `lastAssignedAt`, then ID.

```bash
npx vitest run tests/unit/comfyui/request-state-machine.test.ts tests/concurrency/comfyui/scheduler.concurrency.test.ts
npm run typecheck
git add src/lib/comfyui tests
git commit -m "feat: schedule ComfyUI requests"
```

## Task 8: Execute, transfer, recover, cancel

**Files:**
- Create: `src/lib/comfyui/media.ts`, `dispatcher.ts`
- Create: `src/lib/comfyui/observability.ts`
- Create: `src/app/api/comfyui/requests/[requestId]/cancel/route.ts`
- Test: `tests/integration/provider/comfyui-dispatcher.contract.test.ts`
- Test: `tests/integration/provider/comfyui-recovery.contract.test.ts`
- Test: `tests/unit/comfyui/observability.test.ts`

- [ ] **Step 1: Write failing dispatcher tests**

Cover upload, render after upload, prompt-ID persistence, WebSocket progress, history fallback, every declared output, primary output, storage retry without resubmit, pre-submit failover, post-submit pinning, restart, exact queued cancel, running reconciliation without global interrupt, correlation IDs, metric increments, and credential/prompt redaction.

- [ ] **Step 2: Verify red**

Run both suites; expect missing dispatcher.

- [ ] **Step 3: Implement media/execution**

Resolve storage refs with `toFetchableUrl`, enforce byte limits, upload collision-resistant names, and apply only approved transforms. Store output Buffers via `uploadObject` with actual MIME/extension. Persist Comfy refs before storage and keys after transfer.

`dispatchRequest` rechecks owner/lease/health/compatibility, persists `promptId` immediately, uses WebSocket first and queue/history fallback, heartbeats, and owner-releases only in terminal paths.

`observability.ts` must attach task, request, workflow/version, connection, prompt,
and lease IDs to scoped logs without raw prompts or credentials. Record connection
uptime/idle/busy state, capacity wait, execution and transfer duration, workflow
success, failure code, lease contention, reconciliation, and transfer retry through
a small injectable metrics interface so unit tests do not need an external metrics
service.

- [ ] **Step 4: Implement reconcile/cancel**

A recorded prompt never resubmits. Reconcile queue/history to running, transfer, completed, or failed. Before submit, cancel locally. After submit, double-check prompt and lease ownership before deleting an exact pending prompt. Running or uncertain prompts reconcile to a natural terminal state; production never calls global `/interrupt` or affects manual prompts.

- [ ] **Step 5: Verify and commit**

```bash
npx vitest run tests/unit/comfyui/observability.test.ts tests/integration/provider/comfyui-dispatcher.contract.test.ts tests/integration/provider/comfyui-recovery.contract.test.ts
npm run typecheck
git add src/lib/comfyui src/app/api/comfyui tests
git commit -m "feat: execute and recover ComfyUI workflows"
```

## Task 9: Native provider, polling, progress, zero billing

**Files:**
- Create: `src/lib/comfyui/provider.ts`
- Modify: `src/lib/api-config.ts`, `generator-api.ts`, `async-poll.ts`
- Modify: `src/lib/workers/utils.ts`, `billing/task-policy.ts`, `task/progress-message.ts`
- Modify: `messages/{zh,en}/progress.json`
- Test: `tests/unit/comfyui/provider-routing.test.ts`
- Test: `tests/unit/comfyui/async-poll.test.ts`
- Modify test: `tests/unit/billing/task-policy.test.ts`

- [ ] **Step 1: Write failing integration tests**

Assert owned/published/type-correct selection, cross-user/unpublished failures, image/video async IDs, COMFY parsing, internal stages/multiple outputs, no execution timeout while capacity waits, zero billing, unchanged cloud cases.

- [ ] **Step 2: Verify red**

Run three targeted suites; expect COMFY routing failures.

- [ ] **Step 3: Add explicit strict routing**

In `api-config.ts`, branch only when parsed provider is `comfyui`; verify owned published workflow and media type. In `generator-api.ts`, route before `getProviderConfig`. Return:

```ts
return {
  success: true,
  async: true,
  externalId: formatComfyExternalId(mediaType, request.id),
}
```

- [ ] **Step 4: Extend polling/waiting**

Add COMFY to `parseExternalId`. Extend `PollResult` with `stage`, `resultUrls`, `waitingForCapacity`. Start execution deadline only after capacity wait ends. Publish stable stages, not fake elapsed progress.

- [ ] **Step 5: Billing/localization, verify, commit**

Parsed Comfy models return nonbillable/skipped with zero freeze. Add all seven approved Comfy stages to both locales.

```bash
npx vitest run tests/unit/comfyui/provider-routing.test.ts tests/unit/comfyui/async-poll.test.ts tests/unit/billing/task-policy.test.ts
npm run check:no-provider-guessing
npm run check:no-model-key-downgrade
npm run typecheck
git add src/lib messages tests
git commit -m "feat: route generation through ComfyUI"
```

## Task 10: Runtime loops and configuration

**Files:**
- Create: `src/lib/comfyui/runtime.ts`
- Modify: `src/lib/workers/index.ts`
- Modify: `.env.example`, `docker-compose.yml`
- Test: `tests/unit/comfyui/runtime.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

With fake timers/injected functions, assert immediate tick, non-overlap, wake on idle health, periodic reconcile, abort, graceful close.

- [ ] **Step 2: Verify red**

Run runtime suite; expect missing module.

- [ ] **Step 3: Implement lifecycle**

```ts
export interface ComfyRuntime {
  close(): Promise<void>
  wakeDispatcher(): void
}
export function startComfyRuntime(
  deps?: Partial<ComfyRuntimeDeps>,
): ComfyRuntime
```

Use condition wakeups plus bounded fallback. Guard loops with in-flight promises. Start once in workers; close before worker shutdown.

- [ ] **Step 4: Add exact configuration**

Wire `COMFYUI_ENABLED`, `COMFYUI_NETWORK_MODE`, `COMFYUI_ALLOWED_HOSTS`, `COMFYUI_ALLOWED_CIDRS`, health/dispatch intervals, lease TTL, image/video timeouts, workflow/input/output byte limits. Network mode defaults to allowlist.

- [ ] **Step 5: Verify and commit**

```bash
npx vitest run tests/unit/comfyui/runtime.test.ts
npm run typecheck
git add src/lib/comfyui src/lib/workers/index.ts .env.example docker-compose.yml tests
git commit -m "feat: run ComfyUI dispatcher runtime"
```

## Task 11: Dynamic models and project defaults

**Files:**
- Modify: `src/app/api/user/models/route.ts`
- Modify: `src/lib/config-service.ts`
- Modify: `src/app/api/novel-promotion/[projectId]/route.ts`
- Test: `tests/integration/api/specific/user-models-comfyui.test.ts`
- Test: `tests/integration/api/specific/project-comfyui-defaults.test.ts`

- [ ] **Step 1: Write failing list/precedence tests**

Only owned published workflows appear; image/video grouping works; archived/unpublished/foreign workflows do not. Untested current versions cannot default. Precedence: task override, project Comfy binding, specialized project model, user default.

- [ ] **Step 2: Verify red**

Run both suites; expect workflows absent.

- [ ] **Step 3: Merge dynamic models**

```ts
{
  value: composeModelKey('comfyui', workflow.id),
  label: workflow.name,
  provider: 'comfyui',
  providerName: 'ComfyUI',
}
```

Do not write graph to `customModels`; no provider key required.

- [ ] **Step 4: Bind project defaults**

Add `comfyImageWorkflowId`, `comfyVideoWorkflowId` to project GET/PATCH. Validate project/workflow ownership, type, publication, successful test. Overlay strict keys using tested precedence; clearing restores existing providers.

- [ ] **Step 5: Verify and commit**

```bash
npx vitest run tests/integration/api/specific/user-models-comfyui.test.ts tests/integration/api/specific/project-comfyui-defaults.test.ts
npm run check:no-multiple-sources-of-truth
npm run typecheck
git add src/app/api src/lib/config-service.ts tests
git commit -m "feat: select ComfyUI workflows as models"
```

## Task 12: Connection-pool UI

**Files:**
- Create: `src/app/[locale]/profile/components/comfyui/ComfyUiSettings.tsx`
- Create: `ConnectionPoolPanel.tsx`, `ConnectionCard.tsx`, `ConnectionEditor.tsx`, `hooks.ts` in that folder
- Modify: `src/app/[locale]/profile/page.tsx`
- Create: `messages/{zh,en}/comfyui.json`
- Modify: `src/i18n.ts`
- Test: `tests/unit/components/comfyui-connection-settings.test.ts`

- [ ] **Step 1: Write failing UI tests**

Assert profile navigation, name/URL/auth fields, no secret hydration, every approved state, visible-tab polling, delete disabled during owned work.

- [ ] **Step 2: Verify red**

Run component suite; expect missing components.

- [ ] **Step 3: Implement hooks/forms**

Use `apiFetch` and React Query. Refresh visible status every five seconds and stop while hidden. Submit `{ name, baseUrl, authType, credentials? }`; empty edit credential preserves saved value.

- [ ] **Step 4: Implement cards/navigation**

Cards show URL, state, last check, queue counts, GPU/VRAM, owned task, controls. Add ComfyUI section using existing glass primitives; no graph canvas.

- [ ] **Step 5: Localize, verify, commit**

```bash
npx vitest run tests/unit/components/comfyui-connection-settings.test.ts
npm run check:locale-navigation
npm run typecheck
git add "src/app/[locale]/profile" src/i18n.ts messages tests
git commit -m "feat: add ComfyUI connection settings"
```

## Task 13: Workflow UI, selection, diagnostics

**Files:**
- Create: `WorkflowLibraryPanel.tsx`, `WorkflowEditor.tsx`, `WorkflowMappingTable.tsx`, `WorkflowCompatibilityTable.tsx` under profile ComfyUI
- Modify: `ComfyUiSettings.tsx`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/WorkspaceHeaderShell.tsx`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video/panel-card/VideoPanelCardBody.tsx`
- Modify: `src/components/task/TaskStatusOverlay.tsx`
- Modify: `messages/{zh,en}/comfyui.json`
- Test: `tests/unit/components/comfyui-workflow-settings.test.ts`
- Test: `tests/unit/novel-promotion/comfyui-workflow-selection.test.ts`

- [ ] **Step 1: Write failing UI tests**

Assert file/paste import, placeholder rows, typed variables/defaults/required, node/input mappings, enumerated transforms, one primary output, draft/publish/test, compatibility, project defaults, task-level Comfy selection, wait/instance/workflow/prompt diagnostics.

- [ ] **Step 2: Verify red**

Run both suites; expect UI missing.

- [ ] **Step 3: Implement authoring**

Keep form separate from saved version. Parse/upload JSON, call server validation, render node/path issues, require explicit outputs. Static-valid drafts publish; project default requires `lastSuccessfulTestAt`.

- [ ] **Step 4: Integrate selection/diagnostics**

Add project defaults. Reuse current model dropdowns for task override via `/api/user/models`; preserve cloud options/capabilities. Task overlay separates capacity wait from execution and exposes sanitized IDs only.

- [ ] **Step 5: Verify and commit**

```bash
npx vitest run tests/unit/components/comfyui-workflow-settings.test.ts tests/unit/novel-promotion/comfyui-workflow-selection.test.ts
npm run check:locale-navigation
npm run typecheck
git add "src/app/[locale]" src/components/task messages tests
git commit -m "feat: add ComfyUI workflow controls"
```

## Task 14: Acceptance, security regression, docs, full verification

**Files:**
- Modify: `tests/contracts/requirements-matrix.ts`, `requirements-matrix.test.ts`
- Create: `tests/system/comfyui-generation.system.test.ts`
- Create: `scripts/comfyui-contract-check.ts`
- Modify: `package.json`, `README.md`, `README_en.md`
- Modify: design spec status after verification

- [ ] **Step 1: Add acceptance/system tests**

Map every acceptance criterion. Run fake image/video workflows through submit, busy wait, idle assignment, storage, cancel, restart. Include cross-user isolation, an external prompt keeping a node busy, metric emission, and a log-capture assertion proving credentials and raw prompts are absent.

- [ ] **Step 2: Add opt-in real contract check**

Add `npm run check:comfyui-contract`. Require URL and workflow env inputs; probe, validate, submit one authorized test, fetch primary output, print sanitized timings. Exclude from default CI.

- [ ] **Step 3: Document operations**

Document enablement, network modes, Docker host access, auth, API Format export, bindings/outputs, statuses, concurrency one, queue wait, recovery/cancel, no built-ins, CC BY-NC-SA. Mark design Implemented only after verification.

- [ ] **Step 4: Run full verification**

```bash
npx prisma validate
npm run lint:all
npm run typecheck
npm run test:behavior:full
npm run test:integration:task
npm run test:system
npm run test:guards
npm run build
```

Expected: every command exits 0; record counts and optional real check status.

- [ ] **Step 5: Scope/secret check and commit**

```bash
git diff --check origin/main...HEAD
git status --short
rg -n "(Bearer |Basic |api[_-]?key|password).*([A-Za-z0-9+/=_-]{16,})" src tests messages .env.example docker-compose.yml
git add package.json README.md README_en.md scripts tests docs/superpowers/specs/2026-07-11-comfyui-provider-integration-design.md
git commit -m "test: verify ComfyUI provider integration"
```

Expected: no whitespace issue or real secret.

## Spec coverage

- Connections/status: Tasks 3, 4, 6, 12.
- Arbitrary workflows/mappings/outputs: Tasks 2, 5, 13.
- Private ownership: Tasks 4, 5, 7, 11, 14.
- FIFO/idle/LRU/concurrency-one/wait: Tasks 7, 9, 14.
- Transfer/failover/no-duplicate recovery/cancel: Task 8.
- Existing providers/strict keys: Tasks 9, 11, 14.
- Project defaults/task override: Tasks 11, 13.
- Zero billing: Task 9.
- Allowlist/trusted security: Tasks 3, 10, 14.
- Progress/diagnostics/metrics: Tasks 8, 9, 13, 14.
- No built-ins: Tasks 5, 13, 14.
- Docs/license: Task 14.
