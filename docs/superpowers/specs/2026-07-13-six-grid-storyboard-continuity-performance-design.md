# Six-Grid Storyboard Continuity and Workspace Performance Design

- Date: 2026-07-13
- Status: Approved design, pending implementation plan
- Target branch: `feat/comfyui-integration`

## 1. Summary

Add an optional six-grid storyboard mode without replacing the existing
individual-shot workflow. In six-grid mode, screenplay analysis groups a
single continuous scene into exactly six ordered shots, generates one 3-by-2
storyboard sheet, deterministically crops the sheet into the existing six
panel cards, and optionally upscales either the full sheet before cropping or
each cropped panel afterward.

The same change improves downstream video cards with dialogue-aware prompts
and model routing, automatically estimated editable durations, and reliable
first/last-frame linking. Workspace navigation is also redesigned to load only
the active stage, preserve visited-stage state, avoid whole-project refetches,
and virtualize long panel lists.

## 2. Goals

1. Preserve visual and narrative continuity across adjacent storyboard shots.
2. Add a selectable six-grid mode while keeping the current individual-shot
   mode fully compatible.
3. Generate exactly one borderless 3-by-2 image for each six-shot group.
4. Automatically crop the sheet into six existing panel cards and allow
   precise manual recropping.
5. Support both full-sheet-upscale-before-crop and crop-before-panel-upscale.
6. Route dialogue shots to an optional dialogue video model and include
   dialogue performance direction only in video prompts.
7. Estimate video duration during screenplay analysis, allow per-panel edits,
   and resolve estimates against selected model capabilities.
8. Make first/last-frame video generation follow the continuous shot sequence,
   including links between six-grid groups.
9. Make stage navigation and long storyboard/video views respond immediately
   from cached state instead of reloading the whole project.

## 3. Non-Goals

- Do not replace or migrate existing individual-shot projects automatically.
- Do not create a second storyboard or video page layout.
- Do not add built-in ComfyUI workflow templates.
- Do not use an image model to crop; cropping is deterministic server-side
  pixel processing.
- Do not put literal dialogue, subtitles, numbers, watermarks, or logos into
  storyboard image prompts.
- Do not silently coerce unsupported image ratios, video durations, or
  first/last-frame modes.

## 4. User-Visible Configuration

Before screenplay-to-storyboard analysis starts, the user chooses a storyboard
generation mode:

- `individual`: the existing variable-shot workflow.
- `six_grid`: the new continuous six-shot workflow.

Six-grid settings are stored as a run snapshot so later project-setting
changes cannot reinterpret existing outputs:

- Cell aspect ratio: inherit project video ratio, `16:9`, or `9:16`.
- Processing order: `sheet_upscale_then_crop` or
  `crop_then_panel_upscale`.
- Storyboard image model: inherit the existing project storyboard model.
- Storyboard upscale model: optional model/workflow with `upscale` capability.
- Normal video model: the existing project video model.
- Dialogue video model: optional; falls back to the normal video model.

Old projects and existing runs remain `individual`. New projects may choose
either mode explicitly before analysis.

## 5. Six-Grid Geometry

The generated sheet always contains three columns and two rows, read left to
right and then top to bottom. Cells have no gaps, borders, gutters, labels, or
padding.

- A `16:9` cell produces an overall sheet ratio of `8:3`.
- A `9:16` cell produces an overall sheet ratio of `27:32`.

Crop rectangles use normalized coordinates in the canonical source image.
Server-side crop geometry assigns integer pixel boundaries cumulatively so
odd source dimensions contain no overlapping or missing pixels. Manual crop
adjustments remain constrained to the selected cell's safe region and locked
to the configured cell aspect ratio.

The system must preserve these artifacts independently:

1. Original generated sheet.
2. Upscaled sheet, when full-sheet upscale is used.
3. Cropped panel source.
4. Upscaled panel result, when per-panel upscale is used.
5. Current selected panel image.
6. Crop rectangle, processing order, model snapshot, and artifact lineage.

## 6. Screenplay Analysis and Continuity Planning

Six-grid analysis begins with a scene-boundary pass over the whole episode,
not independent analysis of each existing clip. A hard scene boundary is a
change in location, time, major lighting condition, or explicit screenplay
scene heading. A six-grid group never crosses a hard boundary.

Each scene is converted into one or more six-shot groups:

- A short scene is expanded to six meaningful shots using establishing,
  reaction, detail, insert, and transition shots. It must not be padded with
  duplicate content.
- A long scene is split into consecutive six-shot groups.
- The next group inherits the prior group's final continuity state.

Every group records a continuity anchor containing:

- Scene identity, location, time, weather, lighting, palette, and atmosphere.
- Character identity, face, hair, age presentation, costume, position,
  direction, and current emotional state.
- Prop identity, owner, position, and state changes.
- The incoming state from the previous group and outgoing state after shot 6.

Every panel records:

- Ordered narrative beat and source-text range.
- Shot type, composition, camera position/movement, and acting direction.
- Character, costume, prop, location, lighting, and emotional constraints.
- Dialogue metadata, if present.
- Target video duration in seconds.
- Image prompt and video prompt components.

The planner contract requires exactly six panels numbered 1 through 6. It
rejects cross-scene groups, invalid asset references, missing continuity
anchors, duplicate panel numbers, and non-positive durations. A failed group
retries independently and never overwrites successful groups.

## 7. Storyboard-Sheet Prompt Contract

The sheet prompt combines the shared continuity anchor with six ordered panel
descriptions. It explicitly requires:

- One coherent, continuous story across all six cells.
- A strict 3-by-2 layout, read left-to-right and top-to-bottom.
- Consistent characters, faces, costumes, props, location, lighting, palette,
  and emotional progression.
- Complete composition inside every cell.
- No unrelated images.
- No numbers, text, captions, subtitles, speech bubbles, watermarks, logos,
  white borders, black borders, or gutters.

Literal dialogue is excluded from the image prompt. Dialogue is represented
only by visual acting state, facial expression, body language, and mouth
movement so the image model is not encouraged to render text.

If the selected workflow accepts reference images, the previous group's sixth
final panel is preferred as a visual reference. The textual continuity anchor
is always present and remains authoritative when references are unsupported.

## 8. Model Capability Rules

The existing storyboard image model generates the sheet. Before submission,
the capability gate verifies that the model/workflow accepts the required
sheet width and height. Unsupported providers are blocked with an actionable
diagnostic; the system does not substitute another ratio.

ComfyUI upscale workflows are user-created workflows tagged with the `upscale`
capability and a valid image-input/image-output contract. No built-in upscale
workflow is shipped. The model picker only lists compatible workflows.

For `sheet_upscale_then_crop`, the full source sheet is submitted once to the
selected upscale workflow and all six crops are derived from its output. For
`crop_then_panel_upscale`, deterministic crops are produced first and each
panel can be upscaled independently. The project supplies a default processing
order; each group can override it.

## 9. Persistence Model

The existing `NovelPromotionClip -> NovelPromotionStoryboard ->
NovelPromotionPanel` relationship remains the downstream contract. In
six-grid mode, one storyboard represents one six-shot group and always owns six
panels.

Project configuration adds persisted defaults for:

- Storyboard generation mode.
- Six-grid cell ratio.
- Six-grid processing order.
- Storyboard upscale model key.
- Dialogue video model key.

Storyboard persistence adds explicit fields for:

- Layout mode and group sequence index.
- Continuity-anchor JSON and prompt version.
- Original sheet media reference.
- Upscaled sheet media reference.
- Cell ratio and processing-order snapshot.
- Image/upscale workflow snapshot and processing state.

Panel persistence adds explicit fields for:

- Grid cell index 0 through 5.
- Normalized crop rectangle.
- Cropped source media reference.
- Upscaled panel media reference.
- Current image derivation and reversible image history.
- Dialogue flag, speaker, text, emotion, and prompt-inclusion preference.
- Estimated duration and optional user duration override.
- Automatic/manual first/last-frame source metadata.

Media values use `MediaObject` relations rather than introducing new legacy
URL-only storage. APIs expose signed media views but never storage credentials.

## 10. Background Tasks and Recovery

The pipeline uses independently idempotent task steps:

1. `storyboard_sheet_generate`
2. `storyboard_sheet_upscale`
3. `storyboard_sheet_crop`
4. `storyboard_panel_upscale`

Each task snapshots its source media ID, model key, workflow version, crop
geometry, processing order, and target artifact version. A retry with the same
idempotency key reattaches to or returns the existing result. A new source,
crop rectangle, or workflow version creates a new artifact version.

Generation failure leaves six text panels visible but does not mark their
images complete. Crop failure is group-scoped and retryable. Panel-upscale
failure affects only that panel. Original inputs and all successful sibling
artifacts remain available. Worker restarts reconcile task and media state
before submitting new external work.

## 11. Storyboard Page Interaction

The page keeps the current group and card layout.

The group header adds:

- Generate/regenerate six-grid sheet.
- Preview source sheet.
- Processing-order selector.
- `Upscale full sheet and crop`, `Crop source sheet`, and `Reprocess` actions.
- Current source, workflow, processing state, and partial-failure diagnostic.

Each panel card displays the current crop and adds:

- Recrop.
- Upscale.
- View source.
- Undo to the prior derivation.
- Image lineage/status.

The recrop dialog can choose the original sheet or upscaled sheet, adjust a
ratio-locked crop inside the cell's safe region, and optionally upscale the
new crop immediately. Clicking the card image continues to use the existing
large preview.

Dialogue panels use a distinct accessible border/background treatment and a
non-color dialogue indicator. They show speaker, dialogue summary, emotion,
and estimated duration.

## 12. Dialogue-Aware Video Generation

Dialogue never enters the image prompt. Its video-prompt fragment contains:

- Speaker identity.
- Literal dialogue.
- Emotion and intensity.
- Acting, mouth-movement, and timing direction.

The panel card provides an explicit include/exclude dialogue-prompt control.
Dialogue panels use the configured dialogue video model. If it is absent, they
fall back to the normal project video model. Model keys are snapshotted at task
submission.

## 13. Duration Estimation and Editing

The screenplay planner estimates a target duration for every panel:

- Non-dialogue shots generally use 3 to 6 seconds based on action complexity,
  camera movement, and transition needs.
- Dialogue shots use estimated spoken duration plus acting and reaction
  margin.

The estimated value is stored separately from a user override. Video cards
show the effective value and allow edits. On model selection or submission,
the capability resolver:

1. Uses the exact effective duration when supported.
2. Otherwise chooses the nearest supported duration not shorter than the
   target.
3. If no supported value is long enough, blocks submission and asks the user
   to shorten the shot, split it, or select another model.

The UI never silently shortens a shot.

## 14. First/Last-Frame Video Cards

On the finished-video page:

- The first frame defaults to the current panel's final selected image.
- The last frame defaults to the next panel's final selected image.
- Cell 6 links to cell 1 of the next continuous group.
- The final shot has no automatic last frame.
- Users can replace, clear, or unlink either automatic choice.
- The UI shows whether each frame source is automatic or manual.

Only models declaring first/last-frame capability can submit the mode.
Switching to an incompatible model preserves the user's stored frame choices
but does not send them; the card shows a blocking capability diagnostic.

## 15. Workspace Performance Architecture

### 15.1 Stage Loading

Workspace stages become dynamically imported boundaries. Only the active
stage's code and data load on first entry. A visited-stage cache preserves
lightweight UI state so returning to a stage renders cached content
immediately instead of remounting the entire stage tree.

### 15.2 Stage-Specific Data

The oversized episode payload is replaced by stage-specific contracts for
configuration, screenplay, storyboard, video, and voice data. Queries use
precise Prisma `select`, stable cursor pagination, and media summaries. Image
history and original-resolution assets load only on demand.

### 15.3 Shared Subscriptions

User model catalogs and project assets are subscribed once at the workspace
boundary. Cards consume a stable shared snapshot instead of creating hundreds
of model and asset query observers.

### 15.4 Targeted Task Updates

SSE events patch the exact storyboard, panel, voice line, or video card. They
do not automatically refetch project data, project assets, episode data,
storyboards, and voice lines together. Full refresh remains an explicit
recovery action.

### 15.5 Long Lists and Media

Storyboard and video lists virtualize expensive card bodies around the visible
viewport. Offscreen cards do not mount model dropdowns, task observers, crop
dialogs, or original-resolution images. Thumbnails use responsive sizes and
lazy loading; original media loads only for crop or preview actions.

### 15.6 Instrumentation and Targets

Development instrumentation records stage-switch latency, request duration,
payload bytes, mounted card count, and invalidation/refetch count.

- A previously visited stage should show cached content within 300 ms on the
  reference development machine.
- Stage switching must not refetch the whole project.
- First entry requests only active-stage data.
- Long lists initially mount only the visible range plus a small overscan.
- Background task completion must not blank or visibly reload the page.
- Build chunk sizes and key endpoint payload sizes receive before/after
  evidence in the implementation report.

## 16. API Boundaries

APIs are owner- and project-scoped and use existing `apiHandler` and task
submission patterns. Required operations include:

- Start screenplay-to-storyboard with an immutable mode/settings snapshot.
- Generate/regenerate a storyboard sheet.
- Start full-sheet upscale.
- Crop or recrop all/single cells.
- Start single-panel upscale.
- Select or undo an image derivation.
- Update dialogue-prompt inclusion and duration override.
- Update automatic/manual first/last-frame links.

Responses return task IDs and stable artifact metadata. Large media bytes do
not pass through JSON payloads.

## 17. Validation and Error Handling

- Six-grid runs require `16:9` or `9:16` cell ratio after inheritance.
- A group must contain exactly six ordered panels from one scene.
- Sheet media must have valid dimensions before cropping.
- Crop rectangles must be in bounds, non-overlapping in automatic mode, and
  match the configured aspect ratio.
- Upscale submission requires a compatible published workflow.
- Dialogue-model fallback is explicit in diagnostics and task snapshots.
- Duration and first/last-frame options are validated against the selected
  video model before billing freeze or queue submission.
- Cross-project media IDs, panel IDs, and storyboard IDs return not found.

## 18. Testing Strategy

### Unit

- Scene boundary classification and fixed six-shot grouping.
- Short-scene expansion and long-scene continuation anchors.
- Prompt construction and exclusion of literal dialogue/text instructions.
- Exact crop geometry for landscape, portrait, odd dimensions, and upscaled
  sources.
- Duration estimation and model-capability resolution.
- Dialogue-model fallback and prompt inclusion.
- First/last-frame sequence resolution across group boundaries.
- Cache patch reducers and viewport-range calculations.

### Integration

- Schema persistence and ownership for settings, sheet artifacts, crop
  lineage, dialogue, duration, and frame links.
- Idempotent task submission and restart recovery.
- ComfyUI image and upscale workflow contracts.
- Stage-specific APIs and targeted cache invalidation contracts.

### System

- Screenplay analysis to a valid six-shot group.
- Sheet generation through a fake ComfyUI server.
- Automatic six-cell crop.
- Full-sheet-upscale-before-crop.
- Crop-before-panel-upscale.
- Manual recrop and undo.
- Dialogue video model, prompt, duration, and first/last-frame submission.
- Partial failure and retry without duplicate external work.
- Existing individual-shot workflow regression.

### Performance

- Automated request-count and payload-budget checks.
- Mounted-card budget for long lists.
- Stage code-splitting assertion.
- Browser timing trace for cold entry and cached stage switching.

## 19. Acceptance Criteria

1. Users choose individual or six-grid mode before storyboard analysis.
2. Six-grid groups contain exactly six shots from one continuous scene.
3. A single 3-by-2 source image generates with no text, labels, borders, or
   unrelated cells.
4. The source automatically crops into six existing panel cards in reading
   order.
5. Users can recrop, preview, undo, upscale the full sheet before crop, or
   upscale a crop afterward.
6. Both `16:9` and `9:16` cell ratios preserve exact crop geometry.
7. Dialogue panels are visibly and accessibly distinct; dialogue is excluded
   from image prompts and optionally included in video prompts.
8. Dialogue panels use the dialogue video model or an explicit normal-model
   fallback.
9. Every panel receives an editable estimated duration that is validated
   against model capabilities.
10. First/last-frame defaults follow the continuous panel sequence across
    six-grid group boundaries and remain manually editable.
11. Existing individual-shot projects behave unchanged.
12. Cached stage switching meets the 300 ms target, avoids whole-project
    refetches, and long lists mount only a bounded visible range.
13. Unit, integration, system, regression, typecheck, lint, guard, and
    production-build verification pass.

## 20. Rollout

The feature is additive and initially opt-in. Database migration adds nullable
artifact/metadata fields and project defaults without rewriting existing
rows. Existing records resolve to `individual`. Six-grid UI appears only when
the run snapshot declares `six_grid`.

Performance API changes ship behind compatible query hooks so each stage can
move to the new endpoint independently. Instrumentation compares the old and
new request/payload behavior before removal of the monolithic fallback.
