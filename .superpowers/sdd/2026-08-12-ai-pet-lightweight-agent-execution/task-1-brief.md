### Task 1: 将文件深模块收敛为五个工具

**Files:**

- Modify: `packages/file-tools/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `packages/file-tools/src/schemas.ts`
- Modify: `packages/file-tools/src/file-tool-service.ts`
- Modify: `packages/file-tools/src/errors.ts`
- Modify: `packages/file-tools/src/index.ts`
- Delete: `packages/file-tools/src/entry-snapshot.ts`
- Modify: `packages/file-tools/tests/file-tool-service.test.ts`
- Verify: `packages/file-tools/tests/path-policy.test.ts`

**Interfaces:**

- Consumes: 现有 `PathPolicy.resolveExisting()`、`PathPolicy.resolveTarget()`、`RecycleBinPort.moveToRecycleBin()`。
- Produces: `FileToolService.executeRead()`、`preview()`、`executeWrite()`；`VerifiedWriteAction` 只包含 Renderer 可见摘要，正文、基础哈希和补丁结果只保存在私有 WeakMap。

```ts
export type VerifiedWriteAction =
  | Readonly<{
      operation: 'create_file';
      authorizationGeneration: number;
      targetRelativePath: string;
      contentCharacters: number;
      contentPreview: string | null;
      previewTruncated: boolean;
    }>
  | Readonly<{
      operation: 'apply_patch';
      authorizationGeneration: number;
      targetRelativePath: string;
      addedLines: number;
      removedLines: number;
      diffPreview: string;
      previewTruncated: boolean;
    }>
  | Readonly<{
      operation: 'delete_file';
      authorizationGeneration: number;
      targetRelativePath: string;
      targetType: 'file' | 'empty_directory';
    }>;
```

- [ ] **Step 1: 固定已知未提交实验范围**

运行：

```powershell
git diff --name-only
```

预期仅包含：

```text
packages/file-tools/src/entry-snapshot.ts
packages/file-tools/src/errors.ts
packages/file-tools/src/file-tool-service.ts
packages/file-tools/tests/file-tool-service.test.ts
```

若出现其他文件，停止并先归属差异。不要恢复到 `c56d007` 再重写；直接用 `apply_patch` 把这四个实验差异收敛为本任务最终实现。

- [ ] **Step 2: 写五工具严格 schema 与旧名消失的 RED**

在 `file-tool-service.test.ts` 增加精确断言：

```ts
expect(Object.keys(toolArguments).sort()).toEqual([
  'apply_patch', 'create_file', 'delete_file', 'list_files', 'read_file'
]);
expect(() => toolArguments.create_file.parse({ relativePath: 'a.txt', extra: true })).toThrow();
expect((toolArguments as Record<string, unknown>)['copy_entry']).toBeUndefined();
```

运行：

```powershell
pnpm.cmd --dir packages/file-tools exec vitest run --config vitest.config.ts tests/file-tool-service.test.ts -t "五个工具"
```

预期：FAIL，旧 schema 仍存在。

- [ ] **Step 3: 最小实现 schema 并删除旧工具结构**

`schemas.ts` 只保留：

```ts
export const toolArguments = {
  list_files: z.object({
    relativePath: relativePathSchema.default('.'),
    maxDepth: z.number().int().min(1).max(4).default(1),
    maxResults: z.number().int().min(1).max(200).default(100)
  }).strict(),
  read_file: z.object({
    relativePath: relativePathSchema,
    startLine: z.number().int().min(1).default(1),
    lineCount: z.number().int().min(1).max(500).default(200)
  }).strict(),
  create_file: z.object({ relativePath: relativePathSchema, content: z.string().default('') }).strict(),
  apply_patch: z.object({ relativePath: relativePathSchema, patch: z.string().min(1).max(262_144) }).strict(),
  delete_file: z.object({ relativePath: relativePathSchema }).strict()
} as const;
```

删除 `entry-snapshot.ts`，移除 `SecureFileSystemPort`、seal、search/copy/move/rename/create_directory/write_text_file 分支和相关错误码。

- [ ] **Step 4: 写 `list_files` 与 `read_file` RED**

覆盖：默认不递归、最大深度、最大结果、链接不下钻、相对摘要、行范围、UTF-8/二进制/大小限制、截断标志。关键断言：

```ts
expect(result.entries.every(entry => !('modifiedAt' in entry) && !('size' in entry))).toBe(true);
expect(result).toMatchObject({ toolName: 'read_file', startLine: 2, endLine: 3, truncated: true });
```

运行：

```powershell
pnpm.cmd --dir packages/file-tools exec vitest run --config vitest.config.ts tests/file-tool-service.test.ts -t "list_files|read_file"
```

预期：FAIL，执行名和结果契约尚未迁移。

- [ ] **Step 5: 复用 PathPolicy 和有界读取实现只读 GREEN**

`list_files` 使用 `opendir` + `lstat`，链接只作为条目返回，绝不递归；扫描达到 `maxResults` 即停止并设置 `truncated`。`read_file` 继续使用 fatal UTF-8 解码，按行切片并保留不可信数据提示。

- [ ] **Step 6: 安装并锁定 jsdiff**

运行：

```powershell
pnpm.cmd add diff@8.0.2 --filter @myself/file-tools
```

只允许 `packages/file-tools/package.json` 与 `pnpm-lock.yaml` 出现依赖变化。

- [ ] **Step 7: 逐个写三个写工具 RED**

依次运行独立测试：

```powershell
pnpm.cmd --dir packages/file-tools exec vitest run --config vitest.config.ts tests/file-tool-service.test.ts -t "create_file"
pnpm.cmd --dir packages/file-tools exec vitest run --config vitest.config.ts tests/file-tool-service.test.ts -t "apply_patch"
pnpm.cmd --dir packages/file-tools exec vitest run --config vitest.config.ts tests/file-tool-service.test.ts -t "delete_file"
```

每组先得到真实 RED，并覆盖：

- `create_file` 使用 `open('wx')`，正文只在私有动作中；
- `apply_patch` 的 `parsePatch()` 必须恰好返回一个补丁，`applyPatch(..., { fuzzFactor: 0 })` 返回 `false` 时拒绝；确认后基础 SHA-256 变化返回 `ENTRY_CHANGED`；临时文件使用随机名与 `wx`，成功后同目录 `rename`；
- `delete_file` 拒绝授权根、链接、特殊实体、非空目录；执行只调用回收站端口；
- 三类动作均绑定 authorization generation、只能执行一次、对象克隆与伪造均为 `ACTION_EXPIRED`。

- [ ] **Step 8: 实现三个写工具 GREEN**

私有记录使用封闭联合：

```ts
type InternalWriteAction =
  | { operation: 'create_file'; targetRelativePath: string; content: string }
  | { operation: 'apply_patch'; targetRelativePath: string; baseSha256: string; result: string }
  | {
      operation: 'delete_file';
      targetRelativePath: string;
      targetType: 'file' | 'empty_directory';
      expectedIdentity: Readonly<{ device: bigint; inode: bigint; size: bigint; modifiedAtNs: bigint }>;
    };
```

所有动作在解析路径或产生副作用前从 WeakMap 消费，失败后也不能重放。

- [ ] **Step 9: 运行文件包完整验证并提交**

```powershell
pnpm.cmd --filter @myself/file-tools test
pnpm.cmd --filter @myself/file-tools typecheck
git diff --check
git diff --name-only -- apps/website
git add packages/file-tools pnpm-lock.yaml
git commit -m "refactor: 收敛桌宠轻量文件工具"
```

预期：测试/typecheck 退出 0，网站差异为空。

