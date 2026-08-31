# AI Pet 共享资源包隔离扫描服务

该服务只接收 CloudBase 后端签发的私有对象短期下载地址，并在
`/tmp/scan` 下为每个请求创建独立目录。无论扫描成功或失败，请求目录都会被删除。

## 运行配置

必须设置以下环境变量：

- `SCANNER_INTERNAL_SECRET`：内部请求 HMAC 密钥。
- `SCANNER_DOWNLOAD_HOSTS`：允许下载的对象存储主机名，多个主机用英文逗号分隔。
- `SCANNER_DOWNLOAD_SIGNATURE_PARAMETERS`：下载 URL 必须携带的签名参数名，多个参数
  用英文逗号分隔；参数名必须依据实际 CloudBase 短期签名 URL 配置，不能随意猜测。
- `TENCENT_CLOUD_REGION`：腾讯云图片内容安全服务地域。
- `TENCENT_IMS_BIZ_TYPE`：可选的图片审核业务策略编号。
- `TENCENTCLOUD_SECRETID`：腾讯云服务端访问密钥 ID。
- `TENCENTCLOUD_SECRETKEY`：腾讯云服务端访问密钥 Key。
- `TENCENTCLOUD_SESSIONTOKEN`：使用临时凭据时必填的会话令牌；长期密钥可不填。
- `PORT`：可选，默认 `8080`。

内部请求使用 `x-internal-timestamp` 和 `x-internal-signature` 请求头。签名原文固定为
`protocolVersion + "\n" + timestamp + "\n" + sha256(rawBody)`，算法为
HMAC-SHA256。协议版本固定为 `2026-08-15`，规则版本固定为
`character-package-2026-08-15`。

扫描接口固定为 `POST /internal/scan`，请求体为：

```json
{
  "protocolVersion": "2026-08-15",
  "submissionId": "3d594650-3436-4ad0-a9a8-80ca4388824b",
  "downloadUrl": "https://已配置的对象存储主机/私有对象?实际签名参数=值",
  "expiresAt": "2026-08-15T02:05:00.000Z"
}
```

`expiresAt` 是带时区的 ISO 8601 下载地址过期时间，必须晚于服务端当前时间且最多只允许未来
五分钟。服务同时校验 HTTPS、默认 443 端口、主机白名单和配置的必需签名参数。

## 部署约束

CloudBase 云托管必须设置：

- Node.js 22 容器；
- 容器内存至少 1 GB；
- 单实例请求并发数为 1；
- 最小实例数为 0；
- 扫描工作目录只使用 `/tmp/scan`；
- 健康检查路径为 `/healthz`。

服务进程也会拒绝同一实例上的并发扫描请求，并返回
`503 SCANNER_BUSY`。部署平台仍须把单实例并发数设置为 1，避免请求在进入进程前堆积。
单个请求具有 120 秒整包硬截止；超时返回 `503 SCANNER_SCAN_TIMEOUT`，取消当前
ClamAV/图片审核等待并释放单任务并发锁。腾讯云 IMS 官方客户端请求超时为 15 秒。

容器以非 root 的 `scanner` 用户运行。ClamAV 病毒库在镜像构建时通过
`freshclam` 更新；若病毒库更新失败，镜像构建必须失败，不能发布缺少病毒库的镜像。

## 本地验证

```powershell
pnpm --filter @myself/package-scanner test
pnpm --filter @myself/package-scanner typecheck
pnpm --filter @myself/package-scanner build
pnpm verify:scanner-candidate
```

最后一条命令要求本机 Docker runtime 可用。它构建固定标签的本地候选镜像，并在
无网络容器内验证不可变 image ID、非 root UID、Node/ClamAV/病毒库版本、`/healthz`、
EICAR 阻断和扫描超时 `HTTP 503`。命令只输出本地候选 JSON，不部署或修改云端环境；
任一运行时门缺失时以非零退出码失败，不得用静态 Dockerfile 文本检查代替。
若 Docker CLI 不在当前进程的 `PATH`，可用 `DOCKER_CLI_PATH` 指向已安装的可执行文件；
Windows 标准 Docker Desktop 安装路径也会作为仅在 `PATH` 缺失时使用的回退。

正式部署前还必须用真实 ClamAV 和腾讯云图片内容安全测试一次干净包、病毒命中、
审核通过、审核拦截与服务超时场景。
