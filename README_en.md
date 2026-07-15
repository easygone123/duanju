<p align="center">
  <img src="public/banner.png" alt="waoowaoo" width="600">
</p>

<h1 align="center">waoowaoo AI Video Studio</h1>

<p align="center">
  An AI-powered tool for creating short drama / comic videos — automatically generates storyboards, characters, and scenes from novel text, then assembles them into complete videos.
</p>

<p align="center">
  <a href="README.md">中文文档</a> · <a href="https://www.waoowaoo.com/">Join Waitlist</a> · <a href="https://github.com/saturndec/waoowaoo/issues">Report Bug</a>
</p>

> [!IMPORTANT]
> **Beta Notice**: This project is currently in its early beta stage. As it is currently a solo-developed project, some bugs and imperfections are to be expected. We are iterating rapidly — please stay tuned for frequent updates! We are committed to rolling out a massive roadmap of new features and optimizations, with the ultimate goal of becoming the top-tier solution in the industry. Your feedback and feature requests are highly welcome!

---

## ✨ Features

- 🎬 **AI Script Analysis** — Parse novels, extract characters, scenes & plot automatically
- 🎨 **Character & Scene Generation** — Consistent AI-generated character and scene images
- 📽️ **Storyboard Video** — Auto-generate shots and compose into complete videos
- 🎙️ **AI Voiceover** — Multi-character voice synthesis
- 🌐 **Bilingual UI** — Chinese / English, switch in the top-right corner

---

## 🚀 Quick Start

**Prerequisites**: Install [Docker Desktop](https://docs.docker.com/get-docker/)

### Method 1: Pull Pre-built Image (Easiest)

No need to clone the repository. Just download and run:

```bash
# Download docker-compose.yml
curl -O https://raw.githubusercontent.com/saturndec/waoowaoo/main/docker-compose.yml

# Start all services
docker compose up -d
```

> ⚠️ This is a beta version. Database is not compatible between versions. To upgrade, clear old data first:

```bash
docker compose down -v
docker rmi ghcr.io/saturndec/waoowaoo:latest
curl -O https://raw.githubusercontent.com/saturndec/waoowaoo/main/docker-compose.yml
docker compose up -d
```

> After starting, please **clear your browser cache** and log in again to avoid issues caused by stale cache.

### Method 2: Clone & Docker Build (Full Control)

```bash
git clone https://github.com/saturndec/waoowaoo.git
cd waoowaoo
docker compose up -d
```

To update:
```bash
git pull
docker compose down && docker compose up -d --build
```

### Method 3: Local Development (For Developers)

```bash
git clone https://github.com/saturndec/waoowaoo.git
cd waoowaoo

# Copy environment config (must be done before npm install)
cp .env.example .env
# ⚠️ Edit .env to fill in your AI API Keys (NEXTAUTH_URL defaults to http://localhost:3000, no change needed)

npm install

# Start infrastructure only
docker compose up mysql redis minio -d

# Run database migration
npx prisma db push

# Start development server
npm run dev
```

---

Visit [http://localhost:13000](http://localhost:13000) (Method 1 & 2) or [http://localhost:3000](http://localhost:3000) (Method 3) to get started!

> The database is initialized automatically on first launch — no extra configuration needed.

> [!TIP]
> **If you experience lag**: HTTP mode may limit browser connections. Install [Caddy](https://caddyserver.com/docs/install) for HTTPS:
> ```bash
> caddy run --config Caddyfile
> ```
> Then visit [https://localhost:1443](https://localhost:1443)

---

## 🔧 API Configuration

After launching, go to **Settings** to configure your AI service API keys. A built-in guide is provided.

> 💡 **Note**: Currently only official provider APIs are recommended. Third-party compatible formats (OpenAI Compatible) are not yet fully supported and will be improved in future releases.

---

## 🧩 ComfyUI Image and Video Generation

ComfyUI is a native provider that coexists with every existing cloud image and video provider. The runtime is enabled by default, and each user can add their own ComfyUI URL directly in Settings. Connections and workflows are private to their creator by default.

```env
COMFYUI_ENABLED=true
# Default: let users add trusted self-hosted ComfyUI instances
COMFYUI_NETWORK_MODE=trusted
# docker-compose.yml accepts the same names and uses the defaults above when omitted
COMFYUI_LEASE_TTL_MS=30000
COMFYUI_OUTPUT_MAX_BYTES=536870912
```

> ⚠️ **Multi-user security warning**: Any deployment with login users who are not fully trusted must use `allowlist` mode. Upgrade warning: existing deployments that leave both variables unset will change from disabled/allowlist to enabled/trusted; assess the risk and configure them explicitly before upgrading.

Public multi-user deployments can explicitly switch to the stricter allowlist mode:

```env
COMFYUI_NETWORK_MODE=allowlist
COMFYUI_ALLOWED_HOSTS=comfy.example.com
COMFYUI_ALLOWED_CIDRS=192.168.1.0/24
```

`trusted` is the default network mode, so local and self-hosted deployments can add loopback or LAN instances directly. `trusted` still lets user-supplied URLs reach other HTTP services on loopback or the LAN; it is not a destination-isolation boundary. It is not a complete security bypass: cloud credential metadata endpoints, credentials embedded in URLs, and unsafe redirects remain blocked. `allowlist` rejects unauthorized destinations, and loopback/LAN targets require authorization through `COMFYUI_ALLOWED_CIDRS`. From a container, reach ComfyUI on the Docker host at `http://host.docker.internal:8188`; Linux Docker also needs a `host-gateway` mapping, plus the resolved address in an allowed CIDR when allowlist mode is used. Never embed credentials in the URL.

Connections support no auth, a Bearer token, or Basic auth. Credentials are configured in Settings and stored encrypted. Only sanitized states are exposed: `online_idle`, `online_busy_owned`, `online_busy_external`, `offline`, `auth_failed`, and `workflow_incompatible`. `online_busy_external` means a manual or another client's prompt is active, so waoowaoo will not claim that instance.

Workflow setup:

1. In ComfyUI, use **Save (API Format)** / **Export API Format**. A regular UI workflow JSON is not accepted.
2. After import, declare placeholders or explicit node/input mappings, uploaded inputs, and at least one primary output mapping. Image and video outputs must be explicit; the system does not guess nodes.
3. Publish the immutable version, then choose project-level image and video defaults. An individual task can still override that selection.

waoowaoo concurrency is fixed at 1 for each ComfyUI instance. When every compatible instance is busy, work remains in the waoowaoo queue and is not preloaded into the ComfyUI queue. An accepted prompt stays pinned to its original instance for recovery; restart, disconnect, and output-transfer retries do not resubmit it. Cancellation only auto-deletes an exact queued prompt after a second ownership-aware queue check. A running prompt stays canceling/reconciling with its lease until queue/history reaches a natural terminal state; production never calls global `/interrupt`, so manual work remains untouched. Every mapped output is copied into waoowaoo storage before continuing through existing business flows.

The project ships, downloads, and auto-selects no built-in ComfyUI workflow, checkpoint, LoRA, or custom node. Instance operators provide all models and nodes.

The authorized real-instance contract check is manually opt-in and excluded from default CI. Its workflow file is a JSON bundle containing `graph`, `outputs`, and optional `variableDefinitions` / `bindings` / `variables`. It uses the production network policy and auth path and prints only sanitized timings plus the primary output byte count:

```bash
COMFYUI_CONTRACT_URL=http://127.0.0.1:8188 \
COMFYUI_CONTRACT_WORKFLOW_FILE=/absolute/path/to/contract-workflow.json \
COMFYUI_NETWORK_MODE=allowlist \
COMFYUI_ALLOWED_CIDRS=127.0.0.1/32 \
npm run check:comfyui-contract
```

Optional auth variables are `COMFYUI_CONTRACT_AUTH_TYPE=none|bearer|basic` and the corresponding `COMFYUI_CONTRACT_AUTH_TOKEN` or `COMFYUI_CONTRACT_AUTH_USERNAME` / `COMFYUI_CONTRACT_AUTH_PASSWORD`. This command performs one real generation; use a dedicated safe test workflow. The contract check explicitly rejects bundles requiring uploaded `image_ref` / `video_ref` inputs; use a text-only or built-in-value workflow. On success or failure it only best-effort deletes its exact queued prompt and clears history. If that prompt is still running, it waits briefly and emits a sanitized operator-required notice; it never calls global `/interrupt`, so manual prompts remain untouched.

This integration does not change the repository license. The project remains under **CC BY-NC-SA 4.0**, and deployment or redistribution must honor its attribution, non-commercial, and share-alike terms.

### Continuous six-grid storyboards

Novel-promotion projects can opt into `six_grid` mode to generate one 3x2 storyboard sheet and deterministically crop it into six shots. Both `sheet_upscale_then_crop` and `crop_then_panel_upscale` are supported. Upscaling requires a user-owned ComfyUI upscale workflow published in Settings; the project does not bundle workflows.

```env
SIX_GRID_CROP_MAX_SOURCE_BYTES=52428800
SIX_GRID_CROP_MAX_SOURCE_PIXELS=32000000
```

Back up the database and run `npx prisma migrate deploy` before deploying the new version. Local development may continue to use `npx prisma db push` as described above. Existing projects remain in `individual` mode by default.

---

## ⚡ Workspace performance acceptance

Run `npm run perf:workspace -- --compare` for a reproducible workspace performance comparison. The command validates architecture budgets with fixed clocks and fixtures, independent of machine load. The repository does not currently bundle an authenticated browser fixture, so this table is not a real-browser benchmark; browser measurements are supporting evidence only.

| Scenario | Metric | Pre-optimization baseline | Current contract |
| --- | --- | ---: | ---: |
| Cold storyboard entry | Visible time | 1240 ms | 620 ms |
| Cold storyboard entry | Requests / bytes | 3 / 1,876,000 B | 2 / 300,000 B |
| Cold storyboard entry | JS chunks / mounted card bodies | 2 / 96 | 2 / 18 |
| Cold storyboard entry | Refetches | 2 | 0 |
| Cached stage switch | Visible time | 460 ms | 180 ms (budget ≤ 300 ms) |
| Cached stage switch | Requests / bytes | 1 / 1,480,000 B | 0 / 0 B |
| Cached stage switch | JS chunks / mounted card bodies | 0 / 96 | 0 / 18 |
| Cached stage switch | Whole-project refetches | 1 | 0 |

The initial data request names are exactly `project-shell` and `storyboard-stage`; unrelated task-completion refetches are exactly 0. CI enforces these budgets in `tests/performance/workspace-performance.contract.test.ts` and `tests/system/workspace-stage-performance.system.test.ts`.

---

## 📦 Tech Stack

- **Framework**: Next.js 15 + React 19
- **Database**: MySQL + Prisma ORM
- **Queue**: Redis + BullMQ
- **Styling**: Tailwind CSS v4
- **Auth**: NextAuth.js

---

## 📦 Preview

![4f7b913264f7f26438c12560340e958c67fa833a](https://github.com/user-attachments/assets/fa0e9c57-9ea0-4df3-893e-b76c4c9d304b)
![67509361cbe6809d2496a550de5733b9f99a9702](https://github.com/user-attachments/assets/f2fb6a64-5ba8-4896-a064-be0ded213e42)
![466e13c8fd1fc799d8f588c367ebfa24e1e99bf7](https://github.com/user-attachments/assets/09bbff39-e535-4c67-80a9-69421c3b05ee)
![c067c197c20b0f1de456357c49cdf0b0973c9b31](https://github.com/user-attachments/assets/688e3147-6e95-43b0-b9e7-dd9af40db8a0)

---

## 🤝 Contributing

This project is maintained by the core team. You're welcome to contribute by:

- 🐛 Filing [Issues](https://github.com/saturndec/waoowaoo/issues) — report bugs
- 💡 Filing [Issues](https://github.com/saturndec/waoowaoo/issues) — propose features
- 🔧 Submitting Pull Requests as references — we review every PR carefully for ideas, but the team implements fixes internally rather than merging external PRs directly

---

**Made with ❤️ by waoowaoo team**

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=saturndec/waoowaoo&type=date&legend=top-left)](https://www.star-history.com/#saturndec/waoowaoo&type=date&legend=top-left)
