# Data Plan

## Context provenance
- `做一个通用的视频生成工作流，什么类型的视频都能做，包括短剧、漫剧 / 绘本、口播短视频、产品种草视频等，不要只针对某一种视频写死。` (prior user statement; 视频类型做成项目字段而非写死模板)
- `左侧是工作流面板，右侧是无限画布` + 六步工作流、角色棚、连续性台账、后台任务、文本模型设置等全部细则 (prior user statement in ~/workspace/user/files/muse.md, read verbatim at build start; drives the whole schema and action design below)
- `不要加任何测试内容，也不要自己完整走一遍流程测试…不要为了测试实际生成视频、定妆图或消耗额度` (prior user statement; 验证只做页面加载与非生成类交互，不建测试项目、不触发生成)
- `直接调用你（Muse）自己的视频生成能力，不要让我再去接入外部视频服务` (prior user statement; 视频与定妆图只走 Muse 运行时通道，自定义模型仅限文本)

## Tested sources
### Muse 文本推理 ctx.inference.complete（脚本生成、拆分镜、角色提取/补描述、连续性核对/修复、发布文案的默认通道；自定义模型未配置时使用）
**Used by**: startJob 派发的文本类 job 处理器（经 jobs 表 + spawnTask 分步执行）、设置页默认文本来源
**Test command**: `bun /opt/muse/assets/spaces/ts-runtime/dist/probe-ctx.js < /tmp/probe2.ts`（snippet 调用 ctx.inference.complete 并要求 zod 结构化输出）
**Sample output**: `{"inference_ok":true,"intro":"这是一部讲述都市白领在职场打拼与情感纠葛中逆袭成长的短剧。"}`
**Processing**: 所有文本任务都要求结构化 JSON 输出（脚本为纯文本字段、分镜为数组、核对为结论枚举），由 zod schema 校验后逐条落库；长脚本按段切分、一次只处理一小段，逐段保存实现断点续跑。

### Muse 图片生成 ctx.tool.generate_media（角色定妆图，永远只用 Muse）
**Used by**: 定妆图 job（单张与一键全部，一批 3 个并行）
**Test command**: 探针模式明确返回 `ctx.tool.generate_media is not available in probe mode — requires a built web artifact`；能力以 SDK 类型为准：`/opt/hatch/skills/spaces/ts-runtime/dist/space-ts-deps/node_modules/@hatch/space-sdk/dist/verticals.d.ts` 中 `generate_media(prompt, options): Promise<GeneratedMedia>`，返回已存入本空间 ctx.blobs 的 blobKey 与 own-origin url。
**Sample output**: 文档契约：`{ blobKey, url, contentType, bytes }`，图片直接存本空间 blob 存储。
**Processing**: 以角色四项定妆描述拼中文提示词生成肖像定妆图；成功即把 image_blob_key 写入 characters 并自动 locked=1；重新生成时新图成功落库后才替换旧 key，失败保留旧图并把原因写回角色卡。

### Muse 视频生成（经 ctx.agent.spawnTask 后台 agent 调用 media.generate_video）
**Used by**: 单镜生成、并发生成全部（每批 ≤6）、收片处理
**Test command**: SDK 契约核查：同一 verticals/index 类型文件中 ctx.tool 只有 generate_media（图片），无视频方法；视频生成是 agent 工具，故走 `ctx.agent.spawnTask(message, { expectsAction, dedupeKey })`——index.d.ts 明确 spawnTask 立即返回 taskId、结果经 expectsAction 动作回写。按用户明示不为测试消耗视频额度，本通道未在计划阶段实跑。
**Sample output**: 契约：`{ ok: true, taskId, agentId, messageId }`；agent 生成真视频文件后调用 saveShotVideo 回写 blob key、时长与失败原因（额度耗尽单独标记 quota_exceeded，UI 禁止反复重试）。
**Processing**: 每镜一个后台任务，任务消息自包含：中文提示词＋本镜角色定妆描述与定妆图＋上一镜结尾状态承接＋台词口型同步与画外音旁白要求＋字幕样式（白字黑描边、无底色）。生成成功才置 done；已 done 的镜头永不重复生成；失败保留 fail_reason，重试只补失败镜。

### 宿主机 ffmpeg 8.1.2（拼接成片）
**Used by**: stitchFinal job（经 spawnTask agent 在宿主机执行 ffmpeg）
**Test command**: `which ffmpeg ffprobe; ffmpeg -version | head -3`
**Sample output**: `/usr/bin/ffmpeg`，`ffmpeg version 8.1.2`，含 libx264、libass、libfreetype（可烧字幕）。
**Processing**: 短片用尾帧定格＋叠化、长片用无损 concat；只保留各镜原片音轨，绝不二次配音；字幕以白字＋黑色描边烧录（无背景色块）；产物回写为 final blob 并记录总时长、分辨率、镜头数供预览与下载。

### 用户自定义文本模型（OpenAI 兼容 /v1/chat/completions，可选）
**Used by**: 文本来源选 custom 时的全部文本任务与连续性并发核对/修复、设置页测试连接
**Test command**: 无用户提供的接口可测（用户尚未配置）；实现为服务端 fetch POST `{baseUrl}/v1/chat/completions`，Bearer 鉴权，失败按连接失败/鉴权失败/模型不存在/超时分类回显。
**Sample output**: 不适用（用户配置后由测试连接按钮当场验证）。
**Processing**: API Key 只存 settings 表，接口只回掩码（末 4 位）；切换即时生效于新任务，不影响在跑任务与已保存数据；自定义通道下连续性核对/修复按批并发调用该接口。

## Web-search sources
无。本应用不依赖任何网络检索数据，全部内容由用户输入与 Muse 生成通道产生。

## Agent-task sources
### 后台任务执行（ctx.agent.spawnTask + jobs 表）
**Delivered by**: startJob 创建 jobs 行并 spawnTask（expectsAction=jobStep 回写）→ jobStep 每步只推进一小块并落库 → 客户端每 4 秒轮询 getProject 拉取进度
**Checked with**: SDK index.d.ts 的 AgentClient 契约（spawnTask 立即返回、expectsAction 回写、dedupeKey 单飞防重复点击）。

## Stuck-shot self-healing（2026-11-13 按用户要求「卡住就重新生成，不要死板」补强）
- 事故根因（项目 5 第 3 镜，shots.id 15）：收片任务（job 30）已把视频存入 blob 并置 done，随后一个重复派发的任务（job 32）经 spawnVideoTask 无条件把状态打回 generating 且再无回写，该镜永久卡住；批量任务（job 35）把它算作 inFlight 永不结束；拼接因 genStatus≠done 反复拒绝，尽管视频文件其实已在库里。
- 同日第二处修复（拼接 30 秒超时，jobs 31/37/38/40/41 五连败）：同步 executeStitch 一次调用要跑完多段全量转码，必超动作调用时限。改为后台独立进程：privileged 新增 stitchBackground——把同一 stitchMain 函数序列化成 runner 脚本、用宿主运行时 detached 派发，结果/错误写 marker 文件（stitch-work/<jobId>/result.json、error.txt），调用只负责启动/轮询、秒回；已转码的 seg 与 joined.mp4 跨尝试复用。executeStitch 改为非阻塞轮询（进行中返回 ok:false），stepJob 的 stitch 驱动（pollStitch）在全齐后自动启动并收取成片，拼接不再派发 agent 任务。
- 修复（server/src/actions.ts）：① reconcileShotStates——凡 video_blob_key 已落库且状态为 generating/processing 的镜头一律校正为 done，getProject / startJob / advanceJob(stepJob) / executeStitch 入口都先校正；② spawnVideoTask 派发前先查状态，已 done 绝不打回 generating，dedupeKey 带 jobId+attempt 防重复任务互相覆盖；③ 卡住判定：generating 超 15 分钟、processing 超 5 分钟无回写即判卡住，单镜任务与批量任务自动重新生成（每镜上限 2 次，超限明确报错让用户手动重试，防无限烧额度）；④ processing 且 job detail 里留有 sourcePath 时先补收原片文件，不重新生成；⑤ jobStep(fail) 迟到的失败回写不再覆盖已有视频的镜头、也不再误杀不属于自己的 job；⑥ 拼接不再硬拒绝：startJob(stitch) 在镜头未齐时也建任务，stepJob 驱动它先自动补齐/重生成缺失镜头、全齐后才派发拼接任务，拼接任务派发后 30 分钟无回写判失败；⑦ 画布卡片在生成中状态下提供「卡住了？重新生成」按钮，服务端确认真卡住才接管重派、没卡住则提示任务仍在运行。

## 第 4 步人物一致性硬门禁（2026-11-14 按用户要求「把它做进工作流第 4 步」新增）
- 用户原话：`把它做进工作流第 4 步：每镜生成时带全员定妆锚图（含背景人物）、提示词写死特征、抽帧硬验不过就重生成，不通过不让进拼接。` 背景铁律（用户 2026-11-13 定）：角色性别、脸、服装跨镜不一致零容忍；验片必须逐镜抽多帧、连背景里只露半边的人物都查到，背景龙套也要锚图锁死。
- 生成侧（jobStep claim + spawnVideoTask 任务消息）：payload.characters 给全员（含背景人物）定妆描述+定妆图 blob key+mustMatch 写死特征串（性别/外貌/发型/服装逐字带入提示词），payload.hardRules 明文四条：全员锚图、特征写死、名单外零人物（背景/远景/半边人都不行）、硬验门禁预告。
- 硬验侧（advanceShotQa / verifyShotConsistency，server/src/actions.ts）：收片（saveShotVideo）后镜头只算「已生成、待硬验」（shots.qa_status=pending）；驱动在 advanceJob 轮询步里执行——privileged.extractFrames 用宿主机 ffmpeg 从成片抽 4 帧（512px JPEG），privileged.readBlobImage 读每个绑定角色的定妆锚图（512px），一并交给 ctx.inference.complete 视觉核对（锚图读不到则按文字特征从严核对并注明）；核对规则：逐帧查每一个人（含背景/远景/半边人）、名单外任何人判不过、本应可见的角色缺席或性别/脸/发型/服装对不上判不过、看不清按对不上处理。结论与原因写入 qa_status/qa_reason/qa_model/qa_checked_at。
- 不过处理：advanceShotQa 作废该片并在同一任务下自动重新生成，qa_attempts 上限 MAX_QA_ATTEMPTS=2；仍不过把镜头置 failed 并写明原因，批量（gen_all_videos）与拼接（stitch）驱动都不会再自动重派它（qaExhausted 判定），只能用户手动重试（新预算）。
- 拼接门禁：shotReady = gen_status=done 且有视频且 qa_status=passed。startJob(stitch) / stepJob stitch 驱动 / executeStitch 全部按 shotReady 计算未就绪镜头：已生成未过验的先派 verify_shot 子任务复验（≤4 并发），硬验多次不过的拼接任务直接失败并写明被哪一镜拦下；第 3 步计数、第 4 步待办（stepDone case 4 按 ready）、第 5 步就绪数、项目列表 doneShots 均按 shotReady 口径。
- 人工放行已删除（2026-11-14 用户拍板「不通过不让进拼接」）：原「仍然用这一镜」（setShotQaExempt 动作 + shots.verify_exempt）与要求矛盾，已整段移除——shotReady 不再读 verify_exempt，动作与卡片按钮/标注全部删除，失败镜头只能重新生成并通过硬验。DB 列 verify_exempt 保留但恒写 0、不再被读取；存量 verify_exempt=1 的镜头自此按未通过处理（qa_status 未 passed 即未就绪）。
- 存量镜头：迁移 0003 给 shots 加 qa_* 列，旧视频默认 qa_status=pending，不会被误判为已通过——下次批量/拼接驱动会先对存量成片抽帧复验，不过才重生成。

## Long-term data behavior
- **Refresh policy**: 无外部数据刷新；页面打开时从 DB 读取项目全量数据，任务运行期间客户端每 4 秒轮询进度，任务完成由 invalidateQueries 触发回填。
- **Growth**: 用户手动新建项目，项目下脚本、分镜、角色、连续性结论、任务记录、成片随使用累积，互不影响；不预置任何示例/测试项目（遵用户明示）。
- **Ordering**: 项目按更新时间倒序；分镜按 seq 顺序排布与连线；连续性结论按相邻对序号；任务按创建时间倒序。
- **Time semantics**: created_at/updated_at 为服务端即时时间戳，客户端按本地时区渲染；分镜时长为内容时长（秒），与时钟无关。

## Rejected approaches
- **Tried**: 在探针模式实测 ctx.tool.generate_media
  **Why rejected**: 探针运行时明确拒绝（requires a built web artifact）；改以 SDK 类型契约作为依据，构建后由真实动作承载，且按用户要求不在本次构建中实际触发生成。
- **Tried**: 用 ctx.tool 直接生成视频
  **Why rejected**: SDK 的 SpaceToolClient 只有图片 generate_media，没有视频方法；视频必须经 spawnTask 后台 agent 调用 Muse 视频生成工具，这也正好满足长任务后台化、批次并行与断点回写的要求。
- **Tried**: 同步动作内一口气完成脚本生成/角色提取/拼接
  **Why rejected**: 用户明示同步长请求会 Gateway timeout；全部改为 jobs 表＋分步回写的后台模式，每步只做一小块并立即落库。
