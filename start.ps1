# Compatibility launcher. The panel owns the MCP and Cloudflare processes.
param([string]$Workspace, [int]$Port = 0, [switch]$Force, [switch]$OpenUI)
if ($Force) { Write-Warning '-Force no longer kills port owners. Use Stop in the panel.' }
if ($Workspace -or $Port) { Write-Warning 'Set WORKSPACE_PATH / PORT in the panel, then restart MCP.' }
& "$PSScriptRoot\launcher.ps1"
