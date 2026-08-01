# AI Pet 本地关键词相关性审核实施计划

> **给执行代理：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，按任务逐项实施本计划。步骤使用复选框（`- [ ]`）跟踪。

**目标：** 用零外部调用成本的本地分组关键词分类器替换 CloudBase AI 相关性审核，同时保持腾讯云内容安全自动驳回、管理员二次审核和三天隔离流程不变。

**架构：** 新增实现现有 `RelevanceClassifier` 端口的纯本地 `KeywordRelevanceClassifier`，由审核工作器直接装配。分类器只返回 `pass` 或 `review`；审核服务继续负责固定状态映射，并以 `local-keyword` 和独立规则版本写入审计记录。

**技术栈：** TypeScript 5、Node.js ESM、Vitest 3、CloudBase 云函数、腾讯云 TMS/IMS、pnpm 11。

## 全局约束

- 所有文档和新增结构性注释使用中文。
- 采用最小修改策略，不修改数据库结构、公开接口、管理端数据契约或 `RelevanceClassifier` 签名。
- 本地关键词分类器只能返回 `pass` 或 `review`，任何零命中、弱命中、组合不足或内部异常都返回 `review`。
- 政治、脏话及其他明确内容安全风险，继续由 TMS、IMS、OCR 或资源包技术扫描自动驳回。
- `pass` 和 `review` 都进入 `manual_review_pending`；只有管理员批准后才能进入 `published`。
- 关键词规则版本固定为 `keyword-relevance-2026-08-01`。
- 不新增运行时依赖，不调用外部 AI，不启用或购买 CloudBase AI 能力。
- 不读取、打印、提交或改写任何真实密码、SecretId、SecretKey、API Key、OTP 或忽略的环境文件。
- 当前工作树存在其他未提交修改；每次提交前必须核对暂存区，只提交本任务列出的文件。

---

## 文件结构

### 新建

- `apps/cloudbase-api/src/services/keyword-relevance.ts`：保存规则版本、关键词分组、规范化和本地分类器。
- `apps/cloudbase-api/tests/keyword-relevance.test.ts`：覆盖强词、组合词、Unicode、英文边界和转人工策略。

### 修改

- `apps/cloudbase-api/src/config.ts`：删除不再需要的 CloudBase AI 配置字段与必填校验。
- `apps/cloudbase-api/src/functions/moderation-worker.ts`：改为装配本地关键词分类器。
- `apps/cloudbase-api/src/services/moderation-service.ts`：将相关性审计提供方改为 `local-keyword`，并记录关键词规则版本。
- `apps/cloudbase-api/tests/config.test.ts`：证明无 AI 环境变量时仍能加载配置。
- `apps/cloudbase-api/tests/cloudbase-runtime.test.ts`：同步精简 `CloudConfig` 测试夹具。
- `apps/cloudbase-api/tests/moderation-worker.test.ts`：证明生产工作器可在无 AI 配置时完成装配。
- `apps/cloudbase-api/tests/moderation-service.test.ts`：验证本地关键词审计记录和状态映射。
- `apps/cloudbase-api/tests/support/cloudbase-production.ts`：删除测试环境中的 AI 变量。
- `docs/operations/cloudbase-deployment.md`：把 AI 开通步骤替换为本地关键词说明，并精简环境变量清单。
- `docs/operations/content-moderation.md`：补充关键词分组、零命中转人工和规则维护流程。

### 删除

- `apps/cloudbase-api/src/adapters/cloudbase-relevance.ts`：删除不再使用的 CloudBase OpenAI 兼容接口适配器。
- `apps/cloudbase-api/tests/cloudbase-relevance.test.ts`：删除对应网络适配器测试，由本地分类器测试替代。

---

### 任务 1：实现纯本地分组关键词分类器

**文件：**

- 新建：`apps/cloudbase-api/src/services/keyword-relevance.ts`
- 新建：`apps/cloudbase-api/tests/keyword-relevance.test.ts`
- 参考：`apps/cloudbase-api/src/ports.ts:278,446-448`

**接口：**

- 使用：`RelevanceClassifier.classify(input: RelevanceInput): Promise<RelevanceSuggestion>`
- 产出：`keywordRelevanceRuleVersion = 'keyword-relevance-2026-08-01'`
- 产出：`KeywordRelevanceClassifier implements RelevanceClassifier`
- 保证：本实现只返回 `Promise<'pass' | 'review'>` 范围内的值。

- [ ] **步骤 1：先编写失败测试**

创建 `apps/cloudbase-api/tests/keyword-relevance.test.ts`：

```ts
import { describe, expect, it } from 'vitest';

import {
  KeywordRelevanceClassifier,
  keywordRelevanceRuleVersion
} from '../src/services/keyword-relevance.js';

describe('本地关键词相关性分类器', () => {
  const classifier = new KeywordRelevanceClassifier();

  it('公开稳定的规则版本', () => {
    expect(keywordRelevanceRuleVersion)
      .toBe('keyword-relevance-2026-08-01');
  });

  it.each([
    ['AI桌宠导入新角色后闪退', ''],
    ['桌面宠物建议', '希望增加动作'],
    ['DESKTOP PET package', 'new skin'],
    ['ＡＩ Ｐｅｔ', '导入资源包']
  ])('强产品词命中后通过：%s', async (title, body) => {
    await expect(classifier.classify({ title, body }))
      .resolves.toBe('pass');
  });

  it.each([
    ['PNG 贴图', '导入后显示异常'],
    ['拖拽建议', '希望增加透明度'],
    ['角色模型反馈', '显示异常']
  ])('有效跨组组合通过：%s', async (title, body) => {
    await expect(classifier.classify({ title, body }))
      .resolves.toBe('pass');
  });

  it.each([
    ['这个模型很好看', ''],
    ['希望支持这个功能', ''],
    ['今天天气不错', ''],
    ['Petroleum update', 'unrelated news']
  ])('弱命中、零命中和英文子串转人工：%s', async (title, body) => {
    await expect(classifier.classify({ title, body }))
      .resolves.toBe('review');
  });

  it('任何规则输入都不产生自动驳回', async () => {
    const decisions = await Promise.all([
      classifier.classify({ title: 'AI Pet', body: '' }),
      classifier.classify({ title: '模型', body: '' }),
      classifier.classify({ title: '', body: '' })
    ]);
    expect(decisions).not.toContain('reject');
  });
});
```

- [ ] **步骤 2：运行测试并确认失败原因正确**

运行：

```powershell
pnpm.cmd --filter @myself/cloudbase-api test -- keyword-relevance.test.ts
```

预期：失败，并提示无法找到 `../src/services/keyword-relevance.js`；不能接受由其他既有测试失败造成的假失败。

- [ ] **步骤 3：编写最小实现**

创建 `apps/cloudbase-api/src/services/keyword-relevance.ts`：

```ts
import type {
  RelevanceClassifier,
  RelevanceInput,
  RelevanceSuggestion
} from '../ports.js';

export const keywordRelevanceRuleVersion =
  'keyword-relevance-2026-08-01';

const strongProductPatterns = [
  /\bai\s*pet\b/iu,
  /ai\s*桌宠/iu,
  /桌面宠物/u,
  /桌宠/u,
  /\bdesktop\s+pet\b/iu
] as const;

const resourcePatterns = [
  /角色|模型|皮肤|贴图|动画|动作|资源包|压缩包/u,
  /\b(?:json|png|jpe?g|webp)\b/iu
] as const;

const functionPatterns = [
  /跟随鼠标|拖拽|点击互动|待机|移动|缩放|透明度|置顶|开机启动|托盘|导入|上传|下载|加载/u
] as const;

const issuePatterns = [
  /闪退|卡顿|无法启动|导入失败|显示异常|兼容性|建议|反馈|希望增加|能否支持/u
] as const;

function hasAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(text));
}

function normalizeInput(input: RelevanceInput): string {
  return `${input.title}\n${input.body}`
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
}

/** 使用确定性分组关键词给出相关性建议；任何不确定情况均转人工。 */
export class KeywordRelevanceClassifier implements RelevanceClassifier {
  async classify(input: RelevanceInput): Promise<RelevanceSuggestion> {
    try {
      const text = normalizeInput(input);
      if (hasAny(text, strongProductPatterns)) return 'pass';

      const hasResource = hasAny(text, resourcePatterns);
      const hasFunction = hasAny(text, functionPatterns);
      const hasIssue = hasAny(text, issuePatterns);
      return Number(hasResource) + Number(hasFunction) + Number(hasIssue) >= 2
        ? 'pass'
        : 'review';
    } catch {
      return 'review';
    }
  }
}
```

- [ ] **步骤 4：运行分类器测试并确认通过**

运行：

```powershell
pnpm.cmd --filter @myself/cloudbase-api test -- keyword-relevance.test.ts
```

预期：`keyword-relevance.test.ts` 全部通过；测试过程中无网络请求。

- [ ] **步骤 5：运行类型检查**

运行：

```powershell
pnpm.cmd --filter @myself/cloudbase-api typecheck
```

预期：退出码为 `0`，`KeywordRelevanceClassifier` 正确满足现有端口。

- [ ] **步骤 6：只提交本任务文件**

```powershell
git add -- apps/cloudbase-api/src/services/keyword-relevance.ts apps/cloudbase-api/tests/keyword-relevance.test.ts
git diff --cached --check
git diff --cached --name-only
git commit -m "feat: 增加本地关键词相关性分类器"
```

预期：暂存区只包含上述两个文件。

---

### 任务 2：移除 CloudBase AI 运行配置并切换生产装配

**文件：**

- 修改：`apps/cloudbase-api/src/config.ts:2-23,35-50,59-80`
- 修改：`apps/cloudbase-api/src/functions/moderation-worker.ts:1-55`
- 修改：`apps/cloudbase-api/tests/config.test.ts:5-58`
- 修改：`apps/cloudbase-api/tests/cloudbase-runtime.test.ts:11-33`
- 修改：`apps/cloudbase-api/tests/moderation-worker.test.ts:29-40`
- 修改：`apps/cloudbase-api/tests/support/cloudbase-production.ts:4-27`
- 删除：`apps/cloudbase-api/src/adapters/cloudbase-relevance.ts`
- 删除：`apps/cloudbase-api/tests/cloudbase-relevance.test.ts`

**接口：**

- 使用：任务 1 产出的 `new KeywordRelevanceClassifier()`。
- 产出：`CloudConfig` 不再包含 `cloudbaseAiBaseUrl`、`cloudbaseAiApiKey`、`relevanceModel`。
- 产出：`createProductionWorker()` 不依赖 `CLOUDBASE_AI_BASE_URL` 或 `CLOUDBASE_AI_API_KEY`。

- [ ] **步骤 1：先修改配置测试，使无 AI 变量成为明确要求**

在 `apps/cloudbase-api/tests/config.test.ts` 的 `validEnv` 中删除：

```ts
CLOUDBASE_AI_BASE_URL: 'https://ai.example.com/v1',
CLOUDBASE_AI_API_KEY: 'ai-secret'
```

在完整配置期望对象中删除：

```ts
cloudbaseAiBaseUrl: 'https://ai.example.com/v1',
cloudbaseAiApiKey: 'ai-secret',
relevanceModel: 'deepseek-v4-flash'
```

并在“从传入环境变量加载完整运行配置”测试末尾增加：

```ts
expect(config).not.toHaveProperty('cloudbaseAiBaseUrl');
expect(config).not.toHaveProperty('cloudbaseAiApiKey');
expect(config).not.toHaveProperty('relevanceModel');
```

同时删除该文件其他测试夹具里的两个 `CLOUDBASE_AI_*` 字段。

- [ ] **步骤 2：同步修改生产测试夹具**

从以下位置删除所有 AI 配置字段：

- `apps/cloudbase-api/tests/cloudbase-runtime.test.ts` 的 `validConfig`。
- `apps/cloudbase-api/tests/support/cloudbase-production.ts` 的 `values`。

将 `apps/cloudbase-api/tests/moderation-worker.test.ts` 第一个测试名称改为：

```ts
it('无需 AI 环境变量即可创建生产工作器', () => {
```

该测试继续调用 `stubCloudConfig()` 和 `createProductionWorker()`，并保留现有运行时及函数类型断言。

- [ ] **步骤 3：运行测试并确认旧配置要求导致失败**

运行：

```powershell
pnpm.cmd --filter @myself/cloudbase-api test -- config.test.ts cloudbase-runtime.test.ts moderation-worker.test.ts
```

预期：至少 `config.test.ts` 或 `moderation-worker.test.ts` 因缺少 `CLOUDBASE_AI_BASE_URL` 而失败。

- [ ] **步骤 4：精简运行配置**

从 `CloudConfig` 删除：

```ts
cloudbaseAiBaseUrl: string;
cloudbaseAiApiKey: string;
relevanceModel: 'deepseek-v4-flash';
```

从 `loadCloudConfig` 删除 `cloudbaseAiBaseUrl` 的读取及 HTTPS 校验，并从返回对象删除：

```ts
cloudbaseAiBaseUrl,
cloudbaseAiApiKey: readRequired(env, 'CLOUDBASE_AI_API_KEY'),
relevanceModel: 'deepseek-v4-flash'
```

保留 `SCANNER_URL` 的 HTTPS 校验和所有腾讯云内容安全配置不变。

- [ ] **步骤 5：切换工作器装配**

在 `apps/cloudbase-api/src/functions/moderation-worker.ts` 中删除：

```ts
import { CloudBaseRelevanceClassifier } from '../adapters/cloudbase-relevance.js';
```

增加：

```ts
import { KeywordRelevanceClassifier } from '../services/keyword-relevance.js';
```

将：

```ts
new CloudBaseRelevanceClassifier(
  config.cloudbaseAiBaseUrl,
  config.cloudbaseAiApiKey
),
```

替换为：

```ts
new KeywordRelevanceClassifier(),
```

- [ ] **步骤 6：删除已失效的网络适配器与测试**

使用补丁删除：

- `apps/cloudbase-api/src/adapters/cloudbase-relevance.ts`
- `apps/cloudbase-api/tests/cloudbase-relevance.test.ts`

本步骤只删除这两个已被本地实现完全替代的文件，不执行批量删除。

- [ ] **步骤 7：运行定向测试和类型检查**

运行：

```powershell
pnpm.cmd --filter @myself/cloudbase-api test -- config.test.ts cloudbase-runtime.test.ts moderation-worker.test.ts keyword-relevance.test.ts
pnpm.cmd --filter @myself/cloudbase-api typecheck
```

预期：全部通过；`rg -n "CLOUDBASE_AI|CloudBaseRelevanceClassifier|cloudbase-relevance" apps/cloudbase-api` 无匹配。

- [ ] **步骤 8：只提交本任务文件**

```powershell
git add -- apps/cloudbase-api/src/config.ts apps/cloudbase-api/src/functions/moderation-worker.ts apps/cloudbase-api/tests/config.test.ts apps/cloudbase-api/tests/cloudbase-runtime.test.ts apps/cloudbase-api/tests/moderation-worker.test.ts apps/cloudbase-api/tests/support/cloudbase-production.ts apps/cloudbase-api/src/adapters/cloudbase-relevance.ts apps/cloudbase-api/tests/cloudbase-relevance.test.ts
git diff --cached --check
git diff --cached --name-only
git commit -m "refactor: 切换本地相关性审核"
```

预期：暂存区只包含本任务列出的八个文件。

---

### 任务 3：记录本地关键词审核来源与规则版本

**文件：**

- 修改：`apps/cloudbase-api/src/services/moderation-service.ts:1-10,265-285`
- 修改：`apps/cloudbase-api/tests/moderation-service.test.ts:114-145`

**接口：**

- 使用：任务 1 的 `keywordRelevanceRuleVersion`。
- 产出：相关性记录使用 `provider: 'local-keyword'`。
- 产出：相关性记录使用 `ruleVersion: 'keyword-relevance-2026-08-01'`。
- 保持：`RelevanceClassifier` 的 `reject` 兼容路径不删除，以便未来实现仍能复用审核编排。

- [ ] **步骤 1：先增加审计记录失败测试**

在 `apps/cloudbase-api/tests/moderation-service.test.ts` 的状态映射测试后增加：

```ts
it.each([
  ['pass' as const, 'Pass', 'AI_PET_PASS'],
  ['review' as const, 'Review', 'AI_PET_REVIEW']
])('记录本地关键词审核来源和版本：%s', async (
  relevanceSuggestion,
  signalSuggestion,
  label
) => {
  const { service, store } = createService({
    relevance: relevanceSuggestion
  });

  await service.process('submission-1');

  const records = store.applyModerationDecision.mock.calls[0]![0].results;
  expect(records.find(
    (record: ModerationRecord) => record.kind === 'relevance'
  )).toMatchObject({
    provider: 'local-keyword',
    ruleVersion: 'keyword-relevance-2026-08-01',
    suggestion: signalSuggestion,
    label
  });
  expect(store.applyModerationDecision).toHaveBeenCalledWith(
    expect.objectContaining({ nextStatus: 'manual_review_pending' })
  );
});
```

- [ ] **步骤 2：运行测试并确认旧审计值导致失败**

运行：

```powershell
pnpm.cmd --filter @myself/cloudbase-api test -- moderation-service.test.ts
```

预期：新增用例因当前记录仍为 `provider: 'cloudbase-ai'`、规则版本仍为 `2026-07-31` 而失败。

- [ ] **步骤 3：以最小修改更新相关性记录**

在 `apps/cloudbase-api/src/services/moderation-service.ts` 顶部增加：

```ts
import { keywordRelevanceRuleVersion } from './keyword-relevance.js';
```

将 `reviewRelevance` 中的记录写入改为：

```ts
const record = this.record(submission.id, 'relevance', 'local-keyword', {
  suggestion: suggestion === 'pass'
    ? 'Pass'
    : suggestion === 'reject'
      ? 'Block'
      : 'Review',
  label: `AI_PET_${suggestion.toUpperCase()}`
});
results.push({
  ...record,
  ruleVersion: keywordRelevanceRuleVersion
});
```

保持 `record()` 对 TMS、IMS、扫描器记录使用的默认版本不变，避免扩大修改范围。

- [ ] **步骤 4：运行审核服务全部测试**

运行：

```powershell
pnpm.cmd --filter @myself/cloudbase-api test -- moderation-service.test.ts
```

预期：新增审计用例、相关性兼容 `reject` 用例、明确风险自动驳回和依赖失败关闭用例全部通过。

- [ ] **步骤 5：只提交本任务文件**

```powershell
git add -- apps/cloudbase-api/src/services/moderation-service.ts apps/cloudbase-api/tests/moderation-service.test.ts
git diff --cached --check
git diff --cached --name-only
git commit -m "feat: 记录关键词审核审计信息"
```

预期：暂存区只包含上述两个文件。

---

### 任务 4：更新运维文档并完成整体回归

**文件：**

- 修改：`docs/operations/cloudbase-deployment.md:29-38,48-70,107-118`
- 修改：`docs/operations/content-moderation.md:1-20,73-78,95-99`

**接口：**

- 使用：任务 1 至任务 3 已验证的运行行为。
- 产出：部署人员不再被要求购买、启用或配置 CloudBase AI。
- 产出：管理员明确知道零命中不是违规结论，而是需要人工判断。

- [ ] **步骤 1：更新 CloudBase 部署手册**

将 `docs/operations/cloudbase-deployment.md` 的“AI 相关性审核”整节替换为：

```markdown
## 4. 本地关键词相关性审核

1. 相关性审核由后端内置的分组关键词规则执行，不需要开通 CloudBase AI、购买 AI Token 或配置第三方模型。
2. 强产品词或有效跨组组合输出系统通过建议；零命中、单个弱词、组合不足和内部异常一律转人工。
3. 关键词层不产生自动驳回。政治、脏话及其他明确风险仍由 TMS、IMS、OCR 和资源包技术扫描处理。
4. 系统通过与转人工都进入管理员队列，只有管理员批准后才能公开。
```

从“服务端环境变量清单”删除：

```text
CLOUDBASE_AI_BASE_URL
CLOUDBASE_AI_API_KEY
```

在“开发环境冒烟门禁”中补充：

```markdown
验证强产品词和有效组合进入管理员队列，零命中与弱命中也进入管理员队列且不会自动驳回；明确内容安全风险仍进入自动驳回。
```

- [ ] **步骤 2：更新内容审核运维手册**

在 `docs/operations/content-moderation.md` 的“审核原则”后增加独立的 `1.1` 小节，避免改动既有章节编号：

```markdown
### 1.1 本地关键词相关性信号

- 强产品词包括 AI Pet、AI桌宠、桌宠、桌面宠物和 desktop pet，命中后给出相关性通过建议。
- 资源对象、产品功能、问题与建议采用跨组组合判断；单个弱词不能自动通过。
- 零命中、弱命中、组合不足或规则异常统一转人工，不代表内容已经违规。
- 关键词审核记录提供方为 `local-keyword`，规则版本为 `keyword-relevance-2026-08-01`。
- 关键词层绝不自动驳回，管理员仍需结合原文、TMS/IMS、OCR 和文件扫描结果作出最终决定。
```

保持后续章节编号不变，并把“失败关闭”中的 `AI 相关性服务不可用` 替换为：

```markdown
本地相关性规则异常并转人工
```

在“误判复盘”中把“调整词库或模型阈值”改为“调整关键词分组或组合规则”，并要求先增加对应回归用例再改源码。

- [ ] **步骤 3：检查文档和代码中不再存在运行时 AI 要求**

运行：

```powershell
rg -n "CLOUDBASE_AI|CloudBaseRelevanceClassifier|cloudbase-relevance|cloudbase-ai|deepseek-v4-flash" apps/cloudbase-api docs/operations
```

预期：无匹配。历史设计与历史实施计划允许保留原有记录，因此本检查不扫描 `docs/superpowers/specs` 和 `docs/superpowers/plans`。

- [ ] **步骤 4：运行 CloudBase 全量验证**

运行：

```powershell
pnpm.cmd verify:cloudbase
```

预期：CloudBase API 构建、类型检查、全部测试，以及资源包扫描器类型检查和测试全部通过。

- [ ] **步骤 5：检查最终差异范围和敏感信息**

运行：

```powershell
git diff --check
git status --short
rg -n "AKID[0-9A-Za-z]+|Secret(Key|Id)\s*[=:]|API[_ -]?Key\s*[=:]" apps/cloudbase-api docs/operations
```

预期：

- `git diff --check` 无错误。
- 没有 `.env.cloudbase-*.txt`、`apps/website/.env.local` 或其他密钥文件进入差异。
- 敏感信息扫描只允许命中字段名称、测试假值或安全说明，不得出现真实凭据。
- 工作树中与本计划无关的既有修改保持原样，不得加入本次暂存区。

- [ ] **步骤 6：只提交运维文档**

```powershell
git add -- docs/operations/cloudbase-deployment.md docs/operations/content-moderation.md
git diff --cached --check
git diff --cached --name-only
git commit -m "docs: 更新本地关键词审核运维说明"
```

预期：暂存区只包含上述两个文档。

- [ ] **步骤 7：记录最终验证证据**

再次运行：

```powershell
git status --short --branch
git log -4 --oneline
pnpm.cmd verify:cloudbase
```

预期：

- 最近提交依次覆盖分类器、生产装配、审计记录和运维文档。
- `verify:cloudbase` 再次通过。
- `git status` 仅显示执行前已存在且与本计划无关的修改；如果出现本计划文件未提交，必须先处理，不能宣称完成。

---

## 完成定义

- `KeywordRelevanceClassifier` 对强产品词和有效跨组组合返回 `pass`。
- 零命中、弱命中、组合不足及分类异常返回 `review`。
- 本地分类器从不返回 `reject`，也不执行网络请求。
- CloudBase API 不再要求 AI Base URL、AI API Key 或模型名称。
- 生产审核工作器使用本地关键词分类器。
- 相关性审核记录显示 `local-keyword` 和 `keyword-relevance-2026-08-01`。
- 系统明确风险自动驳回、管理员二次审核、自动驳回转人工和三天隔离逻辑保持通过。
- 部署与运维文档不再要求购买或启用 CloudBase AI。
- `pnpm.cmd verify:cloudbase` 全部通过，且没有真实敏感信息进入版本库。
