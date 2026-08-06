/**
 * #8: screenshot tool — captures the screen and saves to VFS.
 * Uses platform-native screencapture (macOS) or scrot/import (Linux).
 */
import { spawnSync } from 'node:child_process';
import type { VirtualFilesystem } from '../vfs/virtual-filesystem.js';

export interface ScreenshotInput { display?: number }
export interface ScreenshotOutput { path: string; width: number; height: number; bytes: number }

export async function screenshot(vfs: VirtualFilesystem, _input: ScreenshotInput): Promise<ScreenshotOutput> {
  const timestamp = Date.now();
  const path = `/workspace/.screenshots/screenshot-${timestamp}.png`;
  const platform = process.platform;

  let result: { status: number | null; stdout: string; stderr: string };
  if (platform === 'darwin') {
    result = spawnSync('screencapture', ['-x', '-t', 'png', `/tmp/ah-screenshot-${timestamp}.png`], {
      encoding: 'utf8', timeout: 10_000, shell: false,
    });
  } else {
    // Linux: try import (ImageMagick), then scrot
    result = spawnSync('import', ['-window', 'root', `/tmp/ah-screenshot-${timestamp}.png`], {
      encoding: 'utf8', timeout: 10_000, shell: false,
    });
    if (result.status !== 0) {
      result = spawnSync('scrot', [`/tmp/ah-screenshot-${timestamp}.png`], {
        encoding: 'utf8', timeout: 10_000, shell: false,
      });
    }
  }

  if (result.status !== 0) {
    throw new Error(`screenshot failed: ${result.stderr || 'unknown error'}`);
  }

  // Read the screenshot and write to VFS
  const fs = await import('node:fs');
  const data = fs.readFileSync(`/tmp/ah-screenshot-${timestamp}.png`);
  vfs.write(path, data);
  // Clean up temp file
  try { fs.unlinkSync(`/tmp/ah-screenshot-${timestamp}.png`); } catch { /* */ }

  // Detect dimensions from PNG header
  const width = data.length > 24 ? data.readUInt32BE(16) : 0;
  const height = data.length > 28 ? data.readUInt32BE(20) : 0;

  return { path, width, height, bytes: data.length };
}
