# Registers the Store Listing Publisher's native messaging host with Firefox,
# and declares which directories it is allowed to read.
#
#   .\install-native-host.ps1 -Root E:\my-project
#   .\install-native-host.ps1 -Root E:\my-project,D:\other-assets
#
# (PowerShell takes several values as one comma-separated array, not as a
# repeated switch.)
#
# Pass every directory the tool must read: the assets root from your config, and
# — if you use "extends" — the directory holding the project config file.
#
# Two machine-specific things are generated here rather than committed: the host
# manifest (which needs an absolute path to the launcher) and allowed-roots.json.
# Both are gitignored.
#
# RE-RUN THIS AFTER MOVING OR RENAMING THIS CHECKOUT: the manifest and the
# registry value both point at the old location, and nothing else notices.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string[]] $Root
)

$ErrorActionPreference = 'Stop'

$hostName     = 'com.storelistingpublisher.filereader'
$templatePath = Join-Path $PSScriptRoot 'host-manifest.example.json'
$manifestPath = Join-Path $PSScriptRoot "$hostName.json"
$rootsPath    = Join-Path $PSScriptRoot 'allowed-roots.json'
$launcherPath = Join-Path $PSScriptRoot 'filereader.bat'
$regKey       = "HKCU:\Software\Mozilla\NativeMessagingHosts\$hostName"

# Resolve the roots now, so a typo fails here instead of mid-run as a refusal.
$resolved = foreach ($candidate in $Root) {
  if (-not (Test-Path -LiteralPath $candidate)) {
    throw "Root does not exist: $candidate"
  }
  (Resolve-Path -LiteralPath $candidate).Path
}

@{ roots = @($resolved) } | ConvertTo-Json -Depth 3 |
  Set-Content -Path $rootsPath -Encoding UTF8

$manifest = Get-Content $templatePath -Raw | ConvertFrom-Json
$manifest.path = $launcherPath
$manifest | ConvertTo-Json -Depth 5 | Set-Content -Path $manifestPath -Encoding UTF8

New-Item -Path $regKey -Force | Out-Null
Set-ItemProperty -Path $regKey -Name '(Default)' -Value $manifestPath

Write-Host 'Registered the native messaging host.'
Write-Host "  Manifest: $manifestPath"
Write-Host "  Launcher: $launcherPath"
Write-Host '  Readable roots:'
foreach ($r in $resolved) { Write-Host "    $r" }
Write-Host ''
Write-Host "Python on PATH: $(python --version 2>&1)"
