/**
 * AH-TOOL-SEARCH-001: search_files tool.
 *
 * Uses ripgrep when available on the real filesystem for fast multi-file
 * search with line numbers and regex support. Falls back to VFS substring
 * search when rg is unavailable or when searching non-local backends.
 */
import { spawnSync } from 'node:child_process';
import type { VirtualFilesystem, VfsEntry } from '../vfs/virtual-filesystem.js';

export interface SearchFilesInput {
  root: string;
  needle: string;
  max_results?: number;
  mode?: 'content' | 'filename' | 'regex';
  glob?: string;
}

export interface SearchMatch extends VfsEntry {
  line_number?: number;
  line_content?: string;
  match_count?: number;
}

export interface SearchFilesOutput {
  matches: SearchMatch[];
  truncated: boolean;
}

interface RgMatch {
  type: 'match';
  data: {
    path: { text: string };
    line_number: number;
  };
}

/**
 * Try to run ripgrep on the real filesystem. Returns null if rg is
 * unavailable or the root is not on the local backend.
 */
function tryRipgrep(
  root: string,
  needle: string,
  mode: 'content' | 'filename' | 'regex' | undefined,
  glob: string | undefined,
  maxResults: number,
): SearchMatch[] | null {
  // Only attempt rg for absolute paths that look like real FS paths
  if (!root.startsWith('/workspace/') && root !== '/workspace') {
    // VFS virtual paths — rg can't help, but the workspace root maps
    // to a real directory. We still try, because LocalBackend serves /workspace.
  }

  const args: string[] = ['--json', '--max-count', String(maxResults)];
  if (mode === 'filename') {
    args.push('--files');
  } else {
    args.push('--line-number');
    if (mode === 'regex') {
      args.push('-e', needle);
    } else {
      args.push('-F', needle); // fixed string for content mode
    }
  }
  if (glob) {
    args.push('--glob', glob);
  }
  args.push(root);

  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync('rg', args, {
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
  } catch {
    return null; // rg not found
  }
  if (result.error || result.status === 127 || result.status === null) {
    return null; // rg not available
  }
  if (result.status !== 0 && result.status !== 1) {
    // rg exits 1 for no matches, 2 for errors
    return null;
  }

 const matches: SearchMatch[] = [];
 const stdoutStr = typeof result.stdout === 'string' ? result.stdout : result.stdout.toString('utf8');
 if (mode === 'filename') {
   // rg --files outputs one path per line
   const lines = stdoutStr.split('\n').filter((l: string) => l.length > 0);
   for (const line of lines.slice(0, maxResults)) {
     matches.push({ path: line, kind: 'file' as const, size: 0 });
   }
 } else {
   // Parse JSON-lines output
   for (const line of stdoutStr.split('\n')) {
      if (line.length === 0) continue;
      try {
        const entry = JSON.parse(line) as RgMatch;
        if (entry.type !== 'match') continue;
        matches.push({
          path: entry.data.path.text,
          kind: 'file' as const,
          size: 0,
          line_number: entry.data.line_number,
        });
      } catch {
        // Skip non-JSON lines
      }
    }
  }
  return matches;
}

export async function searchFiles(
  vfs: VirtualFilesystem,
  input: SearchFilesInput,
): Promise<SearchFilesOutput> {
  const max = input.max_results ?? 100;
  const mode = input.mode ?? 'content';

  // Try ripgrep first for local filesystem paths
  const rgResults = tryRipgrep(
    input.root,
    input.needle,
    mode,
    input.glob,
    max,
  );
  if (rgResults !== null) {
    return {
      matches: rgResults.slice(0, max),
      truncated: rgResults.length > max,
    };
  }

  // Fallback: VFS substring search
  const all = vfs.search(input.root, input.needle);
  const matches: SearchMatch[] = all.slice(0, max).map((e) => ({ ...e }));
  return { matches, truncated: all.length > max };
}
