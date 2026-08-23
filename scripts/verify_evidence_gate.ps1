param(
  [Parameter(Mandatory = $true)]
  [string]$GateFile
)

if (-not (Test-Path $GateFile)) {
  Write-Error "EVIDENCE_GATE_MISSING"
  exit 1
}

$content = Get-Content -Raw -Path $GateFile
$evidenceCount = ([regex]::Matches($content, '^## Evidencia [123]', 'Multiline')).Count
$sourceCount = ([regex]::Matches($content, '^Fonte:\s*\S+', 'Multiline')).Count
$classCount = ([regex]::Matches($content, '^Classe:\s*[ABC](?:/B)?', 'Multiline')).Count
$approved = $content -match '(?m)^Veredito:\s*APROVADO\s*$'

if ($evidenceCount -lt 3 -or $sourceCount -lt 3 -or $classCount -lt 3 -or -not $approved) {
  Write-Error "EVIDENCE_GATE_BLOCKED"
  exit 2
}

Write-Output "EVIDENCE_GATE_APPROVED"
exit 0
