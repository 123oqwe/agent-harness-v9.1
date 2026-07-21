// @ts-nocheck
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const threatsPath = path.resolve(__dirname, '../../../spec/threat-model/threats.yaml');
const controlsPath = path.resolve(__dirname, '../../../spec/threat-model/controls.yaml');
const controlTestMapPath = path.resolve(__dirname, '../../../spec/threat-model/control-test-map.yaml');

describe('AH-THREAT-001: threat model', () => {
  it('threats.yaml exists and is non-empty', () => {
    expect(fs.existsSync(threatsPath)).toBe(true);
    const content = fs.readFileSync(threatsPath, 'utf-8');
    expect(content.length).toBeGreaterThan(50);
  });

  it('controls.yaml exists and is non-empty', () => {
    expect(fs.existsSync(controlsPath)).toBe(true);
    const content = fs.readFileSync(controlsPath, 'utf-8');
    expect(content.length).toBeGreaterThan(50);
  });

  // AH-THREAT-001 acceptance: "No control without test".
  // Every control_id in controls.yaml must have a mapping in control-test-map.yaml.
  it('every control has a test mapping (No control without test)', () => {
    const controls = fs.readFileSync(controlsPath, 'utf-8');
    const controlIds = Array.from(controls.matchAll(/control_id:\s+(CTRL-[A-Z0-9-]+)/g)).map(m => m[1]);
    expect(controlIds.length).toBeGreaterThan(0);

    const map = fs.readFileSync(controlTestMapPath, 'utf-8');
    const mappedIds = new Set(Array.from(map.matchAll(/^(CTRL-[A-Z0-9-]+):/gm)).map(m => m[1]));

    const unmapped = controlIds.filter(id => !mappedIds.has(id));
    expect(unmapped).toEqual([]);
  });
});
