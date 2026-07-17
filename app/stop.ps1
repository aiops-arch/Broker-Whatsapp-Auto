param(
    [switch]$Quiet
)

$ErrorActionPreference = 'SilentlyContinue'
$AppDir = $PSScriptRoot
$DataDir = Join-Path $AppDir 'data'
$StopFlag = Join-Path $DataDir 'stop.flag'
$ServerPidFile = Join-Path $DataDir 'server.pid'
$ServerScript = [IO.Path]::GetFullPath((Join-Path $AppDir 'src\server.js'))
$RuntimeDir = [IO.Path]::GetFullPath((Join-Path $AppDir 'runtime'))
$WhatsAppAuthDir = [IO.Path]::GetFullPath((Join-Path $DataDir 'wwebjs_auth'))

function Show-UserMessage([string]$Message, [int]$Icon = 64) {
    if ($Quiet) { return }

    try {
        $shell = New-Object -ComObject WScript.Shell
        $shell.Popup($Message, 0, 'Broker Demand Desk', $Icon) | Out-Null
    } catch {
        Write-Host $Message
    }
}

function Test-ContainedExecutable([string]$CandidatePath, [string]$RootPath) {
    if ([string]::IsNullOrWhiteSpace($CandidatePath) -or [string]::IsNullOrWhiteSpace($RootPath)) {
        return $false
    }

    try {
        $candidateFullPath = [IO.Path]::GetFullPath($CandidatePath)
        $rootFullPath = [IO.Path]::GetFullPath($RootPath).TrimEnd(
            [IO.Path]::DirectorySeparatorChar,
            [IO.Path]::AltDirectorySeparatorChar
        ) + [IO.Path]::DirectorySeparatorChar
        return $candidateFullPath.StartsWith($rootFullPath, [StringComparison]::OrdinalIgnoreCase)
    } catch {
        return $false
    }
}

function Test-CommandLineReferencesPath([string]$CommandLine, [string]$ExactPath) {
    if ([string]::IsNullOrWhiteSpace($CommandLine) -or [string]::IsNullOrWhiteSpace($ExactPath)) {
        return $false
    }

    $searchFrom = 0
    while ($searchFrom -lt $CommandLine.Length) {
        $matchIndex = $CommandLine.IndexOf($ExactPath, $searchFrom, [StringComparison]::OrdinalIgnoreCase)
        if ($matchIndex -lt 0) { return $false }

        $beforeIsBoundary = $matchIndex -eq 0
        if (-not $beforeIsBoundary) {
            $before = $CommandLine[$matchIndex - 1]
            $beforeIsBoundary = [char]::IsWhiteSpace($before) -or $before -in @('"', "'", '=')
        }

        $afterIndex = $matchIndex + $ExactPath.Length
        $afterIsBoundary = $afterIndex -eq $CommandLine.Length
        if (-not $afterIsBoundary) {
            $after = $CommandLine[$afterIndex]
            $afterIsBoundary = [char]::IsWhiteSpace($after) -or $after -in @('"', "'", '\', '/')
        }

        if ($beforeIsBoundary -and $afterIsBoundary) { return $true }
        $searchFrom = $matchIndex + 1
    }

    return $false
}

function Stop-OwnedChromium {
    try {
        $chromeProcesses = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction Stop
        foreach ($chromeProcess in $chromeProcesses) {
            $isOwned =
                (Test-ContainedExecutable $chromeProcess.ExecutablePath $RuntimeDir) -and
                (Test-CommandLineReferencesPath $chromeProcess.CommandLine $WhatsAppAuthDir)
            if (-not $isOwned) { continue }

            Stop-Process -Id ([int]$chromeProcess.ProcessId) -Force -ErrorAction Stop
            Wait-Process -Id ([int]$chromeProcess.ProcessId) -Timeout 5 -ErrorAction SilentlyContinue
        }
    } catch {
        # Chromium cleanup is best-effort. Never broaden the match if process
        # details are unavailable or a candidate exits while it is inspected.
    }
}

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
New-Item -ItemType File -Force -Path $StopFlag | Out-Null

if (-not (Test-Path $ServerPidFile)) {
    Stop-OwnedChromium
    Show-UserMessage 'Broker Demand Desk is not running.'
    return
}

try {
    $serverProcessId = [int](Get-Content -Path $ServerPidFile -Raw).Trim()
    $process = Get-Process -Id $serverProcessId -ErrorAction Stop
    $details = Get-CimInstance Win32_Process -Filter "ProcessId = $serverProcessId" -ErrorAction Stop
    $isOwned = Test-CommandLineReferencesPath $details.CommandLine $ServerScript
    if (-not $isOwned) {
        Remove-Item $ServerPidFile -Force
        Stop-OwnedChromium
        Show-UserMessage 'The saved process ID belongs to another program, so it was left untouched. The stale app marker was removed.' 48
        return
    }

    Stop-Process -Id $serverProcessId -Force -ErrorAction Stop
    $process.WaitForExit(10000) | Out-Null
    Remove-Item $ServerPidFile -Force -ErrorAction SilentlyContinue
    Stop-OwnedChromium
    Show-UserMessage 'Broker Demand Desk stopped. This department''s database and WhatsApp session remain safely on this device.'
} catch {
    Remove-Item $ServerPidFile -Force -ErrorAction SilentlyContinue
    Stop-OwnedChromium
    Show-UserMessage 'Broker Demand Desk was not running. No other program was stopped.'
}
