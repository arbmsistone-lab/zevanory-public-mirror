import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const proxy = await readFile(new URL('../workers/control-plane-proxy.mjs', import.meta.url), 'utf8');
const config = JSON.parse(await readFile(new URL('../wrangler.control-plane-proxy.jsonc', import.meta.url), 'utf8'));
const worker = await readFile(new URL('../src/cloudflare-worker.mjs', import.meta.url), 'utf8');
const wrangler = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));

test('control plane proxy is canonical and AppDeploy-free', () => {
  assert.match(proxy, /CONTROL_PLANE_ENTRY = '\/central'/);
  assert.match(proxy, /ZEVANORY_RUNTIME\.fetch/);
  assert.doesNotMatch(proxy, /appdeploy/i);
  assert.equal(config.name, 'arbm-control-senior-proxy');
  assert.equal(config.services[0].binding, 'ZEVANORY_RUNTIME');
  assert.equal(config.services[0].service, 'zevanory');
});

test('canonical ZEVANORY worker consumes private ZEA-10 RPC', () => {
  assert.match(worker, /env\.ZEA10_ENGINE\.report\(\)/);
  assert.match(worker, /zea10_live/);
  const binding = wrangler.services?.find((item) => item.binding === 'ZEA10_ENGINE');
  assert.ok(binding);
  assert.equal(binding.service, 'arbm-control');
  assert.equal(binding.entrypoint, 'Zea10ControlPlaneService');
});
