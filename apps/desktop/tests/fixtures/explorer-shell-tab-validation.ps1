# Task 0E 固定验收服务：公开 stdout 只包含脱敏状态，原生句柄仅流经同进程命名管道。
$ErrorActionPreference = 'Stop'
$desktopRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$helperPath = Join-Path $desktopRoot 'resources\windows\explorer-space-shell-tab-helper.cs'
if (-not (Test-Path -LiteralPath $helperPath -PathType Leaf)) { throw 'VALIDATION_HELPER_MISSING' }

$source = "#define SHELL_TAB_HELPER_VALIDATION`r`n" +
    [IO.File]::ReadAllText($helperPath, [Text.Encoding]::UTF8)
Add-Type -TypeDefinition $source -ReferencedAssemblies @('System', 'System.Core') -ErrorAction Stop

$pipeToken = [Environment]::GetEnvironmentVariable('AI_PET_TASK0E_PIPE_TOKEN', 'Process')
if ($pipeToken -notmatch '^[a-f0-9]{32}$') { throw 'VALIDATION_PIPE_TOKEN_INVALID' }
$pipeName = "ai-pet-task0e-$PID-$pipeToken"
$pipeSecurity = [IO.Pipes.PipeSecurity]::new()
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$pipeSecurity.SetAccessRule([IO.Pipes.PipeAccessRule]::new(
    $currentSid,
    [IO.Pipes.PipeAccessRights]::FullControl,
    [Security.AccessControl.AccessControlType]::Allow
))
$pipe = [IO.Pipes.NamedPipeServerStream]::new(
    $pipeName,
    [IO.Pipes.PipeDirection]::InOut,
    1,
    [IO.Pipes.PipeTransmissionMode]::Byte,
    [IO.Pipes.PipeOptions]::None,
    0,
    0,
    $pipeSecurity
)
$pipe.WaitForConnection()
$internalReader = [IO.StreamReader]::new($pipe, [Text.UTF8Encoding]::new($false))
$internalWriter = [IO.StreamWriter]::new($pipe, [Text.UTF8Encoding]::new($false))
$internalWriter.AutoFlush = $true
if ($internalReader.ReadLine() -cne $pipeToken) { throw 'VALIDATION_PIPE_AUTH_FAILED' }
$internalWriter.WriteLine('accepted')

try {
    while ($true) {
        $command = [Console]::In.ReadLine()
        if ($null -eq $command -or $command -ceq 'quit') { break }
        if ($command -cne 'observe') { throw 'VALIDATION_COMMAND_INVALID' }

        $result = [AiPet.ExplorerSpace.ShellTabCandidateValidation]::ValidateExactCandidate()
        [ordered]@{
            status = $result.Status
            matchCount = $result.MatchCount
            switchRound = $result.SwitchRound
            errorCode = $result.ErrorCode
        } | ConvertTo-Json -Compress

        $method = [AiPet.ExplorerSpace.ShellTabCandidateValidation].GetMethod(
            'GetValidatedOuterHwnd',
            [Reflection.BindingFlags]::Static -bor [Reflection.BindingFlags]::NonPublic
        )
        $outerHwnd = [Int64]$method.Invoke($null, @())
        $instanceMethod = [AiPet.ExplorerSpace.ShellTabCandidateValidation].GetMethod(
            'GetValidatedInstanceId',
            [Reflection.BindingFlags]::Static -bor [Reflection.BindingFlags]::NonPublic
        )
        $internalWriter.WriteLine(([ordered]@{
            outerHwnd = $outerHwnd.ToString()
            instanceId = [string]$instanceMethod.Invoke($null, @())
        } |
            ConvertTo-Json -Compress))
    }
}
finally {
    $internalReader.Dispose()
    $internalWriter.Dispose()
    $pipe.Dispose()
}
