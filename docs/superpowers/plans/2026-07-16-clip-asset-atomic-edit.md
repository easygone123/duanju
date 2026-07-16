# Clip Asset Atomic Edit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make character, location, and prop edits in a specific clip persist from one final-state calculation and one PATCH instead of stale sequential remove/add requests.

**Architecture:** Pure helpers will reduce a clip plus the user's final pending selection into one serialized field value while preserving unmatched legacy entries. The script runtime will submit that field once and update local selection state only after success; the editor remains open with a safe error on failure. All-clips behavior remains on the existing action path.

**Tech Stack:** React, TypeScript, TanStack Query, Next.js App Router, next-intl.

**Owner verification override:** Do not add or run automated tests. Verify with a one-off reproduction script, TypeScript, affected-file ESLint, locale parity, and `git diff --check`.

---

### Task 1: Add final-state clip asset reducers

**Files:**
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/script-view/asset-state-utils.ts`

- [ ] **Step 1: Define the atomic selection input**

Export the discriminated union used by the panel and runtime:

```ts
export type ClipAssetSelectionCommit =
  | { type: 'character'; items: Array<{ characterId: string; appearanceName: string }> }
  | { type: 'location'; items: Array<{ locationId: string; label: string }> }
  | { type: 'prop'; propIds: string[] }
```

- [ ] **Step 2: Build a complete character field from one clip snapshot**

Add `buildCharacterSelectionValue` that parses legacy comma or JSON character data, preserves entries that do not match any project character, removes all managed character entries, then appends the deduplicated desired character/appearance objects using canonical character names. Return one JSON string.

```ts
export function buildCharacterSelectionValue(input: {
  clip: ClipLike
  items: Array<{ characterId: string; appearanceName: string }>
  characters: Character[]
}): string
```

- [ ] **Step 3: Build complete location and prop fields**

Add `buildLocationSelectionValue` and `buildPropSelectionValue`. Each helper preserves unmatched legacy names, replaces managed asset entries with the desired pending set, trims labels, deduplicates output, and returns the existing storage format (`location` comma string, `props` JSON or `null`).

```ts
export function buildLocationSelectionValue(input: {
  clip: ClipLike
  items: Array<{ locationId: string; label: string }>
  locations: Location[]
  fuzzyMatchLocation: (left: string, right: string) => boolean
}): string

export function buildPropSelectionValue(input: {
  clip: ClipLike
  propIds: string[]
  props: Prop[]
}): string | null
```

- [ ] **Step 4: Run the one-off reducer reproduction**

Use `npx tsx -e` to assert that renaming `小明/日常` to `小明/战斗` produces only `战斗`, renaming `客厅` to `夜晚客厅` produces the new label, and two selected assets both remain in the final serialized value. Expected: the script prints `atomic clip asset reducers: OK` and exits 0.

- [ ] **Step 5: Commit the reducers**

```bash
git add 'src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/script-view/asset-state-utils.ts'
HUSKY=0 git commit -m "fix: compute final clip asset state"
```

### Task 2: Add a one-PATCH runtime commit path

**Files:**
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/script-view/ScriptViewRuntime.tsx`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/script-view/ScriptViewAssetsPanel.tsx`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/hooks/useWorkspaceVideoActions.ts`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/hooks/useWorkspaceStageRuntime.ts`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/WorkspaceStageRuntimeContext.tsx`
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/hooks/workspace-controller-view-model.ts`

- [ ] **Step 1: Return an explicit clip-save result**

Change the stage runtime clip update contract to `Promise<boolean>`. `handleUpdateClip` returns `true` only after `updateProjectClipMutation.mutateAsync` succeeds; missing episode or caught mutation errors return `false` after the existing log/alert behavior.

```ts
onClipUpdate: (clipId: string, data: unknown) => Promise<boolean>
```

- [ ] **Step 2: Add the atomic panel callback**

Add this prop to `ScriptViewAssetsPanel` and pass it from `ScriptViewRuntime`:

```ts
onCommitClipAssetSelection: (commit: ClipAssetSelectionCommit) => Promise<boolean>
```

- [ ] **Step 3: Resolve and save one final field in the runtime**

In `ScriptViewRuntime`, reject the atomic callback when `assetViewMode === 'all'` or the selected clip is missing. For a character/location/prop commit, call the matching Task 1 helper and then call `onClipUpdate(targetClip.id, { characters | location | props: finalValue })` exactly once. Update `activeCharIds`, `selectedAppearanceKeys`, `activeLocationIds`, or `activePropIds` only when it returns `true`.

- [ ] **Step 4: Keep the all-clips path unchanged**

Do not route all-clips actions or card-level removal through the new callback. Their existing selection/removal behavior remains outside this bug fix.

- [ ] **Step 5: Run focused static checks and commit**

Run affected-file ESLint, `npm run typecheck`, and `git diff --check`. Expected: exit 0 with no new lint errors.

```bash
git add 'src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/script-view/ScriptViewRuntime.tsx' \
  'src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/script-view/ScriptViewAssetsPanel.tsx' \
  'src/app/[locale]/workspace/[projectId]/modes/novel-promotion/hooks/useWorkspaceVideoActions.ts' \
  'src/app/[locale]/workspace/[projectId]/modes/novel-promotion/hooks/useWorkspaceStageRuntime.ts' \
  'src/app/[locale]/workspace/[projectId]/modes/novel-promotion/WorkspaceStageRuntimeContext.tsx' \
  'src/app/[locale]/workspace/[projectId]/modes/novel-promotion/hooks/workspace-controller-view-model.ts'
HUSKY=0 git commit -m "fix: save clip asset edits atomically"
```

### Task 3: Switch single-clip confirmation to the atomic path

**Files:**
- Modify: `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/script-view/ScriptViewAssetsPanel.tsx`
- Modify: `messages/zh/scriptView.json`
- Modify: `messages/en/scriptView.json`

- [ ] **Step 1: Submit final pending selections once**

In each confirm handler, when `assetViewMode !== 'all'`, create one `ClipAssetSelectionCommit` from the complete pending set and await `onCommitClipAssetSelection`. Do not call the old remove/add loops in single-clip mode.

- [ ] **Step 2: Keep the editor open on failure**

Add `selectionSaveError` state. Clear it when opening or retrying, close the popover only when the callback returns `true`, and render a `role="alert"` message next to the action buttons when it returns `false`.

- [ ] **Step 3: Add matching localized messages**

Add `asset.selectionSaveFailed` to both locale files:

```json
"selectionSaveFailed": "保存出场角色或场景失败，请重试"
```

```json
"selectionSaveFailed": "Failed to save clip characters or locations. Please try again."
```

- [ ] **Step 4: Verify locale parity and commit**

Run recursive English/Chinese key parity for `scriptView`, affected-file ESLint, `npm run typecheck`, and `git diff --check`. Expected: all exit 0.

```bash
git add 'src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/script-view/ScriptViewAssetsPanel.tsx' \
  messages/zh/scriptView.json messages/en/scriptView.json
HUSKY=0 git commit -m "fix: keep failed clip asset edits open"
```

### Task 4: Final verification and delivery

**Files:**
- Review: all files changed since `bdc81de`

- [ ] **Step 1: Re-run the original stale-snapshot reproduction**

Run the pre-fix sequential helper reproduction and the new atomic reducer reproduction. Confirm the old sequence still demonstrates stale behavior while the new reducers produce only the final requested values.

- [ ] **Step 2: Run the owner-approved verification suite**

Run `npm run typecheck`, ESLint on every changed TS/TSX file, scriptView locale parity, focused source assertions that single-clip confirm uses `onCommitClipAssetSelection`, and `git diff --check`. Do not run automated tests.

- [ ] **Step 3: Review and push**

Review `git diff --stat bdc81de..HEAD`, ensure the worktree is clean, request final code review, then push `feat/comfyui-guided-workflow-creation` to `duanju` and verify local/remote SHA equality so draft PR #1 updates.
