# Kill leftover desktop-lyric windows so "open" never leaves two copies behind.
$ErrorActionPreference = 'SilentlyContinue'
Get-Process electron, powershell |
  Where-Object { $_.MainWindowTitle -eq '桌面歌词' } |
  Stop-Process -Force
Start-Sleep -Milliseconds 200
exit 0
