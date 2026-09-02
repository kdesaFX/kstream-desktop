# Windows code signing (SmartScreen)

Unsigned `kstream-Setup.exe` builds trigger **Microsoft Defender SmartScreen**. There is no reliable way around that without signing.

This repo is wired for **Azure Artifact Signing** (formerly Trusted Signing) — ~$10/month, no USB token. CI signs automatically once GitHub secrets are set.

> Note: Signing greatly reduces SmartScreen. Brand-new signed files can still warn until Microsoft builds reputation for that publisher/hash. That is normal.

## One-time Azure setup (you must do this)

1. Create / sign in to [Azure Portal](https://portal.azure.com) (pay-as-you-go is fine).
2. **Subscriptions → Resource providers → register `Microsoft.CodeSigning`.**
3. Create an **Artifact Signing** account (search “Artifact Signing” / “Trusted Signing”).
   - Pick a region close to you (e.g. East US → endpoint `https://eus.codesigning.azure.net/`).
   - Note the **account name**.
4. **IAM** on that account → grant yourself **Artifact Signing Identity Verifier**.
5. **Identity validations → Individual → Public** and complete ID verification (gov ID + proof of address). Wait for **Completed**.
6. Create a **Certificate profile** (Public Trust). Note the **profile name**.
7. **Entra ID → App registrations → New registration** (e.g. `kstream-codesign`).
   - Create a **Client secret**. Copy the **Value** once.
   - Note **Application (client) ID** and **Directory (tenant) ID**.
8. On the Artifact Signing account → **IAM** → assign the app’s service principal **Artifact Signing Certificate Profile Signer**.

Eligibility: individuals currently **US / Canada**. Orgs have wider regions. See [Microsoft’s code signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options).

## GitHub secrets

In `kdesaFX/kstream-desktop` → Settings → Secrets and variables → Actions, add:

| Secret | Example / notes |
| --- | --- |
| `AZURE_TENANT_ID` | Directory (tenant) ID |
| `AZURE_CLIENT_ID` | Application (client) ID |
| `AZURE_CLIENT_SECRET` | Client secret **value** |
| `AZURE_CODE_SIGNING_ENDPOINT` | `https://eus.codesigning.azure.net/` (match your region) |
| `AZURE_CODE_SIGNING_ACCOUNT_NAME` | Artifact Signing account name |
| `AZURE_CERT_PROFILE_NAME` | Certificate profile name |
| `AZURE_PUBLISHER_NAME` | Exact name from identity validation (often your legal name / CN) |

## Local signed build

```powershell
$env:AZURE_TENANT_ID="..."
$env:AZURE_CLIENT_ID="..."
$env:AZURE_CLIENT_SECRET="..."
$env:AZURE_CODE_SIGNING_ENDPOINT="https://eus.codesigning.azure.net/"
$env:AZURE_CODE_SIGNING_ACCOUNT_NAME="..."
$env:AZURE_CERT_PROFILE_NAME="..."
$env:AZURE_PUBLISHER_NAME="..."
pnpm run dist
```

Without those vars, `pnpm run dist` still produces an **unsigned** installer (dev/testing only).

## Verify a build is signed

```powershell
pwsh ./scripts/verify-release-signature.ps1
# or
Get-AuthenticodeSignature .\dist\kstream-Setup.exe | Format-List *
```

`Status` should be `Valid`.

## If SmartScreen still warns after signing

Signing is required but not always instant. Common follow-ups:

1. **Publisher name must match** — `AZURE_PUBLISHER_NAME` must match the CN on your Azure identity validation exactly.
2. **Build reputation** — new publishers/files can warn for a while even when signed. Distribute the same signed build (do not re-upload unsigned copies to R2/CDN).
3. **Submit false-positive / reputation** — [Microsoft file submission](https://www.microsoft.com/en-us/wdsi/filesubmission) (developer → “I believe this file is safe”). Include the signed `kstream-Setup.exe` hash and your publisher name.
4. **Keep one download URL** — `kdesa.stream/download/kstream-Setup.exe` should always serve the latest **signed** GitHub release asset.

Unsigned local builds (`pnpm run dist` without Azure env vars) will always trigger SmartScreen — that is expected.
