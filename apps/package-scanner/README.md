# AI Pet 共享资源包本地扫描 CLI

该工具只在本地 Docker 容器内扫描一个角色 ZIP。它复用现有 ZIP 预算、路径、图片解码、
角色结构与 ClamAV 检查，不监听端口，不读取 Secret 或腾讯云凭据，也不连接数据库、
对象存储或远端审核服务。

图片通过格式与实际解码检查后统一产生 `manual-review-required` 信号；成功结果始终包含
`"manualReviewRequired": true`。该结果只表示本地自动检查已完成，不能作为隔离扫描服务、
内容审核或公开发布的通过证据。

## 构建与运行

```powershell
$clamavRefreshDate = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')
docker build --file apps/package-scanner/Dockerfile `
  --build-arg "CLAMAV_DB_REFRESH_DATE=$clamavRefreshDate" `
  --tag ai-pet-package-scanner:local .
$archivePath = (Resolve-Path '.\package.zip').Path
docker run --rm --network none --read-only `
  --tmpfs /tmp/scan:rw,noexec,nosuid,nodev,mode=1777 `
  --mount "type=bind,source=$archivePath,target=/input/package.zip,readonly" `
  ai-pet-package-scanner:local /input/package.zip
```

镜像默认以非 root 的 `scanner` 用户运行。输入 ZIP 只读挂载，容器根文件系统只读，
临时目录仅使用 `/tmp/scan` 的内存文件系统。CLI 会先把输入复制为私有快照，并只扫描该快照；
整包扫描默认在 120 秒后取消。UTC 日期参数只让构建阶段的 `freshclam` 每日重新执行，运行阶段
不需要网络；候选验证会拒绝缺失或超过 7 天的病毒库。

退出码约定：

- `0`：ZIP、预算、路径、图片解码、结构与 ClamAV 检查完成；图片仍需人工审核。
- `1`：恶意包、非法结构、损坏内容或扫描依赖故障。
- `2`：参数错误；CLI 必须且只能接收一个 ZIP 路径。

## 本地验证

```powershell
pnpm.cmd --filter @myself/package-scanner test
pnpm.cmd --filter @myself/package-scanner typecheck
pnpm.cmd --filter @myself/package-scanner build
pnpm.cmd verify:scanner-candidate
```

最后一条命令要求本机 Docker runtime 可用。它使用不可变 image ID，在 `--network none`、
只读根文件系统、只读输入和非 root 条件下分别验证干净包成功、EICAR 阻断与非法包拒绝；
任一门禁缺失都会以非零状态失败。命令只生成本地候选报告，不部署或修改云端环境。
