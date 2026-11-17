#!/usr/bin/env node
// Deterministic regression suite. No provider credentials or live inference required.
const { spawnSync } = require('node:child_process');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const store = path.join(mkdtempSync(path.join(tmpdir(), 'ag-offline-')), 'signatures.json');
const files = [
 'test-session-hybrid.test.cjs', 'test-health-timeout.test.mjs',
 'test-grok-bridge.test.cjs', 'test-openai-grok-compat.test.mjs',
 'test-caller-system-placement.test.mjs', 'test-system-prompt-placement.cjs',
 'test-identity-scrub.cjs', 'test-billing-header.cjs',
 'test-session-manager.cjs', 'test-signature-cache.cjs',
 'test-model-registry.cjs', 'test-schema-sanitizer.cjs',
 'test-strategies.cjs', 'test-403-account-rotation.cjs',
 'test-403-integration.cjs', 'test-usage-stats.js', 'test-version-detection.js'
];
let failures = 0;
for (const file of files) {
 console.log('\nRunning ' + file);
 const result = spawnSync(process.execPath, [path.join(__dirname, file)], {
  stdio: 'inherit', timeout: 60000,
  env: { ...process.env, ANTIGRAVITY_SIGNATURE_STORE: store, FALLBACK_ANTIGRAVITY_VERSION: '2.32.0' }
 });
 if (result.status !== 0 || result.error) {
  failures++;
  console.error(file + ' FAILED: ' + (result.error?.message || result.status));
 }
}
console.log(files.length + ' suites finished, ' + failures + ' failed');
process.exitCode = failures ? 1 : 0;
