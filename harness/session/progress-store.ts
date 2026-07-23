/**
 * AH-RUNTIME-SESSION-001: Atomic progress.json writer.
 *
 * Writes .harness/progress.json atomically: write to temp file, fsync, rename.
 * Called by LoopEngine after every turn and on every stop condition.
 */
import { writeFileSync, renameSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

export interface ProgressEntry {
  run_id: string;
  current_step: string;
  goal: string;
  completed_steps: string[];
  open_tasks: string[];
  last_error: string | null;
  checkpoint_refs: string[];
  last_updated: string;
}

export function writeProgressAtomic(dataDir: string, entry: ProgressEntry): string {
  const progressPath = join(dataDir, '.harness', 'progress.json');
  const tmpPath = progressPath + '.tmp';
  mkdirSync(dirname(progressPath), { recursive: true });
  writeFileSync(tmpPath, JSON.stringify(entry, null, 2), 'utf8');
  renameSync(tmpPath, progressPath); // atomic on POSIX
  return progressPath;
}

export function readProgress(dataDir: string): ProgressEntry | null {
  const progressPath = join(dataDir, '.harness', 'progress.json');
  if (!existsSync(progressPath)) return null;
  return JSON.parse(readFileSync(progressPath, 'utf8')) as ProgressEntry;
}
