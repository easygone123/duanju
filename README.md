<p align="center">
  <a href="https://www.waoowaoo.com/">
    <img src="images/cta-banner.png" alt="🚀 探索 AI 影视的下一代创作流 | 立即加入 waoowaoo 在线网页版内测候补" width="800">
  </a>
</p>

<p align="center">
  <img src="public/banner.png" alt="waoowaoo" width="600">
</p>

<h1 align="center">waoowaoo AI 影视 Studio</h1>

<p align="center">
  一款基于 AI 技术的短剧/漫画视频制作工具，支持从小说文本自动生成分镜、角色、场景，并制作成完整视频。
</p>

<p align="center">
  <a href="README_en.md">English</a> · <a href="https://www.waoowaoo.com/">加入内测候补</a> · <a href="https://github.com/saturndec/waoowaoo/issues">反馈问题</a>
</p>

> [!IMPORTANT]
> ⚠️ **测试版声明**：本项目目前处于测试初期阶段，由于暂时只有我一个人开发，存在部分 bug 和不完善之处。我们正在快速迭代更新中，**欢迎进群反馈问题和需求，及时关注项目更新！目前更新会非常频繁，后续会增加大量新功能以及优化效果，我们的目标是成为行业最强AI工具！**

<img src="https://github.com/user-attachments/assets/d190bf41-488d-47df-a5df-06346ef0f2f5" width="30%">

---
## ✨ 功能特性

- 🎬 **AI 剧本分析** — 自动解析小说，提取角色、场景、剧情
- 🎨 **角色 & 场景生成** — AI 生成一致性人物和场景图片
- 📽️ **分镜视频制作** — 自动生成分镜头并合成视频
- 🎙️ **AI 配音** — 多角色语音合成
- 🌐 **多语言支持** — 中文 / 英文界面，右上角一键切换

---

## 🚀 快速开始

**前提条件**：安装 [Docker Desktop](https://docs.docker.com/get-docker/)

### 方式一：拉取预构建镜像（最简单）

无需克隆仓库，下载即用：

```bash
# 下载 docker-compose.yml
curl -O https://raw.githubusercontent.com/saturndec/waoowaoo/main/docker-compose.yml

# 启动所有服务
docker compose up -d
```

> ⚠️ 当前为测试版，版本间数据库不兼容。升级请先清除旧数据：

```bash
docker compose down -v
docker rmi ghcr.io/saturndec/waoowaoo:latest
curl -O https://raw.githubusercontent.com/saturndec/waoowaoo/main/docker-compose.yml
docker compose up -d
```

> 启动后请**清空浏览器缓存**并重新登录，避免旧版本缓存导致异常。

### 方式二：克隆仓库 + Docker 构建（完全控制）

```bash
git clone https://github.com/saturndec/waoowaoo.git
cd waoowaoo
docker compose up -d
```

更新版本：
```bash
git pull
docker compose down && docker compose up -d --build
```

### 方式三：本地开发模式（开发者）

```bash
git clone https://github.com/saturndec/waoowaoo.git
cd waoowaoo

# 复制环境变量配置文件（必须在 npm install 之前完成）
cp .env.example .env
# ⚠️ 编辑 .env，填入你的 AI API Key（NEXTAUTH_URL 默认已是 http://localhost:3000，无需修改）

npm install

# 只启动基础设施
# 注意：docker-compose.yml 将服务映射到非标准端口，.env.example 已按此预设
mysql:13306  redis:16379  minio:19000
docker compose up mysql redis minio -d

# 初始化数据库表结构（首次必须执行，跳过会导致启动后报错）
npx prisma db push

# 启动开发服务器
npm run dev
```

> [!WARNING]
> 跳过 `npx prisma db push` 会导致所有数据库表不存在，启动后报错 `The table 'tasks' does not exist`。请务必先运行此命令再启动开发服务器。

---

访问 [http://localhost:13000](http://localhost:13000)（方式一、二）或 [http://localhost:3000](http://localhost:3000)（方式三）开始使用！

> 首次启动会自动完成数据库初始化，无需任何额外配置。

> [!TIP]
> **如果遇到网页卡顿**：HTTP 模式下浏览器可能限制并发连接。可安装 [Caddy](https://caddyserver.com/docs/install) 启用 HTTPS：
> ```bash
> caddy run --config Caddyfile
> ```
> 然后访问 [https://localhost:1443](https://localhost:1443)

---

## 🔧 API 配置

启动后进入**设置中心**配置 AI 服务的 API Key，内置配置教程。

> 💡 **注意**：目前仅推荐使用各服务商官方 API，第三方兼容格式（OpenAI Compatible）尚不完善，后续版本会持续优化。

---

## 🧩 ComfyUI 图片与视频生成

ComfyUI 作为原生 provider 与现有云端图片、视频 provider 共存。部署方先显式启用运行时；每位用户再在设置中心添加自己的 ComfyUI URL，连接和工作流默认仅添加者本人可用。

```env
COMFYUI_ENABLED=true
# 默认且推荐：只允许明确列出的主机或网段
COMFYUI_NETWORK_MODE=allowlist
COMFYUI_ALLOWED_HOSTS=comfy.example.com
COMFYUI_ALLOWED_CIDRS=192.168.1.0/24
# docker-compose.yml 也接受同名变量；未提供时使用安全默认值
COMFYUI_LEASE_TTL_MS=30000
COMFYUI_OUTPUT_MAX_BYTES=536870912

# 仅适用于你完全信任的自托管网络；必须显式选择
# COMFYUI_NETWORK_MODE=trusted
```

`allowlist` 是默认网络模式；它拒绝未授权目标，并且访问环回、LAN 等敏感地址时必须通过 `COMFYUI_ALLOWED_CIDRS` 明确授权。`trusted` 是显式的部署选择，不等于关闭全部防护，云凭证元数据端点仍会被阻止。容器内连接宿主机 ComfyUI 时使用 `http://host.docker.internal:8188`；Linux Docker 还需要配置 `host-gateway`，并把解析地址加入允许网段。不要在 URL 中嵌入用户名或密码。

连接支持无认证、Bearer token 和 Basic auth。凭证在设置中心配置并加密保存；状态只显示安全诊断：`online_idle`、`online_busy_owned`、`online_busy_external`、`offline`、`auth_failed`、`workflow_incompatible`。`online_busy_external` 表示实例正在执行手工或其他客户端提交的 prompt，waoowaoo 不会抢占它。

工作流配置流程：

1. 在 ComfyUI 中通过 **Save (API Format)** / **Export API Format** 导出 JSON；普通 UI workflow JSON 不能直接使用。
2. 导入后声明占位符或显式 node/input mappings、输入上传变量，以及至少一个 primary output mapping。图片和视频输出都必须明确映射，系统不会猜测节点。
3. 发布不可变版本，再配置项目级图片/视频默认工作流；具体任务仍可覆盖选择。

每个 ComfyUI 实例的 waoowaoo 并发固定为 1。所有兼容实例忙碌时，任务留在 waoowaoo queue 中等待空闲实例，不会提前塞进 ComfyUI queue。已接受 prompt 会固定在原实例进行恢复；重启、断线和输出传输重试不会重新提交。取消只自动删除经二次确认、属于当前任务的 queued prompt；运行中的 prompt 进入 canceling/reconciling，保留租约并等待 queue/history 自然终态，绝不会调用全局 `/interrupt` 误伤手工工作。所有映射输出会复制到 waoowaoo 存储后再进入现有业务流。

项目不内置、不下载也不自动选择任何 ComfyUI workflow、checkpoint、LoRA 或 custom node。模型和节点必须由实例管理员准备。

真实实例的授权合约检查是手动 opt-in，不属于默认 CI。工作流文件是包含 `graph`、`outputs`，以及可选 `variableDefinitions` / `bindings` / `variables` 的 JSON bundle；检查会沿用生产网络策略和认证，只输出脱敏耗时与主输出字节数：

```bash
COMFYUI_CONTRACT_URL=http://127.0.0.1:8188 \
COMFYUI_CONTRACT_WORKFLOW_FILE=/absolute/path/to/contract-workflow.json \
COMFYUI_ALLOWED_CIDRS=127.0.0.1/32 \
npm run check:comfyui-contract
```

可选认证变量为 `COMFYUI_CONTRACT_AUTH_TYPE=none|bearer|basic`，以及对应的 `COMFYUI_CONTRACT_AUTH_TOKEN` 或 `COMFYUI_CONTRACT_AUTH_USERNAME` / `COMFYUI_CONTRACT_AUTH_PASSWORD`。该命令会真实提交一次生成，请只使用专用的安全测试工作流。合约检查目前明确拒绝需要上传 `image_ref` / `video_ref` 的 bundle；请使用纯文本或内置值工作流。检查结束或失败时只会按 prompt ID 尽力删除自己的排队项并清理历史；若该 prompt 仍在运行，会短暂等待后输出脱敏的人工处理提示，绝不会调用全局 `/interrupt`，因此不会误伤手工 prompt。

本集成不改变仓库许可证：项目继续使用 **CC BY-NC-SA 4.0**，部署和再分发必须遵守非商业及署名、相同方式共享条款。

### 六宫格连续分镜

小说推文项目可选择 `six_grid` 模式，一次生成一张 3x2 分镜大图，再按固定几何切分为六个镜头。支持 `sheet_upscale_then_crop` 和 `crop_then_panel_upscale` 两种处理顺序；放大需在设置中发布用户自有的 ComfyUI upscale 工作流，项目不内置工作流。

```env
SIX_GRID_CROP_MAX_SOURCE_BYTES=52428800
SIX_GRID_CROP_MAX_SOURCE_PIXELS=32000000
```

部署新版本前先备份数据库，然后执行 `npx prisma migrate deploy`；本地开发环境仍可按上文使用 `npx prisma db push`。旧项目默认保持 `individual` 模式。

---

## 📦 技术栈

- **框架**: Next.js 15 + React 19
- **数据库**: MySQL + Prisma ORM
- **队列**: Redis + BullMQ
- **样式**: Tailwind CSS v4
- **认证**: NextAuth.js

---

## 📦 页面功能预览

![4f7b913264f7f26438c12560340e958c67fa833a](https://github.com/user-attachments/assets/fa0e9c57-9ea0-4df3-893e-b76c4c9d304b)
![67509361cbe6809d2496a550de5733b9f99a9702](https://github.com/user-attachments/assets/f2fb6a64-5ba8-4896-a064-be0ded213e42)
![466e13c8fd1fc799d8f588c367ebfa24e1e99bf7](https://github.com/user-attachments/assets/09bbff39-e535-4c67-80a9-69421c3b05ee)
![c067c197c20b0f1de456357c49cdf0b0973c9b31](https://github.com/user-attachments/assets/688e3147-6e95-43b0-b9e7-dd9af40db8a0)

---

## 🤝 参与方式

本项目由核心团队独立维护。欢迎你通过以下方式参与：

- 🐛 提交 [Issue](https://github.com/saturndec/waoowaoo/issues) 反馈 Bug
- 💡 提交 [Issue](https://github.com/saturndec/waoowaoo/issues) 提出功能建议
- 🔧 提交 Pull Request 供参考 — 我们会认真审阅每一个 PR 的思路，但最终由团队自行实现修复，不会直接合并外部 PR

---

**Made with ❤️ by waoowaoo team**

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=saturndec/waoowaoo&type=date&legend=top-left)](https://www.star-history.com/#saturndec/waoowaoo&type=date&legend=top-left)
