# Compatibility entry point for named Cloudflare tunnels with a custom domain.
param([int]$Port = 0)
Write-Host 'Open Cloudflare Tunnel in the panel to configure your domain and start the tunnel.'
& "$PSScriptRoot\launcher.ps1"
