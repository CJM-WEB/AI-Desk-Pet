# DeepSeek 与内置 Qwen 文件任务实施计划

> 执行方式：使用 subagent-driven-development 分任务实施与审查，使用 test-driven-development 执行 RED → GREEN → REFACTOR。用户后续已授权完成并验证的小任务进行 Git 提交，由主控统一处理，暂不 push；早期只读记录按当时事实保留。

**目标：** 使用现有 DeepSeek 与内置免费 Qwen，从正式桌宠入口完成实际文件读取、编辑以及构建／测试／修正任务。

**架构：** 以有限 OpenCode Core 原代码组装执行模块，原 runner 管理多步模型和工具往返；AI Pet 管理现有模型、任务授权、桌面事件与生命周期。模型原生工具消息直接进入上游协议，正式任务链不再嵌套旧 AgentLoop。

**技术栈：** 现有 Electron、TypeScript、pnpm、Vitest、Playwright，以及固定提交 OpenCode Core 所需的原生运行依赖。

## 全局约束

- 适用规格：[文件任务重构规格](../specs/2026-09-05-ai-pet-coding-assistant-design.md)，尤其第 1.1 节用户确认。
- 上游为本地 `D:/AgentLearning`，固定提交 `2a6be0a03b93a6734070e10a6c3b56863475f214`；保留 MIT 许可证、源路径和本地修改清单。
- 按任务授权明确范围，范围内连续执行；超出范围或高风险操作再确认。
- 用户模型、Provider 设置、凭据来源、内置模型运行与分发、人设及角色功能保留。
- 桌宠与网站业务严格隔离：不修改 `apps/website`、`apps/cloudbase-api`、`apps/package-scanner` 的业务、配置与运行入口。共享锁文件只允许新桌面包所需增量，网站链的 importer 和既有解析依赖版本保持原样；共享类型只改桌面任务事件，保留网站消费的契约并验证直接消费者。
- 只复用执行所需模块；不得直接使用加载所有产品服务的 `AppNodeBuilder.build` 或全量 `BuiltInTools.node`。
- 不自行重写任务循环、消息存储或第二套权限引擎；产品适配层仅管理输入、授权、模型连接、生命周期和事件投影。
- 首轮真实验收分别使用 DeepSeek 与内置 Qwen；没有凭据、运行结果或窗口观察时明确记为待验证。
- 文档与新增结构性注释使用中文；第三方原注释和许可证保持来源真实性。
- 已处于 `AgentCoreExtension` 的隔离工作区。用户后续授权每个已完成并验证的小任务提交，暂不 push；提交由主控统一处理，未完成工作保留在工作区。
- 新路径通过定向与必要验收后删除被替代代码，不永久保留双任务链；大量文件删除另行列明范围并取得二次批准。

## 任务 1：保留原核心并贯通真实读取

**文件职责：**

- 新建 `packages/coding-task-core/`：AI Pet 的窄接口、组装与定向集成测试。
- 新建 `vendor/opencode/`：从固定本地提交提取的必要原代码、资源、精简 package manifests、MIT 许可证和来源清单。每个文件记录源路径及 SHA-256；运行闭包由实际入口生成，不复制整个产品目录。
- 修改 `pnpm-workspace.yaml` 与锁文件：仅登记实际需要的本地包和固定依赖。
- 测试 `packages/coding-task-core/tests/session-read.test.ts`：原 runner、原 read、原权限与本地 HTTP 协议夹具共同执行。

**接口：**

```ts
export interface CodingModelConnection {
  baseUrl: string;
  modelId: string;
  contextWindow: number;
  outputTokens: number;
  requestBody?: Readonly<Record<string, unknown>>;
  readCredential(): Promise<string>;
}

export interface CodingSessionOptions {
  directory: string;
  dataDirectory: string;
  model: CodingModelConnection;
  onEvent(event: CodingSessionEvent): void;
}

export type CodingSessionEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; callId: string; name: string; status: 'running' | 'completed' | 'failed' }
  | { type: 'permission'; id: string; action: string; resources: readonly string[] }
  | { type: 'phase'; phase: 'running' | 'awaiting_permission' | 'completed' | 'failed' | 'cancelled' };

export interface CodingSession {
  run(text: string, signal: AbortSignal): Promise<{ text: string; toolCalls: number }>;
  replyPermission(id: string, decision: 'once' | 'reject'): Promise<void>;
  close(): Promise<void>;
}

export function createCodingSession(options: CodingSessionOptions): Promise<CodingSession>;
```

该接口不拥有第二份任务历史。结果、调用计数和公开事件从原会话与事件投影取得。凭据回调仅在 Main 与核心内部消费，绝不进入日志、事件或 Renderer。

首个红测的核心内容如下；用本地 HTTP 服务器模拟模型协议，文件操作由原工具执行：

```ts
const nonce = crypto.randomUUID();
await writeFile(join(directory, 'note.txt'), nonce, 'utf8');
const bodies: Array<{ messages: Array<{ role: string; content: unknown; tool_call_id?: string }> }> = [];
const server = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk.toString();
  bodies.push(JSON.parse(body));
  const delta = bodies.length === 1
    ? { tool_calls: [{ index: 0, id: 'call_read_note', type: 'function', function: {
        name: 'read', arguments: JSON.stringify({ path: 'note.txt' })
      } }] }
    : { content: nonce };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end([
    `data: ${JSON.stringify({ id: 'response', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: 'response', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: bodies.length === 1 ? 'tool_calls' : 'stop' }] })}\n\n`,
    'data: [DONE]\n\n'
  ].join(''));
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address() as AddressInfo;
const events: CodingSessionEvent[] = [];
const session = await createCodingSession({
  directory, dataDirectory,
  model: {
    baseUrl: `http://127.0.0.1:${address.port}`, modelId: 'fixture',
    contextWindow: 8192, outputTokens: 1024, readCredential: async () => 'fixture'
  },
  onEvent: event => events.push(event)
});
try {
  const result = await session.run('请读取 note.txt 并显示内容', new AbortController().signal);
  const returned = bodies[1]?.messages.find(message => message.role === 'tool' && message.tool_call_id === 'call_read_note');
  expect(JSON.stringify(returned?.content)).toContain(nonce);
  expect(result.text).toContain(nonce);
  expect(events).toContainEqual(expect.objectContaining({ type: 'tool', name: 'read', status: 'completed' }));
} finally {
  await session.close();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
```

测试夹具必须收集异步服务器错误并由测试断言，临时目录在 `afterEach` 中清理；随机正文不应出现在第一轮模型请求中。执行命令：`pnpm.cmd --filter @myself/coding-task-core test`；类型检查命令：`pnpm.cmd --filter @myself/coding-task-core typecheck`。必要的 Node 内建模块导入和临时目录夹具由该测试文件声明。

- [x] RED：在临时目录写入随机文本；HTTP 夹具先返回带唯一调用 ID 的 `read` 请求，第二轮检查请求包含该 ID 对应的真实文本，再返回该文本；断言 `run` 返回正确正文及有真实工具事件。没有新模块或读取闭环时失败，不能仅断言调用次数。
- [x] 提取原 `session/runner/llm.ts`、协调器、会话／事件／数据库／权限及 `tool/read.ts` 所需闭包。以 `session-runner-recorded.test.ts` 为组装参考，使用真实权限与真实文件工具，保留 Node SQLite 分支。
- [x] 用 `LayerNode.compile` 加有限 Location 服务图；通过原 `SessionRunnerModel.layerWith` 注入模型。Config 只返回宿主批准数据；默认插件和外部指令发现不装配；Snapshot 使用原 `noopLayer`，不承诺撤销。
- [x] 将 Global 的导入时文件操作收束到显式应用目录初始化。数据库先使用内存，工具输出若落盘仅写入指定任务数据目录，关闭时清理任务资源。
- [x] GREEN：运行读取测试；追加拒绝权限、读取不存在文件、HTTP 失败和取消四种终态，确保不会永久“正在读取”。
- [x] 验证当前 Electron 的实际导入与组装，而非仅系统 Node。记录依赖、包体和必要上游差异；上游未实现项不能写成已支持。

**完成标准：** 原上游 runner 驱动真实磁盘读取，结果关联与最终正文正确，失败和取消可结束；没有导入无关 OpenCode 产品服务。

## 任务 2：完整文件工具、任务授权和 Windows 命令

**文件：** `packages/coding-task-core/src/` 的组装与策略接缝、`vendor/opencode/` 中原文件／命令工具及必要依赖、`packages/coding-task-core/tests/session-coding.test.ts`、`session-permission.test.ts`、`session-cancel.test.ts`。

现有 `packages/file-tools/src/path-policy.ts` 中的系统／私有路径保护是可复用的纯边界。需要共享时仅提取或导出该保护函数，保留其他现有调用者的行为；新核心不得调用旧 `FileToolService`、旧任务循环或整套旧路径授权流程。Windows 绝对路径按新规格处理，仍拒绝设备路径、UNC、NTFS ADS 和真实路径越界。

**消费：** 任务 1 的 `createCodingSession` 与原生会话／权限服务。

**补充输入：** `CodingSessionOptions` 增加 `approvedCommands: readonly string[]`，表示用户在本任务明确批准的完整构建／测试命令；不得用任意前缀匹配把拼接命令自动放行。常规目录内文件读写由本任务授权允许，外部目录和删除仍请求单次许可。权限等待沿用同一原 runner，不另存继续令牌。

具体接缝与测试约定如下：

```ts
// 这些连接均来自 Main；模型参数不能设置 shell、许可列表或回收站回调。
export interface CodingTaskHostOptions {
  approvedCommands: readonly string[];
  commandShell?: string;
  trashFile?: (canonicalPath: string) => Promise<void>;
  windowsJobHelper?: Readonly<{ executablePath: string; sha256: string }>;
  ripgrepExecutable?: Readonly<{ executablePath: string; sha256: string }>;
}
```

将这些字段合入 `CodingSessionOptions`。默认命令外壳沿用 Windows `COMSPEC`，正式桌面端显式提供已有 PowerShell 路径。`trashFile` 缺失时拒绝删除，不能退化为永久删除。`permission` 事件可增加私有 `metadata` 和 `callId`，供 Main 转成精确、有限的确认摘要；不得直接广播整个上游事件。

搜索沿用原 `Ripgrep.Service` 与 `AppProcess`，但组装时替换原 `RipgrepBinary.node`：只接受宿主指定并通过 SHA-256 校验的 `ripgrepExecutable`。缺失或变化时明确失败，不使用 PATH、不下载、不启动解压命令。原服务的默认自动下载及直接 `CrossSpawnSpawner` 不是本产品授权的运行路径。成功用例显式提供真实搜索二进制，失败用例证明不会借用 PATH 上的程序；构建及发行资源由任务 3 接入。

- 命令继续使用原 `bash` 工具和 `PermissionV2.assert`。已批准命令的资源使用固定 shell、真实工作目录及完整命令的 SHA-256 标识，规则只匹配该标识；实际命令和工作目录置于权限请求 metadata。这样命令中的 `*`、`?` 和换行不会被原通配符匹配扩张。原权限引擎仍是唯一决议者，规则仍只属于当前任务 Agent 和内存数据库。
- Windows 调用借用固定上游 `packages/opencode/src/tool/shell.ts` 的 `cmd` 分支：PowerShell 使用 `-NoLogo -NoProfile -NonInteractive -Command`，cmd 保留原受控 shell 启动；`windowsHide` 必须生效。不引入全量 Tree-sitter 或以简单命令分词器充当隔离边界。
- 原 `write` 已有目标增加独立 `overwrite` 许可；没有目标使用原 `create`，拒绝意外覆盖。取得许可前记录旧字节，许可后使用原 `writeIfUnchanged` 检查冲突。原 `edit` 和补丁更新继续使用原冲突检查。
- 原 `apply_patch` 的删除增加独立 `delete` 许可，所有目标的许可完成后才开始副作用。删除只允许具体普通文件，使用 Main 回收站回调；批量删除不直接启用。混合补丁在权限拒绝时不得先写入其他目标。已经开始应用后遇到文件冲突，沿用上游准确报告部分应用的机制，不宣称跨文件原子回滚。
- `read`、`glob`、`grep`、修改和命令工作目录都必须覆盖真实路径与 Junction 越界；搜索不能因为使用 `RelativePath` 类型就跳过真实路径校验。保留私有设置、凭据和系统目录保护；保护策略在受控文件入口集中实施，不散落在 Renderer。
- 会话结束只表示原 runner 已停下；中途测试失败后成功修复不能被“历史中出现过错误”永久判失败。最终命令退出值和实际变更作为独立事实保留。

先扩展任务 1 的 HTTP/SSE 夹具为可编排响应，保留真实磁盘和真实进程。下面是权限红测的必要观察点；`waitForPermission` 仅等待 `onEvent` 收集的匹配事件，必须有测试超时：

```ts
// 夹具第一轮请求 write({path:'existing.txt', content:'after'})。
await writeFile(join(directory, 'existing.txt'), 'before', 'utf8');
const execution = session.run('重写 existing.txt', controller.signal);
const permission = await waitForPermission(events, 'overwrite');
expect(await readFile(join(directory, 'existing.txt'), 'utf8')).toBe('before');
await session.replyPermission(permission.id, 'reject');
await execution;
expect(await readFile(join(directory, 'existing.txt'), 'utf8')).toBe('before');
```

夹具收到被拒绝的工具结果后正常结束模型回复，测试断言无副作用和明确失败事件，不依赖错误文案。另一个用例在许可等待期间外部写入 `changed-by-user`，随后批准，断言保留 `changed-by-user` 并反馈冲突。

```ts
// 真实脚本内容，禁止用模型声称的退出码冒充测试执行。
await writeFile(join(directory, 'value.cjs'), 'module.exports = 1;\n', 'utf8');
await writeFile(join(directory, 'check.cjs'),
  'const assert = require("node:assert/strict"); assert.equal(require("./value.cjs"), 3); console.log("checked-three");\n', 'utf8');
// 夹具按 glob → read → edit 到 2 → bash(node check.cjs) → edit 到 3 → bash → 总结驱动。
// 断言首个真实命令退出非零，第二个退出 0 且含 checked-three，磁盘最终导出 3。
// session.run 完成后 toolCalls >= 6，最终终态 completed，期间失败事实仍可见。
```

命令权限表驱动用例批准 `node check.cjs`，分别请求同一命令、`node check.cjs & echo unexpected`、带换行的附加命令、不同 cwd；只有第一项可直接执行，其余必须等待对应许可且拒绝后不产生标记。另测命令原文含 `*` 时不会授权其他字符串。不同任务实例不得共享规则、待处理 ID 或已批准命令。

进程测试使用临时中文含空格目录和父／子／孙三层 Node 进程，等待三个 PID 的 READY 标记后取消；每个 PID 在五秒内应退出，后续写入标记停止。另测超时、父进程先退出而子进程仍存活，以及清理失败必须显式反馈。测试仅清理本次记录且仍匹配的 PID；不得清理用户其他 Node 或 PowerShell 进程。

进程所有权采用 Windows Job Object，保持原 AppProcess：新增 `src/windows-job-spawner.ts`、`native/windows-job-helper.cs` 和 `build-windows-helper.cjs`。helper 仅管理一次命令的创建、输出与退出；使用 Windows 10 的 `PROC_THREAD_ATTRIBUTE_JOB_LIST` 在创建时绑定 Job、`KILL_ON_JOB_CLOSE` 兜底，并在终止后确认 ActiveProcesses 归零。C# helper 构建期编译并生成 SHA-256 清单；目标机无需编译，命令执行时由 Main 提供固定路径和哈希，缺失或不匹配则拒绝执行，不退回无 Job 的命令。helper 在 Job 外持有句柄，命令输出与控制管道分开；不得从退出了的父 PID 重建归属或吞掉清理错误。原搜索等 AppProcess 消费者也须核对其参数形态，不能因为替换底层服务而暗中降级。具体官方证据、接口细节及最小故障用例见本计划私有执行记录 `.superpowers/sdd/2026-09-05-deepseek-qwen-coding-tasks/windows-process-cleanup-design.md`；交付时将采用内容纳入正式维护文档。

Task 1 审查保留的 Minor 同时在本任务收口：初始化失败以及 dispose 失败仍须尝试清理本实例目录，保留原错误，并且重复关闭不会把首次未确认的清理变成成功。只为实际资源故障补最小回归，不扩展成通用资源框架。

定向命令：`pnpm.cmd --filter @myself/coding-task-core test -- tests/session-coding.test.ts tests/session-permission.test.ts tests/session-cancel.test.ts`，随后该包完整 `test` 与 `typecheck`。先观察正确红测再改原工具接缝，报告记录 RED 与 GREEN。

- [x] RED：HTTP 夹具驱动搜索、读取、编辑、命令测试失败、再次编辑、再次测试及总结，实际临时文件和实际进程决定结果。至少经过五次工具操作，证明不再受旧四轮收口影响。
- [x] 注册原 `glob`、`grep`、`write`、`edit`、`apply-patch`、`bash`、`todowrite` 工具及必要依赖。适配源码差异集中记录；工具方法不回调旧 FileToolService 或 AgentLoop。
- [x] RED → GREEN：已授权目录内编辑连续执行；外部目录、删除、未授权命令暂停并发出原权限事件；拒绝后无副作用，许可只能作用于对应待执行调用。任务结束或取消后不能复用许可。
- [x] RED → GREEN：从上游成熟 Windows 路径借用需要的命令调用与进程清理，实现 PowerShell／cmd 参数、有限输出、超时及取消。测试命令写入临时标记，超时／取消后的子进程不得继续产生标记；不宣传 OS 沙箱。
- [x] RED → GREEN：上下文中多工具调用 ID 与各自结果完整关联；Qwen 禁用并行调用只影响模型请求策略，不破坏连续任务。

**完成标准：** 临时项目通过改测修正闭环，真实权限、命令超时和清理可验证；旧任务框架未参与执行。

## 任务 3：接入正式桌面入口和现有模型

实施与独立审查已完成，3B 复审关闭目标引用与清理屏障两项重要发现。下列勾选项对应自动化证据；实际 Electron 界面、最终分发和旧专属文件删除仍由任务 4 收口，详见[验收记录](../../operations/2026-09-05-deepseek-qwen-coding-tasks.md)。

**执行状态：** 3A模型／资源与3B正式入口的实施、定向自动化和独立审查已完成；3B两项重要发现经一轮RED/GREEN修复与独立复审关闭。下列跨阶段项目涉及的实际模型、Electron界面、分发和旧源码删除继续由任务4验收；完成事实见独立验收记录。

**执行拆分：** 3A 先实现模型协议／连接、上下文预算及可信程序的构建与分发接缝；经独立审查后，3B 再接入正式任务服务、授权卡、会话与事件生命周期。两步串行，不并行改写同一运行链；3A 完成不代表桌面入口已经替换。以下要求按所属职责分别验收，完整正式链由 3B 与任务 4 验证。

**文件：** `apps/desktop/src/main/agent/coding-task-service.ts`、`apps/desktop/src/main/conversation/` 中任务接入、`apps/desktop/src/main/index.ts`、`apps/desktop/src/main/providers/` 中连接配置接缝、`apps/desktop/electron.vite.config.ts`，以及必要的共享授权卡契约、聊天授权卡组件与对应测试。`packages/coding-task-core/src/model-route.ts` 仅承接本任务发现的 DeepSeek 协议参数适配及其测试，不另建模型请求循环。

**消费：** 新核心 `CodingSession`；Main 现有模型选择、SecretStore、LocalModelRuntime、会话 generation 和聊天事件端口。

**产出：** 正式任务端口实现 `submitFileTask / confirm / cancelAction / cancelActive / resetForNewConversation / close`，保留桌面接入所需外形，内部只调用新核心。

直接消费者的最小迁移包含 `apps/desktop/scripts/local-model-acceptance-runner.ts`：桌面测试直接导入其中生命周期函数，类型检查会跟随其组合工厂。若新端口使原工厂不再兼容，在任务3B迁移该工厂与必要类型／夹具字段，使其引用同一正式 CodingTaskService；不能增加旧执行器兼容分支或排除类型检查。完整自然场景、公开结果字段和真实运行仍归任务4，此步不把脚本可编译写成真实验收通过。

具体文件与边界：

- `apps/desktop/src/main/agent/coding-task-service.ts`：每次已授权任务创建一个 `CodingSession`；持有取消控制器、当前权限 ID 与提交 owner；结束后关闭该实例。`confirm` 只回复当前原权限请求，不启动另一段 AgentLoop。
- 该服务必须在最终正文发布且资源清理结算后才向桌面发送终态。原 Core 会在 `run` 返回前发出 `completed`，而现有 Adapter 收到终态会释放 owner；直接透传会让随后返回的正文被当作迟到事件丢弃。Core 终态先留在当前服务调用内，先发布最终正文／错误摘要，再等待 `close`，依据清理结果投影终态。
- Core 运行结束与每次本地操作结果分别投影。原 `bash` 工具正常返回但退出码非零时，不能记成测试通过；模型最终回复也不能把失败改为成功。保留现有 Main 短期事实摘要时需识别新工具名及真实结果，移走对旧 AgentService／AgentLoop 专用类型的依赖。状态追问不能仅凭“runner 已结束”回答所有操作成功，也不能因一次已被修复的中间测试失败宣布整个后续运行失败；不用模型裁判或另一个规划器判定完成。
- 旧 `CapabilityTransactionStore` 的 `expectedOperation` 完成裁决、私有工具转录回灌和自动重试／续接许可不再接入新任务。Main 只保留当前 generation 的有限只读结果摘要，用于回答上次运行是否结束、实际操作数量及最近命令退出事实；不保存第二份工具消息历史，不据此启动工具。任务结束后的新操作仍重新申请任务范围，符合规格第 1.1 节的授权失效规则。已披露的普通对话只作参考上下文，不能继承旧工具票据或授权。
- 历史接入复用原输入入口：`CodingSessionOptions` 增加可选 `initialHistory: readonly { userText: string; assistantText: string }[]`，不修改现有 `run(text, signal)` 外形。Main 仅将披露后的严格 `user/assistant` 配对正文转入；Core 在异步操作前复制并校验最多 20 个完整回合、总计 16,000 个 Unicode 字符，拒绝额外字段，不静默截断。首次 run 将每个完整回合编码成明确标注为历史引用的 JSON prompt，按序 `delivery:'steer', resume:false` 接纳；当前请求最后独立接纳，再唯一一次 `resume`，继续用当前 admitted ID 查询结果。引用不升成 system，不伪造旧工具事件，也不各自触发模型执行；重复 run 不重复接纳初始历史。部分接纳后失败或取消的会话不可再执行，仍必须关闭清理。使用真实 HTTP 夹具验证消息顺序、零提前请求、非法历史在 HTTP 前拒绝，以及原 compaction 接管较旧完整回合；原压缩允许摘要化旧正文，不承诺永久逐字记忆。固定源码调查依据见本计划私有记录 `history-context-seam.md`。
- 任务环境通过原 `AgentV2.Info.system` 提供，不新增提示词框架或规划器：从已固定的宿主选项生成简短指令，说明当前平台、真实任务目录、实际 shell 类型、完整预批准命令，并要求按真实工具结果返回正文／结论。目录与命令以 JSON 引用数据表达；不混入凭据、旧工具转录或披露历史，不把这些数据当成额外命令。协议工具名 `bash` 不代表实际使用 Bash，模型必须能辨认 Main 提供的 PowerShell 环境。该信息与权限规则取自同一份任务快照，只解释已有许可，不新增许可。HTTP RED 覆盖首轮收到真实环境及准确命令，且自然用户请求、原工具关联和压缩仍有效。依据为当前 Core 只写入 agent.permissions、原 Info.empty 不设 system、原 runner 已消费 agent.info.system；见私有 `task-3b-host-context-seam.md`。
- `apps/desktop/src/main/providers/coding-model-connection.ts`：从选定的 `ProviderProfileV2` 产生 `CodingModelConnection`。DeepSeek 使用现有 SecretStore 回调与 profile 的 baseUrl/modelId；本地 Qwen 使用 `LocalModelRuntime.getReadyConnection()` 的私有连接。新增该文件的直接消费者测试，不修改普通聊天的 Provider 协议。
- 本地连接固定取得时的 runtime generation、baseUrl 与 modelId；每次读取私有令牌时复核仍是同一运行实例，重启后拒绝旧任务继续发送。复用现有内置 profile 身份校验与 Provider 配置校验，不能只凭可伪造的 profileId 获取本地令牌。Key、令牌及完整配置不得出现在异常、事件或普通日志。
- `apps/desktop/src/main/conversation/capability-task-adapter.ts`：原实现禁止在 `submit` 尚未返回时确认，而原 runner 会在同一个 `run` 中等待权限。把“提交正在执行”和“权限回复正在执行”分开持有，允许等待中的原任务获得回复；终态、重置或取消前保持任务 owner。过期和重复 ID 在服务内拒绝。
- 取消也必须沿同一拥有者结算：现有 Coordinator 和 Adapter 的 `cancelActive` 会立即释放 owner 并发出 cancelled，不能照搬到等待 Job 清理的新服务。发出取消请求后保持任务占用，直到原 run／close 确认清理，再发布终态并允许下一任务；清理失败明确报错。`cancelAction` 只拒绝当前许可，原 runner 仍可能接收失败结果并总结或尝试其他已授权操作，不能因点击拒绝便把整个任务 owner 清掉。`close`、reset 和权限回复使用可等待的 Promise 端口，避免吞掉后台异常。对应 RED 覆盖取消清理尚未释放时第二次提交被拒绝、拒绝许可后总结仍可见、清理失败不出现成功／已取消终态。最终正文和真实操作事实可先显示，但终态必须在 close 结算后发布。
- 复用 `file-task-public-errors.ts` 的脱敏错误出口时同步核对文案：运行中取消不保证撤销已完成写入，不能沿用旧 `FILE_TASK_USER_CANCELLED` 的“未执行本地写入”结论。拒绝单次许可、整任务取消、原工具失败和资源清理失败分别依据实际阶段说明；不得公开 raw cause、凭据或进程输出，也不能把模型总结当回滚证明。
- `apps/desktop/src/main/conversation/conversation-coordinator.ts` 与 `main-conversation-composition.ts`：显式文件／命令任务也先建立任务范围授权，模型建议只允许请求授权。许可界面不再说明“每次写入都确认”。授权／历史披露 IPC 在任务获准进入后及时返回；任务继续由既有事件报告，避免 Renderer 的 actionBusy 阻止后续权限按钮。后台 Promise 必须有错误和清理处理。
- `packages/shared-types/src/contracts.ts`、`apps/desktop/src/renderer/src/chat/CapabilityAuthorizationCard.tsx` 和当前确认卡消费者：范围卡显示当前目录、模型、常规文件能力与完整命令列表；具体权限卡显示真实目标／命令及覆盖或删除含义。Main 投影有限、经过 schema 的必要字段，不发送密钥、原始工具输出或整份模型请求。
- 具体许可回复复用既有 `confirmAction(actionId)`／`cancelAction(actionId)` → `actionConfirm`／`actionCancel` → `resolveFileAction`；入站只接受 `.strict()` 且 1—128 字符的 opaque id，Main 只映射当前 Core 请求的 `once`／`reject`。不新增同义 API 或 IPC，也不回复 `always`。新增严格 `task_permission_required` 公共事件，原 `ConfirmationCard.tsx` 就地改为对应卡片；旧 `PendingAction` 类型可仅供待批准删除的旧源码编译，正式新任务不再发旧事件。
- Main 私存当前任务的待决许可映射，Renderer 只保留按到达顺序展示的待决 DTO 队列，二者上限 16 项；同一回合多个许可不得互相覆盖或静默丢弃，超限明确终止并清理当前任务。只移除当前已接纳回复的 id，终态／reset 清空，重复或过期回复拒绝。该队列不控制工具顺序，不形成第二个执行状态机。
- 范围卡保留现有两分钟接纳有效期；具体 Core 许可沿用原请求的存活期，由回复、任务结束、取消和配置／generation 失效来结算。新许可 DTO 不沿袭旧 PendingAction 的独立 `expiresAt` 或倒计时，也不另建一套许可过期调度器。这里的“过期回复”指已结束或失效任务的旧 id；不能对界面声明一个宿主没有实际执行的到期时间。
- `bash` 许可的 `resources` 是完整命令与固定 shell／真实 cwd 绑定后的哈希标识，不能拿来显示命令。Main 验证私有 `metadata.command/cwd` 的类型、预算及其与资源标识的绑定关系，重建只含原命令和准确 cwd 的卡片 DTO；shell、其余 metadata、callId 与原输出均不透传。文件许可按 `external_directory/delete/overwrite` 判别，只显示做决定所需的准确目标与固定含义。未知 action、畸形或超限请求封闭失败，不能降为通用确认。单命令复用现有 16,384 字符上限，任务命令列表最多 16 项且总计最多 32,768 字符；资源最多 16 项、单项 1,024 字符、合计 4,096 字符。路径和 modelId 字段复用现有严格契约，不能把准确目录缩成无法辨认的泛化标签。`ConversationEventProjection` 原有 chat 全事件／pet 仅 phase 的实现继续复用，只补直接消费者验证。只读证据见私有 `task-3b-ui-contract-seam.md`。
- 上述命令绑定校验复用 `packages/coding-task-core/src/host-boundary.ts` 的现有 `commandResource(shell, cwd, command)`；需要时从 Core 增加窄公共出口，保持公开声明自包含，不让 Main 再复制同一 JSON 排列和 SHA-256 算法。文件与 cwd 的最终执行检查仍属于原 Core／宿主边界，卡片投影不得另写执行授权引擎。
- `apps/desktop/package.json`、`apps/desktop/electron-builder.yml` 与 Main 资源解析：开发／构建准备阶段生成任务 2 的固定 Windows helper 与哈希清单，发行时作为专用 `extraResources` 携带，Main 分别解析开发路径与 `process.resourcesPath`。开发目录以 Main 提供的稳定应用根为依据，不能按 `import.meta.dirname` 的源码层级回退并期待编译后仍相同。用户目标机只运行已打包 helper，不调用 C# 编译器。包配置测试核对准备／分发契约和路径映射；资源集成测试自行准备临时输入／输出并确认真实文件及解析，不能依赖先前命令偶然生成的被忽略产物，也不能静默要求所有桌面单元测试联网。不存在或哈希变化时命令明确失败。PowerShell 根只接受规范化本地绝对 Windows 路径，空、相对、UNC 与设备形式封闭失败。Main 构建把新核心及其必要依赖纳入同一 ESM 运行图，并保持 `jsonc-parser` 的 ESM 解析优先级。
- Task 3A 完整 Electron 验证实际遇到断言通过后进程以句柄错误退出；该次仍判失败。官方 [PR 52956](https://github.com/electron/electron/pull/52956)及 [43.5.0 发布记录](https://releases.electronjs.org/release/v43.5.0)包含匹配的 Windows 调度器退出修复。先保留准确日志、用同一测试对照官方 43.5.0；若证据支持，再只更新桌面 Electron 依赖及必要锁项，不跨主版本、不改网站图，也不吞掉退出错误。此项仅修复已观察的运行时故障；具体来源与对照要求见私有 `electron-shutdown-source.md`，实际结果写入验收报告。
- 同一资源准备阶段为搜索提供官方 ripgrep 15.1.0 Windows x64 二进制及许可文件：新增 `packages/coding-task-core/resources/ripgrep-source.json` 与 `prepare-ripgrep.cjs`，仅在构建／开发准备时下载和校验固定资产，缓存已校验文件供离线重复构建；输出至包内被忽略的 `dist/rg.exe`，许可文件放在 `dist/ripgrep-licenses/`，沿用任务2已验证的资源位置。Main 从正式打包资源解析 `ripgrepExecutable`，不能引用测试机 Codex 的 PATH。固定 ZIP SHA-256 为 `124510b94b6baa3380d051fdf4650eaa80a302c876d611e9dba0b2e18d87493a`，`rg.exe` SHA-256 为 `decdd4992f3f1b9a5ef9898f1b40ab16886d579d6516b4efd3d5eaa19364e408`；正式清单保留官方 URL、固定提交、大小与许可条目。完整来源和当前已校验私有资产见 `.superpowers/sdd/2026-09-05-deepseek-qwen-coding-tasks/ripgrep-release-source.md`。新核心测试默认读取这份准备后的资源，不把私有 SDD 路径或特定用户目录写入可提交代码。验证包含缺失、篡改、无 PATH ripgrep 及不触发运行时联网四项。

连接参数采用已存在的模型事实：本地 Qwen 的 `contextWindow:8192` 对应实际 llama.cpp `--ctx-size`，首轮输出预算为 2048；保留 `reasoning_effort:'none'`、`chat_template_kwargs:{enable_thinking:false}`、`parallel_tool_calls:false`。DeepSeek 延续当前任务非思考模式 `thinking:{type:'disabled'}`，首轮输出预算为 8192；对于当前 DeepSeek V4 profile，按官方文档使用 1,000,000 上下文上限。其他 DeepSeek 模型不套用 V4 上限；优先使用其已知配置，缺少数字时采用宿主 8192 上下文／2048 输出的保守预算并记录，不改动用户 modelId。该预算只是限制本轮送入的上下文，不声称是模型能力上限。其他 Provider 的任务适配不在首轮范围，普通聊天照常保留。本轮不启用跨模型失败回退。协议依据：[DeepSeek 模型说明](https://api-docs.deepseek.com/quick_start/pricing/)、[工具调用说明](https://api-docs.deepseek.com/guides/tool_calls/)。输出预算是本产品的首轮配置，不是厂商宣称上限。

真实模型探针已确认：原 HTTP transport 禁止 `requestBody` 覆盖 `thinking`，会在发请求前失败。不得删除该禁止表，也不得把未设置参数的成功读取写成“已关闭思考”。为 `CodingModelConnection` 增加宿主专用的可选 `protocol: 'openai-chat' | 'deepseek'`，省略时保持现有通用协议；仅 DeepSeek 连接选用后者。在窄 `model-route.ts` 中使用原 `Protocol.make`：通过已导出的 `OpenAIChat.bodyFields` 构造增加 `thinking: { type: 'disabled' }` 的严格 Schema，`body.from` 在原 `OpenAIChat.protocol.body.from` 结果上添加该字段，`stream` 完整复用原协议。用原 `Route.make` 和 `HttpTransport.sseJson` 构造对应路由，保留原凭据、端点、消息／工具关联和 reasoning 元数据处理。Qwen 的既有 `parse_tool_calls:true` 一并保留。不得复制整个 OpenAI Chat 协议或把模型正文覆盖作为补丁。

为此先在 `packages/coding-task-core/tests/model-route.test.ts` 写真实 HTTP 请求红测：DeepSeek 路由将 `thinking.type` 作为协议字段发送，同时能完成 read 工具结果的第二轮回注；普通路由与 Qwen 参数保持原样；对 `requestBody` 中 `messages`、`tools`、`model` 和 `thinking` 的覆盖仍在 HTTP 前被拒绝。接口类型与桌面 Main 连接测试通过后，再用当前真实 DeepSeek 做非思考读取验收。

小上下文还须适配原压缩配置：上游 `session/compaction.ts` 默认保留 8,000 tokens、预留 20,000 tokens，与内置 Qwen 的 8,192 上下文不匹配。`CodingModelConnection` 增加宿主专用可选 `compaction: { buffer: number; keepTokens: number }`；Qwen 连接指定二者均为 2,048，未指定的连接沿用上游默认值。组装层只把宿主值转换为内存中的原 `Config.Document` 条目，不扫描项目配置、不重写压缩算法。HTTP 夹具分别验证低于可用预算时不多发总结请求、预算增长后使用原压缩且后续工具调用 ID／最终正文仍正确。完整工具集、中文输入及较大文件的真实 Qwen 验收继续检查上下文溢出；失败时记录具体阶段，不能静默换云模型或截断当前用户请求。

Main 对未知模型采用保守 8,192／2,048 预算时，同样显式提供 2,048／2,048 的压缩参数；该条适用于未知 DeepSeek 与首轮兼容夹具所复用的通用 OpenAI 连接。原 Core 公共接口未指定参数的默认行为保持不变，不因模型名称未知而使同一小上下文预算再次失配。

任务范围输入仍由 Main 绑定真实目录及模型。范围卡允许用户确认本任务的完整命令列表；初始列表可从本项目已经存在的 `package.json` 中 build/test/typecheck/lint 脚本生成精确包管理器命令，不能默认批准不存在的脚本。没有列入的命令在原工具请求时再次询问。若命令列表来自 Renderer，必须通过长度／数量 schema，并在当前权限请求 ID 下单次绑定，不接受新目录或模型覆盖。

首轮验收对象与协议复用范围要区分：现有通用 `openai-compatible` profile 可以使用同一原 OpenAI Chat 路由，不需要另写兼容层，也不据此宣称其他厂商已经真实验收。原有 E2E 的本地 HTTP 兼容 profile 可继续验证正式入口，不能添加只在 E2E 下绕开任务边界的特殊执行器。未具备任务协议适配的其他协议在任务准备时明确返回不支持，普通聊天保留。

先给 `apps/desktop/tests/capability-task-adapter.test.ts` 增加下述语义的 RED；正式组合测试仍用真实新核心和 HTTP 夹具：

```ts
// service.submitFileTask 在 permissionDeferred 被确认前保持未决。
const submission = adapter.submit(input);
await permissionShown;
await adapter.resolveAction(actionId, 'confirm');
await submission;
expect(events.some(event => event.type === 'phase' && event.phase === 'success')).toBe(true);
// 第二张权限卡、重复 ID 和 reset 后迟到事件各用独立分支验证。
```

`apps/desktop/tests/coding-task-service.test.ts` 通过真实 HTTP fixture 与随机文件断言最终 `message` 包含正文、工具结果事实先于成功终态；再用慢 HTTP 和权限等待测试取消／reset 不发布旧结果。`apps/desktop/tests/main-conversation-composition.test.ts` 从 `coordinator.submit('帮我看看 note.txt 里写了什么')` 开始，经真实范围确认进入核心，断言最终正文，不能直接调用新服务绕过正式分流。

桌面接入的适配形态示例：

```ts
const session = await createCodingSession({
  directory: snapshot.authorizedRootPath,
  dataDirectory: privateTaskDirectory,
  model: await modelConnection(),
  approvedCommands: grant.approvedCommands,
  commandShell: windowsPowerShellPath,
  trashFile: canonicalPath => shell.trashItem(canonicalPath),
  onEvent: event => publishOwnedEvent(owner, event)
});
try {
  const result = await session.run(submission.text, controller.signal);
  // 最终文字来自原会话；成功／失败事实来自原工具结果与执行终态。
  publishFinalMessage(owner, result.text);
} finally {
  await session.close();
}
```

这里的 `publishOwnedEvent`／`publishFinalMessage` 是该服务的私有投影方法：先检查当前 owner 和 generation，再转成既有 TaskEvent；不是新任务状态机。真实局部失败不抹掉已完成操作，模型没有工具调用时明确结束，不伪造“已读取”事实。

定向 RED/GREEN 命令：`pnpm.cmd --filter @myself/desktop test -- tests/coding-task-service.test.ts tests/capability-task-adapter.test.ts tests/main-conversation-composition.test.ts`。随后运行 desktop 的 `typecheck`、相关 Renderer／共享契约测试和桌面构建，最后由任务 4 运行全门禁。

- [x] RED：通过正式 Conversation 组合提交自然表达读取，断言实际文件正文进入聊天事件并结束运行；HTTP 夹具只模拟模型，不预设 Router 必须选中的工具或返回固定成功短语。
- [x] DeepSeek 从现有实际选中 profile 取得 baseUrl/modelId 与 Main 凭据回调；Qwen 从已运行的私有本地连接取得配置，保留 `enable_thinking:false`、`parallel_tool_calls:false`。不经过旧单工具 ModelResponse，不静默切换模型。
- [x] RED → GREEN：普通聊天无工具，明确任务进入范围授权；一次授权后在范围内连续读写和运行批准命令。授权界面显示任务、目录、模型及可执行范围；高风险或范围外的具体请求使用独立确认。
- [x] RED → GREEN：重置、模型切换、目录变化、关闭及取消终止旧核心；迟到事件不能进入新会话。工具结果是任务事件来源，角色表现仅消费最小事实摘要。
- [x] RED → GREEN：模型仅说“正在读取”时不会形成无活动请求的永久运行态；真实失败、拒绝及部分执行准确展示。
- [ ] 正式构建只加载一条新任务链；打包所需原代码、资源及依赖可解析。依据通过的替换范围删除旧专用实现和测试，保留仍用于普通聊天的公共组件。

**完成标准：** 正式入口使用现有 DeepSeek／Qwen 配置运行新核心，授权、正文、终态与取消可在 Electron 链路观察。

## 任务 4：真实模型验收与交付

**执行顺序：** 3B 独立审查通过后，先迁移现有真实模型验收入口并分别运行 DeepSeek 与内置 Qwen，以实际读取、修复测试、许可拒绝和命令取消尽早暴露产品问题；再迁移混合安全／集成／Electron E2E 夹具、完成标准门禁和分发检查。两步串行且分别审查，不因前一步真实运行通过而跳过后一步。旧源码大量删除仍须在替换证据齐备后单独取得二次批准。

**文件：** `apps/desktop/scripts/` 中共享新核心的真实模型验收入口、相应协议夹具与桌面 E2E、根 `package.json` 的桌面验证命令、`apps/desktop/electron-builder.yml` 的原许可证分发项及对应配置测试、`docs/operations/2026-09-05-deepseek-qwen-coding-tasks.md`，受影响的旧规格／索引和协作规则。

- [ ] 分别用内置 Qwen 与 DeepSeek 在隔离临时项目执行自然表达读取、内容问答、改测修正、拒绝与取消；随机内容必须由实际文件读取，不能被预置到模型答案。
- [ ] 真实 API 无可用配置时准备可执行验收入口，明确记录缺失条件，不把 HTTP fixture 结果写成真实 DeepSeek 通过。API 密钥只在 Main 内使用，不进入报告。
- [ ] 运行新 package 测试与 typecheck，随后运行 `pnpm.cmd verify:desktop`；必要的新增 E2E 以实际界面最终正文与终态为断言。把 Core 的独立测试脚本纳入标准桌面验证命令，避免根 Vitest 的旧 project 白名单永久漏掉新核心；沿用该包资源准备入口，不另建第二套配置。阶段门禁超过时间盒时保留输出并缩小诊断，不绕过失败。
- [ ] 最终桌面分发携带未修改的 `vendor/opencode/LICENSE`，通过现有 `extraResources` 映射到任务资源内的来源子目录；核对最终资源文件与原许可证字节一致。当前准备目录只有 helper 与 ripgrep 许可，不能把仓库中有许可证等同安装包已携带。保持 ripgrep 的原许可分发，不增设产品流程或依赖框架。
- [ ] 校验 `git diff --check`、中文文档、第三方来源和旧路径清理范围；更新实际运行记录。未观察的手工项写为“待用户人工确认”。

**完成标准：** 两个目标模型各自有真实运行证据；相关自动化门禁通过；正式旧路径按批准范围退役；剩余限制明确，不以单元测试代替真实体验。
