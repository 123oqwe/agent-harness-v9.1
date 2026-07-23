/** AH-TOOL-007: search_files - bounded literal/regex search */
import type { VirtualFilesystem } from '../vfs/virtual-filesystem.js';

export interface SearchFilesInput {
  directory: string;
  pattern: string;
  is_regex?: boolean;
  limit?: number;
  ignored_dirs?: string[];
}

export interface SearchResultEntry {
  file: string;
  line_number: number;
  line: string;
}

export interface SearchFilesResult {
  directory: string;
  matches: SearchResultEntry[];
  total: number;
  truncated: boolean;
}

export function searchFiles(vfs: VirtualFilesystem, input: SearchFilesInput): SearchFilesResult {
  const limit = input.limit ?? 100;
  const files = vfs.list(input.directory);
  const matches: SearchResultEntry[] = [];
  let regex: RegExp;
  
  if (input.is_regex) {
    regex = new RegExp(input.pattern, 'i');
  } else {
    regex = new RegExp(input.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }

  const ignoredDirs = input.ignored_dirs ?? ['node_modules', '.git', 'dist'];

  for (const file of files) {
    if (ignoredDirs.some((dir) => file.includes(`/${dir}/`))) continue;
    
    const content = vfs.read(file);
    if (content === null) continue;
    
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        matches.push({ file, line_number: i + 1, line: lines[i] });
        if (matches.length >= limit) {
          return { directory: input.directory, matches, total: matches.length, truncated: true };
        }
      }
    }
  }

  return { directory: input.directory, matches, total: matches.length, truncated: false };
}
