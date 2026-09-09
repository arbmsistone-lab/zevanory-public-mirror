import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decodePngRgba, pngVisualMetrics } from '../src/pngVisualMetrics.mjs';

test('PNG visual decoder measures the official ZEVANORY asset deterministically',async()=>{
  const png=await readFile(new URL('../public/brand/zevanory-avatar.png',import.meta.url));
  const decoded=decodePngRgba(png),metrics=pngVisualMetrics(png);
  assert.equal(decoded.width,1080);assert.equal(decoded.height,1080);
  assert.ok(metrics.dynamic_range>200);assert.ok(metrics.luminance_std>40);
  assert.ok(metrics.occupied_fraction>0.05&&metrics.occupied_fraction<0.5);
});