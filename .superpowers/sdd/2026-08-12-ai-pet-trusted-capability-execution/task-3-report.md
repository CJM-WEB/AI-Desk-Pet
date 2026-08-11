# Task 3 执行报告：补齐文件工具与快照执行

## 状态

DONE（等待主控提交与独立审查）

## 实现摘要

- 新增 `search_entries`、`write_text_file`、`copy_entry`、`move_entry`，并让 `create_file` 支持可选 UTF-8 正文。
- 将 `VerifiedWriteAction` 收口为 `operation / authorizationGeneration / source / target / content` 深冻结契约；签发能力、绝对路径、设备号、inode、旧正文哈希与真实正文只保存在服务私有 `WeakMap`。
- 写入确认绑定源实体、大小和旧 SHA-256；执行前再次校验，动作在任何路径解析或副作用前消费，克隆、伪造、失败后重放均返回 `ACTION_EXPIRED`。
- 搜索采用字面名称、最大深度和最大结果数，不递归符号链接或 Junction。
- 复制逐项 `lstat`，文件使用 `COPYFILE_EXCL`；失败时只按本次成功创建记录回滚，不删除竞争产生的既有目标。
- 移动、重命名和回收站操作绑定确认时快照；目标必须不存在；跨设备移动稳定返回 `CROSS_DEVICE_MOVE_NOT_ALLOWED`。
- 文件错误不保留底层 `cause`，避免绝对路径或底层正文通过异常链泄漏。
- 回收站端口成功后按设备号、inode 和实体类型确认原实体确实离开；仅修改正文不能冒充回收成功。

## TDD 证据

1. 带正文排他创建：RED 为 48 通过、1 失败（严格 schema 拒绝 `content`）；GREEN 为 49/49。
2. 文本旧哈希 CAS：RED 为 49 通过、1 失败（无写入分支）；GREEN 为 50/50。
3. 有界字面搜索：RED 为 50 通过、1 失败（只读入口拒绝未知工具）；GREEN 为 51/51。
4. 复制：RED 为 51 通过、2 失败（无复制分支）；GREEN 为 53/53。
5. 移动：RED 为 53 通过、1 失败（无移动分支）；GREEN 为 54/54。
6. generation 与重命名源替换：RED 为 54 通过、2 失败；GREEN 为 56/56。
7. 新动作快照契约：RED 为 56 通过、1 失败（仍返回旧公共字段）；GREEN 为 57/57。
8. EXDEV 与错误隔离：RED 为 56 通过、2 失败（注入端口未接线、异常 cause 泄漏）；GREEN 为 58/58。
9. 回收站同实体判断：RED 为 58 通过、1 失败（只修改文件被误判为已移走）；GREEN 为 59/59。

测试启动时曾遇到沙箱阻止 esbuild 读取工作树上级目录，以及 PowerShell 把过滤表达式中的 `|` 当作管道；两者均为环境错误，未计作行为 RED。改用已授权的包目录测试进程和窄过滤后继续。

## 最终验证

- `pnpm.cmd test -- file-tool-service.test.ts path-policy.test.ts`（在 `packages/file-tools`）：59/59 通过。
- `pnpm.cmd typecheck`（在 `packages/file-tools`）：退出 0。
- `git diff --check`：退出 0；仅有 Git 的 LF→CRLF 工作副本提示，无空白错误。
- `git diff --name-only d4e709f -- apps/website`：无输出。

## 接缝说明

本任务按已裁决的新 `VerifiedWriteAction` 建立 `file-tools` 深模块，没有保留旧 `toolName/id/扁平相对路径` 双结构兼容壳。Desktop 当前消费端将在 Task 4 一次性迁移，因此本任务只以 `file-tools` 的测试和类型检查作为阶段门禁。

## 关注点

无阻塞项。Node 的原生 `rename` 在 Windows 上对既有目标失败；服务仍在执行前再次通过 `PathPolicy.resolveTarget` 验证目标不存在，并把跨卷 `EXDEV` 转换为稳定失败，不自动退化为复制删除。
