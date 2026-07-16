# Six-Grid Submission and Global ComfyUI Models Design

## Problems

Two disconnected data paths produce user-visible failures:

1. A newly persisted six-grid storyboard has a prompt snapshot but deliberately stores `sheetModelSnapshot = null`. The generate button sends no `imageModel`, so the sheet API rejects every first submission with `SIX_GRID_SHEET_SNAPSHOT_MISSING`. The mutation clears its optimistic overlay without rendering the error, making the button appear inert.
2. Published and tested ComfyUI workflows are exposed by `/api/user/models`, but the profile global-default selectors only consume the stored provider/model catalog from `/api/user/api-config`. ComfyUI image and video workflows therefore cannot be selected as global defaults even when they are executable.

## Goals

- Make the six-grid generate button submit with the authoritative effective storyboard image model and show actionable failures.
- Make executable owned ComfyUI generation workflows selectable as global image and video defaults.
- Keep ComfyUI workflows dynamic; do not copy them into `customModels` or create fake providers/API keys.
- Revalidate ComfyUI defaults on the server before saving them.

## Six-Grid Model Resolution

The sheet generation API is the authority for effective model resolution.

For `operation = generate`, resolve the model in this order:

1. an explicit request `imageModel`, when present;
2. the storyboard's immutable `sheetModelSnapshot`, when regenerating an existing sheet;
3. the effective project model configuration's `storyboardModel`, including project ComfyUI bindings, project defaults, and user defaults.

The prompt remains `request.prompt ?? storyboard.sheetPromptSnapshot`. The API returns a stable invalid-parameter reason when either the effective model or prompt is unavailable. Once the task is accepted, the resolved model and prompt are copied into the immutable task snapshot; successful persistence continues to write them back to the storyboard sheet snapshot.

The client may send its visible storyboard model as an explicit override, but correctness must not depend on it. Server-side resolution supports old storyboards, refreshed pages, user-level defaults, and non-UI callers.

## Six-Grid Error Feedback

The six-grid mutation stores its latest safe error per affected storyboard. The group controls render the localized error in an alert region next to the buttons and clear it when a new submission starts or succeeds.

- Missing effective storyboard model explains that the user must select a storyboard image model.
- Missing prompt or incomplete six-grid data receives a safe localized message.
- Other task submission failures use the existing normalized task error message.
- The generate button is disabled only when a task is running; server resolution remains authoritative, so a stale client cannot incorrectly enable a submission.
- A failed pre-task request must not look like a running or completed task.

## Dynamic Global Model Options

The profile API configuration page loads both:

- stored provider and model configuration from `/api/user/api-config`;
- executable dynamic model options from `/api/user/models`.

The global default selectors merge dynamic ComfyUI options at the selector layer:

- `mediaType = image`, `purpose = generation` enters image defaults, including character, location, storyboard, edit, and the global image pipeline selector;
- `mediaType = video`, `purpose = generation` enters the global video default selector;
- `purpose = upscale` remains in the dedicated upscale model collection and never enters ordinary image/video defaults.

The merge is keyed by the canonical model key, keeps ComfyUI's `providerName`, and does not mutate stored providers or models. A loading or refresh failure for dynamic options shows a safe status but does not corrupt stored configuration.

## Executable Workflow Eligibility

A ComfyUI workflow is a selectable global default only when the current user owns it and its current version satisfies all existing executable checks:

- workflow status is `published`;
- workflow `currentVersionId` matches the selected current version;
- current version has `publishedAt`;
- current version has a non-empty content hash;
- current version has `lastSuccessfulTestAt`;
- the successful test connection belongs to the current user;
- purpose is `generation`;
- media type matches the target default field (`image` or `video`).

Client filtering is presentation only. The save endpoint must repeat the authoritative checks.

## Saving Global ComfyUI Defaults

When `/api/user/api-config` receives a default model key with provider `comfyui`, it validates the referenced workflow through a shared server helper before persistence.

- Image default fields require an executable owned image-generation workflow.
- `videoModel` requires an executable owned video-generation workflow.
- Audio, lip-sync, voice-design, and analysis defaults reject ComfyUI keys.
- A stale, archived, untested, unpublished, wrong-purpose, wrong-media, or foreign workflow is rejected with a safe invalid-parameter response.
- Validated ComfyUI defaults bypass cloud-provider API-key and pricing-catalog requirements. They are executed and billed according to the existing local ComfyUI path, which does not charge cloud model pricing.
- GET sanitization preserves still-valid ComfyUI defaults and clears invalid or no-longer-executable ones using the same helper semantics.

No ComfyUI workflow is written to `customModels`, and deletion/archive behavior remains governed by the workflow and project-default services.

## Refresh and Existing Workflows

- Successful test and successful publish both invalidate the dynamic user-model query.
- The unified activation flow remains the preferred test-and-publish path.
- Existing saved workflows must expose a way to open the same activation flow, so an old draft, published-but-untested version, or new version can become executable without recreating the workflow.
- Profile global-default selectors consume fresh dynamic options when mounted and after user-model invalidation.

## Accessibility and Localization

- Six-grid submission errors use `role="alert"` and do not rely on button titles alone.
- Dynamic model loading/refresh status uses a polite status region.
- Image and video selector labels continue to identify provider name as `ComfyUI`.
- All new messages have matching Chinese and English keys.
- Raw server payloads, workflow graphs, URLs, credentials, and internal stack traces are never displayed.

## Validation

Per the project owner's prior direction, do not run the repository-wide test suite. Before submission, run TypeScript checking, affected-file ESLint, locale-key parity inspection, `git diff --check`, and focused static/contract checks only.

## Non-Goals

- Copying ComfyUI workflows into the stored custom-model catalog.
- Creating a fake ComfyUI API provider or API key.
- Making upscale workflows available as normal image-generation defaults.
- Changing six-grid prompt construction, crop behavior, or image worker execution.
- Making another user's workflow globally visible.
