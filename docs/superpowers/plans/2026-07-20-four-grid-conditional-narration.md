# Four-grid Conditional Narration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate plot-aware narration recommendations for dialogue-free four-grid cells before cropping, while letting users keep automatic behavior or manually force narration on/off without losing text or audio.

**Architecture:** Store narration configuration on `NovelPromotionPanel` as the source of truth and project enabled narration into stable `NovelPromotionVoiceLine` rows for the existing voice pipeline. Extend the full-sheet vision result and crop transaction so prompt, duration, and narration metadata commit atomically; expose one panel-scoped mutation for manual overrides and make every voice consumer fail closed on `enabled: false`.

**Tech Stack:** Next.js route handlers, React, TanStack Query, Prisma/MySQL/SQLite, BullMQ workers, Zod, existing AI vision runtime, Vitest regression specifications.

---

## File structure

- `prisma/schema.prisma`, `prisma/schema.sqlit.prisma`, and a new migration: persistent panel narration state and derived voice-line metadata.
- `src/lib/novel-promotion/narration/state.ts`: pure mode validation and effective-state rules.
- `src/lib/novel-promotion/narration/sync.ts`: transactional panel-to-voice-line projection and dialogue-index collision protection.
- `src/lib/novel-promotion/grid-storyboard/sheet-analysis.ts`: four-grid AI narration contract and prompt.
- `src/lib/workers/handlers/storyboard-crop-task-handler.ts`: atomic crop, analysis, panel narration merge, and voice-line sync.
- `src/app/api/novel-promotion/[projectId]/panels/[panelId]/narration/route.ts`: ownership-checked manual narration mutation.
- `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/PanelNarrationControl.tsx`: three-state control and text/emotion editor.
- Existing stage serializers, project types, and storyboard components: deliver narration state to the card and refresh it after mutations.
- Existing voice routes/runtime/cards: return and operate on enabled lines only, label narration, and keep narration edits synchronized with the panel.

## Standing verification constraint

The user explicitly requested no test, TypeScript, build, or provider-integration execution. Tasks below add focused regression specifications before implementation, but do not run them. Verification is limited to source inspection, `git diff --check`, Prisma schema comparison, JSON parsing, and staged-diff review.

### Task 1: Add backward-compatible narration persistence

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `prisma/schema.sqlit.prisma`
- Create: `prisma/migrations/20260720120000_add_panel_narration/migration.sql`
- Modify: `src/types/project.ts`
- Modify: `src/lib/novel-promotion/episode-stage-data.ts`
- Modify: `src/app/api/novel-promotion/[projectId]/episodes/[episodeId]/stage/[stage]/route.ts`

- [ ] **Step 1: Add the panel and voice-line fields to both Prisma schemas**

Add the same fields to `NovelPromotionPanel` in both schema files:

```prisma
  narrationMode        String   @default("auto")
  narrationRecommended Boolean  @default(false)
  narrationSuggestedText String? @db.Text
  narrationSuggestedEmotion String?
  narrationText        String?  @db.Text
  narrationEmotion     String?
```

Add these fields to `NovelPromotionVoiceLine`:

```prisma
  lineType String  @default("dialogue")
  enabled  Boolean @default(true)
  sourceKey String? @unique
```

For the SQLite schema, omit provider-specific native annotations if that schema does not accept them, matching the existing `content`/text-field convention there.

- [ ] **Step 2: Create the MySQL migration**

Use backward-compatible defaults and a nullable unique key:

```sql
ALTER TABLE `novel_promotion_panels`
  ADD COLUMN `narrationMode` VARCHAR(191) NOT NULL DEFAULT 'auto',
  ADD COLUMN `narrationRecommended` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `narrationSuggestedText` TEXT NULL,
  ADD COLUMN `narrationSuggestedEmotion` VARCHAR(191) NULL,
  ADD COLUMN `narrationText` TEXT NULL,
  ADD COLUMN `narrationEmotion` VARCHAR(191) NULL;

ALTER TABLE `novel_promotion_voice_lines`
  ADD COLUMN `lineType` VARCHAR(191) NOT NULL DEFAULT 'dialogue',
  ADD COLUMN `enabled` BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN `sourceKey` VARCHAR(191) NULL;

CREATE UNIQUE INDEX `novel_promotion_voice_lines_sourceKey_key`
  ON `novel_promotion_voice_lines`(`sourceKey`);
```

- [ ] **Step 3: Extend shared panel types and storyboard-stage selects**

Add this reusable type and fields to `src/types/project.ts`:

```ts
export type PanelNarrationMode = 'auto' | 'on' | 'off'

export interface NovelPromotionPanel {
  // existing fields
  narrationMode?: PanelNarrationMode
  narrationRecommended?: boolean
  narrationSuggestedText?: string | null
  narrationSuggestedEmotion?: string | null
  narrationText?: string | null
  narrationEmotion?: string | null
}
```

Add all six narration field names to `StoryboardPanelFields` and `storyboardPanelSelect`. This ensures the storyboard page can resolve the latest AI suggestion separately from a preserved manual override.

- [ ] **Step 4: Review schema parity without generating clients**

Compare both model blocks and migration column names directly. Do not run Prisma generation or validation.

- [ ] **Step 5: Commit the persistence contract**

```bash
git add prisma/schema.prisma prisma/schema.sqlit.prisma \
  prisma/migrations/20260720120000_add_panel_narration/migration.sql \
  src/types/project.ts src/lib/novel-promotion/episode-stage-data.ts \
  'src/app/api/novel-promotion/[projectId]/episodes/[episodeId]/stage/[stage]/route.ts'
git commit --no-verify -m "feat: add conditional narration persistence"
```

### Task 2: Implement pure narration rules and stable voice-line projection

**Files:**
- Create: `src/lib/novel-promotion/narration/state.ts`
- Create: `src/lib/novel-promotion/narration/sync.ts`
- Test: `tests/unit/novel-promotion/narration-state.test.ts`
- Test: `tests/unit/novel-promotion/narration-sync.test.ts`
- Modify: `src/lib/novel-promotion/six-grid/persistence-voice.ts`
- Modify: `src/lib/workers/handlers/voice-analyze.ts`

- [ ] **Step 1: Author rule specifications without executing them**

Cover these exact cases in `narration-state.test.ts`:

```ts
expect(resolveNarrationEnabled({ mode: 'auto', recommended: true })).toBe(true)
expect(resolveNarrationEnabled({ mode: 'auto', recommended: false })).toBe(false)
expect(resolveNarrationEnabled({ mode: 'on', recommended: false })).toBe(true)
expect(resolveNarrationEnabled({ mode: 'off', recommended: true })).toBe(false)
expect(() => parseNarrationMode('invalid')).toThrow('PANEL_NARRATION_MODE_INVALID')
expect(() => validateManualNarration({ mode: 'on', text: '  ' }))
  .toThrow('PANEL_NARRATION_TEXT_REQUIRED')
```

Cover projection behavior in `narration-sync.test.ts`: stable `sourceKey`, create only with usable text, `auto` refresh, manual `on/off` preservation, disabled audio preservation, and relocation of a narration row only when an incoming dialogue index collides.

- [ ] **Step 2: Implement the pure state contract**

Create `state.ts` with these exports:

```ts
export const PANEL_NARRATION_MODES = ['auto', 'on', 'off'] as const
export type PanelNarrationMode = (typeof PANEL_NARRATION_MODES)[number]

export function parseNarrationMode(value: unknown): PanelNarrationMode {
  if (typeof value !== 'string' || !PANEL_NARRATION_MODES.includes(value as PanelNarrationMode)) {
    throw new Error('PANEL_NARRATION_MODE_INVALID')
  }
  return value as PanelNarrationMode
}

export function resolveNarrationEnabled(input: {
  mode: PanelNarrationMode
  recommended: boolean
}) {
  if (input.mode === 'on') return true
  if (input.mode === 'off') return false
  return input.recommended
}

export function validateManualNarration(input: {
  mode: PanelNarrationMode
  text: string | null
}) {
  if (input.mode === 'on' && !input.text?.trim()) {
    throw new Error('PANEL_NARRATION_TEXT_REQUIRED')
  }
}

export function resolveNarrationContent(input: {
  mode: PanelNarrationMode
  suggestedText: string | null
  suggestedEmotion: string | null
  manualText: string | null
  manualEmotion: string | null
}) {
  return input.mode === 'auto'
    ? { text: input.suggestedText, emotion: input.suggestedEmotion }
    : { text: input.manualText, emotion: input.manualEmotion }
}
```

- [ ] **Step 3: Implement one transactional projection boundary**

Create `sync.ts` with:

```ts
export const narrationSourceKey = (panelId: string) => `panel-narration:${panelId}`

export declare function syncPanelNarrationVoiceLine(input: {
  tx: Prisma.TransactionClient
  episodeId: string
  panelId: string
  storyboardId: string
  panelIndex: number
  locale: 'zh' | 'en'
  mode: PanelNarrationMode
  recommended: boolean
  suggestedText: string | null
  suggestedEmotion: string | null
  text: string | null
  emotion: string | null
}): Promise<{ id: string } | null>

export declare function relocateNarrationIndexConflicts(input: {
  tx: Prisma.TransactionClient
  episodeId: string
  incomingDialogueIndexes: number[]
}): Promise<void>
```

The upsert must not write `voicePresetId`, `audioUrl`, `audioMediaId`, or `audioDuration` in its update branch. It sets `speaker` to `旁白` for `zh` and `Narrator` for `en`, `lineType: 'narration'`, `matchedPanelId`, `matchedStoryboardId`, `matchedPanelIndex`, `emotionPrompt`, and effective `enabled`.

Resolve effective text/emotion from mode plus suggested/manual fields before writing. If no row exists and effective text is empty, return without creating one. If a row exists and the effective state is disabled, update `enabled` only and preserve all media fields.

- [ ] **Step 4: Prevent dialogue reanalysis from deleting narration**

Before dialogue upserts in both `persistGridVoiceLines` and the transaction in `voice-analyze.ts`, call `relocateNarrationIndexConflicts` with the incoming dialogue indexes. Mark created/updated generated lines with `lineType: 'dialogue'`, `enabled: true`, and change cleanup to:

```ts
await tx.novelPromotionVoiceLine.deleteMany({
  where: {
    episodeId,
    lineType: 'dialogue',
    ...(lineIndexes.length > 0 ? { lineIndex: { notIn: lineIndexes } } : {}),
  },
})
```

This preserves narration records and audio while keeping the existing dialogue identity behavior.

- [ ] **Step 5: Commit the narration domain boundary**

```bash
git add src/lib/novel-promotion/narration \
  src/lib/novel-promotion/six-grid/persistence-voice.ts \
  src/lib/workers/handlers/voice-analyze.ts \
  tests/unit/novel-promotion/narration-state.test.ts \
  tests/unit/novel-promotion/narration-sync.test.ts
git commit --no-verify -m "feat: synchronize panel narration voice lines"
```

### Task 3: Extend four-grid visual analysis with conditional narration

**Files:**
- Modify: `src/lib/novel-promotion/grid-storyboard/sheet-analysis.ts`
- Modify: `tests/unit/novel-promotion/four-grid-sheet-analysis.test.ts`

- [ ] **Step 1: Add unexecuted parsing and prompt regression cases**

Add cases asserting:

```ts
expect(rows[0]).toMatchObject({
  narration_recommended: true,
  narration_text: '三年后，他终于回到故乡。',
  narration_emotion: '克制而怀念',
})
expect(rows[1]).toMatchObject({
  narration_recommended: false,
  narration_text: null,
  narration_emotion: null,
})
```

Also assert rejection when a dialogue panel recommends narration, when recommendation is true with blank text, or when recommendation is false with non-null text.

- [ ] **Step 2: Extend the strict Zod row contract**

Add:

```ts
narration_recommended: z.boolean(),
narration_text: z.string().trim().min(1).max(MAX_PROMPT_LENGTH).nullable(),
narration_emotion: z.string().trim().min(1).max(200).nullable(),
```

After Zod parsing, validate each sorted row against the corresponding planned panel:

```ts
const hasDialogue = Boolean(plannedPanel.dialogueText?.trim())
if (hasDialogue && row.narration_recommended) invalid()
if (row.narration_recommended !== Boolean(row.narration_text)) invalid()
if (!row.narration_recommended && row.narration_emotion !== null) invalid()
```

Pass planned panels into the parser so eligibility checks cannot rely on model claims.

- [ ] **Step 3: Update the AI instruction and response shape**

Add explicit instructions that narration is permitted only for dialogue-free panels, must communicate non-visible plot information, must not describe visible action, and must be included in duration allocation. Update the JSON example to contain the three narration keys for every row.

- [ ] **Step 4: Commit the AI contract**

```bash
git add src/lib/novel-promotion/grid-storyboard/sheet-analysis.ts \
  tests/unit/novel-promotion/four-grid-sheet-analysis.test.ts
git commit --no-verify -m "feat: analyze four-grid narration needs"
```

### Task 4: Merge narration atomically before four-grid crop persistence

**Files:**
- Modify: `src/lib/workers/handlers/storyboard-crop-task-handler.ts`
- Modify: `tests/unit/worker/storyboard-sheet-task-handler.test.ts`
- Modify: `tests/system/four-grid-storyboard.system.test.ts`

- [ ] **Step 1: Specify atomic merge behavior without running tests**

Extend crop transaction fixtures with all six panel narration fields. Assert:

- `auto` panels receive all current AI fields and the matching enabled/disabled voice-line projection.
- `on/off` panels refresh recommendation only and preserve manual text/emotion.
- dialogue panels cannot persist a positive narration recommendation.
- any panel or voice-line write failure rejects the transaction without committing crop metadata.
- six-grid crop behavior does not invoke narration synchronization.

- [ ] **Step 2: Load the existing narration mode with each current panel**

Extend `CurrentCropPanel` and the transaction `findMany` selection:

```ts
type CurrentCropPanel = {
  id: string
  gridCellIndex: number | null
  imageMediaId: string | null
  imageUrl: string | null
  narrationMode: string
  narrationRecommended: boolean
  narrationSuggestedText: string | null
  narrationSuggestedEmotion: string | null
  narrationText: string | null
  narrationEmotion: string | null
  storyboard: { episodeId: string }
}
```

The transaction boundary must also expose the voice-line methods used by `syncPanelNarrationVoiceLine` rather than opening a nested transaction.

- [ ] **Step 3: Apply the explicit merge rule inside the crop transaction**

For a four-grid analysis row, always persist the latest suggestion while leaving manual overrides untouched:

```ts
const mode = parseNarrationMode(previous.narrationMode)
const suggestion = {
  narrationRecommended: analysis.narration_recommended,
  narrationSuggestedText: analysis.narration_text,
  narrationSuggestedEmotion: analysis.narration_emotion,
}
const effective = resolveNarrationContent({
  mode,
  suggestedText: analysis.narration_text,
  suggestedEmotion: analysis.narration_emotion,
  manualText: previous.narrationText,
  manualEmotion: previous.narrationEmotion,
})
```

Write recommendation and suggestion fields on every reanalysis; never overwrite manual fields. After updating the panel, call `syncPanelNarrationVoiceLine` with the same transaction, `snapshot.locale`, storyboard/episode identifiers, suggestion fields, manual fields, and the effective mode.

- [ ] **Step 4: Keep the pre-crop failure boundary**

Retain the current call order: load full sheet, analyze all four cells, validate all rows, crop, then run one database transaction. No narration row may be created before all crop artifacts exist and the storyboard lock succeeds.

- [ ] **Step 5: Commit crop integration**

```bash
git add src/lib/workers/handlers/storyboard-crop-task-handler.ts \
  tests/unit/worker/storyboard-sheet-task-handler.test.ts \
  tests/system/four-grid-storyboard.system.test.ts
git commit --no-verify -m "feat: persist four-grid narration with crops"
```

### Task 5: Add the owned panel narration mutation

**Files:**
- Create: `src/app/api/novel-promotion/[projectId]/panels/[panelId]/narration/route.ts`
- Test: `tests/integration/api/contract/panel-narration.route.test.ts`
- Modify: `src/app/api/novel-promotion/[projectId]/voice-lines/route.ts`

- [ ] **Step 1: Author API contract specifications without running them**

Cover project/panel ownership, rejection on dialogue panels, invalid mode, `on` with blank text, atomic projection, `off` preserving audio, and narration edits through the voice-line PATCH route updating the canonical panel fields.

- [ ] **Step 2: Implement the panel-scoped PATCH route**

Accept only:

```ts
type NarrationPatchBody = {
  mode: 'auto' | 'on' | 'off'
  text?: string | null
  emotion?: string | null
  locale?: 'zh' | 'en'
  expectedPanelUpdatedAt: string
}
```

The route must:

1. Run `requireProjectAuthLight(projectId)`.
2. Load `panelId` through `storyboard.episode.novelPromotionProject.projectId`.
3. Reject `hasDialogue === true` with `INVALID_PARAMS` and detail code `PANEL_NARRATION_DIALOGUE_UNSUPPORTED`.
4. Parse mode and trim optional text/emotion.
5. Treat editing text/emotion as `mode: 'on'`.
6. When leaving `auto`, initialize omitted manual text/emotion from the current suggestion; validate non-empty effective text for `on`.
7. Use `expectedPanelUpdatedAt` for optimistic concurrency and return `CONFLICT` with code `PANEL_NARRATION_STALE` on mismatch.
8. Update the panel and call `syncPanelNarrationVoiceLine` in one transaction.
9. Return all six narration fields plus `updatedAt`.

- [ ] **Step 3: Keep voice-stage narration edits canonical**

In the existing voice-line PATCH route, load `lineType`, `sourceKey`, and `matchedPanelId` before building update data. For `lineType === 'narration'`, reject speaker/panel reassignment, mirror content and emotion changes to `NovelPromotionPanel.narrationText/narrationEmotion`, force `narrationMode: 'on'`, and retain the same voice-line id/media. Keep voice preset and audio clearing behavior unchanged.

- [ ] **Step 4: Commit the mutation contract**

```bash
git add 'src/app/api/novel-promotion/[projectId]/panels/[panelId]/narration/route.ts' \
  'src/app/api/novel-promotion/[projectId]/voice-lines/route.ts' \
  tests/integration/api/contract/panel-narration.route.test.ts
git commit --no-verify -m "feat: edit panel narration overrides"
```

### Task 6: Add the three-state storyboard control

**Files:**
- Create: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/PanelNarrationControl.tsx`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/PanelCard.tsx`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/StoryboardPanelList.tsx`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/StoryboardGroup.tsx`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/hooks/useStoryboardState.ts`
- Modify: `messages/zh/storyboard.json`
- Modify: `messages/en/storyboard.json`
- Test: `tests/unit/components/four-grid-narration-control.test.tsx`

- [ ] **Step 1: Author component behavior specifications without executing them**

Specify that dialogue panels render no control; `auto` displays the AI recommendation; `on` requires text; editing AI text switches to `on`; `off` preserves the local text; a stale response shows a localized conflict message; and a successful response invalidates the storyboard-stage and voice-line queries.

- [ ] **Step 2: Project narration fields into `StoryboardPanel`**

Extend `StoryboardPanel` and `getTextPanels` with:

```ts
narrationMode: (p.narrationMode ?? 'auto') as PanelNarrationMode,
narrationRecommended: p.narrationRecommended ?? false,
narrationSuggestedText: p.narrationSuggestedText ?? null,
narrationSuggestedEmotion: p.narrationSuggestedEmotion ?? null,
narrationText: p.narrationText ?? null,
narrationEmotion: p.narrationEmotion ?? null,
updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : p.updatedAt?.toISOString(),
```

- [ ] **Step 3: Implement the focused control**

`PanelNarrationControl` receives `projectId`, `episodeId`, and the panel narration fields. It owns draft text/emotion, calls the new PATCH route through `apiFetch`, disables inputs while saving, and invalidates:

```ts
queryKeys.episodeStage(projectId, episodeId, 'storyboard')
queryKeys.episodeData(projectId, episodeId)
queryKeys.voiceLines.all(episodeId)
queryKeys.voiceLines.matched(projectId, episodeId)
```

Render one compact segmented selector for automatic/on/off, an AI recommendation badge, and text/emotion inputs only when auto recommends narration or mode is on. Do not render it for `hasDialogue` panels.

- [ ] **Step 4: Wire identifiers through existing storyboard components**

Pass `projectId` and `episodeId` from `StoryboardGroup` to `StoryboardPanelList`, then `PanelCard`. Mount `PanelNarrationControl` directly below `DialoguePanelBadge` and above `PanelEditForm`, so narration is visible on the same cropped-panel card rather than in a separate modal.

- [ ] **Step 5: Add Chinese and English strings**

Add keys under `storyboard.sixGrid.panel.narration` for title, AI recommended/not recommended, auto/on/off labels, text, emotion, saving, required text, stale update, and generic save failure. Parse both JSON files after editing.

- [ ] **Step 6: Commit the storyboard UI**

```bash
git add 'src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard' \
  messages/zh/storyboard.json messages/en/storyboard.json \
  tests/unit/components/four-grid-narration-control.test.tsx
git commit --no-verify -m "feat: control narration from storyboard panels"
```

### Task 7: Exclude disabled narration and label enabled narration in the voice pipeline

**Files:**
- Modify: `src/app/api/novel-promotion/[projectId]/voice-lines/route.ts`
- Modify: `src/app/api/novel-promotion/[projectId]/voice-generate/route.ts`
- Modify: `src/app/api/novel-promotion/[projectId]/download-voices/route.ts`
- Modify: `src/app/api/novel-promotion/[projectId]/episodes/[episodeId]/stage/[stage]/route.ts`
- Modify: `src/lib/novel-promotion/stages/voice-stage-runtime/types.ts`
- Modify: `src/lib/novel-promotion/stages/voice-stage-runtime/useVoiceGenerationActions.ts`
- Modify: `src/lib/novel-promotion/stages/voice-stage-runtime/useVoiceTaskState.ts`
- Modify: `src/lib/novel-promotion/stages/video-stage-runtime/task-targets.ts`
- Modify: `src/lib/novel-promotion/stages/video-stage-runtime/useVideoVoiceLines.ts`
- Modify: `src/lib/query/hooks/useVoiceLines.ts`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/voice/VoiceLineCard.tsx`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/voice-stage/VoiceLineList.tsx`
- Modify: `messages/zh/voice.json`
- Modify: `messages/en/voice.json`
- Test: `tests/unit/novel-promotion/voice-line-filtering.test.ts`
- Test: `tests/unit/components/voice-line-narration-badge.test.tsx`

- [ ] **Step 1: Author disabled-line consumer specifications without running them**

Cover list/count queries, single and bulk generation, downloads, task targets, video-stage panel voice mapping, config readiness, and UI delete behavior. Every disabled row must be absent or rejected even if it still has an audio URL.

- [ ] **Step 2: Filter at server boundaries**

Add `enabled: true` to normal voice-line GET, speaker statistics, bulk/single voice generation lookups, downloadable lines, and config `voiceCount`. A direct request for a disabled line must return `INVALID_PARAMS` with detail code `VOICE_LINE_DISABLED` rather than enqueueing work.

- [ ] **Step 3: Carry metadata through client contracts**

Extend every voice-line type returned to the voice/video stage with:

```ts
lineType: 'dialogue' | 'narration'
enabled: boolean
```

Defensively filter `enabled !== false` in `buildVoiceLineTargets`, `useVoiceTaskState`, `useVoiceGenerationActions`, and `useVideoVoiceLines` so stale client caches cannot submit or attach disabled audio.

- [ ] **Step 4: Label narration and protect its identity**

Show a localized narration badge in `VoiceLineCard` when `lineType === 'narration'`. Keep edit, emotion, voice binding, generation, regeneration, playback, download, and locate-panel actions. Hide the delete-line action and disable speaker/panel reassignment for narration; users turn it off from the storyboard panel instead. Clearing only its generated audio remains allowed.

- [ ] **Step 5: Commit voice-pipeline integration**

```bash
git add 'src/app/api/novel-promotion/[projectId]/voice-lines/route.ts' \
  'src/app/api/novel-promotion/[projectId]/voice-generate/route.ts' \
  'src/app/api/novel-promotion/[projectId]/download-voices/route.ts' \
  'src/app/api/novel-promotion/[projectId]/episodes/[episodeId]/stage/[stage]/route.ts' \
  src/lib/novel-promotion/stages/voice-stage-runtime \
  src/lib/novel-promotion/stages/video-stage-runtime/task-targets.ts \
  src/lib/novel-promotion/stages/video-stage-runtime/useVideoVoiceLines.ts \
  src/lib/query/hooks/useVoiceLines.ts \
  'src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/voice/VoiceLineCard.tsx' \
  'src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/voice-stage/VoiceLineList.tsx' \
  messages/zh/voice.json messages/en/voice.json \
  tests/unit/novel-promotion/voice-line-filtering.test.ts \
  tests/unit/components/voice-line-narration-badge.test.tsx
git commit --no-verify -m "feat: integrate narration with voice pipeline"
```

### Task 8: Static verification and local integration

**Files:**
- Review all files from Tasks 1-7.
- Preserve: `package-lock.json` as the user's unrelated local change.

- [ ] **Step 1: Scan for unfinished implementation markers**

```bash
rg -n "TBD|TODO|FIXME|PANEL_NARRATION" \
  src/lib/novel-promotion/narration \
  src/lib/novel-promotion/grid-storyboard/sheet-analysis.ts \
  'src/app/api/novel-promotion/[projectId]/panels/[panelId]/narration/route.ts'
```

Expected: only intentional error-code and constant references; no placeholders.

- [ ] **Step 2: Run whitespace verification**

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 3: Parse locale JSON only**

```bash
node -e "JSON.parse(require('fs').readFileSync('messages/zh/storyboard.json','utf8')); JSON.parse(require('fs').readFileSync('messages/en/storyboard.json','utf8')); JSON.parse(require('fs').readFileSync('messages/zh/voice.json','utf8')); JSON.parse(require('fs').readFileSync('messages/en/voice.json','utf8'))"
```

Expected: exit code 0 and no output.

- [ ] **Step 4: Compare Prisma model fields statically**

```bash
rg -n "narrationMode|narrationRecommended|narrationSuggestedText|narrationSuggestedEmotion|narrationText|narrationEmotion|lineType|enabled|sourceKey" \
  prisma/schema.prisma prisma/schema.sqlit.prisma \
  prisma/migrations/20260720120000_add_panel_narration/migration.sql
```

Expected: both schemas contain matching logical fields and the migration contains each physical column/index.

- [ ] **Step 5: Review the complete change scope**

```bash
git status --short
git diff --stat HEAD~7..HEAD
git diff --name-only HEAD~7..HEAD
```

Expected: narration implementation, specifications, schemas, migration, and locale files only; `package-lock.json` remains modified but uncommitted.

- [ ] **Step 6: Do not run automated validation**

Do not run Vitest, Jest, TypeScript, Prisma generation/validation, Next.js build, or provider calls. Report this explicitly in the handoff.

- [ ] **Step 7: Integrate locally and stop before remote push**

If implementation was performed in an isolated worktree, fast-forward local `main`, remove the worktree and temporary branch after verifying their commits are reachable, and leave `duanju/main` untouched until the user explicitly requests a GitHub push.
