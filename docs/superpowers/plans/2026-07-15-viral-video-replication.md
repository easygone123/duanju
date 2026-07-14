# Viral Video Replication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Add a homepage “爆款复刻” workflow that streams one MP4/MOV upload, analyzes server-extracted shots with the configured analysis model, lets the user review the report, and then atomically creates editable episode storyboards and image/video prompts without generating media.

**Architecture:** A two-step authenticated upload API creates a `ViralReplication` session, validates and streams the source through a bounded temporary file, then creates a draft project/episode and submits a single-attempt BullMQ analysis task. A dedicated worker uses FFprobe/FFmpeg, versioned Zod contracts, the existing model gateway, TaskEvent/SSE, and an atomic storyboard persistence service. The UI has a small homepage launcher and a dedicated review page whose cache is invalidated only by `ViralReplication` task events.

**Tech Stack:** Next.js 15 Route Handlers, React 19, TypeScript, Prisma/MySQL, BullMQ/Redis, FFmpeg/FFprobe, Zod, TanStack Query, Vitest, Testing Library, Docker Alpine.

---

## Working rules

- Execute every task in the worktree created for this feature: `/Users/rziiiii/.config/superpowers/worktrees/waoowaoo/viral-video-replication`.
- Keep the source video out of JSON and Prisma task payloads; payloads contain media IDs and scalar metadata only.
- Do not call an LLM directly from a Route Handler. Routes submit tasks; the dedicated worker calls `runModelGatewayVisionCompletion` and `runModelGatewayTextCompletion`.
- Do not add automatic image, video, voice, or render submissions. The final write stops at episode text, storyboard rows, panel rows, `imagePrompt`, and `videoPrompt`.
- Use single-attempt BullMQ jobs and `Task.maxAttempts = 1`. A user retry creates a new full analysis task.
- Run each task’s focused test first and observe the documented failure before implementation.
- Use `apply_patch` for hand edits. Do not overwrite unrelated user changes.

## Task 1: Add the persistence model and versioned domain contracts

**Files:**

- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260715090000_add_viral_replication/migration.sql`
- Create: `src/lib/viral-replication/contracts.ts`
- Create: `src/lib/viral-replication/constants.ts`
- Test: `tests/unit/viral-replication/contracts.test.ts`

- [ ] **Step 1: Write failing contract tests**

Cover these cases in `tests/unit/viral-replication/contracts.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  parseViralAnalysisReport,
  parseViralStoryboardGeneration,
} from '@/lib/viral-replication/contracts'

describe('viral replication contracts', () => {
  it('accepts a continuous in-bounds analysis timeline', () => {
    expect(parseViralAnalysisReport(validReport, 15_000).shots).toHaveLength(1)
  })

  it.each([
    ['empty shots', { ...validReport, shots: [] }],
    ['non-continuous shot index', { ...validReport, shots: [{ ...validReport.shots[0], shotIndex: 2 }] }],
    ['out-of-bounds end', { ...validReport, shots: [{ ...validReport.shots[0], endMs: 15_001 }] }],
  ])('rejects %s', (_label, value) => {
    expect(() => parseViralAnalysisReport(value, 15_000)).toThrow()
  })

  it('rejects storyboard output with no panels or non-positive duration', () => {
    expect(() => parseViralStoryboardGeneration(invalidGeneration)).toThrow()
  })
})
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
npx vitest run tests/unit/viral-replication/contracts.test.ts
```

Expected: FAIL because `@/lib/viral-replication/contracts` does not exist.

- [ ] **Step 3: Add constants and strict Zod schemas**

In `src/lib/viral-replication/constants.ts`, define the only allowed runtime states and upload limits:

```ts
export const VIRAL_REPLICATION_STATUS = {
  UPLOADING: 'uploading',
  ANALYZING: 'analyzing',
  REVIEW_READY: 'review_ready',
  GENERATING: 'generating',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const

export const VIRAL_UPLOAD_MAX_BYTES = 500 * 1024 * 1024
export const VIRAL_VIDEO_MIN_DURATION_MS = 15_000
export const VIRAL_VIDEO_MAX_DURATION_MS = 180_000
export const VIRAL_MAX_ANALYSIS_FRAMES = 72
export const VIRAL_ANALYSIS_BATCH_SIZE = 10
```

In `contracts.ts`, implement Zod schemas matching both V1 interfaces in the approved design. Apply explicit maximum lengths to every text field, require `schemaVersion: 1`, require non-empty storyboard/panel arrays, and use wrapper functions for cross-field checks:

```ts
export function parseViralAnalysisReport(value: unknown, durationMs: number) {
  const report = viralAnalysisReportV1Schema.parse(value)
  report.shots.forEach((shot, index) => {
    if (shot.shotIndex !== index) throw new Error('shot indexes must be continuous')
    if (shot.startMs < 0 || shot.startMs >= shot.endMs || shot.endMs > durationMs) {
      throw new Error('shot timeline is out of bounds')
    }
    if (index > 0 && shot.startMs < report.shots[index - 1].startMs) {
      throw new Error('shot timeline must be ordered')
    }
  })
  return report
}
```

- [ ] **Step 4: Add Prisma models and relations**

Add `ViralReplication` and `ViralReplicationFrame` with the fields approved in the design. Use `Json?` for `reportJson`, `@db.LongText` for `transcriptText`, `@unique` nullable relations for `projectId` and `episodeId`, and named MediaObject relations:

```prisma
model ViralReplication {
  id                    String   @id @default(uuid())
  userId                String
  projectId             String?  @unique
  episodeId             String?  @unique
  sourceVideoMediaId    String?  @unique
  brief                 String   @db.Text
  videoRatio            String
  artStyle              String
  status                String   @default("uploading")
  analysisModelSnapshot String?
  durationMs            Int?
  transcriptText        String?  @db.LongText
  reportJson            Json?
  reportVersion         Int      @default(1)
  errorMessage          String?  @db.Text
  confirmedAt           DateTime?
  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt

  user        User                       @relation(fields: [userId], references: [id], onDelete: Cascade)
  project     Project?                   @relation(fields: [projectId], references: [id], onDelete: Cascade)
  episode     NovelPromotionEpisode?     @relation(fields: [episodeId], references: [id], onDelete: Cascade)
  sourceVideo MediaObject?               @relation("ViralReplicationSourceVideo", fields: [sourceVideoMediaId], references: [id], onDelete: SetNull)
  frames      ViralReplicationFrame[]

  @@index([userId, createdAt])
  @@index([status])
  @@map("viral_replications")
}
```

Add inverse relations to `User`, `Project`, `NovelPromotionEpisode`, and `MediaObject`. Add the SQL migration with matching table names, indexes, unique constraints, and foreign keys.

- [ ] **Step 5: Generate Prisma client and run tests**

Run:

```bash
npx prisma format
npx prisma generate
npx vitest run tests/unit/viral-replication/contracts.test.ts
npm run typecheck
```

Expected: all commands pass.

- [ ] **Step 6: Commit the model and contracts**

```bash
git add prisma src/lib/viral-replication tests/unit/viral-replication/contracts.test.ts
git commit -m "feat: add viral replication domain model"
```

## Task 2: Add bounded streaming storage primitives

**Files:**

- Modify: `src/lib/storage/types.ts`
- Modify: `src/lib/storage/index.ts`
- Modify: `src/lib/storage/providers/local.ts`
- Modify: `src/lib/storage/providers/minio.ts`
- Modify: `src/lib/storage/providers/cos.ts`
- Create: `src/lib/viral-replication/temp-file.ts`
- Test: `tests/unit/storage/streaming-object.test.ts`
- Test: `tests/unit/viral-replication/temp-file.test.ts`

- [ ] **Step 1: Write failing storage-stream tests**

Test that local streaming upload writes the exact bytes, exposes a readable stream, and never leaves the `.part-*` file after success or failure. Test the bounded temporary-file writer at exactly 500 MB using a small injected limit so the test does not allocate 500 MB.

The new provider contract is:

```ts
export interface UploadObjectStreamParams {
  key: string
  body: NodeJS.ReadableStream
  contentLength: number
  contentType?: string
}

export interface StorageProvider {
  // existing methods remain
  uploadObjectStream(params: UploadObjectStreamParams): Promise<UploadObjectResult>
  getObjectStream(key: string): Promise<NodeJS.ReadableStream>
}
```

- [ ] **Step 2: Run the tests and confirm RED**

```bash
npx vitest run tests/unit/storage/streaming-object.test.ts tests/unit/viral-replication/temp-file.test.ts
```

Expected: FAIL because the stream methods and temp-file helper do not exist.

- [ ] **Step 3: Implement provider methods**

- Local: use `node:stream/promises.pipeline`, `fs.createWriteStream`, a sibling `.part-${randomUUID()}` path, and `fs.rename` only after the pipeline finishes.
- MinIO: send a `PutObjectCommand` with `Body`, `ContentLength`, and `ContentType`; return the `GetObjectCommand` body only after asserting it is pipeable.
- COS: keep the provider’s existing explicit not-implemented behavior, but implement both interface methods by throwing `StorageProviderNotImplementedError('cos')`. Do not silently buffer or advertise support.
- Facade: export `uploadObjectStream(body, key, contentLength, contentType)` and `getObjectStream(key)` with the same retry policy as buffer upload.

- [ ] **Step 4: Implement the bounded temporary-file helper**

`writeRequestBodyToTempFile` must:

- reject a missing request body;
- convert `ReadableStream<Uint8Array>` with `Readable.fromWeb`;
- count bytes in a `Transform` and abort immediately after the supplied limit;
- return `{ directory, filePath, sizeBytes, cleanup }`;
- make `cleanup` idempotent with `fs.rm(directory, { recursive: true, force: true })`.

- [ ] **Step 5: Run storage tests and typecheck**

```bash
npx vitest run tests/unit/storage/streaming-object.test.ts tests/unit/viral-replication/temp-file.test.ts
npm run typecheck
```

Expected: PASS with no full-buffer code path in either new helper.

- [ ] **Step 6: Commit streaming storage**

```bash
git add src/lib/storage src/lib/viral-replication/temp-file.ts tests/unit/storage tests/unit/viral-replication/temp-file.test.ts
git commit -m "feat: add streaming media storage primitives"
```

## Task 3: Build and verify the FFmpeg preprocessing boundary

**Files:**

- Create: `src/lib/viral-replication/ffmpeg.ts`
- Create: `src/lib/viral-replication/preprocess.ts`
- Create: `src/lib/viral-replication/upload-validation.ts`
- Test: `tests/unit/viral-replication/ffmpeg.test.ts`
- Test: `tests/unit/viral-replication/preprocess.test.ts`
- Create: `tests/fixtures/viral-replication/create-fixture.sh`
- Create (generated by the script and committed): `tests/fixtures/viral-replication/three-scenes.mp4`

- [ ] **Step 1: Write failing parser and shot-selection tests**

Cover:

- FFprobe JSON with video, audio, and subtitle streams;
- rejection when there is no video stream;
- real duration boundaries at 14,999 ms, 15,000 ms, 180,000 ms, and 180,001 ms;
- MP4/MOV format acceptance and arbitrary container rejection;
- scene boundary conversion into ordered `[startMs, endMs]` shots;
- first-frame inclusion;
- fixed-interval fallback when scene detection yields fewer than two useful segments;
- deterministic downsampling to at most 72 frames;
- batches of 10, with the final batch allowed to be 1–10.

- [ ] **Step 2: Run the focused tests and confirm RED**

```bash
npx vitest run tests/unit/viral-replication/ffmpeg.test.ts tests/unit/viral-replication/preprocess.test.ts
```

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement an injectable process runner**

Use `spawn`, never a shell string. Capture bounded stdout/stderr and reject non-zero exits with a normalized error:

```ts
export type CommandRunner = (
  binary: 'ffmpeg' | 'ffprobe',
  args: string[],
) => Promise<{ stdout: string; stderr: string }>
```

Expose `assertFfmpegAvailable`, `probeVideo`, `detectSceneTimestamps`, `extractFrame`, and `extractEmbeddedSubtitles`. Keep all command construction in `ffmpeg.ts` so unit tests can assert exact arguments without invoking binaries.

- [ ] **Step 4: Implement deterministic preprocessing**

`preprocessViralVideo` receives a local source path and output directory. It must:

1. probe the actual file;
2. validate container, video stream, and duration;
3. detect scene changes;
4. build ordered shot ranges, falling back to fixed intervals;
5. cap ranges at 72 with deterministic even sampling;
6. extract one JPEG representative frame for every retained range;
7. extract embedded text subtitles when present;
8. return metadata and local frame paths without calling storage or Prisma.

- [ ] **Step 5: Generate and inspect the licensed test fixture**

Create `create-fixture.sh` using FFmpeg `lavfi` color sources only, so the fixture is original and has no third-party media rights. Generate three 5-second color scenes with visible text and concatenate them:

```bash
bash tests/fixtures/viral-replication/create-fixture.sh
ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 tests/fixtures/viral-replication/three-scenes.mp4
```

Expected: duration reports approximately `15.000000`; `git status --short` shows the script and MP4.

- [ ] **Step 6: Run tests against both fake and real binaries**

Add one test guarded only by an explicit `ffmpeg -version` preflight; the test must fail with a clear environment message when the binary is missing, not silently skip.

```bash
npx vitest run tests/unit/viral-replication/ffmpeg.test.ts tests/unit/viral-replication/preprocess.test.ts
```

Expected: PASS and at least three detected/derived shot ranges for the fixture.

- [ ] **Step 7: Commit preprocessing**

```bash
git add src/lib/viral-replication tests/unit/viral-replication tests/fixtures/viral-replication
git commit -m "feat: add viral video preprocessing"
```

## Task 4: Register the task types, dedicated queue, billing, and worker process

**Files:**

- Modify: `src/lib/task/types.ts`
- Modify: `src/lib/task/queues.ts`
- Modify: `src/lib/billing/task-policy.ts`
- Modify: `src/lib/workers/index.ts`
- Create: `src/lib/workers/viral-replication.worker.ts`
- Create: `src/lib/workers/handlers/viral-replication-analysis.ts`
- Create: `src/lib/workers/handlers/viral-replication-generation.ts`
- Modify: `src/lib/task/progress-message.ts`
- Modify: `messages/zh/progress.json`
- Modify: `messages/en/progress.json`
- Modify: `tests/contracts/task-type-catalog.ts`
- Modify: `tests/contracts/tasktype-behavior-matrix.ts`
- Test: `tests/unit/task/viral-replication-queue.test.ts`
- Test: `tests/unit/worker/viral-replication-worker.test.ts`

- [ ] **Step 1: Write failing queue and dispatch tests**

Assert that:

- both new task constants exist;
- both resolve to queue type `viral`;
- both are submitted with one BullMQ attempt;
- billing resolves through `buildTextTaskInfo` using `analysisModelSnapshot`;
- the worker dispatches analysis and generation to separate handlers;
- unsupported task types throw.

- [ ] **Step 2: Run focused tests and confirm RED**

```bash
npx vitest run tests/unit/task/viral-replication-queue.test.ts tests/unit/worker/viral-replication-worker.test.ts
```

Expected: FAIL because task constants and queue do not exist.

- [ ] **Step 3: Add task and queue constants**

Add:

```ts
VIRAL_VIDEO_ANALYSIS: 'viral_video_analysis',
VIRAL_STORYBOARD_GENERATION: 'viral_storyboard_generation',
```

Extend `QueueType` with `'viral'`, add `QUEUE_NAME.VIRAL_REPLICATION = 'waoowaoo-viral-replication'`, add a queue instance, include it in `ALL_QUEUES`, and route only those two task types to it. Add both to `SINGLE_ATTEMPT_TASK_TYPES`.

- [ ] **Step 4: Add billing and progress metadata**

Add both types to `BILLABLE_TASK_TYPES` and the text branch. Update `buildTextTaskInfo` model selection to include `payload.analysisModelSnapshot` before the existing keys. Add Chinese/English task labels and stages for preprocess, shot analysis, report aggregation, storyboard generation, and persistence.

- [ ] **Step 5: Add the dedicated worker shell**

`viral-replication.worker.ts` should use `withTaskLifecycle`, dependency-injectable handler functions, and:

```ts
concurrency: Number.parseInt(process.env.QUEUE_CONCURRENCY_VIRAL_REPLICATION || '2', 10) || 2
```

Register it in `src/lib/workers/index.ts` so the startup worker count changes from four to five. The handler imports created in later tasks can initially be explicit throwing stubs exported from `src/lib/workers/handlers/viral-replication-analysis.ts` and `viral-replication-generation.ts`; their worker tests must mock those modules.

- [ ] **Step 6: Update test coverage catalogs**

Map both task types to `tests/unit/worker/viral-replication-worker.test.ts`, a new `tests/integration/chain/viral-replication.chain.test.ts`, and `tests/integration/api/contract/viral-replication-routes.test.ts` in the behavior matrix.

- [ ] **Step 7: Run focused tests and task guards**

```bash
npx vitest run tests/unit/task/viral-replication-queue.test.ts tests/unit/worker/viral-replication-worker.test.ts
npm run check:test-tasktype-coverage
npm run check:test-behavior-tasktype-coverage
npm run typecheck
```

Expected: PASS; task coverage count increases by two.

- [ ] **Step 8: Commit task infrastructure**

```bash
git add src/lib/task src/lib/billing/task-policy.ts src/lib/workers messages tests/contracts tests/unit/task tests/unit/worker/viral-replication-worker.test.ts
git commit -m "feat: register viral replication tasks"
```

## Task 5: Implement upload-session and ownership APIs

**Files:**

- Create: `src/lib/viral-replication/service.ts`
- Create: `src/lib/viral-replication/ownership.ts`
- Create: `src/app/api/viral-replications/route.ts`
- Create: `src/app/api/viral-replications/[id]/route.ts`
- Create: `src/app/api/viral-replications/[id]/video/route.ts`
- Modify: `tests/contracts/route-catalog.ts`
- Modify: `tests/contracts/route-behavior-matrix.ts`
- Test: `tests/integration/api/contract/viral-replication-routes.test.ts`
- Test: `tests/integration/api/specific/viral-replication-upload.test.ts`

- [ ] **Step 1: Write failing route contract tests**

Cover authentication, ownership, invalid body, lifecycle rules, and success payloads for:

- `POST /api/viral-replications` with non-empty `brief`, valid ratio, and valid art style;
- `GET /api/viral-replications/[id]` returning status/report/project/episode/source metadata;
- `PATCH /api/viral-replications/[id]` updating `brief` only while `uploading`, `review_ready`, or `failed`;
- `PUT /api/viral-replications/[id]/video` accepting only an `uploading` record owned by the caller.

The upload-specific integration test must use a small injected byte limit and mocked FFprobe/storage to verify that over-limit input is cut off, validation failure creates no project, and success creates all DB records once.

- [ ] **Step 2: Run route tests and confirm RED**

```bash
BILLING_TEST_BOOTSTRAP=1 npx vitest run tests/integration/api/contract/viral-replication-routes.test.ts tests/integration/api/specific/viral-replication-upload.test.ts
```

Expected: FAIL because the routes do not exist.

- [ ] **Step 3: Implement the ownership reader**

Create one reusable query that always scopes by `id` and `userId`, includes only the fields needed by the caller, and throws the existing not-found `ApiError`. Never accept project ownership alone as proof for an upload session whose project is still null.

- [ ] **Step 4: Implement upload session creation and detail/update routes**

Use `apiHandler`, `requireUserAuth`, `resolveTaskLocale`, existing ratio/style validators, and normalized error codes. `POST` creates only `ViralReplication(status='uploading')`; it must not create a project yet.

- [ ] **Step 5: Implement the streamed video route**

The route sequence is exact:

1. authenticate and lock eligibility with a conditional `updateMany` or transaction read;
2. stream `request.body` into a bounded temp file;
3. validate the ISO base media file header and run FFprobe against the local path;
4. reject anything outside MP4/MOV, 15–180 seconds, or 500 MB;
5. stream the validated file into storage;
6. in one Prisma transaction create `MediaObject`, `Project`, `NovelPromotionProject` with user preference snapshots, episode 1, and link/update `ViralReplication` to `analyzing`;
7. call `submitTask` with `maxAttempts: 1`, `targetType: 'ViralReplication'`, the new record ID, source media ID, and the analysis-model snapshot;
8. if submission fails, set the replication to `failed` with the generic error; do not delete the uploaded source or draft project;
9. always clean up the local temp directory.

Use project name `爆款复刻-${formatTimestamp(now)}` and episode name `第 1 集`. Reject submission before project creation when the current analysis model is missing.

- [ ] **Step 6: Register routes in the contract catalogs**

Add category `'viral-replication'` and contract group `'viral-replication-routes'`. Register the four routes created in this task, route them to the new contract test, and map their chain test to `tests/integration/chain/viral-replication.chain.test.ts`.

- [ ] **Step 7: Run route and guard tests**

```bash
BILLING_TEST_BOOTSTRAP=1 npx vitest run tests/integration/api/contract/viral-replication-routes.test.ts tests/integration/api/specific/viral-replication-upload.test.ts
npm run check:api-handler
npm run check:test-route-coverage
npm run check:test-behavior-route-coverage
npm run typecheck
```

Expected: PASS; failed upload assertions show zero projects and zero episodes.

- [ ] **Step 8: Commit upload APIs**

```bash
git add src/lib/viral-replication src/app/api/viral-replications tests/contracts tests/integration/api
git commit -m "feat: add viral replication upload APIs"
```

## Task 6: Implement the reference-video analysis worker

**Files:**

- Create: `src/lib/viral-replication/prompts.ts`
- Create: `lib/prompts/viral-replication/shot_analysis.zh.txt`
- Create: `lib/prompts/viral-replication/shot_analysis.en.txt`
- Create: `lib/prompts/viral-replication/report_aggregation.zh.txt`
- Create: `lib/prompts/viral-replication/report_aggregation.en.txt`
- Modify: `src/lib/prompt-i18n/prompt-ids.ts`
- Modify: `src/lib/prompt-i18n/catalog.ts`
- Replace stub: `src/lib/workers/handlers/viral-replication-analysis.ts`
- Test: `tests/unit/worker/viral-replication-analysis.test.ts`
- Test: `tests/integration/chain/viral-replication.chain.test.ts`

- [ ] **Step 1: Write failing analysis-handler tests**

With injected storage, preprocessor, model gateway, and Prisma dependencies, verify:

- source video is downloaded as a stream into a temp file;
- preprocessing progress is reported;
- all frames are persisted as `MediaObject` plus `ViralReplicationFrame`;
- frames are passed to vision in ordered batches of at most 10 as JPEG data URLs;
- embedded subtitle context and frame timestamps appear in the prompt;
- the same `analysisModelSnapshot` is used for every vision and aggregation call;
- invalid model JSON fails the whole task and sets `ViralReplication.status = failed`;
- successful aggregation passes `parseViralAnalysisReport`, writes `reportJson`, `transcriptText`, `durationMs`, and `review_ready`;
- no alternate model is selected when vision fails.

- [ ] **Step 2: Run tests and confirm RED**

```bash
npx vitest run tests/unit/worker/viral-replication-analysis.test.ts
```

Expected: FAIL because the handler is still a stub.

- [ ] **Step 3: Register localized prompts**

Add prompt IDs `VIRAL_SHOT_ANALYSIS` and `VIRAL_REPORT_AGGREGATION`. Prompt variables are exact and cataloged:

- shot analysis: `brief`, `video_metadata`, `shot_timeline`, `subtitle_context`;
- aggregation: `brief`, `duration_ms`, `batch_results_json`, `report_schema_json`.

Both prompt languages must explicitly prohibit copying names, plot, or dialogue, and require JSON only.

- [ ] **Step 4: Implement the handler**

Use a `try/catch/finally` boundary that:

- verifies the task target belongs to `job.data.userId` and matches the payload media ID;
- materializes the source with `getObjectStream` and `pipeline`;
- invokes `preprocessViralVideo`;
- uploads small JPEG frames with existing `uploadObject` and creates frame media records;
- calls `runModelGatewayVisionCompletion` per batch;
- extracts completion text with the existing completion helper and parses JSON with `jsonrepair` plus Zod;
- calls `runModelGatewayTextCompletion` once to aggregate;
- writes the completed report in a single update;
- changes only the replication state to `failed` on error and rethrows so Task lifecycle also fails;
- always deletes the worker temp directory.

- [ ] **Step 5: Add the chain test**

The chain test uses the real Task submitter and worker handler with deterministic model stubs. Assert:

```ts
expect(replication.status).toBe('review_ready')
expect(replication.reportJson).toMatchObject({ schemaVersion: 1 })
expect(frames.length).toBeGreaterThanOrEqual(3)
expect(task.maxAttempts).toBe(1)
```

- [ ] **Step 6: Run analysis, prompt, and chain tests**

```bash
npx vitest run tests/unit/worker/viral-replication-analysis.test.ts
BILLING_TEST_BOOTSTRAP=1 npx vitest run tests/integration/chain/viral-replication.chain.test.ts
npm run check:prompt-i18n
npm run check:no-api-direct-llm-call
```

Expected: PASS; the model stub records vision batches and one aggregation call.

- [ ] **Step 7: Commit analysis worker**

```bash
git add lib/prompts/viral-replication src/lib/prompt-i18n src/lib/viral-replication src/lib/workers/handlers tests/unit/worker/viral-replication-analysis.test.ts tests/integration/chain/viral-replication.chain.test.ts
git commit -m "feat: analyze viral reference videos"
```

## Task 7: Implement confirm, retry, and atomic storyboard generation

**Files:**

- Create: `src/app/api/viral-replications/[id]/retry/route.ts`
- Create: `src/app/api/viral-replications/[id]/generate/route.ts`
- Create: `src/lib/viral-replication/persistence.ts`
- Create: `lib/prompts/viral-replication/storyboard_generation.zh.txt`
- Create: `lib/prompts/viral-replication/storyboard_generation.en.txt`
- Modify: `src/lib/prompt-i18n/prompt-ids.ts`
- Modify: `src/lib/prompt-i18n/catalog.ts`
- Modify: `tests/contracts/route-catalog.ts`
- Modify: `tests/contracts/route-behavior-matrix.ts`
- Replace stub: `src/lib/workers/handlers/viral-replication-generation.ts`
- Modify: `tests/integration/api/contract/viral-replication-routes.test.ts`
- Modify: `tests/integration/chain/viral-replication.chain.test.ts`
- Test: `tests/unit/viral-replication/persistence.test.ts`
- Test: `tests/unit/worker/viral-replication-generation.test.ts`

- [ ] **Step 1: Write failing retry/generate and persistence tests**

Verify:

- retry is allowed only from `failed`, reuses source media, clears error/report/frame rows, snapshots the current configured model, and submits a new full analysis task;
- generate is allowed only from `review_ready`, updates the final brief, sets `confirmedAt`, snapshots `generating`, and submits one generation task;
- repeated active submissions are rejected or deduped by a generation-specific dedupe key;
- persistence maps every panel field exactly and creates no media task;
- any panel insert failure rolls back the episode/clip/storyboard/panel transaction.

- [ ] **Step 2: Run focused tests and confirm RED**

```bash
npx vitest run tests/unit/viral-replication/persistence.test.ts tests/unit/worker/viral-replication-generation.test.ts
BILLING_TEST_BOOTSTRAP=1 npx vitest run tests/integration/api/contract/viral-replication-routes.test.ts
```

Expected: FAIL because routes, prompt, and persistence service do not exist.

- [ ] **Step 3: Implement the retry and generate routes**

Use conditional state transitions to prevent double clicks:

```ts
await prisma.viralReplication.updateMany({
  where: { id, userId, status: VIRAL_REPLICATION_STATUS.REVIEW_READY },
  data: { status: VIRAL_REPLICATION_STATUS.GENERATING, brief, confirmedAt: new Date(), errorMessage: null },
})
```

If task submission fails, transition back to `failed`. Both routes submit with `maxAttempts: 1`, `targetType: 'ViralReplication'`, and the record ID.

- [ ] **Step 4: Register the two new routes in coverage catalogs**

Add the retry and generate Route Handler paths to `tests/contracts/route-catalog.ts`. Both use category `'viral-replication'`, contract group `'viral-replication-routes'`, and the viral-replication chain test.

- [ ] **Step 5: Register and write the storyboard prompt**

Add `VIRAL_STORYBOARD_GENERATION` with variables `brief`, `video_ratio`, `art_style`, `analysis_report_json`, and `generation_schema_json`. Require an original story while preserving only abstract rhythm, composition, camera, and editing patterns. Require strict V1 JSON.

- [ ] **Step 6: Implement atomic persistence**

Within one `prisma.$transaction`:

1. update episode `name`, `description`, and `novelText`;
2. assert this new draft episode has no clips or storyboards; fail closed instead of deleting unrelated content;
3. create one `NovelPromotionClip` per generated storyboard with `summary`, `content`, `duration`, and `shotCount`;
4. create one `NovelPromotionStoryboard` per clip with `layoutMode: 'individual'`, `groupSequence`, `panelCount`, and a serialized V1 snapshot in `storyboardTextJson`;
5. create ordered `NovelPromotionPanel` rows mapping `durationSeconds`, `shotType`, `cameraMove`, `description`, `imagePrompt`, and `videoPrompt`;
6. update `NovelPromotionProject.lastEpisodeId`;
7. mark the replication `completed`.

Do not invoke `submitTask` inside this module.

- [ ] **Step 7: Implement the generation handler**

Load and validate `reportJson` using the report contract, call `runModelGatewayTextCompletion` with the snapshotted model, parse/validate the generation V1 contract, and pass the fully validated value to the persistence service. On any error set only the replication to `failed` and rethrow.

- [ ] **Step 8: Expand chain assertions**

After analysis, update the brief, submit generation, and assert:

- the model saw the latest brief;
- episode/clip/storyboard/panel rows are readable via the existing episode stage query;
- `imagePrompt` and `videoPrompt` are present;
- no Task rows with image/video/voice task types were created;
- induced insertion failure leaves zero storyboards and zero panels.

- [ ] **Step 9: Run focused and chain tests**

```bash
npx vitest run tests/unit/viral-replication/persistence.test.ts tests/unit/worker/viral-replication-generation.test.ts
BILLING_TEST_BOOTSTRAP=1 npx vitest run tests/integration/api/contract/viral-replication-routes.test.ts tests/integration/chain/viral-replication.chain.test.ts
npm run check:prompt-i18n
npm run typecheck
```

Expected: PASS; rollback test confirms no partial storyboard data.

- [ ] **Step 10: Commit generation flow**

```bash
git add src/app/api/viral-replications src/lib/viral-replication src/lib/workers/handlers lib/prompts/viral-replication src/lib/prompt-i18n tests
git commit -m "feat: generate viral replication storyboards"
```

## Task 8: Add the client data layer and exact SSE invalidation

**Files:**

- Modify: `src/lib/query/keys.ts`
- Create: `src/lib/query/hooks/useViralReplication.ts`
- Modify: `src/lib/query/hooks/index.ts`
- Create: `src/lib/viral-replication/client.ts`
- Modify: `src/lib/query/hooks/useSSE.ts`
- Test: `tests/unit/query/viral-replication-client.test.ts`
- Modify: `tests/unit/optimistic/sse-invalidation.test.ts`

- [ ] **Step 1: Write failing client and SSE tests**

Test that:

- `queryKeys.viralReplication.detail(id)` is stable;
- XHR sends the `File` body directly with `PUT` and reports upload percentage from `upload.onprogress`;
- aborting cancels XHR and rejects with an AbortError;
- a lifecycle event with `targetType === 'ViralReplication'` invalidates exactly `queryKeys.viralReplication.detail(targetId)`;
- it does not invalidate project data, episode stages, or global project lists for that event.

- [ ] **Step 2: Run tests and confirm RED**

```bash
npx vitest run tests/unit/query/viral-replication-client.test.ts tests/unit/optimistic/sse-invalidation.test.ts
```

Expected: FAIL because the query key and client do not exist.

- [ ] **Step 3: Implement the query/mutation hooks**

Add a typed detail query plus create-session, patch-brief, retry, and generate mutations using existing `apiFetch`/mutation helpers. Keep file upload in an XHR helper because browser `fetch` does not expose upload progress.

- [ ] **Step 4: Add exact SSE handling**

In `recoverByTarget`, handle `ViralReplication` before generic recovery:

```ts
if (targetType === 'ViralReplication' && targetId) {
  queryClient.invalidateQueries({
    queryKey: queryKeys.viralReplication.detail(targetId),
    exact: true,
  })
  return
}
```

Allow processing/progress events to refresh the detail as well, but debounce them to one invalidation per 250 ms. Completed and failed events invalidate immediately.

- [ ] **Step 5: Run focused tests**

```bash
npx vitest run tests/unit/query/viral-replication-client.test.ts tests/unit/optimistic/sse-invalidation.test.ts
npm run typecheck
```

Expected: PASS; assertions confirm no broad invalidation.

- [ ] **Step 6: Commit client data flow**

```bash
git add src/lib/query src/lib/viral-replication/client.ts tests/unit/query tests/unit/optimistic/sse-invalidation.test.ts
git commit -m "feat: add viral replication client state"
```

## Task 9: Add the homepage launcher and project re-entry behavior

**Files:**

- Create: `src/components/home/ViralReplicationLauncher.tsx`
- Create: `src/components/viral-replication/ViralReplicationUploadField.tsx`
- Modify: `src/app/[locale]/home/page.tsx`
- Modify: `src/app/[locale]/workspace/page.tsx`
- Modify: `src/app/api/projects/route.ts`
- Create: `src/lib/viral-replication/navigation.ts`
- Modify: `messages/zh/home.json`
- Modify: `messages/en/home.json`
- Test: `tests/unit/home/viral-replication-launcher.test.tsx`
- Test: `tests/unit/viral-replication/navigation.test.ts`
- Modify: `tests/integration/api/contract/crud-routes.test.ts`

- [ ] **Step 1: Write failing launcher and navigation tests**

Verify:

- the launcher is visible on authenticated home;
- MP4/MOV, 500 MB, and required-brief client checks block submission;
- the ratio and art-style defaults are passed to session creation;
- upload progress is rendered;
- successful upload navigates to `/${locale}/workspace/${projectId}/viral-replication/${replicationId}`;
- incomplete viral projects re-enter the analysis page;
- completed viral projects enter `/workspace/${projectId}`;
- ordinary projects are unchanged.

- [ ] **Step 2: Run tests and confirm RED**

```bash
npx vitest run tests/unit/home/viral-replication-launcher.test.tsx tests/unit/viral-replication/navigation.test.ts
```

Expected: FAIL because the components and navigation helper do not exist.

- [ ] **Step 3: Add project-list projection and target helper**

Extend `GET /api/projects` to select the project’s optional replication `{ id, status }`. Add:

```ts
export function getProjectOpenPath(project: ProjectListItem) {
  const replication = project.viralReplication
  if (replication && replication.status !== 'completed') {
    return `/workspace/${project.id}/viral-replication/${replication.id}`
  }
  return `/workspace/${project.id}`
}
```

Use it in both home recent-project cards and workspace project cards.

- [ ] **Step 4: Build the launcher**

The launcher contains a modal/panel with:

- `ViralReplicationUploadField` drag/drop and file picker;
- one-line brief input;
- existing home ratio/art-style selectors or the exact same option sources;
- format/size/duration copy;
- disabled/loading/progress states;
- one generic error with a retry action.

Its submit sequence is create session, XHR upload, then locale-aware navigation. Do not create projects through the existing text-project helper.

- [ ] **Step 5: Add Chinese and English copy**

Add all launcher labels, validation messages, progress labels, and the generic failure message to `messages/zh/home.json` and `messages/en/home.json`. Do not inline user-facing strings in the component.

- [ ] **Step 6: Run UI and route tests**

```bash
npx vitest run tests/unit/home/viral-replication-launcher.test.tsx tests/unit/viral-replication/navigation.test.ts
BILLING_TEST_BOOTSTRAP=1 npx vitest run tests/integration/api/contract/crud-routes.test.ts
npm run check:locale-navigation
npm run typecheck
```

Expected: PASS; ordinary project links remain unchanged.

- [ ] **Step 7: Commit homepage entry**

```bash
git add src/components src/app/'[locale]'/home src/app/'[locale]'/workspace src/app/api/projects src/lib/viral-replication/navigation.ts messages tests
git commit -m "feat: add viral replication homepage launcher"
```

## Task 10: Build the analysis review and generation page

**Files:**

- Create: `src/app/[locale]/workspace/[projectId]/viral-replication/[replicationId]/page.tsx`
- Create: `src/components/viral-replication/ViralReplicationPage.tsx`
- Create: `src/components/viral-replication/ViralReplicationProgress.tsx`
- Create: `src/components/viral-replication/ViralAnalysisReport.tsx`
- Create: `src/components/viral-replication/ViralBriefEditor.tsx`
- Create: `src/components/viral-replication/ViralGenerateAction.tsx`
- Create: `src/lib/viral-replication/view-state.ts`
- Create: `messages/zh/viralReplication.json`
- Create: `messages/en/viralReplication.json`
- Modify the existing next-intl message loader that imports namespace JSON files.
- Test: `tests/unit/viral-replication/view-state.test.ts`
- Test: `tests/unit/components/viral-replication-page.test.tsx`

- [ ] **Step 1: Write failing view-state and component tests**

Map all six DB statuses to a render state. Verify:

- `uploading` shows upload validation;
- `analyzing` shows the five-stage linear progress and subscribes to SSE;
- `review_ready` renders hook, appeal, pacing, emotional arc, style fingerprint, shot timeline, advice, brief editor, and generate action;
- `generating` disables edits and shows generation progress;
- `failed` shows one generic error and retry;
- `completed` navigates to the existing storyboard workspace exactly once;
- report data is never read before the V1 parser accepts it.

- [ ] **Step 2: Run tests and confirm RED**

```bash
npx vitest run tests/unit/viral-replication/view-state.test.ts tests/unit/components/viral-replication-page.test.tsx
```

Expected: FAIL because the page components do not exist.

- [ ] **Step 3: Implement the route shell and ownership-safe loading**

The server route renders a client page with route IDs only; the authenticated detail API remains the source of truth. The client checks that returned `projectId` matches the route `projectId` and renders not-found/error on mismatch.

- [ ] **Step 4: Implement state components**

Keep components presentation-focused:

- `ViralReplicationProgress` receives status/progress only;
- `ViralAnalysisReport` receives a parsed V1 report;
- `ViralBriefEditor` saves on explicit action and before generate;
- `ViralGenerateAction` calls generate once and relies on task state;
- `ViralReplicationPage` owns querying, SSE hookup, and navigation.

The report timeline must show timestamp range, shot type, angle, move, action, transition, subtitle summary, and narrative function. There is no report field editor in MVP.

- [ ] **Step 5: Register translations**

Load the new `viralReplication` namespace in the existing i18n request config and add complete zh/en keys. Include the line explaining that pure-audio speech may not be captured when no subtitle exists.

- [ ] **Step 6: Run component tests and static checks**

```bash
npx vitest run tests/unit/viral-replication/view-state.test.ts tests/unit/components/viral-replication-page.test.tsx
npm run check:locale-navigation
npm run lint:all -- src/components/viral-replication 'src/app/[locale]/workspace/[projectId]/viral-replication'
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit review UI**

```bash
git add src/app/'[locale]'/workspace/'[projectId]'/viral-replication src/components/viral-replication src/lib/viral-replication/view-state.ts messages tests/unit
git commit -m "feat: add viral replication review page"
```

## Task 11: Add runtime packaging, health exposure, and system acceptance

**Files:**

- Modify: `Dockerfile`
- Modify: `docker-compose.yml`
- Create: `src/lib/viral-replication/runtime-health.ts`
- Modify: `src/app/api/viral-replications/route.ts`
- Modify: `tests/contracts/requirements-matrix.ts`
- Create: `tests/system/viral-replication.system.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: Write the failing system test**

The system test runs the committed three-scene fixture through the actual FFmpeg/FFprobe boundary and deterministic model responses. It must assert the full acceptance sequence:

1. upload session is created with no project;
2. streamed upload creates a source MediaObject, project, episode 1, and analysis task;
3. analysis stores at least three frames and a V1 report;
4. brief update is used by generation;
5. generation creates editable panels with both prompt fields;
6. existing episode storyboard-stage API reads the rows;
7. no media-generation Task types exist;
8. refetch after completion returns the same report/result links.

- [ ] **Step 2: Run the system test and confirm RED**

```bash
SYSTEM_TEST_BOOTSTRAP=1 npx vitest run tests/system/viral-replication.system.test.ts
```

Expected: FAIL until runtime health and packaging changes are complete.

- [ ] **Step 3: Package FFmpeg and worker concurrency**

Change the runner install line to:

```dockerfile
RUN apk add --no-cache tini ffmpeg
```

Add `QUEUE_CONCURRENCY_VIRAL_REPLICATION: "2"` to the worker environment in `docker-compose.yml` and `QUEUE_CONCURRENCY_VIRAL_REPLICATION=2` to `.env.example`.

- [ ] **Step 4: Expose feature availability**

Implement a cached `getViralReplicationRuntimeHealth()` that runs `ffmpeg -version` and `ffprobe -version` once per process. Add `GET /api/viral-replications` returning `{ available: boolean }`; when unavailable, `POST /api/viral-replications` rejects before creating a session with the generic feature-unavailable API error. The homepage launcher queries this GET endpoint and disables entry instead of allowing a doomed upload.

- [ ] **Step 5: Add requirements coverage**

Add a P0 `REQ-VIRAL-VIDEO-REPLICATION` entry pointing to:

- `tests/integration/api/contract/viral-replication-routes.test.ts`;
- `tests/integration/chain/viral-replication.chain.test.ts`;
- `tests/system/viral-replication.system.test.ts`;
- `tests/unit/optimistic/sse-invalidation.test.ts`.

- [ ] **Step 6: Run system and requirements tests**

```bash
SYSTEM_TEST_BOOTSTRAP=1 npx vitest run tests/system/viral-replication.system.test.ts
npm run check:requirements-matrix
docker build -t waoowaoo:viral-replication-test .
docker run --rm --entrypoint ffmpeg waoowaoo:viral-replication-test -version
docker run --rm --entrypoint ffprobe waoowaoo:viral-replication-test -version
```

Expected: system test passes; both container commands print version information and exit 0.

- [ ] **Step 7: Commit runtime acceptance**

```bash
git add Dockerfile docker-compose.yml .env.example src/lib/viral-replication src/app/api/viral-replications tests/contracts/requirements-matrix.ts tests/system/viral-replication.system.test.ts
git commit -m "test: verify viral replication end to end"
```

## Task 12: Full regression verification and handoff

**Files:**

- Review all files changed since `511aa67`.
- Update only defects found by verification; do not broaden MVP scope.

- [ ] **Step 1: Inspect change scope and forbidden behavior**

```bash
git diff --stat 511aa67...HEAD
git diff --check 511aa67...HEAD
rg -n "TO""DO|TB""D|place""holder|viral.*(image_panel|video_panel|voice_line)|submitTask" src/lib/viral-replication src/app/api/viral-replications src/components/viral-replication
```

Expected: no whitespace errors, no unfinished markers, and task submission appears only in analysis/generation route services—not in persistence or UI. Inspect every `submitTask` match manually.

- [ ] **Step 2: Run focused feature suite**

```bash
npx vitest run tests/unit/viral-replication tests/unit/storage/streaming-object.test.ts tests/unit/task/viral-replication-queue.test.ts tests/unit/worker/viral-replication-worker.test.ts tests/unit/worker/viral-replication-analysis.test.ts tests/unit/worker/viral-replication-generation.test.ts tests/unit/query/viral-replication-client.test.ts tests/unit/components/viral-replication-page.test.tsx tests/unit/home/viral-replication-launcher.test.tsx tests/unit/optimistic/sse-invalidation.test.ts
BILLING_TEST_BOOTSTRAP=1 npx vitest run tests/integration/api/contract/viral-replication-routes.test.ts tests/integration/api/specific/viral-replication-upload.test.ts tests/integration/chain/viral-replication.chain.test.ts
SYSTEM_TEST_BOOTSTRAP=1 npx vitest run tests/system/viral-replication.system.test.ts
```

Expected: all feature tests pass.

- [ ] **Step 3: Run repository guards and full verification**

```bash
npm run check:test-coverage-guards
npm run check:requirements-matrix
npm run verify:push
```

Expected: lint, typecheck, all tests, guards, and production build pass.

- [ ] **Step 4: Verify schema and task invariants directly**

Use the system-test database or a disposable local database and verify:

```sql
SELECT status, report_version, project_id, episode_id
FROM viral_replications
ORDER BY created_at DESC
LIMIT 1;

SELECT type, max_attempts
FROM tasks
WHERE target_type = 'ViralReplication'
ORDER BY created_at;
```

Expected: completed record has project/episode/report version 1; only `viral_video_analysis` and `viral_storyboard_generation` exist and both have `max_attempts = 1`.

- [ ] **Step 5: Confirm no automatic media generation**

For the test project, query tasks and assert zero rows for `image_panel`, `video_panel`, `voice_line`, `storyboard_sheet_generate`, and all ComfyUI generation types. Open the generated episode in the existing storyboard stage and confirm text/prompt editing works without generated URLs.

- [ ] **Step 6: Commit verification fixes if any**

If verification required code changes:

```bash
git add -A
git commit -m "fix: close viral replication verification gaps"
```

If no fixes were needed, do not create an empty commit.

- [ ] **Step 7: Prepare branch handoff**

```bash
git status --short
git log --oneline 511aa67..HEAD
```

Expected: clean working tree and a readable sequence of focused commits ready for review, push, or PR creation.

## Definition-of-done checklist

- [ ] One MP4/MOV between 15 seconds and 3 minutes and no larger than 500 MB can be streamed without a full-file Buffer.
- [ ] A failed or incomplete upload creates no project; a validated upload creates exactly one project and episode 1.
- [ ] FFmpeg/FFprobe extracts real metadata, at least one first-frame shot, fallback shots, subtitles when present, and at most 72 keyframes.
- [ ] All model calls use the snapshotted configured analysis model and never auto-switch providers/models.
- [ ] The user reviews a validated V1 report before generation.
- [ ] The latest brief is used to create an original story while retaining only abstract structural/style patterns.
- [ ] Storyboard persistence is atomic and maps to existing `NovelPromotionStoryboard`/`NovelPromotionPanel` fields.
- [ ] No image, video, voice, or render task is submitted.
- [ ] Retry is whole-task only and both new task types have one attempt.
- [ ] SSE invalidates only the replication detail for replication events.
- [ ] Incomplete viral projects reopen the review page; completed projects enter the existing workspace.
- [ ] FFmpeg and FFprobe are present in the production image and missing binaries disable the entry.
- [ ] Focused tests, coverage guards, requirements matrix, `verify:push`, and production build all pass.
