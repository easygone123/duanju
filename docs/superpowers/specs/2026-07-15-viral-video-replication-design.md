# 爆款复刻：参考视频拆解与原创分镜生成设计

**日期：** 2026-07-15  
**状态：** 用户已确认设计  
**目标版本：** MVP

## 1. 目标

在首页增加“爆款复刻”入口。用户上传一段短视频，并填写一句新的题材或人物要求。系统学习参考视频的节奏、镜头结构、构图、视觉和剪辑风格，先生成可审阅的拆解报告；用户确认后，再生成新的剧情梗概、可编辑分镜、图片提示词和视频提示词。

生成结果进入现有小说推文第 1 集工作区，继续复用当前分镜编辑和生图流程。MVP 不自动生成分镜图片或视频。

## 2. 已确认的产品决策

- 复刻对象是节奏、镜头结构、构图和提示词风格，不是原人物、原剧情或原台词。
- 入口位于首页，完成上传后自动创建草稿项目和第 1 集。
- 输入为单个 MP4 或 MOV 文件，时长 15 秒至 3 分钟，大小不超过 500 MB。
- 用户除视频外必须填写一句新题材或人物要求。
- 系统先展示拆解报告；只有用户确认后才生成原创分镜。
- 分析沿用系统当前配置的分析模型。视频先在服务端拆镜，再以关键帧、时间码和字幕上下文调用现有视觉分析能力。
- MVP 只生成分镜文案、图片提示词和视频提示词，不自动生图。
- 采用服务端 FFmpeg/FFprobe 预处理，不在浏览器中拆镜，也不依赖原生视频理解模型。
- MVP 仅保留必要的格式/大小/时长校验、统一失败重试和原子写入，不建设高级检查点、分步骤重试、相似度检测或复杂临时文件治理。

## 3. 非目标

- 不支持多视频合并分析。
- 不支持超过 3 分钟的自动分段。
- 不支持直接粘贴第三方视频 URL。
- 不要求分析模型原生接收整段视频。
- 不增加浏览器端 WebCodecs 或 WASM FFmpeg。
- 不新增完整 ASR 配置中心。MVP 提取内嵌字幕，并由视觉模型读取关键帧中的画面字幕；只有语音而没有字幕的视频可能缺少对白语义。
- 不自动生成图片、视频、配音或成片。
- 不覆盖已有项目或已有集；每次首页启动都创建新的草稿项目。

## 4. 用户流程

### 4.1 首页入口

首页新增“爆款复刻”入口。点击后打开上传面板，包含：

- 视频文件选择/拖放区；
- 新题材或人物要求输入框；
- 复用首页现有的视频比例和画风选择器，并使用当前默认值；
- 支持格式、时长和大小说明；
- “开始分析”按钮。

上传成功后，系统创建名称为 `爆款复刻-YYYYMMDD-HHmm` 的草稿项目和“第 1 集”，创建复刻记录，并跳转到：

`/[locale]/workspace/[projectId]/viral-replication/[replicationId]`

项目创建后立即出现在项目列表中；生成完成前，从该项目进入时默认返回复刻分析页，生成完成后默认进入现有分镜阶段。

### 4.2 分析页

分析页显示单一线性进度：

`上传校验 → 视频拆解 → 字幕处理 → 模型分析 → 等待确认`

报告完成后显示：

- 前三秒钩子与主要爆点；
- 节奏和情绪曲线的文字摘要；
- 构图、色彩、光线和剪辑规律；
- 逐镜头时间轴；
- 每镜头的景别、机位、运镜、动作、转场和叙事作用；
- 面向新题材的改写建议。

用户可以修改最初填写的新题材要求，然后点击“生成原创分镜”。MVP 不提供逐字段编辑拆解报告。

### 4.3 生成结果

生成任务成功后：

- 更新第 1 集的标题、简介和原创剧情文本；
- 写入现有 `NovelPromotionStoryboard` 与 `NovelPromotionPanel`；
- 每个 Panel 写入画面描述、时长、景别、运镜、`imagePrompt` 和 `videoPrompt`；
- 跳转到现有分镜阶段；
- 不触发图片或视频生成任务。

## 5. 系统边界与组件

### 5.1 上传与媒体存储

500 MB 文件不得在 Next.js Route Handler 中整体读成 `Buffer`。存储层增加流式上传能力：

- 本地存储使用流写入临时文件，完成后原子改名；
- MinIO/COS 使用流式或分片上传；
- 上传完成后创建 `MediaObject`，记录 MIME、字节数、宽高和时长；
- 任务载荷只保存媒体 ID，不保存 Base64 或大块二进制数据。

上传 API 分为两步：

1. `POST /api/viral-replications` 创建上传会话并返回 `replicationId`；
2. `PUT /api/viral-replications/[replicationId]/video` 流式上传文件。

上传完成后服务端验证文件并在一个事务中创建草稿项目、第 1 集及其关联关系，然后提交分析任务。若上传未完成，不创建项目。

### 5.2 视频预处理器

应用运行镜像加入 FFmpeg 和 FFprobe。预处理器负责：

- 读取真实容器格式、时长、视频流、音频流和字幕流；
- 检测场景切换并生成镜头时间段；
- 保证包含首帧，并为每个镜头提取一个代表帧；
- 当场景检测没有产生有效边界时，按固定间隔降级抽帧；
- 最多保存 72 张分析帧，避免超出模型上下文；
- 提取可用的内嵌文本字幕；
- 将关键帧保存为 `MediaObject`。

MVP 不对纯音轨执行语音识别。画面硬字幕由视觉模型在镜头分析时读取。

### 5.3 模型分析器

分析任务在提交时固定 `analysisModelSnapshot`，运行过程中不随用户设置变化。

模型调用分为两层：

1. **镜头批次分析：** 每批 8 至 12 张关键帧，附带时间码和可用字幕，调用现有 `chatCompletionWithVision` 能力；
2. **报告汇总：** 将所有批次的结构化结果交给同一分析模型，生成最终报告。

当前分析模型无法处理图片时，整个分析任务进入统一失败状态。MVP 不自动切换到其他模型。

### 5.4 原创分镜生成器

生成任务只读取：

- 已完成的结构化报告；
- 用户最终确认的新题材要求；
- 项目视频比例、画风和当前分析模型快照。

生成器使用文本分析模型产生严格结构化输出，先完整校验，再在单个数据库事务中写入第 1 集、Storyboard 和 Panel。任何解析或写入失败都不保留部分分镜。

### 5.5 队列

新增 `viral-replication` 队列与 worker，处理两种任务：

- `viral_video_analysis`
- `viral_storyboard_generation`

两种任务均使用现有 `Task`、TaskEvent 和 SSE 展示状态。MVP 将任务 `maxAttempts` 设为 1；用户点击“重试”时创建一项新的完整任务，并复用已成功上传的源视频。

## 6. 数据模型

### 6.1 ViralReplication

新增 `ViralReplication`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | UUID | 主键 |
| `userId` | String | 所有者 |
| `projectId` | String? | 上传验证成功后关联草稿项目 |
| `episodeId` | String? | 上传验证成功后关联第 1 集 |
| `sourceVideoMediaId` | String? | 源视频媒体 |
| `brief` | Text | 用户的新题材/人物要求 |
| `videoRatio` | String | 创建项目时使用的视频比例 |
| `artStyle` | String | 创建项目时使用的画风 |
| `status` | String | 当前状态 |
| `analysisModelSnapshot` | String? | 提交任务时固定的模型键 |
| `durationMs` | Int? | FFprobe 得到的真实时长 |
| `transcriptText` | LongText? | 内嵌字幕文本，可为空 |
| `reportJson` | Json? | 已校验的拆解报告 |
| `reportVersion` | Int | 报告契约版本，初始为 1 |
| `errorMessage` | Text? | 统一用户可读错误 |
| `confirmedAt` | DateTime? | 用户确认报告时间 |
| `createdAt` / `updatedAt` | DateTime | 审计时间 |

状态值限定为：

- `uploading`
- `analyzing`
- `review_ready`
- `generating`
- `completed`
- `failed`

### 6.2 ViralReplicationFrame

新增 `ViralReplicationFrame`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | UUID | 主键 |
| `replicationId` | String | 所属复刻记录 |
| `mediaId` | String | 关键帧媒体 |
| `shotIndex` | Int | 镜头序号，从 0 开始 |
| `timestampMs` | Int | 帧在源视频中的时间 |
| `startMs` / `endMs` | Int | 镜头时间范围 |

约束：`(replicationId, shotIndex)` 唯一，并为 `replicationId` 建索引。

## 7. 结构化契约

### 7.1 拆解报告

报告使用版本化 JSON Schema：

```ts
interface ViralAnalysisReportV1 {
  schemaVersion: 1
  overview: {
    hook: string
    coreAppeal: string
    pacing: string
    emotionalArc: string
  }
  styleFingerprint: {
    composition: string[]
    lighting: string[]
    color: string[]
    editing: string[]
  }
  shots: Array<{
    shotIndex: number
    startMs: number
    endMs: number
    shotType: string
    cameraAngle: string
    cameraMove: string
    composition: string
    actionBeat: string
    transition: string
    subtitleSummary: string | null
    narrativeFunction: string
  }>
  originalAdaptationAdvice: string[]
}
```

校验规则：

- `schemaVersion` 必须为 1；
- `shots` 非空并按 `shotIndex` 连续排序；
- 每个镜头满足 `0 <= startMs < endMs <= durationMs`；
- 镜头时间范围不得倒序；
- 所有文本字段均设置长度上限。

### 7.2 原创分镜输出

```ts
interface ViralStoryboardGenerationV1 {
  schemaVersion: 1
  title: string
  synopsis: string
  novelText: string
  characters: Array<{
    name: string
    description: string
  }>
  storyboards: Array<{
    sequence: number
    summary: string
    panels: Array<{
      panelIndex: number
      durationSeconds: number
      shotType: string
      cameraMove: string
      description: string
      imagePrompt: string
      videoPrompt: string
      sourceNarrativeFunction: string
    }>
  }>
}
```

生成结果必须至少包含一个 Storyboard 和一个 Panel。Panel 顺序连续，时长为正数。写入前将模型输出映射到现有数据库字段，不新增第二套分镜运行时类型。

## 8. 最小失败处理

MVP 只保留三类必要保护：

1. **上传校验：** 文件头、容器格式、500 MB、15 秒至 3 分钟；
2. **统一失败：** 任一处理步骤失败后，复刻记录为 `failed`，页面显示一条统一错误和“重新分析”按钮；
3. **原子写入：** 生成结果全部校验成功后才写入分镜事务。

重新分析复用源视频，但重新运行完整的拆镜和模型分析。MVP 不保存步骤级检查点，也不自动重试单个步骤。

## 9. API

| 方法与路径 | 用途 |
| --- | --- |
| `POST /api/viral-replications` | 创建上传会话，保存 brief、videoRatio 和 artStyle |
| `PUT /api/viral-replications/[id]/video` | 流式上传并提交分析任务 |
| `GET /api/viral-replications/[id]` | 读取状态、报告和关联项目 |
| `PATCH /api/viral-replications/[id]` | 在确认前更新 brief |
| `POST /api/viral-replications/[id]/retry` | 重新运行完整分析 |
| `POST /api/viral-replications/[id]/generate` | 确认报告并提交原创分镜任务 |

所有路由必须验证当前用户拥有复刻记录及其关联项目。上传与写路由使用现有认证和 API 错误包装约定。

## 10. 前端组件

新增边界清晰的组件：

- `ViralReplicationLauncher`：首页入口和上传面板；
- `ViralReplicationUploadField`：文件选择、客户端初步校验和上传进度；
- `ViralReplicationPage`：加载记录并路由状态；
- `ViralReplicationProgress`：线性状态展示；
- `ViralAnalysisReport`：报告概览和逐镜头时间轴；
- `ViralBriefEditor`：确认前编辑新题材要求；
- `ViralGenerateAction`：提交生成并跳转现有分镜阶段。

页面使用独立查询键 `queryKeys.viralReplication.detail(id)`。SSE 只更新这条详情缓存，不触发整项目 refetch。

## 11. 测试

### 11.1 单元测试

- 文件格式、大小和时长边界；
- FFprobe 元数据解析；
- 镜头边界与固定间隔降级；
- 72 帧上限和 8 至 12 帧分批；
- 报告 Schema 校验；
- 原创分镜 Schema 校验；
- 分镜输出到现有 Panel 字段的映射；
- 前端状态到页面组件的映射。

### 11.2 集成测试

- 上传成功后创建 MediaObject、草稿项目、第 1 集和分析任务；
- 无效格式、超大文件和超时长视频被拒绝；
- `viral_video_analysis` 写入可读取报告；
- 更新 brief 后生成任务使用最新 brief；
- 生成失败时数据库中没有部分 Storyboard/Panel；
- 生成成功后现有 episode-stage API 能读取新分镜和提示词；
- TaskEvent/SSE 只刷新复刻详情。

### 11.3 系统测试

仓库加入一段体积小、许可明确、包含至少三个场景切换的 MP4 测试夹具。系统测试运行真实 FFmpeg/FFprobe；模型调用使用确定性测试响应。

端到端验收：

1. 首页可选择视频并填写 brief；
2. 上传后自动进入草稿项目分析页；
3. 报告展示概览和逐镜头时间轴；
4. 用户确认后生成原创剧情、分镜、图片提示词和视频提示词；
5. 结果可在现有第 1 集分镜阶段继续编辑；
6. 不产生图片、视频或配音任务；
7. 刷新页面后仍能读取报告与最终结果。

## 12. 部署与兼容性

- 在开发、生产和测试容器中安装版本固定的 FFmpeg/FFprobe；
- 启动时检查二进制可用性，缺失时功能入口显示不可用；
- 新增 Prisma migration，不修改现有项目和分镜默认行为；
- 旧项目不创建复刻记录，现有文本到分镜流程不变；
- 新队列沿用现有 Redis/BullMQ 连接和 worker 启动方式；
- 上线前运行数据库迁移并确认媒体存储支持流式上传。

## 13. 完成定义

满足以下条件视为 MVP 完成：

- 用户能从首页完成单视频上传、报告审阅和原创分镜生成；
- 参考视频分析使用当前配置的分析模型和服务端关键帧；
- 输出进入现有第 1 集分镜数据结构；
- 上传边界、统一失败重试和分镜原子写入有效；
- 所有新增单元、集成和系统测试通过；
- 现有 `verify:push` 和生产构建通过；
- 未配置或不支持视觉分析模型时，功能失败可见且不会写入分镜；
- 系统不会自动提交图片或视频生成任务。
