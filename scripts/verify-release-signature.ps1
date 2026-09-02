# Verify Authenticode signature on the Windows release artifact.
# Usage: pwsh scripts/verify-release-signature.ps1 [path-to-exe]

param(
  [string]$Path = ""
)

$ErrorActionPreference = "Stop"

if (-not $Path) {
  $candidates = @(
    "dist\kstream-Setup.exe",
    (Get-ChildItem -Path dist -Filter "*Setup*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName)
  ) | Where-Object { $_ -and (Test-Path $_) }

  if (-not $candidates -or $candidates.Count -eq 0) {
    Write-Error "No installer found under dist/. Pass -Path explicitly."
    exit 1
  }
  $Path = $candidates[0]
}

if (-not (Test-Path $Path)) {
  Write-Error "File not found: $Path"
  exit 1
}

Write-Host "Verifying Authenticode signature: $Path"
$sig = Get-AuthenticodeSignature -FilePath $Path

Write-Host "  Status: $($sig.Status)"
if ($sig.SignerCertificate) {
  Write-Host "  Subject: $($sig.SignerCertificate.Subject)"
  Write-Host "  Thumbprint: $($sig.SignerCertificate.Thumbprint)"
}
if ($sig.TimeStamperCertificate) {
  Write-Host "  Timestamp: $($sig.TimeStamperCertificate.Subject)"
}

if ($sig.Status -ne "Valid") {
  Write-Error "Release artifact is not validly signed ($($sig.Status))."
  exit 1
}

Write-Host "Signature OK."
