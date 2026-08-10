'use strict';

/**
 * electron-builder config.
 * Azure Artifact Signing (Trusted Signing) is enabled only when the required
 * env vars are present — local unsigned builds keep working.
 *
 * Required for signed builds:
 *   AZURE_TENANT_ID
 *   AZURE_CLIENT_ID
 *   AZURE_CLIENT_SECRET
 *   AZURE_CODE_SIGNING_ENDPOINT   e.g. https://eus.codesigning.azure.net/
 *   AZURE_CODE_SIGNING_ACCOUNT_NAME
 *   AZURE_CERT_PROFILE_NAME
 * Optional:
 *   AZURE_PUBLISHER_NAME          CN from your identity validation
 */

const useAzureSigning = Boolean(
  process.env.AZURE_TENANT_ID &&
    process.env.AZURE_CLIENT_ID &&
    (process.env.AZURE_CLIENT_SECRET ||
      process.env.AZURE_CLIENT_CERTIFICATE_PATH ||
      process.env.AZURE_FEDERATED_TOKEN_FILE) &&
    process.env.AZURE_CODE_SIGNING_ENDPOINT &&
    process.env.AZURE_CODE_SIGNING_ACCOUNT_NAME &&
    process.env.AZURE_CERT_PROFILE_NAME,
);

if (useAzureSigning) {
  console.log('[kstream-desktop] Azure Artifact Signing enabled');
} else {
  console.log(
    '[kstream-desktop] Building UNSIGNED (set Azure signing env vars to enable SmartScreen-friendly builds)',
  );
}

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.kdesafx.kstream',
  productName: 'kstream',
  copyright: 'Copyright © 2026 kstream',
  directories: {
    output: 'dist',
  },
  npmRebuild: false,
  publish: {
    provider: 'github',
    owner: 'kdesaFX',
    repo: 'kstream-desktop',
  },
  files: ['src/**/*', 'logo.png', 'icon.ico', 'package.json'],
  extraFiles: [
    { from: 'icon.ico', to: 'icon.ico' },
    { from: 'logo.png', to: 'logo.png' },
  ],
  win: {
    icon: 'icon.ico',
    target: [
      {
        target: 'portable',
        arch: ['x64'],
      },
    ],
    requestedExecutionLevel: 'asInvoker',
    executableName: 'kstream',
    ...(useAzureSigning
      ? {
          sign: {
            type: 'azure',
            publisherName:
              process.env.AZURE_PUBLISHER_NAME || 'kstream',
            endpoint: process.env.AZURE_CODE_SIGNING_ENDPOINT,
            codeSigningAccountName:
              process.env.AZURE_CODE_SIGNING_ACCOUNT_NAME,
            certificateProfileName: process.env.AZURE_CERT_PROFILE_NAME,
          },
        }
      : {}),
  },
  portable: {
    artifactName: 'kstream-Setup.${ext}',
    requestExecutionLevel: 'user',
    unpackDirName: 'kstream-portable',
  },
};
