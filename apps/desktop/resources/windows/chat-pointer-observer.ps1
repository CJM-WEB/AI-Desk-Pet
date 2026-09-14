# 固定原生资源只观察鼠标按下；不接受脚本、路径或任意命令参数。
$ErrorActionPreference = 'Stop'
try {
  Add-Type -Path (Join-Path $PSScriptRoot 'chat-pointer-observer.cs')
  [ChatPointerObserver]::Run()
} catch {
  [Console]::Error.WriteLine('CHAT_POINTER_NATIVE_FAILED')
  exit 1
}
