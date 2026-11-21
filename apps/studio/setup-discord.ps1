[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$StateDirectory,
  [switch]$StartBridge
)

$ErrorActionPreference = 'Stop'
$cli = Join-Path $PSScriptRoot 'cli.mjs'
if (-not (Test-Path -LiteralPath (Join-Path $StateDirectory 'studio.sqlite'))) {
  throw 'Initialize or demo a local studio first, then pass its state directory.'
}
Write-Host 'Use a bot installed in your private guild. The bot needs View Channel, Send Messages, and Read Message History.'
Write-Host 'Deny View Channel to @everyone on the operations channel and explicitly allow the bot and operator roles.'
$vars = 'PIE_DISCORD_GUILD_ID','PIE_DISCORD_CHANNEL_ID','PIE_DISCORD_OPERATOR_IDS','PIE_DISCORD_BOT_TOKEN'
$previous = @{}
foreach ($key in $vars) { $previous[$key] = [Environment]::GetEnvironmentVariable($key,'Process') }
$secret = $null
try {
  if (-not $env:PIE_DISCORD_GUILD_ID) { $env:PIE_DISCORD_GUILD_ID = Read-Host 'Server ID' }
  if (-not $env:PIE_DISCORD_CHANNEL_ID) { $env:PIE_DISCORD_CHANNEL_ID = Read-Host 'Private operations text channel ID' }
  if (-not $env:PIE_DISCORD_OPERATOR_IDS) { $env:PIE_DISCORD_OPERATOR_IDS = Read-Host 'Your Discord user ID for !pie ask (blank for status only)' }
  if (-not $env:PIE_DISCORD_BOT_TOKEN) {
    $secret = Read-Host 'Bot token (hidden, used only in this process and its bridge)' -AsSecureString
    $env:PIE_DISCORD_BOT_TOKEN = [System.Net.NetworkCredential]::new('', $secret).Password
  }
  & node $cli $StateDirectory discord-check
  if ($LASTEXITCODE -ne 0) { throw 'Discord account or channel verification failed.' }
  & node $cli $StateDirectory discord-connect
  if ($LASTEXITCODE -ne 0) { throw 'Could not bind the local operations transcript.' }
  if ($StartBridge) {
    Write-Host 'Bridge active. Keep the studio worker running separately. Use Ctrl+C to stop.'
    & node $cli $StateDirectory discord-serve
    if ($LASTEXITCODE -ne 0) { throw 'Bridge stopped. Check channel access and discord-status.' }
  } else {
    Write-Host 'Binding verified. Run this command again with -StartBridge when ready to mirror new operations messages.'
  }
} finally {
  foreach ($key in $vars) { [Environment]::SetEnvironmentVariable($key,$previous[$key],'Process') }
  if ($secret) { $secret.Dispose() }
}
