param(
  [string]$ModelDir = "bert\models\xhs-bert-sentiment-oldflow-v2-seed42-e5-b16-lr2e5",
  [int]$Port = 7860,
  [string]$HostName = "127.0.0.1",
  [ValidateSet("torch", "onnx", "auto")]
  [string]$Runtime = "torch"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$bertDir = Join-Path $repoRoot "bert"
$python = Join-Path $bertDir ".venv\Scripts\python.exe"

if (-not (Test-Path $python)) {
  throw "Missing BERT virtualenv python: $python"
}

$resolvedModel = Resolve-Path -LiteralPath (Join-Path $repoRoot $ModelDir)
$env:MODEL_DIR = $resolvedModel.Path
$env:BERT_RUNTIME = $Runtime
Set-Location $bertDir

& $python -m uvicorn app:app --host $HostName --port $Port
