# Release build for the self-contained departmental installer.
#
# Preferred signing setup (certificate already installed in CurrentUser\My):
#   $env:CODESIGN_CERT_THUMBPRINT = "40-character SHA-1 thumbprint"
#
# Legacy PFX signing is also supported:
#   $env:CODESIGN_PFX_PATH = "C:\path\to\certificate.pfx"
#   $env:CODESIGN_PFX_PASSWORD = "password"

$ErrorActionPreference = 'Stop'
$InstallerVersion = '1.2.5'
$IsccPath = Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'
$IssPath = Join-Path $PSScriptRoot 'setup.iss'
$AppRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\app')).Path
$RuntimeNode = Join-Path $PSScriptRoot 'runtime\node.exe'
$RuntimeChromeRoot = Join-Path $PSScriptRoot 'runtime\puppeteer-cache'
$OutputName = "BrokerDemandDesk-Setup-$InstallerVersion.exe"
$OutputPath = Join-Path $PSScriptRoot "output\$OutputName"
$HashPath = "$OutputPath.sha256.txt"

function Assert-File([string]$Path, [string]$Description) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Description is missing: $Path"
    }
}

Assert-File $IsccPath 'Inno Setup compiler'
Assert-File $IssPath 'Installer definition'
Assert-File $RuntimeNode 'Bundled Node runtime'
Assert-File (Join-Path $AppRoot 'package.json') 'Application package metadata'
if (-not (Test-Path -LiteralPath (Join-Path $AppRoot 'node_modules') -PathType Container)) {
    throw 'app\node_modules is missing. Run npm install on the build machine before creating a release.'
}

$Package = Get-Content -LiteralPath (Join-Path $AppRoot 'package.json') -Raw | ConvertFrom-Json
if ([string]$Package.version -ne $InstallerVersion) {
    throw "package.json version $($Package.version) does not match installer version $InstallerVersion."
}
$SetupText = Get-Content -LiteralPath $IssPath -Raw
if ($SetupText -notmatch [regex]::Escape("#define MyAppVersion `"$InstallerVersion`"")) {
    throw "setup.iss does not declare version $InstallerVersion."
}

$RuntimeArch = & $RuntimeNode -p 'process.arch'
if ($LASTEXITCODE -ne 0 -or $RuntimeArch.Trim() -ne 'x64') {
    throw "Bundled Node must be x64; detected '$RuntimeArch'."
}
$RuntimeVersion = & $RuntimeNode --version
$Chrome = Get-ChildItem -LiteralPath $RuntimeChromeRoot -Recurse -Filter chrome.exe -File | Select-Object -First 1
if (-not $Chrome) {
    throw "Bundled Chromium is missing below $RuntimeChromeRoot."
}

Write-Host "Preflight OK: Node $RuntimeVersion ($RuntimeArch), Chromium $($Chrome.FullName)"
Write-Host 'Running release tests with the bundled Node runtime...'
$TestFiles = Get-ChildItem -LiteralPath (Join-Path $AppRoot 'test') -Filter '*.test.js' -File | ForEach-Object { $_.FullName }
if (-not $TestFiles -or $TestFiles.Count -eq 0) {
    throw 'No release tests were found.'
}
# Keep the release preflight in one process. This is deterministic for these
# isolated suites and also works in locked-down departmental build agents that
# prohibit the test runner from spawning child worker processes.
& $RuntimeNode --test --test-isolation=none @TestFiles
if ($LASTEXITCODE -ne 0) {
    throw "Release tests failed with exit code $LASTEXITCODE."
}

$signArgs = @()
$SigningConfigured = $false
if ($env:CODESIGN_CERT_THUMBPRINT) {
    $Thumbprint = ($env:CODESIGN_CERT_THUMBPRINT -replace '\s', '').ToUpperInvariant()
    if ($Thumbprint -notmatch '^[0-9A-F]{40}$') {
        throw 'CODESIGN_CERT_THUMBPRINT must be a 40-character SHA-1 certificate thumbprint.'
    }
    if (-not (Get-Command signtool.exe -ErrorAction SilentlyContinue)) {
        throw 'signtool.exe is required for the configured signing certificate.'
    }
    Write-Host 'Code-signing with the installed certificate thumbprint.'
    $signCmd = "signtool.exe sign /sha1 $Thumbprint /tr http://timestamp.digicert.com /td sha256 /fd sha256 `$f"
    $signArgs = @("/Ssigntool=$signCmd", '/DSIGNTOOL_NAME=signtool')
    $SigningConfigured = $true
} elseif ($env:CODESIGN_PFX_PATH -and $env:CODESIGN_PFX_PASSWORD) {
    Assert-File $env:CODESIGN_PFX_PATH 'Code-signing PFX'
    if (-not (Get-Command signtool.exe -ErrorAction SilentlyContinue)) {
        throw 'signtool.exe is required for the configured signing certificate.'
    }
    Write-Host 'Code-signing with the configured PFX certificate.'
    $signCmd = "signtool.exe sign /f `"$env:CODESIGN_PFX_PATH`" /p `"$env:CODESIGN_PFX_PASSWORD`" /tr http://timestamp.digicert.com /td sha256 /fd sha256 `$f"
    $signArgs = @("/Ssigntool=$signCmd", '/DSIGNTOOL_NAME=signtool')
    $SigningConfigured = $true
} else {
    Write-Warning 'No code-signing certificate is configured. The installer will be usable but Windows may show an Unknown Publisher warning.'
}

& $IsccPath @signArgs $IssPath
if ($LASTEXITCODE -ne 0) {
    throw "Inno Setup failed with exit code $LASTEXITCODE."
}
Assert-File $OutputPath 'Compiled installer'

$VersionInfo = (Get-Item -LiteralPath $OutputPath).VersionInfo
if ([string]$VersionInfo.ProductVersion -notlike "$InstallerVersion*") {
    throw "Built ProductVersion '$($VersionInfo.ProductVersion)' does not match $InstallerVersion."
}

$Signature = Get-AuthenticodeSignature -LiteralPath $OutputPath
if ($SigningConfigured -and $Signature.Status -ne 'Valid') {
    throw "Installer signing was configured but verification returned '$($Signature.Status)'."
}

$Hash = Get-FileHash -LiteralPath $OutputPath -Algorithm SHA256
"$($Hash.Hash)  $OutputName" | Set-Content -LiteralPath $HashPath -Encoding ASCII

Write-Host "Installer: $OutputPath"
Write-Host "SHA-256:  $($Hash.Hash)"
Write-Host "Signature: $($Signature.Status)"
