/**
 * AH-RUNTIME-SESSION-001: Atomic progress.json writer.
 *
 * Writes progress.json atomically: write to temp file, fsync, rename.
 * Called by LoopEngine after every turn and on every stop condition.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';

export interface ProgressEntry {
  run_id: string;
  current_step: string | number;
  goal: string;
  completed_steps: unknown[];
  open_tasks: string[];
  last_error: string | null;
  checkpoint_refs: string[];
  last_updated: string;
}

export function writeProgressAtomic(dataDir: string, entry: ProgressEntry): string {
  const progressPath = join(dataDir, 'progress.json');
  const tmpPath = progressPath + '.tmp';
  mkdirSync(dirname(progressPath), { recursive: true });
  const descriptor = openSync(tmpPath, 'w', 0o600);
  try {
    writeFileSync(descriptor, JSON.stringify(entry, null, 2), 'utf8');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    renameSync(tmpPath, progressPath);
    const directory = openSync(dirname(progressPath), 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } catch (error) {
    rmSync(tmpPath, { force: true });
    throw error;
  }
  return progressPath;
}

export function readProgress(dataDir: string): ProgressEntry | null {
  const progressPath = join(dataDir, 'progress.json');
  if (!existsSync(progressPath)) return null;
  return JSON.parse(readFileSync(progressPath, 'utf8')) as ProgressEntry;
}
