import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const threatsPath = path.resolve(__dirname, '../../../spec/threat-model/threats.yaml');
const controlsPath = path.resolve(__dirname, '../../../spec/threat-model/controls.yaml');

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
});
