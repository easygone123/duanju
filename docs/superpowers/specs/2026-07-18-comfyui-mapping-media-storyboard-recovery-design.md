# ComfyUI Mapping, Media, and Storyboard Recovery Design

## Problem

The current ComfyUI workflow path has four connected recovery gaps:

- automatic mapping suggestions can be wrong, missing, or excessive, while the guided importer cannot freely add or remove effective mappings;
- a failed live workflow test leaves the activation surface open and the saved-workflow editor locked;
- `VHS_VideoCombine` is auto-mapped to the history field `files`, although VideoHelperSuite returns video references under `gifs`;
- storyboard and asset reference normalization signs storage through a browser-facing endpoint, which is unreachable from the application container and produces `all reference images failed to normalize`.

Four-grid storyboard support still exists, but its mode selector is visible only in the story/configuration stage. A user already viewing the storyboard stage cannot tell which mode is active or where to change it.

## Goal

Make imported ComfyUI workflows recoverable without editing JSON, make remote image and video outputs use the correct HTTP boundaries, restore reference-image generation, and make the active four-grid or six-grid mode discoverable from the storyboard page.

## Guided Mapping Experience

Automatic mappings remain the initial suggestion, not an immutable contract. The review stage adds a complete mapping editor backed by fields that actually exist in the uploaded API-format graph.

For input mappings, the user can:

- change the canonical role of an automatic mapping;
- remove an unwanted automatic or manual mapping;
- add a missing mapping by selecting a compatible node and literal input field from the graph;
- select scalar roles such as prompt, negative prompt, seed, dimensions, duration, and similar supported values;
- select supported media roles such as source image, source video, first frame, last frame, and reference images;
- see the friendly node title and field name, with node ID and input path available as technical context.

For output mappings, the user can:

- choose an output node discovered in the graph;
- add or remove output mappings while retaining at least one output;
- edit the history field path when a custom node uses a nonstandard field;
- choose which output is primary;
- see the expected media type before creation.

The editor rejects graph fields that do not exist, incompatible value types, duplicate node/path bindings, empty output sets, and a primary output that is not present. It does not accept arbitrary node IDs or paths that cannot be verified against the uploaded graph.

Readiness and workflow creation use the same edited mapping set. There is no second automatic-mapping pass that can overwrite user corrections.

## Saved Workflow Test Recovery

When a saved workflow fails its live ComfyUI test, the activation panel preserves the localized failure and exposes `Return to edit mappings`.

Selecting it:

1. closes activation;
2. keeps the loaded workflow draft intact;
3. unlocks the workflow editor;
4. focuses the input/output mapping section;
5. explains that the repaired draft must be saved before testing again.

Saving creates a new immutable workflow version. The next live test runs that exact saved version. Retry without editing continues to test the unchanged version.

## Video Output Mapping and Remote Retrieval

The output mapping field is a property in the ComfyUI `/history` response, not a local filesystem path.

Known output defaults are class-aware:

- image saver and preview nodes use `images`;
- `VHS_VideoCombine` uses `gifs`, including `.mp4` entries returned by VideoHelperSuite;
- other recognized video saver nodes use their known history field when the application has an explicit rule;
- an unknown output remains editable and must not be silently presented as a verified mapping.

After a history entry is selected, the application downloads bytes from the configured remote ComfyUI instance through `/view?filename=...&subfolder=...&type=...`. It never tries to open the remote host's filesystem. MIME validation and upload into application-owned storage remain unchanged.

## Reference Image Normalization

Server-side reference normalization must resolve application storage keys through the internal object-storage endpoint. Browser-facing signed URLs remain reserved for browser clients.

The flow is:

1. resolve a media reference or `/m/{publicId}` to its owned storage key;
2. generate an internal fetchable object URL;
3. fetch and normalize the bytes inside the application network;
4. upload the normalized reference to the selected remote ComfyUI instance when required;
5. submit the workflow only after at least one requested reference succeeds.

Individual bad references remain skippable under the existing tolerance rules. If every requested reference fails, the error remains explicit, but internal/public endpoint confusion must no longer be a cause.

## Four-grid Discoverability

The authoritative mode selector remains in the story/configuration stage because the mode controls planning and must be selected before new storyboard groups are planned.

The storyboard stage adds a compact mode summary that shows:

- active mode: individual, four-grid, or six-grid;
- derived grid layout and sheet ratio for grid modes;
- a clear action that returns to the story/configuration stage to change the mode.

Changing the project mode does not rewrite already persisted storyboard groups. Existing four-grid and six-grid groups retain their stored layout. Active planning or generation continues to lock the setting through the existing run lock.

## Component Boundaries

### Guided importer

- `WorkflowCreationWizard` owns the edited mapping draft.
- A graph-derived mapping helper exposes compatible input and output candidates and validates edits.
- The guided mapping table renders add, edit, remove, and primary-output controls.
- Contract confirmation consumes the edited draft directly.

### Saved workflow library

- `WorkflowActivationPanel` reports the edit intent after test failure.
- `WorkflowLibraryPanel` owns repair mode and focus handoff.
- `WorkflowEditor` and `WorkflowMappingTable` remain the authoritative saved-draft editor.

### ComfyUI output adapter

- The auto-mapper owns class-to-history-field defaults.
- The history parser extracts output references.
- The ComfyUI client retrieves each output over the remote instance's HTTP `/view` endpoint.

### Media normalization

- Storage helpers distinguish internal object access from browser signing.
- The outbound image normalizer uses internal object access for owned storage keys.

### Storyboard page

- A reusable mode summary reads the existing workspace runtime settings.
- Navigation returns the user to the configuration stage without duplicating planning configuration inside the storyboard component.

## Error Handling

- Invalid edited mappings block creation with a localized, field-specific message.
- A live-test failure never publishes or mutates a workflow version.
- Unknown output fields remain editable instead of being guessed as `files`.
- Remote `/view` failures terminate or retry through the existing task lifecycle; they do not leave the ComfyUI lease permanently busy.
- Reference normalization logs safe per-reference diagnostics and throws the aggregate error only when all requested references fail.
- Four-grid mode changes never mutate existing group layout metadata.

## Validation

Test-driven coverage must include:

1. guided input mapping add, role change, and removal;
2. guided output mapping add, field edit, removal, and primary selection;
3. readiness and confirmation consuming the same edited mapping set;
4. failed activation returning to an unlocked, focused mapping editor;
5. `VHS_VideoCombine` mapping to `gifs` rather than `files`;
6. remote video retrieval using `/history` metadata and `/view`, without filesystem access;
7. outbound storage references using the internal object URL and not the public signer;
8. storyboard-stage mode summary and navigation back to configuration;
9. focused component, mapper, media, worker, and route regressions;
10. TypeScript, affected-file ESLint, locale parity, build, and the repository test gate.

## Non-goals

- editing the uploaded workflow JSON;
- accepting arbitrary node IDs or paths not found in the uploaded graph;
- changing ComfyUI's output directory or requiring shared storage with ComfyUI;
- rewriting existing storyboard groups when the project mode changes;
- generating grid panels with separate image calls;
- changing billing, queue leasing, or media ownership rules outside the identified recovery paths.
