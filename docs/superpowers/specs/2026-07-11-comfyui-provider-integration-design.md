# ComfyUI Provider Integration Design

- Date: 2026-07-11
- Status: Implementation complete; Docker-backed acceptance verification pending
- Target branch: `feat/comfyui-integration`

## 1. Summary

Add ComfyUI as a native image and video provider while preserving every existing
cloud provider. Users can register one or more local or remote ComfyUI instances,
import their own ComfyUI API Format workflows, bind waoowaoo generation inputs to
workflow node inputs, and map workflow outputs back into the existing media
pipeline.

Each ComfyUI connection is private to the user who created it. A per-user scheduler
prefers an online, compatible, idle instance and enforces a hard concurrency limit
of one waoowaoo task per instance. When all compatible instances are busy, work
remains in waoowaoo's queue rather than being submitted to a ComfyUI queue.

This design deliberately includes no built-in workflow, model, checkpoint, or
custom-node dependency.

## 2. Goals

1. Support both image and video generation through ComfyUI.
2. Keep Google, Ark, FAL, Vidu, MiniMax, Bailian, SiliconFlow, and compatible
   providers unchanged and selectable alongside ComfyUI.
3. Support self-hosted ComfyUI on the same machine, a LAN host, or a remote host.
4. Allow users to import arbitrary ComfyUI API Format JSON.
5. Support both JSON placeholders and explicit node-field mappings.
6. Provide a user-level workflow library, project defaults, and task-level workflow
   overrides.
7. Let each user maintain a private pool of ComfyUI connections.
8. Show whether each connection is idle, busy, offline, unauthorized, or
   incompatible with a selected workflow.
9. Prefer idle instances, enforce concurrency one, and wait in waoowaoo when every
   compatible instance is busy.
10. Recover safely from waoowaoo restarts, ComfyUI restarts, WebSocket loss, and
    media-transfer failures without duplicate generation.
11. Offer a secure allowlist network mode and an explicitly enabled trusted
    self-hosted mode.

## 3. Non-goals

- Shipping or downloading ComfyUI workflows, checkpoints, LoRAs, or custom nodes.
- Embedding the ComfyUI graph editor in waoowaoo.
- Sharing user-added connections or workflows across users.
- Running more than one waoowaoo task concurrently on one ComfyUI instance.
- Autoscaling or provisioning ComfyUI machines.
- Moving existing providers behind a ComfyUI gateway.
- Failing over to another instance after `/prompt` has been accepted but before the
  original prompt has been conclusively reconciled.
- Automatically guessing workflow inputs or outputs when no placeholder or mapping
  declares them.

## 4. Architecture

```text
waoowaoo image/video business task
                |
                v
       ComfyUI provider adapter
                |
                v
  durable ComfyGenerationRequest
       (waiting for capacity)
                |
                v
     per-user ComfyUI scheduler
                |
        atomic Redis lease
                |
                v
   idle compatible ComfyUI instance
                |
                v
 upload inputs -> render workflow -> POST /prompt
                |
                v
 WebSocket progress + queue/history reconciliation
                |
                v
 download mapped outputs -> waoowaoo object storage
                |
                v
       existing media/task pipeline
```

### 4.1 Components

`ComfyProviderAdapter`

- Adds explicit `comfyui` routing to `generateImage` and `generateVideo`.
- Resolves `comfyui::<workflowId>` without provider guessing.
- Creates a durable generation request and returns a standard asynchronous
  `GenerateResult` with a `COMFY:IMAGE:<requestId>` or
  `COMFY:VIDEO:<requestId>` external ID.

`ComfyWorkflowService`

- Owns workflow import, static validation, placeholder discovery, mapping
  validation, version publication, and compatibility requirements.
- Resolves the immutable workflow version and variable snapshot used by each
  generation request.

`ComfyScheduler`

- Finds eligible connections within the current user's private pool.
- Enforces online, idle, compatible, enabled, and concurrency-one gates.
- Claims a connection with an atomic Redis lease and a database compare-and-set.
- Uses least-recently-assigned selection among equally eligible idle instances.

`ComfyClient`

- Encapsulates connection probing, input upload, prompt submission, WebSocket
  events, queue/history polling, output download, queue deletion, and interrupt.
- Applies authentication, URL policy, timeouts, response limits, and log redaction
  in one place.

`ComfyDispatcher`

- Consumes durable ComfyUI generation requests independently from ComfyUI's own
  queue.
- Uploads inputs, submits the rendered workflow, follows execution, transfers all
  declared outputs, and releases the lease.
- Wakes on new work, health transitions, task completion, connection changes, and
  a periodic reconciliation tick.

`ComfyHealthMonitor`

- Probes enabled connections and derives operational state from ComfyUI plus local
  leases.
- Caches current health in Redis and stores only a diagnostic summary in the
  database.

`ComfySecurityPolicy`

- Normalizes and authorizes every outbound target.
- Implements allowlist and trusted network modes.
- Revalidates destinations for every connection, upload, prompt, history, view,
  and WebSocket request.

## 5. Persistence Model

Names below describe the intended Prisma entities. Exact index names may follow
existing repository conventions.

### 5.1 `ComfyConnection`

| Field | Purpose |
| --- | --- |
| `id` | Stable connection UUID |
| `userId` | Owner; required on every read and mutation |
| `name` | User-facing instance name |
| `baseUrl` | User-entered HTTP or HTTPS base URL |
| `normalizedBaseUrl` | Canonical URL used for duplicate detection |
| `authType` | `none`, `bearer`, or `basic` |
| `authSecretEncrypted` | Encrypted token or credential payload |
| `enabled` | Whether health checks and scheduling are allowed |
| `lastHealthAt` | Last completed health probe |
| `lastHealthCode` | Stable diagnostic code, not the scheduling authority |
| `lastHealthMessage` | Sanitized diagnostic summary |
| `lastSeenVersion` | Last reported ComfyUI version when available |
| `deviceSummary` | Sanitized GPU/device summary for display |
| `lastAssignedAt` | Load-balancing tie breaker |
| timestamps | Creation and modification audit fields |

`(userId, normalizedBaseUrl)` is unique. Secrets are never returned after save;
the API returns only `hasCredentials`.

### 5.2 `ComfyWorkflow`

| Field | Purpose |
| --- | --- |
| `id` | Stable workflow UUID and model ID |
| `userId` | Owner |
| `name` | User-facing name |
| `mediaType` | `image` or `video` |
| `status` | `draft`, `published`, or `archived` |
| `currentVersionId` | Latest published immutable version |
| timestamps | Creation and modification audit fields |

### 5.3 `ComfyWorkflowVersion`

| Field | Purpose |
| --- | --- |
| `id` | Immutable version UUID |
| `workflowId` | Parent workflow |
| `version` | Monotonically increasing integer |
| `apiFormatJson` | Validated ComfyUI API Format graph |
| `bindingSpec` | Typed variable-to-node-field mappings |
| `outputSpec` | Explicit media output mappings and primary output |
| `requirements` | Derived node classes and model values used for compatibility |
| `contentHash` | Hash across graph and mapping contracts |
| `publishedAt` | Publication time |
| `lastSuccessfulTestAt` | Most recent successful live test for this exact version |
| `lastTestConnectionId` | Connection used by that successful live test |

Editing creates a new draft version. Publishing changes `currentVersionId`, but
in-flight requests remain pinned to their original version. Publishing requires
static validation. Selecting a workflow as a project default additionally requires
at least one successful live test of that exact version on a connection owned by
the same user.

### 5.4 `ProjectComfyBinding`

| Field | Purpose |
| --- | --- |
| `projectId` | Project, unique |
| `userId` | Ownership guard matching the project owner |
| `imageWorkflowId` | Optional default published image workflow |
| `videoWorkflowId` | Optional default published video workflow |

The binding follows the selected workflow's current published version. A generation
request pins that version when the request is created.

### 5.5 `ComfyGenerationRequest`

| Field | Purpose |
| --- | --- |
| `id` | Internal request UUID encoded in the external ID |
| `taskId` | Owning waoowaoo task; not unique because one task may generate more than once |
| `invocationKey` | Idempotency key for a particular generation invocation |
| `userId`, `projectId` | Authorization and trace context |
| `mediaType` | `image` or `video` |
| `workflowId`, `workflowVersionId` | Immutable workflow reference |
| `variableSnapshot` | Typed, sanitized runtime values; media bodies remain storage references |
| `status` | State machine value defined below |
| `connectionId`, `leaseId` | Assigned instance and ownership token |
| `promptId`, `clientId` | ComfyUI execution identifiers |
| `outputRefs` | Declared ComfyUI outputs and durable storage results |
| `errorCode`, `errorMessage`, `nodeErrors` | Sanitized failure diagnostics |
| phase timestamps | Queue, lease, submit, run, transfer, and completion times |

## 6. Workflow Contract

### 6.1 Import format

Only ComfyUI API Format JSON is executable. UI-format graph JSON is rejected with
an actionable message explaining how to export API Format. The imported root must
be a node-ID map. Every node must contain a non-empty `class_type` and an `inputs`
object.

References such as `["12", 0]` are validated against existing node IDs. Static
validation does not require a live ComfyUI connection.

### 6.2 Standard variables

Common variables:

- `prompt`
- `negative_prompt`
- `seed`

Image variables:

- `input_images`
- `width`
- `height`
- `aspect_ratio`
- `steps`
- `cfg`

Video variables:

- `first_frame`
- `last_frame`
- `duration_seconds`
- `frame_count`
- `fps`
- `width`
- `height`
- `aspect_ratio`

Users may define extension variables with a name, `string`, `number`, `boolean`,
or media-reference type, a default value, and a required flag. Arbitrary code and
expression evaluation are not allowed.

### 6.3 Placeholder rules

- A string value equal to `${width}` is replaced with the typed numeric value.
- A string containing `size-${width}` performs string interpolation.
- `${input_images}` can produce a typed list only when it is the complete value.
- An undefined required placeholder blocks submission.
- An undefined optional placeholder uses its declared default or leaves the
  original workflow value unchanged, according to its mapping configuration.
- Placeholder discovery is advisory; publication still requires a valid binding
  contract.

### 6.4 Explicit field mappings

Each mapping contains:

- target node ID;
- target path beneath `inputs`;
- source variable;
- expected type;
- optional safe transform.

Supported media transforms convert an uploaded ComfyUI input response into the
filename, a structured image reference, or a list required by the target node.
Transforms are enumerated server-side and cannot contain user code. Explicit
mappings override placeholders that target the same field.

### 6.5 Output mappings

Every published workflow declares at least one output:

- node ID;
- safe dotted field path within that node's history output;
- media type (`image` or `video`);
- whether it is the primary output.

Exactly one output is primary. All declared outputs are downloaded and copied to
waoowaoo storage. The primary output is returned to the existing image or video
business flow. No output-node guessing is used at runtime.

### 6.6 Compatibility

For each workflow version and connection, compatibility is derived from:

- required `class_type` values compared with `/object_info`;
- loader input values compared with the input enums returned by `/object_info`;
- model folders queried through `/models/{folder}` when the node schema identifies
  a model field.

Compatibility results are cached by workflow content hash and an instance
capability fingerprint. A missing node or model marks the pair incompatible and
lists the exact requirement. Compatibility is a scheduling gate, not a promise
that arbitrary custom-node runtime behavior will succeed.

## 7. Connection Health and Scheduling

### 7.1 Authoritative idle decision

An instance is eligible only when all conditions hold:

1. It is enabled and owned by the request's user.
2. The current network policy authorizes its resolved destination.
3. `/system_stats` is reachable and authenticated.
4. `/queue` reports no running and no pending ComfyUI prompts.
5. No unexpired waoowaoo lease exists for the connection.
6. The connection is compatible with the pinned workflow version.

The UI derives these labels:

- `online_idle`
- `online_busy_owned`
- `online_busy_external`
- `offline`
- `auth_failed`
- `workflow_incompatible` for a workflow-relative view

Transient connection failures may be debounced for display, but a failed probe
immediately removes the instance from scheduling eligibility.

### 7.2 Queueing and fairness

- New requests start as `waiting_capacity`.
- Requests are FIFO per user, with existing waoowaoo task priority retained.
- The scheduler selects the compatible idle connection with the oldest
  `lastAssignedAt`.
- If every compatible connection is busy, the request remains in waoowaoo without
  an execution timeout.
- If there is no enabled compatible connection, the request becomes
  `blocked_no_compatible_instance` and displays the missing requirements. Health,
  connection, or workflow changes automatically make it eligible again.
- A user cancellation is always allowed while waiting or blocked.

### 7.3 Lease

The scheduler claims `comfy:lease:<connectionId>` with Redis `SET NX PX`. The value
contains the request and lease IDs. A database compare-and-set assigns the same
connection only if the request is still schedulable. Failure of either side causes
the partial claim to be released.

The dispatcher renews the lease while uploading, submitting, running, and
transferring. A release requires the matching lease ID. After a crash, an expired
lease does not by itself make the node idle: health must also show an empty ComfyUI
queue, and reconciliation must inspect any recorded prompt ID.

### 7.4 Request state machine

```text
waiting_capacity
  -> blocked_no_compatible_instance -> waiting_capacity
  -> leased
  -> uploading
  -> submitted
  -> running
  -> transferring
  -> completed

Any nonterminal state -> canceled
leased or later       -> reconciling -> prior phase/completed/failed
uploading or later    -> failed (only after phase-specific retry policy)
```

State transitions use compare-and-set updates and are idempotent.

## 8. ComfyUI Execution

### 8.1 Core routes

The client uses the self-hosted ComfyUI server contracts documented at
<https://docs.comfy.org/development/comfyui-server/comms_routes>:

- `GET /system_stats`
- `GET /queue`
- `GET /object_info`
- `GET /models/{folder}`
- `POST /upload/image`
- `POST /prompt`
- `WS /ws`
- `GET /history/{promptId}`
- `GET /view`
- `POST /queue` for deleting a queued owned prompt
- `POST /interrupt` for an executing owned prompt

`baseUrl` may include a reverse-proxy path prefix. URL joining preserves that
prefix. WebSocket URLs use `ws` or `wss` to match HTTP or HTTPS.

### 8.2 Submission sequence

1. Revalidate connection ownership, network policy, health, compatibility, and
   lease ownership.
2. Resolve durable waoowaoo media references to server-fetchable content.
3. Upload required inputs using collision-resistant names scoped to user and
   request.
4. Render a fresh deep clone of the pinned API graph from the typed variable
   snapshot.
5. Re-run binding validation after rendering.
6. Open the WebSocket using a generated client ID.
7. Submit `/prompt`, then persist the returned prompt ID before treating submission
   as successful.
8. Consume WebSocket execution events. Poll `/history/{promptId}` and `/queue` as a
   fallback and during recovery.
9. Read every declared output mapping from history.
10. Fetch each output through `/view` with the same server-side authentication.
11. Copy each output to waoowaoo object storage.
12. Mark the primary output, complete the request, and release the lease.

### 8.3 Timeouts

Capacity waiting has no default timeout. Separate configurable limits apply to:

- connection and health requests;
- input upload;
- prompt submission;
- image execution;
- video execution;
- output download and transfer.

Image/video execution timeout begins only after `/prompt` is accepted. Timeouts do
not authorize duplicate submission; timed-out submitted work enters reconciliation
before it can become terminal.

### 8.4 Progress

The existing task progress contract gains stable ComfyUI stages:

- `comfy_waiting_capacity`
- `comfy_checking_compatibility`
- `comfy_uploading_inputs`
- `comfy_submitting`
- `comfy_running`
- `comfy_transferring_outputs`
- `comfy_reconciling`

WebSocket node and progress events update detail text within the running range.
Elapsed time alone is not reported as fake completion percentage.

## 9. Recovery, Retry, and Cancellation

### 9.1 Before prompt acceptance

If the assigned instance fails before `/prompt` is accepted, the dispatcher may
release the lease and return the request to `waiting_capacity`. Uploaded temporary
inputs are best-effort cleanup and do not make a generation billable or complete.

### 9.2 After prompt acceptance

After a prompt ID exists, the request remains pinned to the same connection. A
network or process failure moves it to `reconciling`. Reconciliation checks history
and queue until it can establish one of:

- completed with declared outputs;
- failed with an execution error;
- still queued or running;
- conclusively absent after the configured reconciliation policy.

The system never submits the same invocation to another instance while the first
prompt may still exist.

### 9.3 Output transfer

ComfyUI execution success and waoowaoo storage success are separate phases. If
storage transfer fails, history output references remain in `outputRefs` and the
transfer retries without rerunning the workflow.

### 9.4 Cancellation

- `waiting_capacity` or `blocked_no_compatible_instance`: cancel locally.
- `leased` or `uploading`: stop before prompt submission and release the lease.
- queued in ComfyUI: delete only the recorded prompt ID owned by the current lease.
- executing in ComfyUI: call `/interrupt` only after verifying the running prompt
  ID and lease ownership.
- transferring: stop transfer, preserve diagnostic output references, and mark the
  task canceled according to the existing task contract.

Manual or third-party ComfyUI prompts are never deleted or interrupted.

## 10. Failure Codes

Stable codes include:

- `COMFY_CONNECTION_OFFLINE`
- `COMFY_AUTH_FAILED`
- `COMFY_NETWORK_TARGET_BLOCKED`
- `COMFY_WORKFLOW_FORMAT_INVALID`
- `COMFY_WORKFLOW_BINDING_INVALID`
- `COMFY_WORKFLOW_INCOMPATIBLE`
- `COMFY_NO_COMPATIBLE_INSTANCE`
- `COMFY_INPUT_UPLOAD_FAILED`
- `COMFY_PROMPT_REJECTED`
- `COMFY_EXECUTION_FAILED`
- `COMFY_EXECUTION_TIMEOUT`
- `COMFY_OUTPUT_MISSING`
- `COMFY_OUTPUT_TRANSFER_FAILED`
- `COMFY_RECONCILIATION_REQUIRED`

`/prompt` validation `node_errors` are sanitized and stored so the UI can identify
the failing node. User-facing messages remain localized through existing i18n
patterns.

## 11. Security

### 11.1 Modes

`COMFYUI_NETWORK_MODE=allowlist` is the secure default.

- Allowed hosts come from `COMFYUI_ALLOWED_HOSTS`.
- Allowed networks come from `COMFYUI_ALLOWED_CIDRS`.
- Unapproved loopback, private, link-local, multicast, IPv4-mapped IPv6, and cloud
  metadata destinations are rejected.

`COMFYUI_NETWORK_MODE=trusted` is an explicit self-hosted opt-in that permits
arbitrary user-supplied HTTP/HTTPS hosts, including LAN and loopback targets. It
does not disable ownership, scheme, redirect, timeout, or response-size controls.

Docker deployments can approve `host.docker.internal` or the relevant host-gateway
CIDR in allowlist mode, or use trusted mode in a single-user environment.

### 11.2 Outbound request controls

- Accept only HTTP and HTTPS base URLs.
- Reject URLs containing embedded usernames or passwords.
- Resolve all addresses before each request and WebSocket connection.
- Apply policy to every resolved address, not just the first result.
- Disable automatic redirects; permit only a same-origin redirect after another
  policy check when an endpoint contract requires it.
- Prevent authentication headers from crossing origins.
- Bound connect, header, body, and idle timeouts.
- Bound workflow JSON, upload, history response, and output sizes.
- Avoid proxy environment inheritance unless explicitly configured by the
  deployment.

### 11.3 Data and authorization

- Encrypt connection credentials with the existing application encryption
  facility.
- Redact authorization, tokens, passwords, cookies, workflow media bodies, and
  prompt text from logs.
- Scope every connection, workflow, version, project binding, generation request,
  and test-run query by the authenticated user.
- Treat a workflow as permission to invoke only nodes already installed on the
  user's chosen ComfyUI; waoowaoo never installs custom nodes or executes supplied
  code.

## 12. User Experience

### 12.1 Node pool page

Users add a connection with name, IP/URL, and optional authentication. Save performs
a connection test and displays ComfyUI version, device, VRAM, and queue details when
available.

Each card shows:

- online state and last check time;
- idle, waoowaoo-busy, or externally busy state;
- current owned task or external queue counts;
- GPU and VRAM summary;
- enable, disable, edit, test, and delete actions.

An instance with active owned work cannot be deleted. It can be disabled to stop
future assignments and deleted after work completes.

### 12.2 Workflow library

Users upload a JSON file or paste API Format JSON. The editor shows:

- discovered placeholders;
- typed variables and defaults;
- node-field mappings;
- input media transforms;
- output mappings and primary output;
- static validation issues;
- compatibility for each owned connection.

A draft may be saved after a failed live test. Static validation is required to
publish it. A successful live test is optional during authoring and publication,
but the current published version must have at least one successful live test on an
owned connection before it can be selected as a project default.

### 12.3 Project and task views

Project settings offer a default image workflow and default video workflow. Model
selectors display published workflows as `ComfyUI / <workflow name>` while storing
the strict key `comfyui::<workflowId>`. A single generation may select another
published workflow.

Task detail shows workflow name and version, assigned instance, capacity wait,
execution and transfer durations, current ComfyUI node when known, prompt ID, and
sanitized errors.

## 13. Existing waoowaoo Integration

1. Add an explicit `comfyui` provider key and display metadata.
2. Expose each published workflow as a dynamic image or video model with model key
   `comfyui::<workflowId>`; do not duplicate the graph into `customModels`.
3. Extend strict model selection to verify workflow ownership, media type, and
   published status.
4. Route ComfyUI before provider API-key resolution because the provider uses a
   private connection pool rather than one provider base URL.
5. Add image and video adapters returning standard asynchronous `GenerateResult`.
6. Extend external ID parsing and polling with `COMFY`. Polling reads the durable
   internal request and does not expose connection credentials.
7. Extend `PollResult` to carry a stable stage and multiple durable output URLs
   while preserving the existing primary URL contract.
8. Reuse existing worker restart behavior through the saved external ID.
9. Reuse existing media processing, task events, cancellation, and storage
   contracts.
10. Resolve project defaults through the current project model configuration path.
11. Price ComfyUI generation at zero in application billing; existing providers'
    pricing and billing flows remain unchanged.

## 14. Observability

Every log and trace includes, when available:

- waoowaoo `taskId`;
- generation request ID;
- workflow ID and version;
- connection ID;
- ComfyUI prompt ID;
- lease ID.

Metrics cover:

- connection uptime, idle ratio, owned busy time, and external busy time;
- capacity wait and execution duration;
- workflow success rate;
- failure counts by stable error code;
- lease contention and reconciliation counts;
- output-transfer retries.

Logs never contain credentials, full workflow media payloads, or raw prompt text.

## 15. Testing Strategy

### 15.1 Unit tests

- API Format graph validation and node references.
- Placeholder discovery, typed replacement, interpolation, and precedence.
- Explicit mapping validation and safe media transforms.
- Output mapping and primary output enforcement.
- Connection URL normalization and duplicate detection.
- Host/CIDR policy, IPv4-mapped IPv6, DNS rebinding, and redirect policy.
- Health-state derivation and compatibility classification.
- External ID parsing and generation-request polling.

### 15.2 Concurrency tests

- Two dispatchers racing for one connection produce one winning lease.
- Lease heartbeats cannot overwrite another lease.
- Stale owners cannot release a new lease.
- Each connection has at most one assigned nonterminal request.
- FIFO and least-recently-assigned behavior are deterministic.

### 15.3 Integration tests

A fake ComfyUI HTTP/WebSocket server covers:

- system stats, object info, models, and queue probes;
- authenticated and unauthenticated connections;
- input upload and workflow submission;
- prompt validation errors and node errors;
- WebSocket progress and disconnect fallback;
- queue/history reconciliation;
- image and video output download;
- cancellation of queued and running owned prompts;
- output-transfer retry without prompt resubmission.

### 15.4 Recovery and security tests

- waoowaoo restart before and after prompt acceptance.
- ComfyUI restart during execution.
- expired lease while ComfyUI still reports a running prompt.
- offline-to-online and incompatible-to-compatible auto-resume.
- cross-user connection, workflow, and request access.
- blocked metadata targets, malicious redirects, oversized responses, and DNS
  rebinding.

### 15.5 Regression and contract tests

- Existing image/video provider tests remain unchanged and pass.
- Configuration-center guards continue to prohibit provider guessing and model-key
  downgrade.
- A user-triggered real-instance contract test runs an imported workflow without
  requiring CI to download any model.

## 16. Acceptance Criteria

1. A user can add local and remote ComfyUI URLs and see accurate idle, busy,
   offline, authentication, and compatibility states.
2. A user can import an arbitrary image or video API Format workflow and declare
   placeholders, typed node-field mappings, input uploads, and output mappings.
3. A project can select default image and video workflows, and a task can override
   them.
4. Generated outputs are copied to waoowaoo storage and continue through existing
   image and video business flows.
5. The scheduler prefers a compatible idle instance and never runs two waoowaoo
   tasks concurrently on one instance.
6. When all compatible instances are busy, requests remain in waoowaoo and do not
   enter a ComfyUI queue.
7. An instance running a manual prompt is displayed as externally busy and receives
   no waoowaoo work.
8. Restart, disconnection, cancellation, and transfer failure do not cause duplicate
   workflow execution.
9. Allowlist mode blocks unauthorized network destinations, and trusted mode is an
   explicit deployment choice.
10. Users cannot access another user's connections, workflows, tasks, or outputs.
11. Existing providers and their regression tests remain functional.

## 17. Rollout

- Add schema migrations without modifying existing provider data.
- Hide ComfyUI controls when the deployment feature is disabled.
- With the feature enabled but no connection or workflow configured, existing
  behavior is unchanged.
- Start health monitoring only for enabled connections.
- Document Docker host access and network-mode configuration.
- Do not seed any workflow or model record.

## 18. External References

- ComfyUI server routes and WebSocket events:
  <https://docs.comfy.org/development/comfyui-server/comms_routes>
- ComfyUI workflow concepts:
  <https://docs.comfy.org/development/core-concepts/workflow>
- ComfyUI upstream repository:
  <https://github.com/Comfy-Org/ComfyUI>

## 19. Licensing Note

The waoowaoo repository is distributed under CC BY-NC-SA 4.0 and states that the
material may not be used commercially without appropriate permission. This design
does not change that license. Redistribution and deployment must continue to honor
the repository's license terms.
