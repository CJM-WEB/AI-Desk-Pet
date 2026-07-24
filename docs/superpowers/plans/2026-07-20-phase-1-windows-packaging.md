# 第一阶段 Windows 打包实施计划

> **面向执行代理：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，逐项执行本计划。所有步骤使用复选框（`- [ ]`）跟踪。

**目标：** 为 `0.1.0-alpha.1` 生成未签名的 Windows 10/11 x64 NSIS 安装包、确定性版本元数据以及有证据支撑的干净环境验收记录。

**架构：** electron-builder 打包已经验证的桌面应用；独立 TypeScript 发布工具计算最终安装包哈希，并生成静态官网消费的精确 JSON 契约。打包不得改变 Agent 行为，且只有桌面端与官网验证门禁都通过后才能开始。

**技术栈：** electron-builder、NSIS、Node.js/TypeScript、Zod、Vitest、PowerShell 验证、干净 Windows 测试环境。

## 全局约束

- 产物必须明确标注为未签名，并仅面向邀请测试者。
- 安装包文件名必须包含 `Myself`、`0.1.0-alpha.1`、`windows` 和 `x64`。
- 卸载绝不能删除用户授权目录中的文件。
- 应用默认不启用登录时自动启动。
- 只有构建成功并完成人工验收的安装包才能更新官网版本清单。
- SHA-256 必须根据打包完成后的最终安装包字节计算。
- Codex 不执行暂存、提交或推送；用户使用 Fork 验收和提交。
- 面向人的文档、发布说明、验收记录与代码注释统一使用中文。

---

## 计划文件结构

```text
apps/desktop/electron-builder.yml              installer configuration
apps/desktop/resources/icon.ico                Windows application icon
tools/release/package.json                     release tool package
tools/release/src/generate-manifest.ts         hash/size/manifest generator
tools/release/tests/generate-manifest.test.ts  deterministic contract tests
docs/operations/windows-alpha-install.md       tester installation help
docs/operations/phase-1-acceptance-record.md   clean-machine evidence template
apps/website/content/release-manifest.json     generated final release metadata
```

### 任务 1：NSIS 打包配置与产物冒烟测试

**文件：**
- 新建： `apps/desktop/electron-builder.yml`
- 新建： `apps/desktop/resources/icon.ico`
- 修改： `apps/desktop/package.json`
- 新建： `apps/desktop/tests/package-config.test.ts`
- 新建： `docs/operations/windows-alpha-install.md`

**接口：**
- 输入： a passing `pnpm verify:desktop` and compiled desktop resources.
- 输出： `dist/Myself-0.1.0-alpha.1-windows-x64.exe` plus an unpacked diagnostic directory.

- [x] **步骤 1： 编写失败的打包配置测试**

```ts
// apps/desktop/tests/package-config.test.ts
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('electron-builder configuration', () => {
  it('builds an unsigned per-user x64 NSIS installer without auto-start', async () => {
    const config = parse(await readFile(new URL('../electron-builder.yml', import.meta.url), 'utf8'));
    expect(config.win.target).toEqual([{ target: 'nsis', arch: ['x64'] }]);
    expect(config.win.signAndEditExecutable).toBe(false);
    expect(config.nsis.perMachine).toBe(false);
    expect(config.nsis.deleteAppDataOnUninstall).toBe(false);
    expect(config.artifactName).toBe('Myself-${version}-windows-${arch}.${ext}');
  });
});
```

运行： `pnpm --filter @myself/desktop test -- package-config.test.ts`

预期： FAIL because `electron-builder.yml` does not exist.

- [x] **步骤 2： 实现构建器配置**

```yaml
# apps/desktop/electron-builder.yml
appId: com.myself.desktop
productName: Myself
artifactName: Myself-${version}-windows-${arch}.${ext}
directories:
  output: dist
  buildResources: resources
files:
  - out/**
  - package.json
asar: true
win:
  target:
    - target: nsis
      arch:
        - x64
  icon: resources/icon.ico
  signAndEditExecutable: false
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
  perMachine: false
  deleteAppDataOnUninstall: false
  createDesktopShortcut: true
  createStartMenuShortcut: true
```

- [x] **步骤 3： 增加明确的打包脚本**

```json
{
  "scripts": {
    "build": "electron-vite build",
    "package:win": "pnpm build && electron-builder --win nsis --x64 --config electron-builder.yml",
    "verify:package-config": "vitest run tests/package-config.test.ts"
  }
}
```

把这些键合并到现有桌面端脚本中，不得删除测试或开发命令。

- [x] **步骤 4： 编写未签名安装包帮助文档**

文档必须说明：支持的 Windows 版本、SHA-256 验证命令、预期的未知发布者警告、继续安装前如何核对发布者与文件名、配置存储行为、卸载行为，以及绝不能全局关闭 SmartScreen 的警告。文档应明确该构建为邀请制 Alpha 软件。

- [x] **步骤 5： 验证配置、桌面端门禁与打包**

运行： `pnpm --filter @myself/desktop verify:package-config && pnpm verify:desktop && pnpm --filter @myself/desktop package:win`

预期： config and desktop gates PASS; `apps/desktop/dist/Myself-0.1.0-alpha.1-windows-x64.exe` exists and an unpacked app launches.

- [x] **用户验收交接点**

提供安装包路径与大小、配置测试输出、启动截图和未签名警告截图，由用户在 Fork 中验收并决定提交。

状态：已产出 `apps/desktop/dist/Myself-0.1.0-alpha.1-windows-x64.exe`，用户已完成安装包测试与验收，并已提交相关变更。

### 任务 2：确定性版本清单生成器

**文件：**
- 新建： `tools/release/package.json`
- 新建： `tools/release/src/generate-manifest.ts`
- 新建： `tools/release/tests/generate-manifest.test.ts`
- 修改： `apps/website/content/release-manifest.json`
- 修改： root `package.json`

**接口：**
- 输入： final `.exe`, public download base URL, version, and publication timestamp.
- 输出： the website's strict release manifest with lowercase SHA-256.

- [x] **步骤 1： 编写确定性生成器测试**

```ts
// tools/release/tests/generate-manifest.test.ts
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateReleaseManifest } from '../src/generate-manifest';

describe('generateReleaseManifest', () => {
  it('derives size, URL, and lowercase sha256 from final bytes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'myself-release-'));
    const installer = join(dir, 'Myself-0.1.0-alpha.1-windows-x64.exe');
    await writeFile(installer, Buffer.from('fixture-installer'));
    const manifest = await generateReleaseManifest({
      installerPath: installer,
      downloadBaseUrl: 'https://download.example.com/releases/',
      publishedAt: '2026-07-20T00:00:00.000Z'
    });
    expect(manifest.fileName).toBe('Myself-0.1.0-alpha.1-windows-x64.exe');
    expect(manifest.downloadUrl).toBe('https://download.example.com/releases/Myself-0.1.0-alpha.1-windows-x64.exe');
    expect(manifest.sizeBytes).toBe(17);
    expect(manifest.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.signed).toBe(false);
  });
});
```

- [x] **步骤 2： 以纯函数和命令行实现生成器**

```ts
// tools/release/src/generate-manifest.ts
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

type Input = { installerPath: string; downloadBaseUrl: string; publishedAt: string };

export async function generateReleaseManifest(input: Input) {
  const fileName = basename(input.installerPath);
  const match = /^Myself-(\d+\.\d+\.\d+-alpha\.\d+)-windows-x64\.exe$/.exec(fileName);
  if (!match?.[1]) throw new Error('Installer filename does not match the Phase 1 release contract');
  const bytes = await readFile(input.installerPath);
  const info = await stat(input.installerPath);
  return {
    version: match[1],
    platform: 'windows-x64' as const,
    fileName,
    downloadUrl: new URL(fileName, input.downloadBaseUrl).toString(),
    sizeBytes: info.size,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    publishedAt: input.publishedAt,
    signed: false as const
  };
}

export async function writeManifest(input: Input, outputPath: string): Promise<void> {
  const manifest = await generateReleaseManifest(input);
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}
```

增加轻量命令行入口，强制要求 `--installer`、`--base-url`、`--published-at` 和 `--output`；缺少参数时以非零状态退出且不写文件。

- [x] **步骤 3： 联合验证生成器与官网契约**

运行： `pnpm --filter @myself/release-tools test`

随后根据真实安装包生成 `apps/website/content/release-manifest.json`，并运行 `pnpm verify:website`。

预期： generator tests PASS; website manifest validation and static build PASS; the displayed SHA-256 matches PowerShell `Get-FileHash -Algorithm SHA256` after case normalization.

- [x] **用户验收交接点**

提供最终清单、独立 PowerShell 哈希、官网验证输出和产物路径，由用户验收并决定提交。

状态：官网清单已替换为 GitHub Release 真实下载地址 `https://github.com/CJM-WEB/AI-Desk-Pet/releases/download/v0.1.0-alpha.1/Myself-0.1.0-alpha.1-windows-x64.exe`，并已通过 `pnpm verify:website`。

### 任务 3：干净 Windows 环境验收与发布交接

**文件：**
- 新建： `docs/operations/phase-1-acceptance-record.md`
- 修改： `docs/operations/windows-alpha-install.md` only when observed behavior differs from instructions.

**接口：**
- 输入： installer and manifest from Tasks 1–2 plus the approved MVP Section 21 checklist.
- 输出： signed-off evidence for invited distribution; no automated upload occurs.

- [ ] **步骤 1： 创建面向证据的验收记录**

验收记录必须包含应用版本、安装包 SHA-256、Windows 版本与构建号、干净环境状态、模型测试夹具、授权测试目录、测试人员和日期；并为规格第 21 节的每个功能与质量门禁提供“通过/失败/证据”列。

状态：用户已明确要求跳过人工验收结果写入，因此本步骤保持未勾选，不再作为当前 MVP 推进阻塞项。

- [x] **步骤 2： 安装并执行准确演示流程**

验证安装、启动、桌宠拖动与位置、托盘、模型配置、根目录授权、列出、读取、新建确认、新建取消、重命名、越界拒绝、目标冲突、重启清除待确认动作、官网校验和，以及卸载后授权测试目录保持不变。

- [ ] **步骤 3： 验证不存在意外持久化或泄露**

在应用日志和配置中搜索测试 API Key 与测试文件正文，预期匹配数为零。确认卸载绝不触碰授权目录；记录保留的应用配置，并确认其符合卸载时的用户选择。

- [x] **步骤 4： 从干净检出运行最终自动门禁**

运行： `pnpm install --frozen-lockfile && pnpm verify:desktop && pnpm verify:website && pnpm --filter @myself/desktop package:win`

预期： every command exits 0 and the rebuilt installer hash is recorded. If reproducible byte-for-byte output is not guaranteed by packaging timestamps, the manifest must be regenerated from the accepted final artifact.

- [x] **用户验收交接点**

交付完整验收记录、安装包、清单、哈希、截图和全部验证输出。用户使用 Fork 与 GitHub 决定是否提交、打标签、上传或分发。

状态：用户已完成安装包测试、验收、提交和 GitHub Release 发布。`pnpm verify:desktop` 已在修复 Windows Electron E2E GPU 启动崩溃后通过；后续如果要对外公开体验，下一步是部署官网静态产物并验证公网下载链路。
