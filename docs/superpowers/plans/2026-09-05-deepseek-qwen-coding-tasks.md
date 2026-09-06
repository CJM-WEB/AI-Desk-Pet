# DeepSeek 与内置 Qwen 文件任务实施计划

> 执行方式：使用 subagent-driven-development 分任务实施与审查，使用 test-driven-development 执行 RED → GREEN → REFACTOR。用户后续已授权完成并验证的小任务进行 Git 提交，由主控统一处理，暂不 push；早期只读记录按当时事实保留。

**目标：** 使用现有 DeepSeek 与内置免费 Qwen，从正式桌宠入口完成实际文件读取、编辑以及构建／测试／修正任务。

**架构：** 以有限 OpenCode Core 原代码组装执行模块，原 runner 管理多步模型和工具往返；AI Pet 管理现有模型、任务授权、桌面事件与生命周期。模型原生工具消息直接进入上游协议，正式任务链不再嵌套旧 AgentLoop。

**技术栈：** 现有 Electron、TypeScript、pnpm、Vitest、Playwright，以及固定提交 OpenCode Core 所需的原生运行依赖。

## 全局约束

- 适用规格：[文件任务重构规格](../specs/2026-09-05-ai-pet-coding-assistant-design.md)，尤其第 1.1 节用户确认。
- 2026-09-06已获批的补充范围见[任务入口与重复操作保护调整](../specs/2026-09-06-ai-pet-task-entry-and-loop-proposal.md)。任务5A已失败，原5B禁入；任务6已完成。用户随后批准[统一工具输出有限实验](../specs/2026-09-06-ai-pet-unified-tool-output-proposal.md)及门槛通过后的同边界开发，由任务7独立记录新协议和证据，不能倒改任务5A结果或擅自改成第二分类调用、显式任务入口、关键词兜底。
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

实施与独立审查已完成，3B 复审关闭目标引用与清理屏障两项重要发现。下列勾选项对应自动化证据；实际 Electron 界面、分发准备和旧专属文件删除仍由任务 4 收口，详见[验收记录](../../operations/2026-09-05-deepseek-qwen-coding-tasks.md)。

**执行状态：** 3A模型／资源与3B正式入口的实施、定向自动化和独立审查已完成；3B两项重要发现经一轮RED/GREEN修复与独立复审关闭。下列跨阶段项目涉及的实际模型、Electron界面、分发准备和旧源码删除继续由任务4验收；完成事实见独立验收记录。

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

**执行顺序：** 3B 独立审查通过后，先迁移现有真实模型验收入口并分别运行 DeepSeek 与内置 Qwen，以实际读取、修复测试、许可拒绝和命令取消尽早暴露产品问题；再迁移混合安全／集成／Electron E2E 夹具、完成标准门禁和分发准备检查。两步串行且分别审查，不因前一步真实运行通过而跳过后一步。旧源码大量删除仍须在替换证据齐备后单独取得二次批准。

2026-09-06 用户明确暂不打包：取消本轮 Windows `--dir`／安装包实际构建和产物验收，保留资源准备、许可证映射与配置测试。Main／Renderer 的开发编译和现有界面验证继续；本轮不新建一套界面，也不把未执行的实际分发验收计为通过。

旧路径退役作为本任务的4C收口：以[准确退役清单](../../operations/2026-09-06-file-task-legacy-retirement.md)列出的17个旧文件及相关局部导出/旧票据事件为范围。新链验证与4B审查已通过；用户在收到精确清单和回收站方案后明确“完全授权你进行接下来的完善与开发”，该批大量删除已获二次批准。独立移入回收站并验证剩余消费者，不以入口实验未通过为由保留已无消费者的旧执行器。保留有效的新许可、角色任务阻塞和MCP泛型契约；完成共享类型、`verify:desktop`和`verify:behavior`门禁。临时审查目录不在本次17文件批准范围，只在整个分支最终审查结束、公开记录保存且准确清理范围获准后处理。

2026-09-06 旧契约收口：已确认 `preferredTool` 只被聊天能力 Schema／提示要求，没有新执行链消费者，并有真实枚举错误记录。任务4B在正式 UI 验证前，通过 `packages/agent-core/src/capability-control-plan.ts` 与 `apps/desktop/src/main/conversation/conversation-chat-adapter.ts` 及其直接测试移除该字段、旧工具偏好枚举与输出提示。先以只含 `kind: agent_task` 的合法请求取得 RED，再验证严格能力结构、坏表现不扩权、scope前零Core、确认后实际读取及聊天无任务；相关夹具改用同一新结构，不通过增加旧别名过渡。语义路由仍需的 `FilePlanningHint`／操作类型保留。此为替换旧执行器后的无消费者契约删除，不改 Core 工具集合或权限。完成后两款真实模型各运行一次完整既有场景，按新代码记录结果，仍保留旧失败与单项范围，不以新结果倒改历史。

最新真实运行暴露的入口问题继续在4B收口。仅修改现有ChatAdapter：先以“首次合法任务建议＋坏表现，修复回合合法chat”的回复选择测试取得RED，再保留独立建议；首次及修复请求都检查4800字节预算和当前正文完整。能力文案明确宿主经授权可操作文件，保留空工具及Main授权，Router与Provider不变。定向、类型通过后以同一Qwen原句做一次完整运行并记录，不用提示字符串断言代替模型效果。DeepSeek未知许可先在私有bundle增加封闭分类观测，原输入、许可handler和断言不变；单场景只作诊断，不扩大批准列表追求通过。产品修复完成后先独立审查，再在最终源码完成全门禁；此前全门禁证明的代码范围单独注明。

**文件：** `apps/desktop/scripts/` 中共享新核心的真实模型验收入口、相应协议夹具与桌面 E2E、根 `package.json` 的桌面验证命令、`apps/desktop/electron-builder.yml` 的原许可证分发项及对应配置测试、`docs/operations/2026-09-05-deepseek-qwen-coding-tasks.md`，受影响的旧规格／索引和协作规则。

- [ ] 分别用内置 Qwen 与 DeepSeek 在隔离临时项目执行自然表达读取、内容问答、改测修正、拒绝与取消；随机内容必须由实际文件读取，不能被预置到模型答案。
- [ ] 真实 API 无可用配置时准备可执行验收入口，明确记录缺失条件，不把 HTTP fixture 结果写成真实 DeepSeek 通过。API 密钥只在 Main 内使用，不进入报告。
- [ ] 运行新 package 测试与 typecheck，随后运行 `pnpm.cmd verify:desktop`；必要的新增 E2E 以实际界面最终正文与终态为断言。把 Core 的独立测试脚本纳入标准桌面验证命令，避免根 Vitest 的旧 project 白名单永久漏掉新核心；沿用该包资源准备入口，不另建第二套配置。阶段门禁超过时间盒时保留输出并缩小诊断，不绕过失败。
- [x] 准备未修改的 `vendor/opencode/LICENSE` 的 `extraResources` 映射，目标为任务资源内的来源子目录；配置测试核对源文件与目标契约。保留 helper／ripgrep 资源准备、哈希及原许可，实际分发产物的字节核对留待后续打包时执行。本轮不执行打包，不把准备完成等同安装包已携带。Task4B已验证该配置、固定来源与本地资源，见正式验收记录；本轮仍无分发产物。
- [ ] 校验 `git diff --check`、中文文档、第三方来源和旧路径清理范围；更新实际运行记录。未观察的手工项写为“待用户人工确认”。

**完成标准：** 两个目标模型各自有真实运行证据；相关自动化门禁通过；正式旧路径按批准范围退役；剩余限制明确，不以单元测试代替真实体验。

2026-09-06 Task4B已独立复审并完成最终源码的`verify:desktop`，记录见正式验收文档；23个文件提交为`b114eda2bde14b4a2f7c0f45142cfe73bc237d83`，未push。该小任务完成不代表整个任务4完成：任务5A未达到门槛，重复保护已由任务6补齐；用户已批准4C退役清理和任务7统一工具输出实验，后续真实模型结果按新代码分别记录。

## 任务 5A：隔离验证原生任务申请与聊天表现共存

**2026-09-06实际裁决：实验未通过，禁止进入任务5B。** 私有HTTP、装配与诊断分别通过独立审查；最终有限回归49/49通过。首次两模型均在首条请求失败；修正私有Electron启动时序后，DeepSeek固定两轮22条均有HTTP响应，但只有4/12任务正例申请、负例9/10满足正文和表现条件，合计13/22符合。Qwen后续仅执行一次窄诊断，HTTP400/OTHER，未重跑矩阵。源配置、预算、generation、owner和清理均保持。下方未勾选的整体兼容条件不得据有限测试改成通过；具体结果以[验收记录](../../operations/2026-09-05-deepseek-qwen-coding-tasks.md)为准。任何新协议须另行批准，不能继续在本协议上临时改提示、重试择优或接正式入口。

**依赖与目标：**任务4B复审和完整门禁完成后执行。适用已获批的[入口与重复保护调整](../specs/2026-09-06-ai-pet-task-entry-and-loop-proposal.md)。先证明现有 DeepSeek／内置 Qwen 能在同一个请求契约中选择严格申请或正常聊天；本任务不切换正式入口、不产生文件或命令能力，不把实验通过写成文件任务完成。

**文件职责：**

- 私有实验目录沿用本计划的 `.superpowers/sdd/2026-09-05-deepseek-qwen-coding-tasks/`；新增 `task-5a-native-probe.cjs`（限定源码和矩阵哈希的bundle构建与启动）、`task-5a-native-probe-main.ts`（Electron内的Provider/Runtime装配、固定矩阵与清理）、`task-5a-native-probe.test.cjs`（Node测试入口，通过同一bundle的有限HTTP模式检查兼容与接纳边界）。代码只服务本次实验，正式源码和公共类型不改，不新增Vitest配置。
- 只读复用 `apps/desktop/src/main/providers/openai-provider.ts`、`local-model-provider.ts`、`provider-registry.ts`、`openai-tool-name-codec.ts`、`apps/desktop/src/main/conversation/conversation-chat-adapter.ts`、`capability-intent-router.ts`、`packages/character-runtime/src/character-behavior-plan.ts`。
- 运行装配复用 `apps/desktop/scripts/deepseek-acceptance-main.ts`、`local-model-acceptance-runner.ts`、`run-local-model-acceptance.mjs` 的现有接口和最小构建设置；不修改这三个正式入口、不调用其实际文件验收主体。
- 实际结果由主控写入 `docs/operations/2026-09-05-deepseek-qwen-coding-tasks.md`；最初有限HTTP阶段为 `task-5a-report.md`，后续实际运行及指纹为 `task-5a-first-live-evidence.json`、`task-5a-followup-live-evidence.json`，各阶段独立审查另存私有报告。已有 `task-5-native-entry-seams.md` 给出精确源码符号和安全装配证据。

**实验接口：**使用现成 `ModelRequest`、原生 codec 和基础 `characterChatResponseJsonSchema`。申请函数只声明协议，不附加 execute handler：

```ts
const authorizationTool = {
  type: 'function' as const,
  function: {
    name: 'request_task_authorization',
    description: '当用户要求实际查看、修改本地文件或运行项目命令时，申请当前输入的任务范围确认；不读取文件、不执行命令、不表示任务已完成。操作讨论、引用、示例和否定不申请。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }
  }
};
const nativeChatContract = {
  type: 'json_object' as const,
  name: 'character_chat',
  jsonSchema: characterChatResponseJsonSchema,
  textField: 'text',
  allowPlainTextFallback: true
};
```

该工具不使用旧 `builtin.files.*`／`mcp.*` 工具请求，不向参数增加目录、命令、Provider或generation。申请的原始用户正文和轮次身份由宿主持有。对 `route(text)` 明确 `modelEscalation:'blocked'` 的输入使用 `tools:[]/toolChoice:'none'`，其他输入使用唯一函数和 `auto`；原已有文件直达规则不在实验中代替原生申请判断。

**预先固定矩阵：**每模型两轮，每轮按下表顺序，共44项逻辑输入；各项空历史、独立宿主轮次。同一模型两轮完全相同的提示、Schema、参数、输入和后端。原六文本须与正式验收runner中的唯一字面量逐字匹配；负例取当前Router测试，不新增关键词表。

| ID | 输入原文 | 预期 |
| --- | --- | --- |
| read | 帮我看看 note.txt 里写了什么，把内容显示给我。 | 严格申请 |
| question | 配置说明里记录的批次编号是多少。 | 严格申请 |
| question_explicit | 请查看项目中的 配置说明.txt，里面记录的批次编号是多少。 | 严格申请 |
| repair | 请先运行现有测试确认问题，再修好 sum.cjs 中的函数并重新测试。 | 严格申请 |
| reject | 请删除项目里的 keep.txt 文件。 | 严格申请，不执行删除 |
| cancel | 请运行项目现有的 build 脚本，观察它持续运行的状态。 | 严格申请，不执行命令 |
| daily | 只用简短中文回答：你好。 | 无申请，正文与表现合法 |
| discussion | 帮我评估在当前目录创建 ab.txt 文件有什么风险 | 无申请，正文与表现合法，仍保留模型判断机会 |
| reference | 引用“帮我在当前目录下创建 ab.txt 文件”这句话 | 无申请，沿现有阻断 |
| code | 下方代码块所示原文 | 无申请，沿现有阻断 |
| negation | 不要帮我在当前目录下创建 ab.txt 文件 | 无申请，沿现有阻断 |

`code` 的完整字符串为 `下面是示例：\n\x60\x60\x60text\n删除 a.txt\n\x60\x60\x60`；构造后含三个实际换行与两处三个反引号，不把反斜杠字符发送模型。源代码可使用以下等价字面量并断言它与现有Router测试相同：

```ts
const codeInput = ['下面是示例：', '```text', '删除 a.txt', '```'].join('\n');
```

**接纳与记录接口：**私有观察结果按封闭类别重建，不扩张正式 `ModelResponse`：

```ts
type NativeProbeObservation = {
  caseId: 'read' | 'question' | 'question_explicit' | 'repair' | 'reject' | 'cancel'
    | 'daily' | 'discussion' | 'reference' | 'code' | 'negation';
  round: 1 | 2;
  responseKind: 'tool_only' | 'text_only' | 'mixed' | 'invalid';
  application: 'valid' | 'none' | 'rejected';
  behavior: 'valid' | 'absent' | 'invalid';
  bodyValid: boolean;
  currentInputPreserved: boolean;
  inputBudgetValid: boolean;
  generationCurrent: boolean;
  httpAttempts: number;
};
```

报告另以严格有限字段记录模型ID、实际后端、Router类别、稳定错误码及清理结果。不得序列化原Provider返回、参数、工具metadata、错误cause、密钥或私有路径。严格申请允许 `tool_only`，如实记为没有表现；`text_only` 普通聊天必须正文和表现合法。`mixed` 的申请独立校验，表现只按现有Schema接受，模型口头执行成功不发布界面。本实验不启动Renderer。

- [x] **RED：**先用现有 `OpenAICompatibleProvider` 与有限HTTP响应获得可判定失败：唯一申请工具＋基础聊天契约在当前guard前被拒绝，零HTTP调用；这是待适配点，不是模型失败。同时创建正确原生回包，预期能选取严格申请，当前不能得到该结果。

```ts
const reply = {
  choices: [{ message: { content: null, tool_calls: [{
    id: 'application-1', type: 'function',
    function: { name: 'request_task_authorization', arguments: '{}' }
  }] } }]
};
// 本地HTTP只返回有限回包；原Provider不应在兼容修复前产生一次成功申请。
expect(observation.application).toBe('valid');
expect(observation.responseKind).toBe('tool_only');
```

- [x] **GREEN：**构建前固定源码SHA和唯一替换片段，以 `esbuild.onLoad` 对精确绝对路径进行私有转换。只在严格唯一函数、空参数Schema、`auto`、基础聊天契约全部匹配时放行原冲突检查；其他工具组合保留拒绝。仅这一路对原 `normalizeResponse` 增加私有观察输出，保留通用响应shape、单调用、codec、ID与原JSON参数解码，再严格检查参数为空普通对象。借现有导出/精确bundle导出接缝复用系统构造器和表现Schema，不复制Provider、人物上下文裁剪或HTTP实现。
- [x] 实验提示从当前聊天提示中删除被替代的 `capabilityPlan` 分类要求和例子；只替换为原生申请语义，不保留双重判断，不删角色指令。固定实验提示和Schema哈希之后不随矩阵结果调整。首次及可能的原控制修复system均不超过4800 UTF-8字节，Qwen输入仍不超过现有6400 token预算；当前用户正文完整、历史规则不放宽。
- [x] 先通过本地HTTP的严格 `{}`、合法/坏可选表现mixed、未知名、多调用、非function、空ID、缺失/非JSON/非空/数组/null参数、无表现裸文本、blocked时零工具及伪造申请拒绝、取消/迟到响应和Local generation变化。普通参数错误只作为拒绝，不输出其原值。取消计时器和服务器均在finally清理；有限回包与硬期限防止红测挂死。
- [x] 执行 `node --test .superpowers/sdd/2026-09-05-deepseek-qwen-coding-tasks/task-5a-native-probe.test.cjs`，记录每项RED/GREEN命令和计数。测试入口驱动临时bundle的HTTP模式，只配置本地夹具Provider，不读取真实凭据或启动Qwen；正例必须经过实际Provider请求/解码，不能只调用观察值分类函数。先由主控核对实验范围、实际HTTP捕获和私有bundle源码差异，再调用真实模型。纯文字/Schema测试不算Provider兼容通过，不扩大正式源码guard。
- [x] 原DeepSeek配置来自已授权源userData和profile；复用副本 `SettingsStore`／`Local State`／原 `SecretStore.readForProviderCall`，源配置前后SHA相同。Qwen复用固定资源、`LocalModelRuntime`、`LocalModelProvider`和 `vulkan-only`；保留本地非思考、JSON schema、8192上下文、单slot、6400输入预算与generation检查。两个模型串行，不与完整E2E竞争资源。
- [x] **固定运行已执行，包含硬失败未运行项，非全矩阵通过。** 主控核对后分别执行 `node .superpowers/sdd/2026-09-05-deepseek-qwen-coding-tasks/task-5a-native-probe.cjs --model deepseek` 和同命令 `--model qwen`，各完成固定两轮矩阵；选择值仅允许这两个常量，源userData与profile沿当前私有授权配置传入子进程且不打印。只发一次语义判定；保留Provider现有最多两次空正文同请求尝试时记录实际HTTP次数，不增加前置分类调用或表现修复后的再次申请判断。语义失败继续收集预定行，传输/Runtime硬错误使后续行记录未运行；两轮不能择优合并。整次运行复用15分钟期限与30秒清理期限，不更改真实任务的产品预算。
- [x] 结束先中止在途请求并等待自身Runtime/Electron退出，再清理已核对的精确临时叶子文件及空目录。源设置不得写入；不按进程名称强杀、不批量删其他目录。运行结果必须同时列源/矩阵/bundle哈希、实际后端、每行判断与cleanup，不以主控后续手工清理倒改失败。
- [ ] **条件门：**44项逻辑输入全部按预期，所有负例正文/表现合法、原预算/原句/generation/清理全部符合，才标本实验通过并交独立审查。任何失败保留具体类别和未运行项，正式入口保持原样；不改成两次分类或关键词兜底。实验成功也不能代替实际文件读写、编程闭环和取消验收。
- [x] 独立规格/质量审查后主控更新公开验收记录和条件门状态。本任务没有正式产品源码差异；临时实验目录留到最终批准清理。经核实的规格/计划/记录按用户授权提交，暂不push；提交结果另记进度日志。

**完成标准：**得到不可择优拼接的协议/语义实验结论，并明确允许或禁止进入任务5B；失败本身是有效实验结果，不是新入口实现完成。

## 任务 6：原 Core 重复操作保护

**2026-09-06 完成记录：** 当前公有任务路径已完成实施、独立审查及最终 `verify:desktop`，具体计数和限制见[验收记录](../../operations/2026-09-05-deepseek-qwen-coding-tasks.md)。活动 steer／queue promotion、overflow 恢复、providerExecuted、重复 call ID 仅有源码核查，未新增动态覆盖；不把这些分支写为实际运行通过。网站、模型配置与角色功能未修改，本轮不打包。

**目标：**同一当前用户输入中，第三次连续同名、同序列化参数的本地调用在副作用前等待许可；仅继续这一次或结束当前任务。

**架构：**检测留在原V2 runner，等待使用PermissionV2.assert；Main保存许可类型并复用取消清理，Renderer在现有确认区增加严格分支。任务6不依赖5A实验通过，不引入总steps或第二执行器。

### 本任务约束与精确文件

- 不打包、不运行真实模型、不修改网站／角色；实施时只做该范围内必要门禁。主控管理 Git，实施者仅只读 Git。
- 复用固定提交 `2a6be0a03b93a6734070e10a6c3b56863475f214` 的 V1 `packages/opencode/src/session/processor.ts:29,353–379` 比较方式；本地适配必须明确补跨轮，不能声称原样复用覆盖全任务。
- 产品修改：`vendor/opencode/packages/core/src/session/runner/llm.ts`、`packages/coding-task-core/src/index.ts`、`packages/shared-types/src/contracts.ts`、`apps/desktop/src/main/agent/coding-task-service.ts`、`apps/desktop/src/renderer/src/chat/ConfirmationCard.tsx`。
- 新增测试：`packages/coding-task-core/tests/session-loop.test.ts`。复用或补充：`packages/coding-task-core/tests/fixture.ts`、`packages/coding-task-core/tests/model-route.test.ts`、`packages/shared-types/tests/contracts.test.ts`、`apps/desktop/tests/coding-task-service.test.ts`、`apps/desktop/tests/chat-panel.test.tsx`、`tests/integration/desktop-agent.test.ts`、`tests/security/permission-boundary.test.ts`、`tests/e2e/desktop.spec.ts`。
- 来源更新：`vendor/opencode/local-patches.json`、`vendor/opencode/sources.json`、`vendor/opencode/README.md`；现行规格、计划、运行记录由主控维护。不要新增接口只为了暴露内部检测给测试。
- `ConversationCoordinator.resolveFileAction` 与 Preload/IPC 的 confirm/cancel 接口保持。`task-store.ts` 现有终态清卡应先用现有测试验证，不预先改生产状态机。

### 已核实的实现接缝

1. **drain 所有权。** `index.ts:113–119` 用原 `SessionRunCoordinator.make` 将 drain 绑定 `runner.run`。`run-coordinator.ts` 在活动 drain 上 join，wake 合并后续 drain，interrupt 清 pendingWake 并等待 owner。当前 `CodingSession.run` 不允许 busy 时重新 run；普通聊天新输入不能向后台旧任务偷偷续权。
2. **窗口存放。** 建议在 `llm.ts` 的 `run` 调用内建立一个非持久窗口，沿私有 `RunTurn` → `runTurn` → `runAfterOverflowCompaction` → `runTurnAttempt` 传递同一个引用；不要放在 layer 级全局变量、每个 provider turn、每个 assistant 或模型压缩历史中。自然返回、失败、中断及 runtime close 后不保留该引用。可用 ensuring 清除最后参数字符串，避免生命周期结束后持有正文。
3. **新输入与压缩。** `runTurnAttempt:187–195` 只有 `promoted > 0` 才是真正推进新 steer/queue，此处与 currentStep 重置一起清窗口；不能每次 `promotion='steer'` 就清空。`ContinueAfterCompaction`／`ContinueAfterOverflowCompaction` 私有递归必须传回原窗口，不能因重建 request 清空。同一个 `run` 外层 queue 循环依赖实际 promotion 清空，不靠 step 值猜测。活动 drain 结束后的新 run 是新任务接纳生命周期，创建空窗口。
4. **调用顺序。** `Stream.runForEach` 按事件顺序处理，当前先 `publish(event)`，再为工具使用 `FiberSet.run` 并发执行。必须在 publish 成功、确定为本地 tool-call 后，同步登记工具名／`JSON.stringify(event.input)`，快照本次重复次数，再启动任何该调用 fiber。不得在并发工具 fiber 中改同一个计数。重复 call ID 已由 publisher 在 `publish-llm-event.ts:313–329` 拒绝，不计作新的合法调用。
5. **等待位置。** 第三次及以后在 stream 消费接缝等待 `PermissionV2.assert` 成功，再启动该工具 fiber；不要在持有 `withPublication` semaphore 时等待用户。这样本轮后续工具不会越过等待点；已启动的前两项仍按原服务结算，可能存在普通许可卡。中断由原 `providerStream`／FiberSet 清理，不能自己另开不归属作用域的 promise。
6. **规则排序。** 当前正式 agent 并非全局 allow：`index.ts:155–156` 是 `* deny` 后叠加具体 allow/ask 与 approvedCommands。`PermissionV2.evaluate` 用 findLast；末尾追加 `{action:'doom_loop',resource:'*',effect:'ask'}`，不能插在默认 deny 前。即使未来先有 `* allow`，末尾精确 ask 也应胜出。`PermissionV2.assert` 等待 Deferred；同名 `ask` 仅登记后返回，不能用。
7. **持久许可。** PermissionV2 最终还把 saved allow 接在配置之后；单靠末尾 ask 对任意已保存的 doom_loop allow 并非通用保证。本正式组装每次用新 `:memory:` DB，公有 `replyPermission` 仅 once/reject，没有装载外部 saved 规则。循环请求必须省略 save，Main 只发送 once，不加 always；以这些已有条件保证每次必问，不新增 PermissionV2 全局特判或第二策略引擎。若实施时发现实际消费者提供持久 saved 规则，先回主控核对，不能静默假定有效。

### 任务6.1：原 runner 保护与 HTTP RED／GREEN

**文件：**新增 `session-loop.test.ts`，修改 `llm.ts`、Core `index.ts` 及来源记录；必要时只为条件化压缩夹具扩展现有 `fixture.ts`，不复制第二套服务器。

**内部接口草案（非公有导出）：**窗口仅需 `{tool?: string, serializedInput?: string, repeatCount: number}`。每次同名同字符串加一，不同则变为 1；达到 3 后每次都询问，不在 once 后归零。成功、普通失败和用户拒绝都计入调用序列；模型文本／摘要不计工具，也不重置。providerExecuted 不参与本地序列。未知／未装配工具保留原失败路径，不生成可授权的新工具名。正式装配八工具已核对为 read、glob、grep、write、edit、apply_patch、bash、todowrite。

**原许可候选：**

```ts
// 参数比较留在 Core；内部 source 只用于原关联，不传 Renderer。
yield* permission.assert({
  sessionID: session.id,
  agent: agent.id,
  action: 'doom_loop',
  resources: [event.name],
  metadata: { repeatCount },
  source: { type: 'tool', callID: event.id, messageID: assistantMessageID }
}).pipe(Effect.orDie);
```

`vendor/opencode/packages/schema/src/permission.ts:17–23` 已核实 Source 必填 type='tool'、messageID、callID；source 对公开 DTO 不可见。runner 增加 `const permission = yield* PermissionV2.Service` 时同步把 `PermissionV2.node` 加入其 node deps；仅在总 Layer.group 出现不等于该 node 已声明直接依赖。当前 RunError 不包含 PermissionV2.Error；候选沿原工具的 Effect.orDie 收口，不扩张公有 RunError。正式循环结束由 Main abort，不依赖把循环 assert reject 变成可继续工具错误；异常与中断仍必须经过原 publisher／FiberSet 结算。

- [x] **RED：**先新增以下有界 HTTP 形状，当前代码会完成更多 read 而没有循环许可，失败原因应是缺少 doom_loop／第三次已完成。所用 fixture、session.run、replyPermission、events、requests 均已存在。

```ts
const calls: Step[] = Array.from({ length: 4 }, (_, i) => [
  { name: 'read', args: { path: 'note.txt' }, id: `repeat_${i + 1}` }
]);
const f = await fixture([...calls, '结束']);
const controller = new AbortController();
let execution: ReturnType<typeof f.session.run> | undefined;
const timer = setTimeout(() => controller.abort(), 8_000);
try {
  await writeFile(join(f.directory, 'note.txt'), '固定测试正文');
  execution = f.session.run('检查本轮文件', controller.signal);
  void execution.catch(() => undefined);
  await expect.poll(() => f.events.some(e => e.type === 'permission' && e.action === 'doom_loop')
    || f.requests.length >= 4, { timeout: 5_000 }).toBe(true);
  const loop = f.events.find((e): e is Extract<CodingSessionEvent, { type: 'permission' }> =>
    e.type === 'permission' && e.action === 'doom_loop');
  expect(loop).toBeDefined();
  expect(f.requests).toHaveLength(3);
  expect(f.events.filter(e => e.type === 'tool' && e.status === 'completed')).toHaveLength(2);
} finally {
  clearTimeout(timer);
  controller.abort();
  await execution?.catch(() => undefined);
  await f.close();
}
```

测试给 10 秒外层期限，计时器是夹具防挂，不是产品限额。Core fixture 的 Step 是有限字符串／工具数组，超出数组默认“结束”，不会真的构造无限模型。

- [x] 运行 `pnpm.cmd --filter @myself/coding-task-core test tests/session-loop.test.ts`，保留明确 RED 输出。
- [x] **GREEN：**按上述窗口、顺序、assert、agent 最终 ask 作最小实现。原七工具拒绝映射完全保留。两次重复完成后出现许可，第三次无副作用。once 后第三次执行，第四次出现新 ID、repeatCount=4；旧 ID 再回复失败。
- [x] 追加有限反例：`read A, read A, read B, read A` 不触发；同输入但不同工具打断；缺失文件重复仍触发；外目录普通许可拒绝两次后第三次先循环卡，再 once 后仍有外目录许可；不允许用 once 循环卡绕过真实访问许可。
- [x] 同轮数组包含四个相同 read：登记顺序固定为第1/2次执行、第3次等待；一次批准不把第4次一起放行。补“第一项普通许可待定，后续第三重复进入循环许可”组合，避免等前项结算才能显示循环卡的死锁。
- [x] 沿 `model-route.test.ts` 的真实原压缩配置构造“两个重复结果后触发摘要，再第三次重复”；必须断言实际出现 `Create a new anchored summary` 请求且 repeatCount 仍为3。可在 fixture 中增加只按请求内容区分“摘要请求→摘要正文／普通请求→下一个有限 Step”的可选回调，保持默认行为不变；不能把预置摘要字符串误当已经触发原压缩。
- [x] 同一 CodingSession 完成两次 read 后新 `run` 再两次，不继承旧窗口；取消／close 后新实例同样为空。当前公有路径已动态验证。Core 未公开 busy steer，未增加测试专用公有入口；活动 promotion 的重置仅源码核查，未覆盖动态活动 steer，已在验收记录保留限制。

### 任务6.2：严格 DTO 与 Main 许可结束语义

**文件：**`contracts.ts`、`contracts.test.ts`、`coding-task-service.ts`、`coding-task-service.test.ts`。

**最小公有 DTO 候选：**在现有 taskPermissionRequiredEventSchema.request discriminatedUnion 增加一支，沿原 actionId 和 Main 固定 summary，不增加 resources、路径、command、metadata、callId 或模型指定文案。

```ts
z.object({
  action: z.literal('doom_loop'),
  tool: z.enum(['read', 'glob', 'grep', 'write', 'edit', 'apply_patch', 'bash', 'todowrite']),
  repeatCount: z.number().int().min(3).max(Number.MAX_SAFE_INTEGER)
}).strict()
```

整数上界只约束安全数值表示，不是总工具预算。summary 固定“重复操作保护”。Core 公有 CodingSessionEvent 现有 permission 分支可继续使用 resources／metadata，但 Main 只抽取唯一工具标识和 count，严格验证 `resources.length===1`、工具白名单及次数；不展开 metadata，不把 source/callId 写入 DTO。

- [x] RED：新分支最小对象通过，未知工具、次数2／小数／无穷、额外 resources／metadata／command／path 全部失败；现有四类许可仍通过。
- [x] RED：Main 接收一张 doom_loop 和一张普通许可，发布准确白名单 DTO；confirm 仅调用原 session.replyPermission(id,'once')；循环 cancelAction 必须中断当前任务，普通 cancelAction 仍只 replyPermission(id,'reject')。
- [x] GREEN：把 `active.permissions: Map<string,boolean>` 最小替换成 `Map<string,{action: TaskPermissionRequiredEvent['request']['action']; replying: boolean}>`，ID 入表时保存 **已解析 DTO** 的 action，不能从后续 Renderer 请求接受 action。重复／失效 ID 校验和16项同时待定限制保留。replying 在任何异步前置真。
- [x] 在原 `reply(actionId, decision)` 完成当前 owner、ID、未答复验证后，若 `decision==='reject' && pending.action==='doom_loop'`，直接 `await this.cancelActive()` 并返回。不要先 replyPermission('reject') 再 cancel，避免原 runner 在中断前继续下一轮；不要在事件回调或 runOwned finally 中 await 自身 owner.done。
- [x] once 和普通 reject 复用原路径；失败只在同 owner 仍活跃且未 abort 时恢复 replying。终止将 controller 同步 abort，原 runOwned finally 等 run／close 屏障后清全部许可并发布终态；清理失败继续 error 并锁入口，不能报取消成功。
- [x] 扩展现有 runGate／cleanupGate 测试，证明 loop cancelAction 在两个门都结算前不返回、不发布 success/cancelled；同轮其他许可 ID 在 abort 后不可 confirm，迟到 tool/text 不公开，reset/config generation/close 不保留任何循环许可。普通拒绝后独立 read 的真实 HTTP 回归必须仍通过。

### 任务6.3：现有确认区及正式链

**文件：**`ConfirmationCard.tsx`、`chat-panel.test.tsx`、现有集成／安全／桌面 E2E 用例。

- [x] RED：渲染新 DTO 时能看到“重复操作保护”、白名单工具与次数，以及“仅继续这一次”“结束当前任务”；不能渲染 resources 循环或把它显示成外目录许可。用现有 confirm/cancel 回调测试对应调用，不新增 IPC。
- [x] GREEN：现有卡片内一个 doom_loop 分支，原四种文案及“拒绝本次操作”保持。说明固定为“同一操作连续重复；继续仅放行本次，原文件和命令许可仍有效。”结束提示已完成操作不撤销。
- [x] 用现有 taskStore 多卡测试证明结束任务的 terminal phase 清除其余 pendingPermissions；点击到清理结束期间即使其他卡仍在，Main 拒绝迟到回复。若 UI 现有 busy 只禁单卡，先判断是否已有任务状态足以全禁；不因方便引入第二份 task 状态。
- [x] 正式 HTTP 组合从范围授权开始，不绕过 Main 创建许可：两次重复 read 后第三次循环卡→继续一次→第四次新卡→结束；scope 前零 Core、结束后后续调用零副作用、原用户文本不改写。
- [x] 实际 Electron E2E 只增加一个有界循环卡旅程，复用已有窗口与私有 fixture；另以定向测试覆盖排列。运行旧普通许可拒绝旅程，证明没有把局部拒绝变成整任务取消。

### 任务6.4：来源、验证及减法交接

- [x] runner 修改必须写入 `local-patches.json` 的固定来源记录，保留原 upstreamSha256，before/after 精确对应固定原文与当前源码，中文 reason 标出“V1阈值与比较参考、V2跨轮/权限接缝适配”。本提取器对 source 用 find，仅消费一条补丁，不能给同一 source 追加多条记录冒充可重放。
- [x] 从仓库根运行 `node packages/coding-task-core/extract-upstream.cjs`：它会拒绝未记录本地修改，重算 sources.localSha256 与静态闭包；不是 Git 写操作。核对新增依赖仅已有 PermissionV2 服务、固定源 commit 与原始 SHA 不变，无跨网站依赖变化；不删除闭包外旧文件。README 只按实际结果更新数量与职责。
- [x] 依次运行 Core 定向、`pnpm.cmd --filter @myself/coding-task-core typecheck`、`node packages/coding-task-core/run-electron-tests.cjs tests/session-loop.test.ts tests/session-permission.test.ts`；该现有 wrapper 60秒上限，组过大就分组，不扩大产品期限。
- [x] 运行 `pnpm.cmd --filter @myself/shared-types test tests/contracts.test.ts`、`pnpm.cmd --filter @myself/desktop test tests/coding-task-service.test.ts tests/chat-panel.test.tsx`，再共享所有消费者类型、相关 integration/security 和 E2E；最终源码 `pnpm.cmd verify:desktop` 已包含 typecheck、Core test、unit、security、integration、desktop E2E，不无理由重复同一全套。
- [x] `git diff --check`、只读 diff 核对无网站／角色／模型路由改动。单诊断或命令15分钟硬时间盒；长门禁后台轮询，不运行安装包构建或真实模型。
- [x] 主控在规格／计划／验收更新实际证据与仍不覆盖的等效循环，不把精确检测写成通用进展判断。普通许可类、旧路径清理和来源索引只做该功能必要调整，无大量删除。交独立审查后停止编辑。

### 实施者可自行决定的局部细节

- 私有窗口参数名称及是否用一个小型非导出辅助函数；不得为此新增 package、公有配置或另一套执行记录。
- runner 对 assert 失败的最小类型收口是否直接用上述 Effect.orDie 或现有错误适配，须保持原清理与 Main 脱敏，不把未知错误透传公开文本。
- 压缩测试的最小触发正文大小与夹具可选响应函数签名，以实际出现原摘要请求为证据；不能通过加大固定 sleep 获得绿色。
- 对 tool definitions 的已装配名称判定复用当前 materialization，不在产品两处维护不同工具目录。公开 DTO 固定八工具是外部白名单，新增工具必须显式更新消费者。

以上均不需要新增用户决定；若不能保持批准的第三次前等待、一次放行、结束全任务、压缩不绕过及普通拒绝局部语义，则交回主控记录冲突，不能自行降级。

## 任务 7：统一工具输出的有限验证

**授权与依赖：**适用[统一工具输出规格](../specs/2026-09-06-ai-pet-unified-tool-output-proposal.md)。用户已批准该实验与通过后同边界开发。4C删除与独立审查已经完成，但完整门禁被未修改的原生拖拽用例阻断；2026-09-06将这项取证与私有协议实验按文件边界分开推进，不降低最终门禁。任务7以当前HEAD、4C审查指纹及13项实际来源建立未提交工作区的明确冻结基线，无须等待无关拖拽调查；同时只允许一名实施者，原生UI与真实模型运行仍串行。任务5A原协议已经失败，不再运行；任务7只替换私有实验中的输出协议，不启动正式Core，不修改产品源码。后续正式接线须以本任务全部门槛通过、4C门禁及提交完成为前提，再按当前接口形成可执行拆解。

### 文件、接口与交付

复用本计划的私有工作区`.superpowers/sdd/2026-09-05-deepseek-qwen-coding-tasks/`，不新增第二套运行器：

- 修改`task-5a-native-probe-main.ts`：两工具声明、固定提示、`buildRequest`、`classifyResponse`、有限HTTP响应夹具及矩阵判定；保持现有`runLiveMatrix`、模型装配、受控生命周期和启动时序。
- 修改`task-5a-native-probe.cjs`：将原私有Provider例外替换为精确两工具协议识别；保留codec与原HTTP解析，冻结新请求和源码指纹，更新父进程的封闭记录校验。
- 修改`task-5a-native-probe.test.cjs`：替换只服务旧正文联合协议的用例，保留已修复的取消、owner、bootstrap、来源和清理回归。`task-5a-bootstrap-timing-fixture.mjs`无行为修改需求。
- 新的证据使用`task-7-`前缀：实施brief/report、基线/最终源码SHA、RED/GREEN日志、HTTP请求快照、审查包/报告、两模型真实记录。旧`task-5a-*`冻结快照和日志只读保留；三个可编辑运行器的旧内容先保存在新的任务基线，不设置旧协议运行开关。
- 主控维护本计划、规格和`docs/operations/2026-09-05-deepseek-qwen-coding-tasks.md`。实施者不修改公开文档、不运行真实模型、不提交Git；HTTP与独立审查通过后由主控串行实际运行。

消费现有`ModelProvider.respond(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse>`、`ToolChoicePolicy`的`required`、`characterChatResponseJsonSchema`、严格`characterChatResponseSchema`、`capabilityIntentRouter.route`、原SecretStore／Registry和`runAcceptanceLifecycle`。不新增共享公有类型。私有观察结果继续只输出闭合类别／布尔／计数／指纹，不保存响应正文或参数。

### 7.1 固定实验输入与RED

- [x] 记录当前HEAD、4C审查指纹、尚未提交的来源差异，以及三个私有运行器的完整内容和SHA；核对现有13项来源集合。仅对4C实际改动的来源重新计算并说明变更，新source-set仍使用仓库相对路径、正斜杠、按路径排序的JSON；旧快照不重写。来源更新属于建立基线，不算功能RED。
- [x] 在现有`runHttpScenario`中先提供一个真实HTTP函数终答夹具，其载荷使用现有`validChatOutput`。新增测试要求观察为合法终答；同时将blocked请求断言改为仅终答工具、required、没有response_format。在旧协议上分别确认失败是工具未接纳和请求格式不同，不是哈希阻止构建。

```js
test('统一输出：函数终答经过真实 HTTP 后成为合法聊天', async () => {
  const result = await probe.runHttpScenario('terminal_valid');
  assert.equal(result.errorCode, 'NONE');
  assert.equal(result.observation.application, 'none');
  assert.equal(result.observation.behavior, 'valid');
  assert.equal(result.observation.bodyValid, true);
  assert.equal(result.request.responseFormat, 'absent');
  assert.equal(result.request.toolChoice, 'required');
  assert.equal(result.cleanup, true);
});
```

- [x] 运行`node --test --test-name-pattern="统一输出" .superpowers/sdd/2026-09-05-deepseek-qwen-coding-tasks/task-5a-native-probe.test.cjs`，保留退出码和正确失败位置。只为RED增加有限响应输入，不先实现新的接纳路径。

- [x] 4C提交后另外记录关联提交658d1427，不回写原冻结记录。

### 7.2 两工具与一次输出协议

申请函数保持现有名称、描述和严格空参数；终答函数直接复用基础Schema：

```ts
export const characterResponseTool = Object.freeze({
  type: 'function' as const,
  function: Object.freeze({
    name: 'return_character_response',
    description: '返回本轮聊天正文与角色表现建议；不申请任务权限，不操作文件或执行命令。',
    parameters: characterChatResponseJsonSchema
  })
});

const tools = route.modelEscalation === 'blocked'
  ? [characterResponseTool]
  : [authorizationTool, characterResponseTool];
const request: ModelRequest = {
  messages: [
    { role: 'system', content: fixedSystemPrompt },
    { role: 'user', content: selected.input }
  ],
  tools,
  toolChoice: 'required',
  reasoningMode: 'disabled'
};
```

- [x] `buildRequest`按上述装配，不附`responseContract`。删除旧`nativeChatContract`及只供正文修复回合的提示／指纹；不增加第二次语义请求。保留原persona、behavior context和构造器裁剪，明确替换以下四处一次匹配；匹配失败直接停止构建。

| 原提示位置 | 固定新文本 |
| --- | --- |
| 开头“只返回 json 对象……” | 每轮只调用一个已提供的函数，把结果放在函数参数中，不输出普通正文。申请任务时仅调用 request_task_authorization；其余情况调用 return_character_response，聊天正文放在 text 中，可用 Markdown。 |
| capabilityPlan说明 | 当用户要求取得现有本地文件信息、实际修改文件或运行项目命令时，调用 request_task_authorization 申请当前输入的任务范围确认；普通聊天、操作讨论、引用、代码、示例和明确否定调用 return_character_response。 |
| 宿主能力说明 | 桌宠宿主经用户确认 Main 范围后能读取、搜索、修改文件及运行已许可命令。本轮申请函数不读取文件、不执行命令、不表示任务已完成；缺定位可问文件名或位置，不能只让粘贴全文。 |
| 原正文格式示例 | 函数参数示例：申请任务使用 request_task_authorization({})；聊天使用 return_character_response({"text":"我会陪着你。","activity":"安静陪伴","status":"idle","movementControl":{"kind":"keep"},"behaviorPlan":{"kind":"none","emotion":"calm"}})。 |

- [x] 其余activity／status／movement／behavior说明仅作为终答函数参数要求。将原“每轮必填”三处最小限定为“return_character_response参数必填”，避免申请空参数与表现字段互相矛盾；不改变角色选择规则或加入新的分类关键词表。首轮system保持4800 UTF-8字节以内，完整工具Schema计入6400输入预算。
- [x] `transformProvider`删除旧“工具＋正文responseContract”放行例外。保留原`assertResponseContractRequest`和正常非实验请求行为；新的私有识别只匹配required、无正文契约、精确工具表／名称／描述／Schema。参数不符不能进入私有放行分支。
- [x] 原codec负责响应名称关联，原解析负责单function、非空ID、JSON对象。私有接缝仅让精确已知协议保留唯一调用并丢弃并存content，记录`tool_only`或`mixed`类别。不得先尝试从content中恢复聊天或任务建议。普通请求的原解析规则不变。
- [x] `classifyResponse`根据本轮实际提供的工具表严格接纳：申请必须名称相等且参数空对象；终答以`characterChatResponseSchema.safeParse`成功为准，拒绝额外外层或嵌套字段。不对未知标准`tool_request`一律记申请。唯一合法申请的behavior为absent、bodyValid=false；唯一合法终答为application=none、behavior=valid、bodyValid=true。
- [x] text_only即使包含完整旧JSON也记协议失败；未知名、多调用、畸形参数、数组／null、空ID、blocked伪造申请均拒绝。mixed中的普通content不影响已校验工具的判定，也不进入正文或表现。没有合法终答时不发布content。

### 7.3 模型策略与有限回归

- [x] DeepSeek原`deepSeekCharacterChat`策略条件在私有构建中扩展到精确统一工具请求，仍限定`providerId==='deepseek'`：`thinking:{type:'disabled'}`、`max_tokens:4096`、原真正空响应至多两次同请求尝试。response_format保持不存在；有效工具调用一次HTTP即返回。只修改该条件和必要工具解析接缝，不复制Provider实现或全局放开请求组合。
- [x] 本地Provider沿原required策略发`temperature:0`；`reasoning_effort:'none'`、`chat_template_kwargs.enable_thinking:false`、`parallel_tool_calls:false`、`parse_tool_calls:true`、stream=false及原连接generation保持。不修改模型、GGUF、模板、llama.cpp版本、slot或上下文预算。
- [x] 有限HTTP回归覆盖：合法申请、合法终答；两种合法mixed且content不会被使用；非法终答外层／嵌套额外字段、无text／坏behavior；两函数同时返回；unknown／nonfunction／emptyID／非JSON／非对象；blocked伪造申请；普通正文旧JSON；DeepSeek空响应后合法终答只发生两次且body一致；直接合法工具只有一次；原标准无契约工具与冲突请求仍按原规则。
- [x] 保留并适配已有取消、迟到HTTP、host／local generation失效、整次deadline、owner未结算、启动／退出、预算及资源清理回归；不以手工拼装结果替代真实共享接缝。新协议不修改已审查的bootstrap和runAcceptanceLifecycle。
- 本轮未新增以下可选诊断，仅保留既有有界错误观察。如增加Qwen HTTP400最小分类，范围只限`error.type`的`invalid_request_error`／`exceed_context_size_error`／`OTHER`／`MISSING`及固定上游sampler报错精确匹配三态。精确字符串为`Failed to initialize samplers: failed to parse grammar`，来源是固定`b95502ba9aa0eb73a2f4fc8878d7fbe6a847a0b9`的`tools/server/server-context.cpp`捕获前缀与`common/sampling.cpp`异常字面量；只记录true／false／null，不输出message。先在现有有限错误响应夹具验证精确值、不同字符串、缺失字段与自由message隔离。保留64KiB／5秒有界读取及owner结算；不新增泛化诊断模块。
- [x] 运行`node --test .superpowers/sdd/2026-09-05-deepseek-qwen-coding-tasks/task-5a-native-probe.test.cjs`一次完整有限回归，记录替换／保留的用例范围和退出码；正式产品零差异，网站依赖图仍保持。保存新HTTP请求快照，使用夹具凭据；不保存真实认证头。
- [x] 固定新提示、两工具Schema、模型分别的请求体、来源、运行器和bundle指纹，独立审查规格及质量；不把更新预期SHA本身当通过证据。审查发现经定向修复复核后才运行真实模型，不提前调用模型调提示。

### 7.4 主控串行实际模型门槛

- [x] 按现有入口先DeepSeek后Qwen：`node .superpowers/sdd/2026-09-05-deepseek-qwen-coding-tasks/task-5a-native-probe.cjs --model deepseek`，然后同命令`--model qwen`。每款模型只跑一次固定两轮矩阵，分别记录到`task-7-deepseek-live.*.log`和`task-7-qwen-live.*.log`；不覆盖旧记录。真实输入不携带期待答案、隐藏分类标签或预置文件内容。
- [ ] 固定原11句、顺序与空历史，matrix SHA保持`5333a6d7e7d96b768bd0ef7a936bb455eec448f29650f1fa4f8cfbf156e0e924`；每模型12个任务正例都应严格申请，10个负例都应合法终答且无申请。任务正例不再要求正文／表现，负例必须完整合法。两模型共44项全部符合才过门。
- [x] 逐行保留当前输入完整、输入预算、generation、HTTP次数与类别；两模型记录实际modelId/backend。源设置前后不变、DeepSeek凭据只在Main、Qwen实际Vulkan offload、owner及清理均须符合。15分钟原整次期限与30秒清理保持，单点没有判定时不能无限等待。
- [x] 语义错误继续预定余行，模型传输／Runtime硬失败使该模型余行标记未运行；仍可运行另一模型的独立固定矩阵。任一门槛失败即收口本协议，不临时改提示、不重试择优、不进入正式接线。两模型结果分别完整记录。
- [ ] 全部符合时主控更新公开证据并形成正式接线的精确任务；同边界授权已具备，不再重复询问是否继续。正式入口、原Main范围卡、权限和Core执行仍需独立实现／审查以及双模型真实读取、问答、改测、拒绝、取消验收，本实验不替代它们。

**完成标准：**私有协议、有限回归与来源均可独立复核；实际44项门槛给出一个确定通过或失败结论；正式产品未切换，历史失败未覆盖。未达门槛不得把任务7写成正式入口已完成。

任务7结论（2026-09-06）：有限回归57/57及独立复审通过；固定真实矩阵38/44，实验失败收口。全部符合的门槛未通过，因此正式接线条件不满足，不能把相应未勾选项记为完成。后续方案另行明确，不在本任务中循环调提示或自动启用备用路线。

用户最新阶段要求：完成文件能力后结束并等待反馈与明确确认，再开始角色行为、状态和动作开发。本轮不继续扩展与文件逻辑无直接关系的拖拽专项诊断；既有门禁结果如实记录。

## Task 8：全分支审查的两项文件边界修复

适用已批准编程助手规格及 whole-branch-review-report.md 的 S1/Q1、Q2。两项都修复现有契约，不改变产品范围；用户持续授权开发。Task7实验已经失败收口，不重试。明确入口提案已于2026-09-06获批，另在Task9实施。本任务是全分支审查的一次合并修复派发，完成后只做定向复审。

### 范围与约束

- 仓库为当前隔离工作区，BASE由主控保存。保留全部已有修改，实施者不执行Git写操作、不修改公开文档、不运行真实模型或原生UI、不打包、不访问网站业务。
- 网站、CloudBase、scanner、MCP启用、角色行为/状态/动作及拖拽均不在范围。不得修改 tests/e2e/desktop.spec.ts。当前原生拖拽门禁失败如实保留，不能为本任务继续诊断或放宽测试。
- 只修改 apps/desktop/src/main/agent/coding-task-service.ts、apps/desktop/tests/coding-task-service.test.ts、vendor/opencode/packages/core/src/tool/apply-patch.ts、packages/coding-task-core/tests/session-cancel.test.ts；必要时最小扩展现有 packages/coding-task-core/tests/fixture.ts 以注入可控trash回调。来源更新限 vendor/opencode/local-patches.json、vendor/opencode/sources.json，源文件仅一条既有补丁记录，原固定提交/原始SHA不变。若必须扩大到其他产品文件先向主控说明具体依赖。
- 使用当前Effect与已有FileMutation思想，不增加第二个生命周期框架。中文结构注释解释实际副作用与取消边界。新旧逻辑只保留一条正式路径。

### 8.1 RED：实际超时与取消缺口

- [x] 阅读 whole-branch-review-report.md 两个发现与直接调用链。先新增Main定向测试：timeout:true、无exit、模型直接终答时，可信工具结果ok:false且最终phase:error；超时后实际命令成功重试可以恢复success，历史失败事实仍是false。保持原非零退出码后成功重试契约。
- [x] 在现有Core真实runner夹具注入延迟trash Promise，先等待回调确实开始，再取消/关闭；结算前run与close不得完成，兑现后才完成且无completed成功终态。覆盖宿主成功和拒绝兑现，以及许可等待阶段仍可取消且trash零调用。Main已有reset/active所有权测试若不能证明reset等待实际Core结算，最小扩展相应测试，不造独立模拟执行器。
- [x] 运行各自最小定向测试并记录正确失败，不以超时或装配错误代替RED。受控deferred与明确进入信号优先于固定sleep。

### 8.2 GREEN：最小修复

- [x] Main工具事实投影纳入timeout，最近命令结果决定未恢复失败；不把任意历史失败永久锁成error，也不让模型口头成功改写工具事实。不扩大公开DTO保存原始工具参数。
- [x] 仅已经开始的单次不可取消trash副作用及必要结果登记等待结算；不得将权限等待、整个apply_patch或整个工具循环设成不可取消。取消后不继续下一次变更，不释放owner后继续本地副作用；失败结算不发布成功。
- [x] 更新已有apply-patch来源补丁，运行 node packages/coding-task-core/extract-upstream.cjs 核对可重放来源，不追加重复source条目或改变其他上游实现。

### 8.3 验证与交接

- [x] Main定向测试、Core取消与相关权限定向测试、两个package typecheck、必要Electron Core wrapper运行；总门禁由主控在Task9后统一执行，不重复启动完整E2E。
- [x] 保存 task-8-red-*.log / task-8-green-*.log，记录命令、起止、退出码与新旧测试数量。git diff --check通过；用task-8-baseline.json核对修改集合。
- [x] 交付 task-8-report.md：DONE/有问题状态、修改与原因、RED/GREEN证据、取消成功与失败语义、来源记录、未验证项。最终清单task-8-final-manifest.json包含所有改动源码与日志SHA。返回主控简短状态，不提交代码。

完成标准：两个审查缺陷有最小失败回归与修复证据，未扩大权限或改变其他模块；全分支审查由原审查者按精确差异定向复核，不重新审阅整个分支。

## Task 9：接入已批准的明确任务入口

适用[明确任务提交规格](../specs/2026-09-06-ai-pet-explicit-task-submit-proposal.md)，用户已明确选择“接受明确入口优先交付”。依赖Task8两项结算修复完成；Task5A/7失败保留，不接入其私有协议。此任务改变提交入口，不重建任务执行能力。

### 文件和固定接口

- 产品范围：apps/desktop/src/shared/myself-api.ts、src/preload/index.ts、src/main/ipc/register-ipc.ts、src/main/index.ts、src/main/conversation/conversation-coordinator.ts、src/renderer/src/chat/ChatPanel.tsx。路径前缀均为apps/desktop；样式仅在既有 src/renderer/src/styles.css 中按实际布局需要最小调整，不另加UI框架。
- 桌面私有共享契约新增 ChatSubmissionIntent = 'auto' | 'task'；MyselfApi.submitMessage(text, intent?)、AgentIpcService.submit(text, intent?)、ConversationCoordinator.submit(text, intent?)缺省auto。IPC现有严格chatSubmitSchema增加intent严格枚举和auto缺省；不引入权限/模型/目录参数，不新增IPC通道或全局持久模式。它只由桌面消费，不修改packages/shared-types或网站。
- 当前共享契约位于apps/desktop/src/shared，不是packages/shared-types；原提案的“共享IPC”不要求扩大跨应用包。常规调用可以保持单实参，以减少机械测试改写。
- 主控维护规格/计划/验收和Git。实施者不运行真实模型、不打包、不push、不改MCP或角色逻辑，不修改任何拖拽代码和测试段落。tests/e2e/desktop.spec.ts只可在“正式Core任务UI”组增加与入口有关的一个有界旅程，其他组零变化。

### 9.1 RED：先证明入口和信任边界

- [ ] 在既有 apps/desktop/tests/conversation-coordinator.test.ts 用当前被自然入口漏判的内容问答发task提交，断言chatTurnFactory/聊天Provider零调用、原始规范化文本不变、Main现有范围卡出现，确认前capability submit/激活为零，确认后同一任务端口执行。拒绝范围时零执行。
- [ ] 断言task是单次意图：下一次省略intent仍走auto；未知intent在IPC拒绝；busy/reset/关闭或配置generation变化后旧确认不能激活新任务。复用既有披露与范围生命周期回归，补针对新增分支的最小用例。
- [ ] 在 apps/desktop/tests/agent-ipc.test.ts 与 preload-api.test.ts 证明只传text和intent，仍验证当前chat sender，额外目录/授权字段严格拒绝；原单参数调用兼容。
- [ ] 在 apps/desktop/tests/chat-panel.test.tsx 通过真实按钮点击断言任务意图、普通发送缺省auto、两者共用空输入/忙碌/许可等待/本地模型加载禁用及停止；不保存模式或复制提交owner。先观察正确RED再改产品。

### 9.2 GREEN：复用准备、披露和范围授权

- [ ] ChatPanel保留“发送给 AI Pet”作为现有表单默认，增加type=button“作为任务发送”，调用同一提交函数并传task；保留文本框、输入长度、错误、停止、revision和owner处理。两个按钮可使用现有primary/quiet样式，无第二消息存储或任务页。
- [ ] Main严格校验后传递单次意图。在Coordinator现有文本/空闲校验、同一context与事件生命周期中，task分支直接进入prepareCapabilityTask(context,'file')，不调用陪伴模型、不通过角色prepareUserPrompt改写任务文字或执行角色指令。当前'file'任务Kind已装配全部八工具与范围命令，不另造coding Kind。
- [ ] 省略/auto保持原路由与陪伴行为。task不被“任务完成了吗”等普通快捷回复吞掉，也不能通过等待确认时的聊天回复绕过busy校验；原auto的等待提示行为保留。原明确后台运行请求拒绝规则保留，可复用已有本地route证据判断，不能用该路由重新决定task是否变聊天。
- [ ] prepareCapabilityTask复用Main快照、跨Provider披露、范围卡、确认/拒绝与过期检查；scope之前零Core。目录/模型/能力/完整命令由Main决定。未知/额外输入不进入授权。不存在替代旧Core或放宽权限的代码。

### 9.3 组合和真实界面回归

- [ ] apps/desktop/tests/main-conversation-composition.test.ts 使用既有真实HTTP/Core夹具从task提交到Main范围卡，再批准并读取未知随机内容。断言范围前无模型请求、范围后真实read回注，最终正文包含内容，未调用聊天适配器。保留自然入口既有测试。
- [ ] 既有“正式Core任务UI”组增加单个明确按钮读取旅程：输入内容问答、点击按钮、出现准确目录/模型卡且Provider请求0；批准后原Core读取随机文件并在既有聊天正文可见；结束后普通发送仍走原聊天。使用当前configureCodingApp/fixture/ProviderServer，不复制新夹具。运行新用例与原自然读取、许可拒绝/重复保护必要旅程，不跑无关拖拽专项。
- [ ] 定向测试后Desktop typecheck/build、preload边界。完整verify:desktop及真实两模型由主控在审查后执行，实施者不重复总门禁。
- [ ] 提供task-9-report.md、task-9-final-manifest.json及RED/GREEN日志；源码检查仅上述范围，git diff --check通过。主控生成冻结差异后独立规格与质量审查。

完成标准：明确任务能从原界面可靠到达原授权与执行链，普通发送保持原体验；scope前不产生本地副作用；新增入口无持久权限；未改变其他业务。自动识别的已知误判不因本任务记为已修复。

## Task 10：明确入口的双模型完整真实验收

依据已批准明确入口规格，依赖Task8/9实现及定向审查通过。用户已配置DeepSeek并批准真实验收，本轮也使用现有内置Qwen，不更换模型、Provider、模型资源或预算。用户已接受自然入口残留误判单独列为后续项，不能将本任务通过宣传成自动分流通过。

### 10.1 最小迁移现有验收器

- [ ] 只修改 apps/desktop/scripts/local-model-acceptance-runner.ts、run-local-model-acceptance.mjs、run-local-model-acceptance.d.mts 和 apps/desktop/tests/local-model-acceptance.test.ts；不建立第二个执行或验收框架。主控维护公开文档和Git。实施者不运行真实模型或UI。
- [ ] 现有runCodingModelAcceptance的六场景输入原文、顺序、磁盘随机内容、修复目标/测试断言、拒绝处理、完整命令allowlist、取消进程与心跳检查保持原样；唯一任务入口变化是每项文件场景调用正式coordinator.submit(text,'task')。首条中文聊天继续auto；不将源文案加文件内容、期望答案或分类暗示。
- [ ] 先以现有正式HTTP/Core夹具覆盖一个问答场景：陪伴Provider只允许首条普通中文聊天，文件问答必须不调用陪伴模型而经原Main范围和真实Core读取未知随机值后通过。旧auto验收路径上应因漏入聊天而正确失败。复用既有runCodingModelAcceptance，不增加测试专用executor。
- [ ] 公开验收记录增加闭合字段taskEntry:'auto'|'task'，真实新运行明确记task；缺失历史字段保留auto含义，不把旧记录标成task。schemaVersion更新为3，声明/失败记录/重建器同步。先补记录白名单失败测试，原隐私与嵌套字段剥离保持；不保存正文、路径、命令原文或凭据。
- [ ] GREEN后运行local-model-acceptance定向与Desktop typecheck，保存 task-10-report.md、task-10-final-manifest.json、RED/GREEN日志和新旧源指纹；独立审查后由主控运行模型。现有15分钟整轮期限、30秒清理、owner/generation与原停止条件不扩大。

### 10.2 主控真实运行及交付

- [ ] 对当前已配置DeepSeek运行现有CLI整套all场景，随后内置Qwen使用vulkan运行相同all场景；与Electron UI门禁串行。源配置前后指纹不变，DeepSeek密钥仅Main读取；Qwen实际backend/offload、云调用隔离与进程清理均记录。不能更改模型或通过只跑成功子集获得整轮通过。
- [ ] 新证据分别使用task-10-deepseek-live和task-10-qwen-live前缀，保留先前Task4/5/7失败；每款模型六场景须在同一完整轮次通过。必要失败诊断仅基于真实证据，精确记录原因为产品缺陷、许可需要人工选择或验收器限制，不能随意放宽allowlist。
- [ ] 根package.json确认脚本后运行最终verify:desktop；涉及共享契约消费者按实际范围验证。保留无关原生拖拽门禁失败，不重新开展专项诊断。新代码引起失败则回到对应接缝修复。
- [ ] 确认MCP继续禁用、网站源及依赖图隔离、git diff --check与精确修改清单；更新规格/计划/独立验收记录，仅提交已审查文件，不push、不打包，不纳入用户独立角色规格。恢复用户原桌宠dev启动方式。
- [ ] 最终说明明确入口使用方法、实际双模型结果、未解决自然识别与原生窗口限制、提交。到此结束文件阶段，等待用户真实反馈与明确确认；不开始角色行为/状态/动作实现。

完成标准：两模型真实文件任务在准确入口标记下得到完整可复查结论。若任一场景仍失败，不能把整个文件阶段记为完成；实际用户确认不由自动化替代。
