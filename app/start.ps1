$ErrorActionPreference = 'Stop'
$AppDir = $PSScriptRoot
Set-Location $AppDir

$DataDir = Join-Path $AppDir 'data'
$StopFlag = Join-Path $DataDir 'stop.flag'
$WatchdogLog = Join-Path $DataDir 'watchdog.log'
$ServerPidFile = Join-Path $DataDir 'server.pid'
$ConfigPath = Join-Path $DataDir 'config.json'
$ServerScript = Join-Path $AppDir 'src\server.js'
$normalizedAppDir = [IO.Path]::GetFullPath($AppDir).TrimEnd('\').ToUpperInvariant()
$instanceHasher = [Security.Cryptography.SHA256]::Create()
try {
    $instanceHash = $instanceHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($normalizedAppDir))
} finally {
    $instanceHasher.Dispose()
}
$instanceKey = ([BitConverter]::ToString($instanceHash)).Replace('-', '').Substring(0, 24)
$MutexName = "Local\BrokerDemandDesk-$instanceKey"

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

function Show-UserError([string]$Message) {
    try {
        $shell = New-Object -ComObject WScript.Shell
        $shell.Popup($Message, 0, 'Broker Demand Desk', 16) | Out-Null
    } catch {
        Write-Host $Message
    }
}

function Write-Log([string]$Message) {
    "$(Get-Date -Format o) $Message" | Add-Content -Path $WatchdogLog
}

if (-not (Test-Path $ConfigPath)) {
    @{
        port = 4173
        host = '127.0.0.1'
        whatsappProvider = 'whatsapp_web'
        defaultCountryCode = '91'
    } | ConvertTo-Json | Set-Content -Path $ConfigPath -Encoding UTF8
}

try {
    $LocalConfig = Get-Content -Path $ConfigPath -Raw | ConvertFrom-Json
    $AppPort = [int]$LocalConfig.port
    if ($AppPort -lt 1024 -or $AppPort -gt 65535) { throw 'port must be between 1024 and 65535' }
    if ([string]$LocalConfig.host -ne '127.0.0.1') { throw 'host must remain 127.0.0.1' }
    if ([string]$LocalConfig.whatsappProvider -ne 'whatsapp_web') { throw 'this departmental build requires whatsapp_web' }
    $CountryCode = [string]$LocalConfig.defaultCountryCode
    if ($CountryCode -notmatch '^\d{1,4}$') { throw 'defaultCountryCode must contain 1 to 4 digits' }
} catch {
    Show-UserError "The local configuration is invalid:`n$($_.Exception.Message)`n`nFile: $ConfigPath"
    exit 1
}

# Force all runtime configuration into this installation. Machine-wide or
# user-wide environment variables cannot redirect one department to another
# department's database, port, provider, or WhatsApp settings.
$env:BROKER_APP_DATA_DIR = $DataDir
$env:PORT = [string]$AppPort
$env:HOST = '127.0.0.1'
$env:WA_PROVIDER = 'whatsapp_web'
$env:WA_DEFAULT_COUNTRY_CODE = $CountryCode

$AppUrl = "http://127.0.0.1:$AppPort"

function Test-PortListening([int]$Port) {
    $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    return $null -ne $connection
}

function Test-AppHealth {
    try {
        $response = Invoke-RestMethod -Uri "$AppUrl/api/health" -Method Get -TimeoutSec 2
        return $response.ok -eq $true -and $response.app -eq 'broker-demand-desk'
    } catch {
        return $false
    }
}

function Open-AppBrowser {
    # Do not depend only on the machine's HTTP file association. Some managed
    # departmental PCs accept Start-Process on a URL but never show a window.
    # Prefer an installed browser explicitly, then fall back to Windows shell.
    $browserCandidates = @()
    $candidatePaths = @(
        $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe' }),
        $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe' }),
        $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe' }),
        $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe' }),
        $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe' }),
        $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe' })
    )
    foreach ($candidatePath in $candidatePaths) {
        if ($candidatePath -and (Test-Path -LiteralPath $candidatePath -PathType Leaf)) {
            $browserCandidates += $candidatePath
        }
    }

    foreach ($browserPath in ($browserCandidates | Select-Object -Unique)) {
        try {
            Start-Process -FilePath $browserPath -ArgumentList @('--new-window', $AppUrl) -ErrorAction Stop | Out-Null
            Write-Log "Opened app in browser: $browserPath"
            return $true
        } catch {
            Write-Log "Browser launch failed ($browserPath): $($_.Exception.Message)"
        }
    }

    try {
        $explorer = Join-Path $env:WINDIR 'explorer.exe'
        Start-Process -FilePath $explorer -ArgumentList @($AppUrl) -ErrorAction Stop | Out-Null
        Write-Log 'Opened app through the Windows URL handler.'
        return $true
    } catch {
        Write-Log "Windows URL handler failed: $($_.Exception.Message)"
    }

    Show-UserError "Broker Demand Desk is running, but Windows could not open a browser.`n`nOpen this address manually in Edge or Chrome:`n$AppUrl"
    return $false
}

function Get-OwnedServerProcess {
    if (-not (Test-Path $ServerPidFile)) { return $null }
    try {
        $serverProcessId = [int](Get-Content -Path $ServerPidFile -Raw).Trim()
        $process = Get-Process -Id $serverProcessId -ErrorAction Stop
        $details = Get-CimInstance Win32_Process -Filter "ProcessId = $serverProcessId" -ErrorAction Stop
        if ($details.CommandLine -and $details.CommandLine.IndexOf($ServerScript, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            return $process
        }
    } catch {
        # Stale/malformed PID file: remove it and start normally.
    }
    Remove-Item -Path $ServerPidFile -Force -ErrorAction SilentlyContinue
    return $null
}

$createdNew = $false
$watchdogMutex = New-Object System.Threading.Mutex($true, $MutexName, [ref]$createdNew)
if (-not $createdNew) {
    # Another watchdog owns startup. Wait for the actual health endpoint
    # instead of returning the misleading "already running" message.
    $startupDeadline = [DateTime]::UtcNow.AddSeconds(75)
    while (-not (Test-AppHealth) -and [DateTime]::UtcNow -lt $startupDeadline) {
        Start-Sleep -Seconds 1
    }
    if (Test-AppHealth) {
        Open-AppBrowser | Out-Null
    } else {
        Show-UserError "Broker Demand Desk did not become reachable.`n`nUse the Stop Broker Demand Desk shortcut once, then start it again.`n`nDiagnostics:`n$WatchdogLog"
    }
    $watchdogMutex.Dispose()
    return
}

try {
    if (Test-Path $StopFlag) { Remove-Item $StopFlag -Force }

    # Use the bundled portable Node runtime when installed. A packaged build
    # must already contain all dependencies and never downloads at first run.
    $BundledNode = Join-Path $AppDir 'runtime\node.exe'
    $IsPackaged = Test-Path $BundledNode
    $NodeExe = if ($IsPackaged) { $BundledNode } else { 'node' }
    if (-not (Test-Path (Join-Path $AppDir 'node_modules'))) {
        if ($IsPackaged) {
            Show-UserError 'This installation is incomplete: node_modules is missing. Reinstall Broker Demand Desk; no online download will be attempted.'
            return
        }
        Show-UserError 'Development dependencies are missing. Run npm install from the app folder, then start again.'
        return
    }

    # A valid health response is stronger evidence than a PID/WMI lookup and
    # works on managed PCs where process command-line inspection is blocked.
    if (Test-AppHealth) {
        Open-AppBrowser | Out-Null
        return
    }

    $existingProcess = Get-OwnedServerProcess
    if ($existingProcess) {
        Write-Log "Recovering unresponsive owned server process $($existingProcess.Id)."
        Stop-Process -Id $existingProcess.Id -Force -ErrorAction SilentlyContinue
        $existingProcess.WaitForExit(10000) | Out-Null
        Remove-Item $ServerPidFile -Force -ErrorAction SilentlyContinue
    }

    if (Test-PortListening $AppPort) {
        Show-UserError "Port $AppPort is already used by another program. Broker Demand Desk did not start and will not stop that other program."
        return
    }

    Write-Log 'Watchdog starting.'
    $browserOpened = $false
    $consecutiveFailures = 0

    while ($true) {
        if (Test-Path $StopFlag) {
            Remove-Item $StopFlag -Force
            Write-Log 'Stop requested - watchdog exiting.'
            break
        }

        if (Test-PortListening $AppPort) {
            Write-Log "Port $AppPort became occupied by another program; watchdog stopped safely."
            Show-UserError "Port $AppPort is now used by another program. Broker Demand Desk stopped safely without closing it."
            break
        }

        Write-Log 'Starting server...'
        $startTime = Get-Date
        $serverArgument = '"' + $ServerScript + '"'
        $process = Start-Process -FilePath $NodeExe -ArgumentList $serverArgument -WorkingDirectory $AppDir -PassThru -WindowStyle Hidden
        Set-Content -Path $ServerPidFile -Value $process.Id -Encoding ASCII

        $startupDeadline = [DateTime]::UtcNow.AddSeconds(75)
        $healthWasReady = $false
        $lastHealthyAt = [DateTime]::MinValue
        $restartReason = $null

        # Keep supervising instead of blocking forever in WaitForExit(). This
        # lets the watchdog recover a process that exists but never listens, or
        # one that becomes unresponsive after startup.
        while (-not $process.HasExited) {
            if (Test-Path $StopFlag) {
                $restartReason = 'stop requested'
                Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
                break
            }

            $healthy = Test-AppHealth
            if ($healthy) {
                $healthWasReady = $true
                $lastHealthyAt = [DateTime]::UtcNow
                if (-not $browserOpened) {
                    Open-AppBrowser | Out-Null
                    $browserOpened = $true
                }
            } elseif (-not $healthWasReady -and [DateTime]::UtcNow -ge $startupDeadline) {
                $restartReason = 'health endpoint did not start within 75 seconds'
                Write-Log "Server $($process.Id) $restartReason; restarting it."
                Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
                break
            } elseif ($healthWasReady -and (([DateTime]::UtcNow - $lastHealthyAt).TotalSeconds -ge 60)) {
                # Chromium startup and antivirus scans can briefly delay the
                # local Node event loop. Require a full minute with no single
                # successful health response before treating it as hung.
                $restartReason = 'health endpoint was unreachable for 60 seconds'
                Write-Log "Server $($process.Id) $restartReason; restarting it."
                Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
                break
            }

            Start-Sleep -Seconds 2
        }

        $process.WaitForExit(10000) | Out-Null
        $currentPid = if (Test-Path $ServerPidFile) { (Get-Content -Path $ServerPidFile -Raw).Trim() } else { '' }
        if ($currentPid -eq [string]$process.Id) {
            Remove-Item $ServerPidFile -Force -ErrorAction SilentlyContinue
        }

        $ranForSeconds = ((Get-Date) - $startTime).TotalSeconds
        Write-Log "Server exited (code $($process.ExitCode)) after ${ranForSeconds}s$(if ($restartReason) { "; reason: $restartReason" })."

        if (Test-Path $StopFlag) {
            Remove-Item $StopFlag -Force
            Write-Log 'Stop requested after exit - watchdog exiting.'
            break
        }

        if ($ranForSeconds -gt 60) { $consecutiveFailures = 0 }
        $consecutiveFailures++
        $delay = [Math]::Min(3 * $consecutiveFailures, 60)
        Write-Log "Restarting in ${delay}s (consecutive failures: $consecutiveFailures)..."
        Start-Sleep -Seconds $delay
    }
} catch {
    Write-Log "Watchdog error: $($_.Exception.Message)"
    Show-UserError "Broker Demand Desk could not start:`n$($_.Exception.Message)`n`nSee $WatchdogLog for details."
} finally {
    try { $watchdogMutex.ReleaseMutex() } catch {}
    $watchdogMutex.Dispose()
}
