# Auto Vid Studio - setup komputer baru (aman dijalankan ulang).
# Jalankan di PowerShell:  powershell -ExecutionPolicy Bypass -File setup.ps1 [-SfxZip <link/ path zip SFX>]
param([string]$SfxZip = "")
$ErrorActionPreference = "Stop"
function Has($c) { [bool](Get-Command $c -ErrorAction SilentlyContinue) }
function Need($cmd, $id, $name) {
  if (Has $cmd) { Write-Host "[ok] $name" -f Green; return }
  Write-Host "[..] install $name" -f Yellow
  winget install --id $id -e --silent --accept-package-agreements --accept-source-agreements
}
if (-not (Has winget)) { throw "winget tidak ada. Update 'App Installer' dari Microsoft Store dulu." }

Need node   "OpenJS.NodeJS.LTS" "Node.js"
Need python "Python.Python.3.12" "Python 3"
Need ffmpeg "Gyan.FFmpeg"       "ffmpeg"
Need git    "Git.Git"           "Git"
$chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") | Where-Object { Test-Path $_ }
if ($chrome) { Write-Host "[ok] Google Chrome" -f Green } else { winget install --id Google.Chrome -e --silent --accept-package-agreements --accept-source-agreements }

# PATH baru dari winget belum kebaca di sesi ini
$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")

if (-not (Has claude)) { Write-Host "[..] install Claude Code" -f Yellow; npm install -g @anthropic-ai/claude-code } else { Write-Host "[ok] Claude Code" -f Green }

Write-Host "[..] Python packages (transkrip)" -f Yellow
python -m pip install -q -r appequirements.txt

Write-Host "[..] plugin HyperFrames untuk Claude Code" -f Yellow
claude plugin marketplace add heygen-com/hyperframes 2>$null
claude plugin install hyperframes@hyperframes 2>$null

Write-Host "[..] cache HyperFrames CLI" -f Yellow
npx -y hyperframes --version | Out-Null

if ($SfxZip) {
  $zip = $SfxZip
  if ($SfxZip -match '^https?://') { $zip = "$env:TEMP\autovid-sfx.zip"; Invoke-WebRequest $SfxZip -OutFile $zip }
  Expand-Archive $zip -DestinationPath "app\public" -Force
}
$n = (Get-ChildItem app\public\sfx -Recurse -Include *.mp3,*.wav -ErrorAction SilentlyContinue).Count
if ($n -gt 0) { Write-Host "[ok] SFX: $n file" -f Green } else { Write-Host "[!!] SFX belum ada: ekstrak zip SFX dari Drive tim ke folder public\ (jadi app\public\sfx\...)" -f Red }

Write-Host "`nSelesai. Buka terminal baru di folder ini, ketik: claude" -f Cyan
Write-Host "Login Claude sekali (Pro/Max atau API key), lalu kasih brief videonya." -f Cyan
