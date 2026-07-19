# ComfyUI Video Workflow Test Duration Design

## Goal

Prevent live tests of user-supplied ComfyUI video workflows from inheriting a long workflow default and timing out. Every video workflow live test must expose and submit a controllable duration value. The workflow may express that value as seconds or total frames.

## Scope

This rule applies only to the live-test paths used by **Test** and **Test and enable**.

- Saving a draft remains allowed without a duration mapping.
- Publishing a version directly remains unchanged.
- Existing published workflows are not archived or removed by migration.
- Image and image-upscale workflow behavior is unchanged.
- A video workflow still needs a successful live test before it can become an available global or project model under the existing eligibility rules.

## Duration contract

A video version is testable only when its contract contains one canonical duration variable and a valid numeric binding from that variable to a workflow input.

- Accepted canonical variable names follow the existing duration resolver: `duration`, then numeric aliases containing `duration` or `seconds`.
- The binding must use the resolved duration variable and a valid numeric transform whose source unit is seconds.
- The target unit may be `seconds` or `frames`.
- A numeric variable definition without a bound workflow target does not satisfy the rule.
- FPS alone does not satisfy the rule.

If the contract is missing, the live-test API returns `INVALID_PARAMS` with the validation issue code `COMFY_VIDEO_TEST_DURATION_REQUIRED` and does not inspect the ComfyUI queue, acquire a lease, upload media, or submit a prompt.

## Test form behavior

For a video workflow, both test surfaces must include the resolved duration variable in the test form even if the saved definition is optional.

The test-only field is treated as required and initialized to the shortest supported duration:

1. If the resolved duration definition contains positive options, select the smallest option.
2. Otherwise, if numeric binding constraints can be inverted to supported seconds, select the smallest supported result.
3. Otherwise default to `1` second.

The displayed label identifies the test duration in seconds. When the binding targets frames, the UI also identifies that the workflow converts the value to total frames; the mapping remains responsible for FPS, rounding, and frame offset.

Users may replace the default with another valid positive value. Zero, negative, non-finite, missing, or unsupported constrained values keep the test action disabled and are rejected again by the server.

If no valid duration binding exists:

- show a localized message instructing the user to add a duration or total-frame mapping;
- disable **Test** and **Test and enable**;
- expose the existing edit-mappings action without requiring a failed ComfyUI request first.

## Server enforcement

The live-test service derives the duration test contract from the persisted version, never from client claims.

Before connection lookup or any external operation it verifies:

1. the workflow media type is video;
2. a canonical duration definition and valid bound target exist;
3. the request supplies a positive duration value;
4. the value satisfies the existing duration constraint conversion.

The renderer continues to perform the authoritative numeric conversion. The new gate only makes the required test input explicit and fails earlier with a stable validation issue.

## Components

- A shared pure helper derives video live-test duration eligibility, the effective field, shortest default, and validation result from workflow media type, definitions, and bindings.
- `workflow-test-service` calls the helper before any ComfyUI/network work.
- `WorkflowActivationPanel` and `WorkflowLibraryPanel` use the same helper to build test definitions and disable invalid test actions.
- `WorkflowTestForm` accepts the prepared test-only definition and validates the positive default or user entry.
- Chinese and English messages explain the missing mapping and invalid test duration.

## Testing

Tests are written before implementation and cover:

- a video live test without a duration binding fails before connection or ComfyUI access;
- a definition without a binding still fails;
- seconds and total-frame numeric bindings are accepted;
- the shortest fixed duration is selected for constrained frame workflows;
- an unconstrained workflow defaults to one second;
- missing, zero, negative, non-finite, and unsupported values are rejected;
- both test UIs show the field and disable testing when the mapping is absent;
- the edit-mappings action is available immediately for the missing mapping;
- image and upscale workflows retain their current behavior.

Focused component, service, contract, type, localization, and production-build checks run before push.
