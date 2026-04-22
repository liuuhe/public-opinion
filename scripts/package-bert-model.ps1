param(
  [string]$ModelDir = "bert/models/xhs-bert-sentiment",
  [string]$Output = ".deploy/xhs-bert-sentiment.zip"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptDir "..")
Set-Location $repoRoot

$modelPath = Resolve-Path $ModelDir -ErrorAction Stop
if (-not $modelPath.Path.StartsWith($repoRoot.Path)) {
  throw "Model directory is outside the repository: $($modelPath.Path)"
}

foreach ($file in @("config.json", "tokenizer.json", "tokenizer_config.json")) {
  if (-not (Test-Path (Join-Path $modelPath.Path $file))) {
    throw "Model directory is missing '$file': $($modelPath.Path)"
  }
}

$hasWeights = (Test-Path (Join-Path $modelPath.Path "model.safetensors")) -or (Test-Path (Join-Path $modelPath.Path "pytorch_model.bin"))
if (-not $hasWeights) {
  throw "Model directory must contain model.safetensors or pytorch_model.bin: $($modelPath.Path)"
}

$outputPath = Join-Path $repoRoot.Path $Output
$outputDir = Split-Path -Parent $outputPath
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
if (Test-Path $outputPath) {
  Remove-Item -LiteralPath $outputPath -Force
}

$stagingDir = Join-Path $repoRoot.Path ".deploy/model-package/xhs-bert-sentiment"
if (Test-Path $stagingDir) {
  Remove-Item -LiteralPath $stagingDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $stagingDir | Out-Null
Get-ChildItem -LiteralPath $modelPath.Path -Force | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination $stagingDir -Recurse -Force
}

Compress-Archive -Path $stagingDir -DestinationPath $outputPath -CompressionLevel Optimal
Write-Host "Model package created: $outputPath"
