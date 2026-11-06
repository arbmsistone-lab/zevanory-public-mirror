# R142 - Chat Phase B - Windows PowerShell 5.1 - ASCII ONLY.
# Default mode is READ ONLY. Changes require an explicit -Preparar, -Ligar, or -Desligar.
# CAUTION: Wrangler secret put immediately deploys a new Worker version.
[CmdletBinding(DefaultParameterSetName="Ler")]
param(
    [Parameter(ParameterSetName="Preparar")][switch]$Preparar,
    [Parameter(ParameterSetName="Ligar")][switch]$Ligar,
    [Parameter(ParameterSetName="Desligar")][switch]$Desligar
)
$ErrorActionPreference = "Stop"
$env:CLOUDFLARE_ACCOUNT_ID = "1b26415802588185a86c1d4d3ebf5bdb"
$wrangler = "wrangler@4.143.0"
$workers = @("zevanory","zevanory-sales-public")
$sitekey = "0x4AAAAAAF2sozEg8we6MsOP"
function SecretNames([string]$worker) {
    $raw = & npx.cmd --yes $wrangler secret list --name $worker --format json
    if ($LASTEXITCODE -ne 0) { throw "Secret list failed for $worker" }
    $items = @($raw | Out-String | ConvertFrom-Json)
    return @($items | ForEach-Object { $_.name } | Where-Object { $_ })
}
function ReadbackNames {
    foreach ($worker in $workers) {
        $names = @(SecretNames $worker)
        Write-Host ("Worker: " + $worker)
        foreach ($name in ($names | Sort-Object -Unique)) { Write-Host ("  " + $name) }
    }
}
function PutText([string]$worker,[string]$key,[string]$value) {
    Write-Host ("Set secret name: " + $worker + " / " + $key)
    $value | & npx.cmd --yes $wrangler secret put $key --name $worker | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Secret put failed: $worker / $key" }
    if (@(SecretNames $worker) -notcontains $key) { throw "Secret name missing after put: $worker / $key" }
}
function PutOwnerSecret {
    Write-Host "Owner: enter SITE_CHAT_TURNSTILE_SECRET only at the hidden Wrangler prompt."
    & npx.cmd --yes $wrangler secret put SITE_CHAT_TURNSTILE_SECRET --name zevanory
    if ($LASTEXITCODE -ne 0) { throw "Turnstile secret put failed" }
    if (@(SecretNames "zevanory") -notcontains "SITE_CHAT_TURNSTILE_SECRET") { throw "Turnstile secret name missing" }
}
function RequireNames([string]$worker,[string[]]$required) {
    $current = @(SecretNames $worker)
    foreach ($key in $required) {
        if ($current -notcontains $key) { throw "Missing required secret name: $worker / $key" }
    }
}
if (-not ($Preparar -or $Ligar -or $Desligar)) {
    ReadbackNames
    Write-Host "READ ONLY: no Worker setting was changed."
    exit 0
}
# Explicit actions intentionally have no force/no-confirm option.
if ($Preparar) {
    # Make both Workers OFF before adding any other secret.
    PutText "zevanory-sales-public" "SITE_CHAT_ENABLED" "false"
    PutText "zevanory" "SITE_CHAT_ENABLED" "false"
    PutText "zevanory" "SITE_CHAT_OFFICIAL_PROTOCOLS" "true"
    PutText "zevanory" "SITE_CHAT_GENERATIVE" "false"
    PutText "zevanory" "SITE_CHAT_SANDBOX" "false"
    PutText "zevanory" "SITE_CHAT_TURNSTILE_SITEKEY" $sitekey
    PutOwnerSecret
    ReadbackNames
    Write-Host "PREPARED: chat flags remain OFF. Verify runtime and dependencies separately."
    exit 0
}
if ($Desligar) {
    PutText "zevanory-sales-public" "SITE_CHAT_ENABLED" "false"
    PutText "zevanory" "SITE_CHAT_ENABLED" "false"
    ReadbackNames
    Write-Host "OFF names recorded; verify /api/chat/status and the pages externally."
    exit 0
}
if ($Ligar) {
    RequireNames "zevanory" @("SITE_CHAT_ENABLED","SITE_CHAT_OFFICIAL_PROTOCOLS","SITE_CHAT_GENERATIVE","SITE_CHAT_SANDBOX","SITE_CHAT_TURNSTILE_SITEKEY","SITE_CHAT_TURNSTILE_SECRET")
    RequireNames "zevanory-sales-public" @("SITE_CHAT_ENABLED")
    # The operator must separately verify the actual values from prior -Preparar.
    # No secret values are read back by this script.
    try {
        PutText "zevanory" "SITE_CHAT_ENABLED" "true"
        PutText "zevanory-sales-public" "SITE_CHAT_ENABLED" "true"
        ReadbackNames
        Write-Host "ON names recorded; confirm both runtimes, status, Turnstile and outbox."
    } catch {
        Write-Host "Enable failed. Attempting fail-closed rollback."
        try { PutText "zevanory-sales-public" "SITE_CHAT_ENABLED" "false" } catch { Write-Host "ALERT: sales OFF requires manual intervention." }
        try { PutText "zevanory" "SITE_CHAT_ENABLED" "false" } catch { Write-Host "ALERT: central OFF requires manual intervention." }
        throw
    }
}
