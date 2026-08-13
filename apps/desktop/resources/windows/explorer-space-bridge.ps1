# 资源管理器空间固定桥接：仅暴露计划批准的三类命令。
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

# Task 0F 生产观察只固定加载并调用新 Shell 标签 Helper。
$shellTabHelperPath = Join-Path $PSScriptRoot 'explorer-space-shell-tab-helper.cs'
if (-not (Test-Path -LiteralPath $shellTabHelperPath -PathType Leaf)) {
    [Console]::Error.WriteLine('SHELL_TAB_HELPER_MISSING')
    exit 1
}
try {
    Add-Type -Path $shellTabHelperPath -ReferencedAssemblies @('System', 'System.Core') -ErrorAction Stop
} catch {
    [Console]::Error.WriteLine('SHELL_TAB_HELPER_UNAVAILABLE')
    exit 1
}

Add-Type -ReferencedAssemblies @('System', 'System.Core') -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Threading;

public static class ExplorerSpaceInput {
    public const int InputCapacity = 8;
    private static readonly ConcurrentQueue<string> Lines = new ConcurrentQueue<string>();
    private static int started;
    private static int count;
    private static int overflowed;

    public static void Start() {
        if (Interlocked.Exchange(ref started, 1) != 0) return;
        var thread = new Thread(() => {
            string line;
            while ((line = Console.In.ReadLine()) != null) {
                if (Interlocked.Increment(ref count) > InputCapacity) {
                    Interlocked.Decrement(ref count);
                    Interlocked.Exchange(ref overflowed, 1);
                    continue;
                }
                Lines.Enqueue(line);
            }
        });
        thread.IsBackground = true;
        thread.Name = "ExplorerSpaceInput";
        thread.Start();
    }

    public static bool TryRead(out string line) {
        if (!Lines.TryDequeue(out line)) return false;
        Interlocked.Decrement(ref count);
        return true;
    }

    public static bool IsOverflowed() { return Volatile.Read(ref overflowed) != 0; }
}
'@

$protocolVersion = 1
$maxLineBytes = 16 * 1024
$sequence = 0L
$observing = $false
$shutdown = $false
$lastSnapshot = $null
$heartbeatIntervalMilliseconds = 1000
$lastHeartbeat = [DateTime]::MinValue
$nonceBytes = New-Object byte[] 16
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($nonceBytes)
$nonce = -join ($nonceBytes | ForEach-Object { $_.ToString('x2') })

function Write-ProtocolObject([hashtable]$value) {
    $line = $value | ConvertTo-Json -Compress -Depth 5
    if ([System.Text.Encoding]::UTF8.GetByteCount($line) -gt $maxLineBytes) {
        [Console]::Error.WriteLine('OUTPUT_LIMIT_EXCEEDED')
        $script:shutdown = $true
        return
    }
    [Console]::Out.WriteLine($line)
    [Console]::Out.Flush()
}

function Write-Response([string]$requestId, [bool]$ok, [string]$errorCode = '') {
    $script:sequence++
    $response = @{
        version = $protocolVersion; type = 'response'; nonce = $nonce
        sequence = $sequence; requestId = $requestId; ok = $ok
    }
    if (-not $ok) { $response.errorCode = $errorCode }
    Write-ProtocolObject $response
}

function Publish-ObserverHeartbeat {
    $script:sequence++
    Write-ProtocolObject @{
        version = $protocolVersion; type = 'observer-heartbeat'; nonce = $nonce; sequence = $sequence
    }
    $script:lastHeartbeat = [DateTime]::UtcNow
}

function Get-ExplorerSnapshot {
    $observation = [AiPet.ExplorerSpace.RestrictedExplorerShellTabObserver]::ObserveActiveExplorer()
    if ($observation.Status -ne 'ready') { return @{ status = [string]$observation.Status } }
    $foregroundValue = $observation.Hwnd
    $width = $observation.Rect.Right - $observation.Rect.Left
    $height = $observation.Rect.Bottom - $observation.Rect.Top
    return @{
        status = 'ready'; windowType = 'explorer'
        instanceId = $observation.InstanceId
        hwnd = $foregroundValue.ToString()
        rect = @{ x = $observation.Rect.Left; y = $observation.Rect.Top; width = $width; height = $height }
        foreground = $true; minimized = $false
    }
}

function Publish-SnapshotIfChanged {
    $snapshot = Get-ExplorerSnapshot
    $fingerprint = $snapshot | ConvertTo-Json -Compress -Depth 4
    if ($fingerprint -eq $lastSnapshot) { return }
    $script:lastSnapshot = $fingerprint
    $script:sequence++
    $message = @{ version = $protocolVersion; type = 'explorer-snapshot'; nonce = $nonce; sequence = $sequence }
    foreach ($entry in $snapshot.GetEnumerator()) { $message[$entry.Key] = $entry.Value }
    Write-ProtocolObject $message
    if ($snapshot.status -eq 'unavailable') {
        [Console]::Error.WriteLine('OBSERVER_UNAVAILABLE')
        $script:shutdown = $true
    }
}

function Test-ExactProperties($value, [string[]]$names) {
    $actual = @($value.PSObject.Properties.Name | Sort-Object)
    $expected = @($names | Sort-Object)
    return (Compare-Object $actual $expected).Count -eq 0
}

function Handle-Command([string]$line) {
    if ([System.Text.Encoding]::UTF8.GetByteCount($line) -gt $maxLineBytes) {
        [Console]::Error.WriteLine('INPUT_LIMIT_EXCEEDED'); $script:shutdown = $true; return
    }
    try { $value = $line | ConvertFrom-Json -ErrorAction Stop } catch {
        [Console]::Error.WriteLine('INPUT_JSON_INVALID'); $script:shutdown = $true; return
    }
    $base = @('version', 'nonce', 'requestId', 'command')
    if ($value.version -ne 1 -or $value.nonce -cne $nonce -or $value.requestId -notmatch '^request-[1-9][0-9]{0,15}$') {
        [Console]::Error.WriteLine('INPUT_PROTOCOL_INVALID'); $script:shutdown = $true; return
    }
    switch ([string]$value.command) {
        'start-observing' {
            if (-not (Test-ExactProperties $value $base)) { Write-Response $value.requestId $false 'COMMAND_INVALID'; return }
            $script:observing = $true; $script:lastSnapshot = $null
            $script:lastHeartbeat = [DateTime]::UtcNow; Write-Response $value.requestId $true
        }
        'stop-observing' {
            if (-not (Test-ExactProperties $value $base)) { Write-Response $value.requestId $false 'COMMAND_INVALID'; return }
            $script:observing = $false; $script:lastSnapshot = $null
            $script:lastHeartbeat = [DateTime]::MinValue; Write-Response $value.requestId $true
        }
        'shutdown' {
            if (-not (Test-ExactProperties $value $base)) { Write-Response $value.requestId $false 'COMMAND_INVALID'; return }
            Write-Response $value.requestId $true; $script:shutdown = $true
        }
        default { Write-Response $value.requestId $false 'COMMAND_INVALID' }
    }
}

Write-ProtocolObject @{ version = $protocolVersion; type = 'hello'; nonce = $nonce; sequence = 0 }
[ExplorerSpaceInput]::Start()
$lastPoll = [DateTime]::MinValue
while (-not $shutdown) {
    if ([ExplorerSpaceInput]::IsOverflowed()) {
        [Console]::Error.WriteLine('INPUT_QUEUE_OVERFLOW')
        $shutdown = $true
        continue
    }
    $line = $null
    if ([ExplorerSpaceInput]::TryRead([ref]$line)) {
        Handle-Command $line
    }
    if ($observing -and ([DateTime]::UtcNow - $lastPoll).TotalMilliseconds -ge 750) {
        $lastPoll = [DateTime]::UtcNow
        try { Publish-SnapshotIfChanged } catch {
            [Console]::Error.WriteLine('SNAPSHOT_FAILED')
            $shutdown = $true
        }
    }
    if ($observing -and -not $shutdown -and ([DateTime]::UtcNow - $lastHeartbeat).TotalMilliseconds -ge $heartbeatIntervalMilliseconds) {
        Publish-ObserverHeartbeat
    }
    Start-Sleep -Milliseconds 25
}
