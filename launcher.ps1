param([switch]$NoOpen, [switch]$ResetPassword)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
& node node_modules/typescript/bin/tsc
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$controllerArgs = @('dist/controller/index.js')
if ($NoOpen) { $controllerArgs += '--no-open' }
if ($ResetPassword) { $controllerArgs += '--reset-password' }
& node @controllerArgs
exit $LASTEXITCODE
