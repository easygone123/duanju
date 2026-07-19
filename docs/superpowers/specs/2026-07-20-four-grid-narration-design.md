# Four-grid Conditional Narration Design

## Goal

Extend the four-grid sheet-analysis flow so every dialogue-free cell can receive a plot-aware narration recommendation before the sheet is cropped. The recommendation must remain editable: users can keep the AI decision, force narration on and enter text, or force narration off without losing generated text or audio.

This work builds on the existing four-grid analysis that assigns grounded prompts and durations before cropping. Six-grid planning and dialogue extraction remain unchanged.

## Product behavior

### Eligible panels

- Only panels with no dialogue are narration candidates.
- A panel with dialogue always receives `narrationRecommended: false` and does not expose the manual narration switch in this iteration.
- The model recommends narration only when the plot needs information that the image and action cannot communicate clearly, such as a time or location transition, inner thought, off-screen background, or necessary causal context.
- Narration must not merely restate visible action.

### User control

Each eligible cropped panel exposes one narration control with three modes:

- `auto`: follow the latest AI recommendation.
- `on`: always include narration. The user must provide non-empty narration text.
- `off`: never include narration.

The panel also exposes editable narration text and emotion. In `auto`, these fields contain the latest AI result. Selecting `on` or editing either field changes the mode to `on`, so later sheet analysis cannot overwrite the user's text or emotion. Selecting `off` preserves the text, voice selection, and any generated audio; it only excludes the narration from generation and playback.

The effective enabled state is:

| Mode | Effective state |
| --- | --- |
| `auto` | `narrationRecommended` |
| `on` | enabled |
| `off` | disabled |

## Analysis contract

The existing full-sheet vision request remains the single analysis step before cropping. Each of the four validated rows adds:

- `narration_recommended`: boolean
- `narration_text`: string or `null`
- `narration_emotion`: string or `null`

The prompt receives the authoritative plot plan, dialogue metadata, and complete 2x2 sheet. It must:

1. Keep rows in reading order: top-left, top-right, bottom-left, bottom-right.
2. Reject narration for rows that already contain dialogue.
3. Recommend narration only when it adds story information rather than visual description.
4. Include narration speaking time when choosing that row's `duration`.
5. Return non-empty narration text when recommendation is `true`, and `null` text when recommendation is `false`.

Validation fails the complete analysis when any row is missing, duplicated, contradicts the dialogue eligibility rule, or recommends narration without text. As with the current four-grid implementation, analysis failure occurs before crop persistence, so no partial panel update is committed.

## Data model

### Panel source of truth

`NovelPromotionPanel` gains:

- `narrationMode`: string enum value `auto | on | off`, default `auto`.
- `narrationRecommended`: boolean, default `false`.
- `narrationText`: nullable text.
- `narrationEmotion`: nullable string.

These fields are the authoritative narration configuration. MySQL and SQLite Prisma schemas receive equivalent fields and a migration supplies backward-compatible defaults.

### Voice-line projection

The existing voice generation and playback pipeline continues to operate on `NovelPromotionVoiceLine`. It gains:

- `lineType`: `dialogue | narration`, default `dialogue` for existing rows.
- `enabled`: boolean, default `true` for existing rows.
- `sourceKey`: nullable unique string used only for system-derived rows.

A panel narration uses `sourceKey = panel-narration:<panelId>`. This provides a stable upsert identity without restricting the existing ability to associate multiple dialogue lines with one panel.

The panel fields remain canonical. A small narration synchronizer projects the effective state into the matching voice line in the same database transaction:

- Create the narration line only when usable narration text exists.
- Update content and emotion from AI only while the panel remains in `auto` mode.
- Preserve manual content and emotion in `on` or `off` mode.
- Set `enabled` from the effective-state table.
- Preserve existing voice preset and generated audio when disabling a line.
- Use speaker `旁白` for Chinese projects and `Narrator` for English projects.
- Allocate a new episode `lineIndex` only on first creation; stable upserts retain the existing index.

## Persistence and reanalysis

For each four-grid cell, the crop transaction writes the crop media, grounded prompts, duration, AI recommendation, narration text, and narration emotion together.

The merge rule is explicit:

- New or `auto` panel: refresh `narrationRecommended`, `narrationText`, and `narrationEmotion` from analysis, then synchronize the voice line.
- Manual `on` panel: refresh only `narrationRecommended`; preserve manual text/emotion and keep the voice line enabled.
- Manual `off` panel: refresh only `narrationRecommended`; preserve manual text/emotion/audio and keep the voice line disabled.

This makes retry and reanalysis idempotent and prevents AI output from undoing user decisions.

## API and UI

### Storyboard panel editing

The cropped-panel card shows the narration control only when `hasDialogue` is false. It displays:

- AI recommendation status.
- `auto / on / off` selector.
- Editable narration text and emotion when narration is recommended or forced on.

Changing mode or content calls one panel-scoped narration endpoint. The endpoint verifies project and panel ownership, validates the mode, rejects `on` with empty text, updates panel fields, and synchronizes the derived voice line atomically.

### Voice stage

Enabled narration lines appear alongside dialogue lines with a visible narration badge and use the existing voice-preset, emotion, generation, regeneration, and playback controls. Editing a narration line routes through the same narration update service so the panel remains the source of truth.

Disabled narration lines are hidden from normal generation queues and completion counts. The storyboard panel still retains and exposes their saved content so the user can turn them back on. Bulk voice generation, download, video-stage voice attachment, and final playback/mix all ignore `enabled: false` rows.

## Error handling

- Invalid AI narration output fails with the existing four-grid sheet-analysis error before cropping.
- Manual `on` with blank text returns `INVALID_PARAMS` with a narration-specific detail code.
- A projection failure rolls back both the panel edit and voice-line update.
- Concurrent first creation of a narration line is resolved by the unique `sourceKey`; the losing request reloads and updates the same row.
- Turning narration off never deletes audio or media ownership records.

## Scope boundaries

Included:

- Four-grid full-sheet narration recommendation before crop.
- Per-panel automatic/manual/off behavior.
- Narration voice-line generation and exclusion behavior throughout the existing voice pipeline.
- Preservation of manual choices across reanalysis.

Excluded:

- Changing six-grid planning behavior.
- Adding narration to panels that contain dialogue.
- Multiple narration lines for one panel.
- Automatic shortening or extending of duration after a user manually rewrites narration; the pre-crop AI analysis remains responsible for initial duration allocation.
- Rebuilding the final audio mixer beyond ensuring disabled lines are excluded from existing consumers.

## Verification strategy

Regression specifications should cover:

- Analysis parsing for recommended and non-recommended narration.
- Rejection of narration on dialogue panels and recommendation without text.
- Duration and narration metadata written before crop commit.
- `auto`, `on`, and `off` effective states.
- Stable voice-line upsert by `sourceKey`.
- Reanalysis preserving manual text, emotion, audio, and mode.
- Bulk generation and downstream consumers excluding disabled narration.
- UI switching modes, requiring text for `on`, and restoring preserved content after `off`.

Per the user's standing instruction, implementation may add these regression specifications but must not run automated tests, TypeScript checks, builds, or provider integration tests. Static verification is limited to focused source inspection, `git diff --check`, and locale/schema file parsing where applicable.
