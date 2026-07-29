# 反馈存储与文件粒子渲染优化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复本地存储不可用时的虚假保存成功，并避免文件粒子生命周期每帧触发 React 列表重渲染。

**Architecture:** 反馈仓储在无 `Storage` 时保持只读回退，所有写操作通过既有 `FeedbackStorageError` 失败；反馈章节依据错误原因显示专用提示。FileSwarm 保留 RAF 生命周期计算，但把逐帧数值更新限制在 ref 中，仅在 React 可见结构发生变化时提交 state。

**Tech Stack:** TypeScript、React 19、Next.js 15、Vitest、Testing Library、Playwright。

## Global Constraints

- 仅处理反馈存储失败和文件粒子渲染提交两个问题。
- 所有新增文档和代码注释使用中文。
- 不新增依赖，不改变视觉设计、生命周期参数和反馈随机规则。
- 所有生产代码修改必须先由失败测试证明问题。

---

### Task 1: 本地存储不可用时拒绝写入

**Files:**
- Modify: `apps/website/components/website-experience/feedback/local-storage-feedback-repository.ts`
- Modify: `apps/website/components/website-experience/feedback/FeedbackChapter.tsx`
- Test: `apps/website/tests/local-storage-feedback-repository.test.ts`
- Test: `apps/website/tests/feedback-chapter.test.tsx`

**Interfaces:**
- Consumes: 既有 `FeedbackStorageError` 和 `FeedbackRepository.create()`。
- Produces: 无 `Storage` 时一致失败的写操作，以及投稿编辑器专用错误提示。

- [ ] **Step 1: 编写失败测试**

增加仓储测试，使用 `storage: null` 创建仓储，断言 `create(validInput)` 抛出 `FeedbackStorageError`，且列表中没有新增本地投稿。增加章节测试，注入抛出无存储原因错误的仓储，提交后断言草稿仍在且显示“浏览器本地存储不可用，投稿无法保存。”

- [ ] **Step 2: 运行目标测试确认失败**

Run: `pnpm.cmd --filter @myself/website test -- local-storage-feedback-repository.test.ts feedback-chapter.test.tsx`

Expected: FAIL，仓储当前静默写入内存，章节当前只显示通用错误。

- [ ] **Step 3: 编写最小实现**

在 `writeDocument()` 中检测 `this.storage === null` 并抛出带可识别原因的 `FeedbackStorageError`。在 `FeedbackChapter` 的提交异常分支中区分该原因，保留既有草稿状态并显示专用提示；其他错误仍使用通用提示。

- [ ] **Step 4: 运行目标测试确认通过**

Run: `pnpm.cmd --filter @myself/website test -- local-storage-feedback-repository.test.ts feedback-chapter.test.tsx`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/website/components/website-experience/feedback/local-storage-feedback-repository.ts apps/website/components/website-experience/feedback/FeedbackChapter.tsx apps/website/tests/local-storage-feedback-repository.test.ts apps/website/tests/feedback-chapter.test.tsx
git commit -m "fix(website): 本地存储不可用时拒绝反馈写入"
```

### Task 2: 限制文件粒子的 React 提交频率

**Files:**
- Modify: `apps/website/components/home-experience/FileSwarm.tsx`
- Test: `apps/website/tests/feedback-preview-source.test.ts`
- Test: `apps/website/tests/swarm-model.test.ts`

**Interfaces:**
- Consumes: `advanceSwarmFrame(particles, deltaMs)` 的既有生命周期结果。
- Produces: 仅在阶段变化或粒子集合变化时提交的 FileSwarm 渲染行为。

- [ ] **Step 1: 编写失败测试**

增加组件级 RAF 测试，用可控帧回调生成粒子后记录图标节点或渲染计数；推进不跨阈值的一帧时断言 React 图标不重新渲染，推进跨越离场阈值与过期时间时断言阶段和活动数量正确更新。

- [ ] **Step 2: 运行目标测试确认失败**

Run: `pnpm.cmd --filter @myself/website test -- feedback-preview-source.test.ts swarm-model.test.ts`

Expected: FAIL，当前普通 RAF 帧也会执行 `setParticles(next)`。

- [ ] **Step 3: 编写最小实现**

增加仅比较 React 可见粒子状态的判定。RAF 每帧更新 `particlesRef.current`；仅在阶段改变、粒子移除或集合改变时调用 `setParticles(next)`，并保持预览绑定释放与活动预览清理顺序不变。

- [ ] **Step 4: 运行目标测试确认通过**

Run: `pnpm.cmd --filter @myself/website test -- feedback-preview-source.test.ts swarm-model.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/website/components/home-experience/FileSwarm.tsx apps/website/tests/feedback-preview-source.test.ts apps/website/tests/swarm-model.test.ts
git commit -m "perf(website): 限制文件粒子逐帧渲染提交"
```

### Task 3: 集成验证

**Files:**
- Verify only.

**Interfaces:**
- Consumes: Task 1 与 Task 2 的独立提交。
- Produces: 可交付的 WebsiteExtension 分支验证证据。

- [ ] **Step 1: 运行完整验证**

Run: `pnpm.cmd verify:website`

Expected: 类型检查、全部网站单元测试、生产构建和完整网站 E2E 均通过。

- [ ] **Step 2: 检查差异**

Run: `git diff --check`

Expected: 无输出。

- [ ] **Step 3: 检查工作树**

Run: `git status --short --branch`

Expected: 仅显示分支领先状态，不存在未提交文件。
