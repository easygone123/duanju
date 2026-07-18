# Internal Media Proxy Storage Design

## Problem

Storyboard images and finished-film videos are projected to stable same-origin `/m/{publicId}` URLs. The `/m` route currently turns the storage key into `/api/storage/sign`, calls that route through `INTERNAL_APP_URL`, and follows its redirect. For MinIO, that redirect is signed against `MINIO_PUBLIC_ENDPOINT`, whose Docker default is `http://localhost:19000`.

Inside the app container, `localhost:19000` is not the MinIO container. The proxy therefore cannot fetch the object and returns a failed media response. Images and videos fail together because both use the same `/m` route.

## Goals

- Keep browser-facing media URLs same-origin as `/m/{publicId}`.
- Make the server-side proxy fetch MinIO through `MINIO_ENDPOINT`, not `MINIO_PUBLIC_ENDPOINT`.
- Preserve byte-range forwarding and `206 Partial Content` responses for video seeking.
- Preserve the existing public signed-URL behavior for routes that intentionally redirect a browser.
- Cover image, full-video, and ranged-video responses with regression tests.

## Non-goals

- Do not change storyboard or video database records.
- Do not expose Docker service names to browsers.
- Do not change media ownership, public IDs, cache policy, or UI components.
- Do not add a second browser-visible media URL format.

## Considered Approaches

### 1. Separate internal and public signed URLs (selected)

Add an internal-object URL method to the storage provider contract. MinIO signs browser redirects with the public signing client and signs proxy fetches with its internal client. Local storage returns its existing same-origin file route. The `/m` route uses the internal-object URL directly and continues proxying the upstream response.

This is the smallest change that fixes the container network boundary while preserving streaming and Range behavior.

### 2. Stream objects directly from every provider

Extend the provider contract with range-aware object reads and response metadata, then remove the proxy's HTTP fetch. This is architecturally clean but requires broader changes across providers and duplicates mature HTTP range behavior already supplied by S3/MinIO.

### 3. Require a public endpoint reachable from both browser and container

Operators could configure a host name that resolves from both environments. This is only a deployment workaround, remains fragile on local Docker installations, and does not separate browser and server concerns.

## Design

The storage provider contract gains `getInternalSignedObjectUrl(params)`. Its meaning is explicit: return an object URL intended only for server-to-storage traffic.

- MinIO uses the client configured with `MINIO_ENDPOINT` for this method.
- MinIO retains the client configured with `MINIO_PUBLIC_ENDPOINT` for `getSignedObjectUrl`.
- Local storage returns `/api/files/{key}` for both methods; the storage facade converts the internal result to an absolute `INTERNAL_APP_URL` before server-side fetch.
- COS retains its current not-implemented behavior.

The storage facade exposes `getInternalObjectUrl(key, expires)`, awaits the provider method, and normalizes relative routes into server-fetchable absolute URLs.

The `/m/{publicId}` route replaces `toFetchableUrl(getSignedUrl(storageKey))` with `getInternalObjectUrl(storageKey)`. It continues forwarding the incoming `Range` header and mirrors upstream `Content-Type`, `Content-Length`, `Content-Range`, and `Accept-Ranges`. It returns the upstream status for successful `200` and `206` responses.

## Error Handling

- Missing media objects remain `404`.
- Missing storage keys remain `500`.
- Upstream `404` remains `404`; other unsuccessful upstream responses remain `502`.
- Provider or network exceptions remain visible to the route error boundary and logs; no fallback to the public endpoint is allowed because that would recreate the bug.

## Tests

- Storage provider test: browser signing uses `MINIO_PUBLIC_ENDPOINT`; internal signing uses `MINIO_ENDPOINT` and separate clients.
- Media route test: image request fetches the internal URL and returns body/content type.
- Media route test: video request forwards `Range`, returns `206`, and preserves `Content-Range`, `Content-Length`, and `Accept-Ranges`.
- Regression assertion: the `/m` route never calls the browser redirect helper.
- Focused typecheck/lint plus the relevant storage and media test suites.

## Acceptance Criteria

- A storyboard image served as `/m/{publicId}` loads without a MinIO host visible to the browser.
- A finished-film video served as `/m/{publicId}` starts playback and can seek through byte ranges.
- `MINIO_PUBLIC_ENDPOINT=http://localhost:19000` no longer affects `/m` proxy reads inside Docker.
- Existing `/api/storage/sign` browser redirects still use `MINIO_PUBLIC_ENDPOINT`.
