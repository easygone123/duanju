# ComfyUI Duration and Frame Mapping Design

**Date:** 2026-07-18

## Problem

ComfyUI video workflows express duration in incompatible ways. Some nodes accept
seconds, some accept a total frame count, and either form may be stored as a
number or a numeric string. Second-based inputs may also accept fractional
values. Frame-based workflows differ in frame rate, rounding behavior, and
whether the first frame is included, for example `5 * 16 + 1 = 81`.

The current guided mapper cannot represent these differences:

- it recognizes only numeric `duration` or `seconds` fields automatically;
- manual scalar candidates recognize only a numeric field literally named
  `duration`;
- numeric strings are classified as prompt candidates;
- fields such as `length`, `num_frames`, and `frame_count` cannot be mapped to
  duration safely;
- runtime alias normalization can rename `duration_seconds` to `duration`, but
  it cannot convert seconds to frames.

Consequently, a valid video workflow may expose only prompt roles in the
mapping selector, or it may accept a duration variable whose value is invalid
for the target node.

## Goal

Keep one application-level duration contract, expressed as fractional seconds,
while allowing each saved ComfyUI workflow version to convert that value into
the exact scalar representation expected by its target node.

The normal authoring path must support:

- integer or fractional seconds;
- total frames;
- numeric or numeric-string targets;
- runtime FPS with a fixed per-workflow fallback;
- explicit rounding and optional first-frame offset;
- fixed target values such as `81` or `161`;
- editing the mapping after a workflow test fails.

Unsupported values must be rejected before ComfyUI submission with an
actionable error. The system must never silently choose a nearby duration.

## Chosen Approach

Add a typed numeric-conversion contract to input bindings. Do not keep growing
a list of field-name aliases as the only behavior, and do not allow arbitrary
user-authored expressions.

This approach separates three concepts:

1. **Canonical value:** the application supplies `duration` as seconds and
   `fps` as frames per second.
2. **Target semantics:** the binding declares whether the workflow field wants
   seconds or total frames.
3. **Target representation:** the renderer writes either a JSON number or a
   numeric string.

Field-name inference remains a convenience. The saved typed contract, not a
name guess, is authoritative at runtime.

## Canonical Runtime Contract

- `duration` is a finite positive number measured in seconds. Fractional
  values are valid.
- `fps` is a finite positive number. When present in request variables it is
  the preferred FPS for duration conversion.
- A frame conversion declares `fps` as an auxiliary workflow variable even
  when the graph has no FPS target binding. Its default is the configured
  fallback FPS, which keeps definition-driven request normalization and
  renderer lookup deterministic. When the graph also exposes an FPS input,
  the same canonical variable may bind to that field as well.
- Existing generator aliases such as `duration_seconds` continue to normalize
  to the canonical `duration` variable according to the pinned workflow
  version.
- The renderer performs unit conversion only after request validation and
  before writing values into the immutable API-format graph.

Application and video-stage code must not calculate workflow-specific frame
counts. That responsibility belongs to the pinned workflow binding contract.

## Binding Contract

`ComfyInputBinding` gains an optional numeric conversion object separate from
the existing media-upload `transform` field. A representative contract is:

```ts
interface ComfyNumericBindingTransform {
  sourceUnit: 'seconds' | 'fps'
  targetUnit: 'seconds' | 'frames' | 'fps'
  output: 'number' | 'numeric_string'
  fps?: {
    source: 'runtime_then_fallback'
    variable: 'fps'
    fallback: number
  }
  rounding?: 'round' | 'floor' | 'ceil'
  frameOffset?: 0 | 1
  allowedTargetValues?: number[]
}
```

The exact TypeScript name may follow nearby schema conventions, but these
semantics are required.

Rules:

- A `seconds` source may target `seconds` or `frames`. An `fps` source may
  target only `fps`; all other unit combinations are invalid.
- A seconds-to-seconds binding preserves the fractional value and does not
  round it.
- A seconds-to-frames binding computes:

  ```text
  frames = rounding(durationSeconds * effectiveFps) + frameOffset
  ```

- `effectiveFps` is the runtime `fps` variable when it is present and valid;
  otherwise it is the binding's positive fixed fallback.
- `rounding` and `frameOffset` are required for a frame target. Offset is
  restricted to `0` or `1` in the guided UI.
- `output` is applied after conversion and validation. Numeric-string output
  uses a canonical decimal representation and never locale formatting.
- `allowedTargetValues`, when present, contains finite unique native target
  values. The converted numeric value must match one exactly before encoding.
- Frame allowed values compare as integers. Fractional-second allowed values
  use decimal-safe normalization rather than raw binary floating-point
  equality; this prevents representation noise without selecting a nearby
  supported duration.
- Arbitrary formulas, JavaScript evaluation, and free-form expressions are
  forbidden.

Bindings and variable definitions already live in JSON fields on immutable
workflow versions, so the contract extension does not require a database
schema migration. Saving a changed conversion creates a new workflow version.

## Backward Compatibility

- A legacy numeric `duration` binding without a numeric conversion retains
  identity behavior and receives seconds, matching current behavior.
- Existing media transforms are unchanged.
- Existing workflow versions are not rewritten in place.
- New validation applies to a numeric conversion only when the field exists.
- Runtime alias normalization remains definition-driven so workflows that
  explicitly declare `duration_seconds` continue to receive that legacy name.

## Automatic Detection

The analyzer scans unbound literal scalars and separates native numbers from
numeric strings. It uses the input path, node title, class type, selected video
workflow kind, and current literal value as evidence.

High-confidence second candidates include:

- `duration`
- `seconds`
- `duration_seconds`
- `duration_s`

High-confidence frame candidates require video-node evidence and include:

- `num_frames`
- `frame_count`
- `total_frames`
- `video_length`

Ambiguous candidates include `length`, `frames`, numeric strings, and fields
whose surrounding node metadata is not clearly video-related. They are shown
to the user but are never published as duration without explicit confirmation.

The analyzer may recommend target semantics, representation, FPS, rounding,
and offset. Only exact evidence may be marked high confidence. A custom field
that is not recognized automatically remains manually selectable if it is a
finite number or a numeric string.

If a selected ComfyUI instance exposes compatible node metadata through its
object information, enum values may prefill `allowedTargetValues`. Uploaded
API-format JSON remains sufficient for manual configuration when instance
metadata is unavailable.

## Guided Authoring Experience

The advanced mapping editor lists every compatible unbound literal scalar,
including numeric strings. Selecting a workflow field filters roles by safe
convertibility rather than by its current JSON primitive alone.

When the user maps a field to **Duration**, the editor asks for the target
unit:

### Target unit: seconds

- Output format: number or numeric string.
- Optional allowed values.
- Fractional test values remain fractional.

### Target unit: total frames

- Runtime FPS is preferred automatically.
- A fixed fallback FPS is required.
- Rounding is required: nearest, down, or up.
- First-frame offset is required: `+0` or `+1`.
- Optional allowed frame counts.

The editor shows a live preview using an editable sample duration and FPS:

```text
Input: 5.5 seconds
Runtime FPS: 24
Calculation: round(5.5 * 24) + 0
Workflow value: 132
```

For a numeric-string target, the final line displays `"132"`. For an
inclusive-first-frame preset it can display `5 * 16 + 1 = 81`.

The normal wizard proposes a safe configuration and asks only unresolved
questions. The complete conversion controls remain available under advanced
mapping. A workflow test failure can return to the same editable mapping,
preserve the failed version's configuration, and save a corrected immutable
version before retesting.

## Supported-Value Policy

When a workflow supports only fixed native values, the UI exposes only source
durations that convert to an allowed target under the current effective FPS.
If runtime FPS changes the available set, the generation form recomputes it.

At request time the server repeats the conversion and exact allowed-value
check. It never trusts the client calculation and never snaps to the closest
supported value.

Examples:

- seconds target `[5, 10]`: `5.5` is rejected;
- frame target `[81, 161]`, FPS `16`, offset `+1`: `5` and `10` seconds are
  valid;
- the same frame target with runtime FPS `24`: unsupported conversions are
  rejected unless they exactly produce an allowed frame count.

## Validation and Error Handling

### Authoring validation

Publishing or testing is blocked when:

- target unit or output representation is missing;
- a frame target lacks a valid FPS fallback, rounding mode, or offset;
- an allowed value is non-finite, duplicated, or incompatible with the output
  representation;
- a numeric conversion is attached to a nonnumeric canonical variable;
- the selected graph target is absent or is not a scalar literal;
- ambiguous duration semantics remain unconfirmed.

### Request validation

Submission is blocked before capacity acquisition, uploads, billing, or ComfyUI
submission when:

- duration or effective FPS is missing, non-finite, or not positive;
- conversion produces a non-finite or nonpositive value;
- a frame conversion exceeds the safe integer range;
- the result is not in `allowedTargetValues`.

User-facing errors state the field, attempted value, effective FPS, and allowed
values without exposing the full workflow graph. Stable internal reason codes
distinguish invalid duration, missing FPS, invalid conversion, and unsupported
target value.

The request snapshot records the canonical duration, effective FPS, conversion
mode, and converted target value for diagnosis. It must not record uploaded
media contents or the complete workflow JSON.

## Renderer Responsibilities

The renderer remains the single component that mutates the cloned graph:

1. Read the canonical validated variable.
2. Resolve runtime FPS or fallback FPS.
3. Apply the typed numeric conversion.
4. Validate the native target value.
5. Encode it as number or numeric string.
6. Write it to the binding path.

The compiler and schema validator verify the contract shape and compatibility.
The request service validates only canonical variables and does not duplicate
workflow-specific conversion logic.

## Testing

### Analyzer and mapping tests

- Detect numeric `duration`, `seconds`, and `duration_seconds` as seconds.
- Detect video-node `num_frames`, `frame_count`, and `video_length` as frames.
- Treat `length`, `frames`, and numeric strings as confirmable candidates.
- Do not classify an unrelated numeric `length` field as video duration.
- Permit manual duration mapping for any finite numeric or numeric-string
  scalar.
- Keep prompt and negative-prompt roles for ordinary nonnumeric strings.

### Schema and compiler tests

- Accept every valid seconds and frames configuration.
- Reject missing FPS fallback, rounding, offset, invalid allowed values, and
  arbitrary transforms.
- Preserve legacy bindings without numeric conversion.
- Include conversion configuration in workflow content hashing and immutable
  version comparison.

### Renderer tests

- Preserve integer and fractional seconds.
- Encode seconds and frames as numbers or numeric strings.
- Cover runtime FPS, fixed fallback FPS, `round`, `floor`, `ceil`, `+0`, and
  `+1`.
- Verify `5 * 16 + 1 = 81` and fractional-second cases.
- Reject values outside fixed target enums before graph submission.
- Never mutate the stored graph or request variables.

### UI and integration tests

- A numeric-string candidate can select Duration instead of showing only
  prompt roles.
- The duration editor changes controls based on seconds or frames.
- Preview values match renderer output for the same configuration.
- Test failure returns to an editable conversion configuration.
- Saving a correction creates and selects a new version.
- Generation forms expose only supported durations when the workflow declares
  fixed values.
- Request snapshots and ComfyUI submissions contain the expected converted
  values.

### Regression

- Existing image mappings and media transforms remain unchanged.
- Existing second-based video workflows render the same values.
- Definition-driven `duration_seconds`/`duration` runtime compatibility remains
  intact.
- Workflow validation, test-before-publish, version pinning, and activation
  continue to pass.

## Acceptance Criteria

1. A user can map any finite numeric or numeric-string scalar to Duration.
2. Seconds targets accept and preserve fractional seconds.
3. Frame targets use runtime FPS when available and a required fixed fallback
   otherwise.
4. Frame rounding and `+0`/`+1` semantics are explicit and previewed.
5. Fixed target values are enforced before ComfyUI submission without silent
   coercion.
6. Ambiguous fields such as `length` require confirmation and remain editable.
7. Existing duration workflows remain compatible without migration.
8. Failed tests can return to the mapping editor, save a new version, and test
   the corrected conversion.
9. The final request diagnostics expose the effective conversion without
   exposing the workflow graph.

## Non-Goals

- Arbitrary formulas or JavaScript evaluation.
- Automatically interpreting every third-party custom node without metadata
  or user confirmation.
- Nonlinear or model-specific duration algorithms that cannot be represented
  by seconds, FPS, rounding, and an optional first-frame offset.
- Silently rounding to a supported duration.
- Rewriting previously published workflow versions.
