# Four-grid and six-grid storyboard design

## Goal

Support `2×2` four-grid and `3×2` six-grid storyboard generation with one image-generation call per group. New projects default to four-grid for broad API-model compatibility; existing projects keep their stored mode and behavior.

The two modes share one planning, persistence, generation, upload, crop, preview, and downstream panel pipeline. Four-grid is not implemented as a second copy of the six-grid feature.

## Product behavior

The project storyboard mode has three values:

- `individual`: existing one-panel-at-a-time behavior;
- `four_grid`: four panels in a `2×2` sheet;
- `six_grid`: six panels in a `3×2` sheet.

For new projects, `storyboardGenerationMode` defaults to `four_grid`. Existing database rows are not rewritten: existing `six_grid` projects remain six-grid, and existing `individual` projects remain individual.

The cell aspect ratio remains `16:9` or `9:16` and normally follows the project video ratio. Sheet ratios are derived rather than independently selected:

| Mode | Columns × rows | Panel count | 16:9 cell sheet | 9:16 cell sheet |
|---|---:|---:|---:|---:|
| Four-grid | 2×2 | 4 | 16:9 | 9:16 |
| Six-grid | 3×2 | 6 | 8:3 | 27:32 |

Four-grid therefore uses common model-native ratios while still generating all four panels in one call. Six-grid remains available when the selected image model explicitly supports its uncommon sheet ratio.

## Canonical grid contract

Add one application-level `StoryboardGridSpec` resolver:

```ts
type GridStoryboardMode = 'four_grid' | 'six_grid'

type StoryboardGridSpec = {
  mode: GridStoryboardMode
  columns: 2 | 3
  rows: 2
  panelCount: 4 | 6
  cellAspectRatio: '16:9' | '9:16'
  sheetAspectRatio: '16:9' | '9:16' | '8:3' | '27:32'
}
```

All grid-aware code obtains panel count, valid indexes, sheet ratio, crop geometry, prompt wording, and UI labels from this resolver. No new production path may hard-code six, indexes `0..5`, or `3×2` layout classes.

The current database columns `sixGridCellAspectRatio` and `sixGridProcessingOrder` remain as compatibility storage for both grid modes. Renaming those columns would add migration risk without changing behavior. Application types expose neutral grid names at new module boundaries while adapters read and write the legacy column names.

Existing six-grid task snapshots remain parseable. New snapshots include a versioned `gridSpec` value so a queued task cannot change layout if project settings are edited later.

## Storyboard planning

Planning is group-first, not “generate an arbitrary panel list and chunk it afterward.” The episode plan chooses grid groups, then the existing multi-phase group planner receives the exact `panelCount` from `StoryboardGridSpec`:

1. establish the group's continuous scene and covered script range;
2. produce exactly four or six numbered shots;
3. add cinematography rules;
4. add acting and continuity directions;
5. finalize detailed image prompts.

Validation accepts numbering `1..panelCount`, checks exact count, ordering, clip coverage, scene boundaries, and continuity with the same generic functions for both modes.

The planner must not create blank cells or duplicate a panel to fill the sheet. When a group is sparse, it adds a distinct reaction, environment, insert, or action-detail shot grounded in the script. When a group is too dense, it combines genuinely redundant beats or creates another group rather than dropping important content. Every persisted grid group contains exactly the mode's panel count.

Generic internal validation errors carry `{ mode, expectedPanelCount, actualPanelCount }`. Existing six-grid public error codes remain aliases so old clients and diagnostics do not break; four-grid exposes equivalent four-grid codes and localized messages.

## Model capability behavior

Before submitting a sheet-generation task, the API derives `sheetAspectRatio` from the immutable grid spec and validates it against the selected model:

- four-grid requests `16:9` or `9:16`;
- six-grid requests `8:3` or `27:32`;
- ComfyUI workflows with dynamic width and height continue to advertise derived ratios;
- unsupported ratios are rejected before billing and queue submission.

The page may display compatibility guidance, but the API remains authoritative. Selecting six-grid is allowed so users can configure a compatible model later. If generation is attempted with an incompatible model, the page shows a direct message recommending four-grid instead of the generic `Invalid parameters` error.

No compatibility path generates panels separately: each grid group always uses exactly one image-generation call.

## Persistence and backward compatibility

`layoutMode` accepts `four_grid` and `six_grid`. A storyboard record stores the mode, group sequence, cell ratio, processing order, sheet media, prompt/model/options snapshots, and the exact panel rows belonging to the group.

Existing six-grid records are read through the grid-spec adapter and retain:

- their `3×2` layout;
- six panels and indexes `0..5`;
- existing generated/uploaded sheet media;
- crop rectangles, lineage, task deduplication, undo, upscale, and video frame linking.

New four-grid records use four panels and indexes `0..3`. Individual records and their downstream behavior are unchanged.

The schema migration only changes the default for newly inserted project rows and permits the new mode string. Because the mode columns are plain strings, no destructive enum rewrite is required. Creation routes and fixtures that explicitly set `individual` remain explicit and are not silently changed.

## Image generation, upload, and crop

Sheet generation uses the same prompt/reference/model snapshot flow for both modes. The prompt builder describes the derived layout and requires exactly the grid spec's panel count and numbering.

Upload validation derives the expected sheet ratio from `StoryboardGridSpec`:

- four-grid uploads accept `16:9` or `9:16` within the existing tolerance;
- six-grid uploads keep `8:3` or `27:32` validation;
- byte, pixel, dimension, MIME, ownership, replacement, and stale-write protections remain unchanged.

Automatic crop rectangles are computed from `columns`, `rows`, and row-major `cellIndex`. Manual crop requires exactly `panelCount` unique rectangles with indexes `0..panelCount-1`. Atomic persistence, claims, undo, sheet upscale, panel upscale, and lineage use the same generic implementation.

The crop pipeline continues producing ordinary panel media. Video generation, prompt editing, panel replacement, and single-panel upscaling remain unaware of whether a panel originated from four-grid or six-grid, except for ordering metadata used by frame linking.

## Page behavior

The configuration stage shows three storyboard modes with concise descriptions:

- Individual;
- Four-grid (recommended, broadly compatible);
- Six-grid (requires special sheet-ratio support).

The selected mode and derived cell/sheet ratio appear in the settings summary. Grid settings are locked while planning or generation is active, matching current locking behavior.

Storyboard group cards reuse one generic grid control surface:

- button label: `Generate 2×2 four-grid` or `Generate 3×2 six-grid`;
- upload, view prompt, sheet upscale, crop, panel upscale, undo, and replacement actions remain in the same locations;
- the sheet image stays inline on the group card;
- compatibility errors include a clear switch-to-four-grid recommendation.

The crop modal renders overlay columns and rows from the grid spec. It shows four or six crop tabs, preserves the current source-selection and manual-adjustment behavior, and validates only the expected number of cells. The preview aspect ratio comes from `sheetAspectRatio`, not a six-grid conditional.

The final cropped storyboard panels continue to render in the existing panel list. The page does not introduce a separate four-grid results area.

## API and naming transition

New shared modules use neutral `grid-storyboard` naming. Existing `/storyboard-sheet` API routes stay in place to avoid a client migration; their payloads become grid-aware.

Existing `SixGrid*` React components and hooks are renamed only where the rename prevents duplicated logic. Compatibility exports may remain temporarily for tests and imports, but there is one implementation behind them.

Stored prompt, model, options, media ownership, and signed URL behavior from the existing six-grid implementation must remain intact.

## Error handling

Failures are surfaced at the earliest reliable layer:

- planning returns exact-count, numbering, continuity, or scene-boundary diagnostics with the selected mode;
- unsupported sheet ratio fails before billing/queue submission;
- invalid upload reports the expected layout and ratio;
- crop validation reports expected panel count and valid index range;
- stale source, ownership, task cancellation, and atomic persistence failures retain their current semantics.

A failed four-grid operation never mutates a six-grid group and vice versa. Task dedupe keys include the immutable grid spec so retries cannot reconcile against a different mode.

## Testing and acceptance

Tests are table-driven across four-grid and six-grid wherever behavior is shared. Required coverage includes:

1. grid-spec derivation for both cell ratios and modes;
2. new-project default and preservation of existing project modes;
3. planning exactly four or six unique, correctly numbered panels;
4. model capability acceptance for common four-grid ratios and rejection of unsupported six-grid ratios;
5. one provider invocation per generated grid group;
6. task snapshot immutability and mode-aware dedupe;
7. upload ratio validation for all four sheet ratios;
8. automatic and manual crop geometry for `2×2` and `3×2`;
9. atomic crop persistence, replacement, undo, upscale, and media ownership;
10. configuration selector, dynamic labels, inline preview, prompt modal, upload modal, and crop tabs;
11. existing six-grid system acceptance unchanged;
12. end-to-end four-grid planning → sheet generation → crop → panel media acceptance.

Before integration, run focused planner/API/worker/component/system suites, TypeScript, targeted ESLint, Prisma schema validation, migration checks, and diff checks. Merge only after the existing six-grid acceptance path and the new four-grid path both pass.

## Out of scope

- generating four or six panels with separate model calls;
- arbitrary user-defined rows, columns, or panel counts;
- changing the individual storyboard mode;
- rewriting already persisted projects to four-grid;
- renaming legacy database columns solely for terminology;
- changing video-generation behavior after panel images exist.
