<#
.SYNOPSIS
  Build an Android app, install it on your phone, open it and follow its logs,
  all through LANclave. Like `npx expo run:android`, without a USB cable.

.DESCRIPTION
  Run from an Expo, React Native or plain Android project folder. Needs the
  dev build of LANclave on this computer and on the phone, with developer tools
  turned on (phone: Settings > Developer tools).

  For an Expo app with expo-dev-client, it starts Metro if it isn't running and
  opens the app already connected to it, so JS edits reload as usual.

.EXAMPLE
  lanclave-run                      # build, install, open, logs
  lanclave-run -NoBuild             # send the last build again
  lanclave-run -Level W             # only warnings and errors
  lanclave-run -Phone pixel         # pick a phone when several are online
#>
param(
  # Part of the phone's name, when more than one is online.
  [string]$Phone = "",
  # Gradle build variant: debug, release, or a flavor like freeDebug.
  [string]$Variant = "debug",
  # CPU type to build native code for. Phones are arm64-v8a; one type builds faster.
  [string]$Arch = "arm64-v8a",
  # Metro's port.
  [int]$Port = 8081,
  # Lowest log level shown: V D I W E F.
  [string]$Level = "V",
  [switch]$NoBuild,
  [switch]$NoMetro,
  [switch]$NoLogs,
  # Project folder; the current one by default.
  [string]$Project = "."
)

$ErrorActionPreference = "Stop"
$lan = "http://localhost:8378"

function Say([string]$msg) { Write-Host "-- $msg" -ForegroundColor Cyan }
function Fail([string]$msg) { Write-Host "!! $msg" -ForegroundColor Red; exit 1 }
function Q([string]$s) { [uri]::EscapeDataString($s) }

# The reply body of a failed Invoke-WebRequest, or the error itself.
function ErrorText($err) {
  if ($err.ErrorDetails -and $err.ErrorDetails.Message) { return $err.ErrorDetails.Message.Trim() }
  return $err.Exception.Message
}

$root = (Resolve-Path $Project).Path

# ---- LANclave ---------------------------------------------------------------
try {
  $null = Invoke-WebRequest "$lan/" -UseBasicParsing -TimeoutSec 20
} catch {
  Fail "LANclave's developer tools aren't answering on $lan. Is the dev build of LANclave running on this computer?"
}

# ---- What kind of project ---------------------------------------------------
$deps = @{}
$packageJson = Join-Path $root "package.json"
if (Test-Path $packageJson) {
  $pj = Get-Content $packageJson -Raw | ConvertFrom-Json
  foreach ($section in @($pj.dependencies, $pj.devDependencies)) {
    if ($section) { $section.PSObject.Properties | ForEach-Object { $deps[$_.Name] = $true } }
  }
}
$isReactNative = $deps.ContainsKey("react-native")
$isExpo = $deps.ContainsKey("expo")
$hasDevClient = $deps.ContainsKey("expo-dev-client")

$androidDir = $null
if (Test-Path (Join-Path $root "android\gradlew.bat")) { $androidDir = Join-Path $root "android" }
elseif (Test-Path (Join-Path $root "gradlew.bat")) { $androidDir = $root }

if (-not $androidDir) {
  if (-not $isExpo) {
    Fail "No Android project here (no android\gradlew.bat or gradlew.bat). Run this from your project folder, or pass -Project <path>."
  }
  Say "no android folder yet: running expo prebuild"
  Push-Location $root
  try { npx expo prebuild -p android } finally { Pop-Location }
  if ($LASTEXITCODE) { Fail "expo prebuild failed" }
  $androidDir = Join-Path $root "android"
}

# ---- Build ------------------------------------------------------------------
$task = "assemble" + $Variant.Substring(0, 1).ToUpper() + $Variant.Substring(1)
if (-not $NoBuild) {
  Say "building ($task, $Arch)"
  Push-Location $androidDir
  try { & .\gradlew.bat $task "-PreactNativeArchitectures=$Arch" } finally { Pop-Location }
  if ($LASTEXITCODE) { Fail "build failed" }
}

# The APK and its package name, from the metadata Gradle writes next to it.
$found = Get-ChildItem -Path (Join-Path $androidDir "*\build\outputs\apk") -Recurse -Filter output-metadata.json -ErrorAction SilentlyContinue |
  ForEach-Object { [pscustomobject]@{ File = $_; Meta = (Get-Content $_.FullName -Raw | ConvertFrom-Json) } } |
  Where-Object { $_.Meta.variantName -eq $Variant } |
  Sort-Object { $_.File.LastWriteTime } -Descending |
  Select-Object -First 1
if (-not $found) { Fail "no $Variant APK found under $androidDir. Build it first, or drop -NoBuild." }
$apk = Join-Path $found.File.DirectoryName $found.Meta.elements[0].outputFile
$appId = $found.Meta.applicationId
$phoneParam = if ($Phone) { "phone=" + (Q $Phone) } else { "" }

# ---- Install ----------------------------------------------------------------
$sizeMb = [math]::Round((Get-Item $apk).Length / 1MB, 1)
Say "installing $(Split-Path $apk -Leaf) ($sizeMb MB) as $appId"
$installUrl = "$lan/install"
if ($phoneParam) { $installUrl += "?$phoneParam" }
& curl.exe -sS --fail-with-body -T $apk $installUrl
if ($LASTEXITCODE) { Fail "install failed" }

# ---- Metro ------------------------------------------------------------------
function MetroUp {
  try {
    $r = Invoke-WebRequest "http://localhost:$Port/status" -UseBasicParsing -TimeoutSec 2
    return $r.Content -match "packager-status:running"
  } catch { return $false }
}

$useMetro = $isReactNative -and -not $NoMetro
if ($useMetro -and -not (MetroUp)) {
  Say "starting Metro in a new window"
  if ($isExpo) {
    $metroCmd = "npx expo start --port $Port"
    if ($hasDevClient) { $metroCmd += " --dev-client" }
  } else {
    $metroCmd = "npx react-native start --port $Port"
  }
  Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location -LiteralPath '$root'; $metroCmd" | Out-Null
  $deadline = (Get-Date).AddSeconds(90)
  while (-not (MetroUp) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 1 }
  if (-not (MetroUp)) { Say "Metro isn't up yet; the app connects once it is" }
}

# ---- Open -------------------------------------------------------------------
$launchUrl = "$lan/launch?pkg=$(Q $appId)"
if ($phoneParam) { $launchUrl += "&$phoneParam" }
if ($useMetro -and $hasDevClient) {
  # Dev client builds answer to exp+<slug>; the phone fills in this computer's address.
  $slug = $null
  $appJson = Join-Path $root "app.json"
  if (Test-Path $appJson) { $slug = (Get-Content $appJson -Raw | ConvertFrom-Json).expo.slug }
  if (-not $slug) {
    Push-Location $root
    try { $slug = (npx expo config --json 2>$null | Out-String | ConvertFrom-Json).slug } catch {} finally { Pop-Location }
  }
  if ($slug) { $launchUrl += "&scheme=$(Q "exp+$slug")&port=$Port" }
}

$capture = $null
$seq = $null
try {
  $r = Invoke-WebRequest $launchUrl -Method Post -UseBasicParsing -TimeoutSec 20
  Say $r.Content.Trim()
  $capture = $r.Headers["x-lanclave-capture"]
  $seq = $r.Headers["x-lanclave-seq"]
} catch {
  Say "could not open the app: $(ErrorText $_)"
}
if ($useMetro -and -not $hasDevClient) {
  Say "no expo-dev-client: if the app can't find Metro, open its dev menu > Change bundle location > <this computer's IP>:$Port"
}

# ---- Logs -------------------------------------------------------------------
if ($NoLogs) { exit 0 }
$logUrl = "$lan/logs?pkg=$(Q $appId)&level=$(Q $Level)&color=1"
if ($capture -and $seq) { $logUrl += "&capture=$(Q $capture)&after=$seq" } else { $logUrl += "&tail=0" }
if ($phoneParam) { $logUrl += "&$phoneParam" }
Say "logs for $appId (Ctrl+C to stop)"
& curl.exe -sS -N $logUrl
