# lanclave: LANclave's developer tools from the terminal. `lanclave help` lists everything.

$ErrorActionPreference = "Stop"
$lan = "http://localhost:8378"

function Say([string]$msg) { Write-Host "-- $msg" -ForegroundColor Cyan }
function Fail([string]$msg) { Write-Host "!! $msg" -ForegroundColor Red; exit 1 }
function Q([string]$s) { [uri]::EscapeDataString($s) }

# Split "logs com.x -Level W -Phone pixel" into a positional value and options.
function Options([object[]]$list) {
  $opts = @{ positional = @() }
  for ($i = 0; $i -lt $list.Count; $i++) {
    $a = [string]$list[$i]
    if ($a.StartsWith("-")) {
      $name = $a.TrimStart("-").ToLower()
      if ($i + 1 -lt $list.Count -and -not ([string]$list[$i + 1]).StartsWith("-")) {
        $opts[$name] = [string]$list[$i + 1]; $i++
      } else {
        $opts[$name] = $true
      }
    } else {
      $opts.positional += $a
    }
  }
  return $opts
}

function PhoneParam($opts) { if ($opts.phone) { "phone=" + (Q $opts.phone) } else { "" } }

# The "Phones:" part of LANclave's own help page.
function Phones {
  try {
    $page = (Invoke-WebRequest "$lan/" -UseBasicParsing -TimeoutSec 20).Content
  } catch {
    Write-Host "  LANclave isn't answering on $lan. Start the dev build of LANclave on this computer." -ForegroundColor Yellow
    return
  }
  $lines = $page -split "`n"
  $start = [array]::IndexOf($lines, ($lines | Where-Object { $_ -like "Phones:*" } | Select-Object -First 1))
  if ($start -lt 0) { return }
  for ($i = $start; $i -lt $lines.Count -and $lines[$i].Trim() -ne ""; $i++) { Write-Host $lines[$i] }
}

function Help {
  Write-Host @"

LANclave developer tools: logs, installs and launches on your phone, no USB cable.

  lanclave run                      Build, install, open the app and follow its logs
                                    (run it in your project folder, like npx expo run:android)
      -Variant release              build type (default debug)
      -NoBuild                      install the last build instead of building
      -NoMetro                      don't start Metro or connect the app to it
      -Level W                      lowest log level shown: V D I W E F
      -Phone <name>                 which phone, when several have developer tools on

  lanclave logs [package]           Live logs; one app's, or the whole phone's
      -Level E                      lowest log level shown
      -Tag MyTag,Other              only these tags
      -Tail 500                     earlier lines to show first (default 200)

  lanclave install <file.apk>       Install an APK
  lanclave open <package>           Open an installed app
  lanclave status                   Which phones are ready
  lanclave help                     This list

Every command takes -Phone <part of its name>. Ctrl+C stops the logs.

On the phone: LANclave > Settings > Developer tools must be on.

"@
  Phones
  Write-Host ""
}

$command = if ($args.Count -gt 0) { ([string]$args[0]).ToLower() } else { "help" }
# @(...) around the whole thing: one leftover argument must stay a list.
$rest = @($args | Select-Object -Skip 1)

switch -Regex ($command) {
  "^(help|-h|--help|-help|/\?|\?)$" { Help; break }

  "^status$" { Phones; break }

  "^run$" {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "lanclave-run.ps1") @rest
    exit $LASTEXITCODE
  }

  "^logs?$" {
    $o = Options $rest
    $url = "$lan/logs?color=1"
    if ($o.positional.Count) { $url += "&pkg=" + (Q $o.positional[0]) }
    if ($o.level) { $url += "&level=" + (Q $o.level) }
    if ($o.tag) { $url += "&tag=" + (Q $o.tag) }
    if ($o.tail) { $url += "&tail=" + (Q $o.tail) }
    $p = PhoneParam $o; if ($p) { $url += "&$p" }
    & curl.exe -sS -N $url
    exit $LASTEXITCODE
  }

  "^install$" {
    $o = Options $rest
    if (-not $o.positional.Count) { Fail "Which APK? lanclave install path\to\app.apk" }
    $apk = $o.positional[0]
    if (-not (Test-Path $apk)) { Fail "No such file: $apk" }
    $url = "$lan/install"
    $p = PhoneParam $o; if ($p) { $url += "?$p" }
    Say "installing $(Split-Path $apk -Leaf) ($([math]::Round((Get-Item $apk).Length / 1MB, 1)) MB)"
    & curl.exe -sS --fail-with-body -T $apk $url
    exit $LASTEXITCODE
  }

  "^open$" {
    $o = Options $rest
    if (-not $o.positional.Count) { Fail "Which app? lanclave open com.example.app" }
    $url = "$lan/launch?pkg=" + (Q $o.positional[0])
    $p = PhoneParam $o; if ($p) { $url += "&$p" }
    & curl.exe -sS --fail-with-body -X POST $url
    exit $LASTEXITCODE
  }

  default {
    Write-Host "Unknown command: $command" -ForegroundColor Red
    Help
    exit 1
  }
}
