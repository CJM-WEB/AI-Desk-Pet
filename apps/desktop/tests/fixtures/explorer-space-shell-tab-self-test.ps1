param(
    [Parameter(Mandatory = $true)]
    [ValidateSet(
        'active-a', 'active-b', 'switch-a-b-a', 'zero-match', 'multiple-match',
        'duplicate-tab-hwnd', 'race-active-tab', 'race-outer-hwnd', 'race-process-id',
        'race-process-created-at', 'race-foreground', 'race-path', 'ending-path-unavailable',
        'ending-path-none', 'ending-path-invalid', 'mapping-race', 'rect-unavailable', 'not-explorer', 'minimized',
        'search-result', 'com-initialization-error', 'query-service-error', 'get-window-error',
        'fixed-helper-file-error', 'unknown-os-major', 'unknown-os-minor', 'unknown-os-build',
        'unknown-product-version', 'unknown-explorer-file-version',
        'unknown-file-major', 'unknown-file-minor', 'unknown-file-build',
        'candidate-profile-production', 'unknown-mapping-version', 'candidate-profile-validation',
        'invalid-percent-location', 'valid-percent-location', 'virtual-directory',
        'keyed-fingerprint-same', 'keyed-fingerprint-different-path',
        'keyed-fingerprint-different-token', 'production-boundary'
    )]
    [string]$Scenario
)

# 固定夹具实际编译生产源文件的条件测试分支，不在 PowerShell 中重写决策。
$ErrorActionPreference = 'Stop'
$helperPath = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'resources\windows\explorer-space-shell-tab-helper.cs'
if (-not (Test-Path -LiteralPath $helperPath -PathType Leaf)) {
    throw 'SHELL_TAB_HELPER_SOURCE_MISSING'
}
$source = [IO.File]::ReadAllText($helperPath, [Text.Encoding]::UTF8)
if ($Scenario -eq 'production-boundary') {
    Add-Type -TypeDefinition $source -ReferencedAssemblies @('System', 'System.Core') -ErrorAction Stop
    $assembly = [AiPet.ExplorerSpace.RestrictedExplorerShellTabObserver].Assembly
    $adapter = $assembly.GetType('AiPet.ExplorerSpace.WindowsExplorerSystemAdapter', $true)
    $constructors = @($adapter.GetConstructors(
        [Reflection.BindingFlags]::Instance -bor [Reflection.BindingFlags]::NonPublic
    ))
    $validation = $assembly.GetType('AiPet.ExplorerSpace.ShellTabCandidateValidation', $false)
    $observerMethods = @([AiPet.ExplorerSpace.RestrictedExplorerShellTabObserver].GetMethods() |
        Where-Object { $_.DeclaringType -eq [AiPet.ExplorerSpace.RestrictedExplorerShellTabObserver] })
    $valid = $null -eq $validation -and $constructors.Count -eq 1 -and
        $constructors[0].GetParameters().Count -eq 0 -and $observerMethods.Count -eq 1 -and
        $observerMethods[0].GetParameters().Count -eq 0
    @{
        scenario = $Scenario; status = $(if ($valid) { 'ready' } else { 'unavailable' })
        pathGetterCalls = 0; titleGetterCalls = 0; candidateEnumerationCalls = 0
        candidateReleaseCalls = 0; publicPayload = @{ status = $(if ($valid) { 'ready' } else { 'unavailable' }) }
    } | ConvertTo-Json -Compress -Depth 5
    exit $(if ($valid) { 0 } else { 1 })
}

$testSource = "#define SHELL_TAB_HELPER_TEST`r`n" + $source
Add-Type -TypeDefinition $testSource -ReferencedAssemblies @('System', 'System.Core') -ErrorAction Stop
$result = [AiPet.ExplorerSpace.ShellTabHelperSelfTest]::Run($Scenario)
$result | ConvertTo-Json -Compress -Depth 5
