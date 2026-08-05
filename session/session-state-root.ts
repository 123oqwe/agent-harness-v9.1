import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";

export type SessionStateRootErrorCode =
  | "STATE_ROOT_REQUIRED"
  | "STATE_ROOT_UNTRUSTED"
  | "DATABASE_OUTSIDE_STATE_ROOT"
  | "DATABASE_IDENTITY_CHANGED";

export class SessionStateRootError extends Error {
  override readonly name = "SessionStateRootError";

  constructor(
    readonly code: SessionStateRootErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface TrustedSessionStateRoot {
  readonly version: 1;
  readonly path: string;
  readonly identity: Readonly<{ dev: number; ino: number }>;
}

export const SESSION_STORAGE_TRUST_BOUNDARY = Object.freeze({
  version: 1 as const,
  same_uid_swap_resistance: "not_guaranteed" as const,
  reason:
    "A malicious same-UID host process can swap and restore a pathname between identity checks because better-sqlite3 accepts only pathnames.",
  complete_resistance_requires: Object.freeze([
    "independent_os_account",
    "container",
    "descriptor_capable_sqlite_broker",
  ] as const),
  phase2_deployment_blocker: "AH-SANDBOX-OCI-001" as const,
});

const issuedRoots = new WeakSet<object>();

function trustedOwner(uid: number): boolean {
  return uid === 0 || uid === process.getuid?.();
}

function assertSafeAncestors(path: string): void {
  // Ancestors with group/other write are allowed only when the sticky bit
  // (0o1000) is set, as on Linux /tmp (mode 1777): the sticky bit prevents
  // other users from deleting or renaming entries they do not own.
  let current = path;
  while (true) {
    const value = lstatSync(current);
    if (!value.isDirectory() || !trustedOwner(value.uid) || ((value.mode & 0o022) && !(value.mode & 0o1000))) {
      throw new SessionStateRootError(
        "STATE_ROOT_UNTRUSTED",
        "session state root ancestor metadata is unsafe",
      );
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

/** Called only by the trusted composition root, never from agent-selected paths. */
export function createTrustedSessionStateRoot(path: string): TrustedSessionStateRoot {
  if (!isAbsolute(path)) {
    throw new SessionStateRootError("STATE_ROOT_UNTRUSTED", "session state root must be absolute");
  }
  const canonical = realpathSync(path);
  assertSafeAncestors(canonical);
  const value = lstatSync(canonical);
  if (!value.isDirectory() || !trustedOwner(value.uid) || (value.mode & 0o777) !== 0o700) {
    throw new SessionStateRootError(
      "STATE_ROOT_UNTRUSTED",
      "session state root must be current/root-owned mode 0700",
    );
  }
  const root = Object.freeze({
    version: 1 as const,
    path: canonical,
    identity: Object.freeze({ dev: value.dev, ino: value.ino }),
  });
  issuedRoots.add(root);
  return root;
}

export function assertTrustedSessionStateRoot(
  root: TrustedSessionStateRoot | undefined,
): asserts root is TrustedSessionStateRoot {
  if (!root || !issuedRoots.has(root)) {
    throw new SessionStateRootError(
      "STATE_ROOT_REQUIRED",
      "a trusted session state root is required",
    );
  }
  const current = lstatSync(root.path);
  if (
    !current.isDirectory() ||
    !trustedOwner(current.uid) ||
    (current.mode & 0o777) !== 0o700 ||
    current.dev !== root.identity.dev ||
    current.ino !== root.identity.ino
  ) {
    throw new SessionStateRootError(
      "STATE_ROOT_UNTRUSTED",
      "session state root identity changed",
    );
  }
}

export function resolveSessionDatabaseLocation(
  dbPath: string,
  root: TrustedSessionStateRoot,
): Readonly<{ path: string; name: string }> {
  assertTrustedSessionStateRoot(root);
  const absolute = resolve(dbPath);

  // Reject null bytes that could truncate paths at the SQLite C API boundary.
  if (absolute.includes("\0")) {
    throw new SessionStateRootError(
      "DATABASE_OUTSIDE_STATE_ROOT",
      "session database path contains null bytes",
    );
  }

  const parent = realpathSync(dirname(absolute));
  const name = basename(absolute);
  if (parent !== root.path || name.length === 0 || name === "." || name === "..") {
    throw new SessionStateRootError(
      "DATABASE_OUTSIDE_STATE_ROOT",
      "session database is outside the trusted state root",
    );
  }

  // Resolve the full path to reject symlinks pointing outside the trust root.
  // For existing files, realpathSync follows symlinks to their target; for
  // non-existing files, lstatSync on the parent (already realpath'd) is trusted.
  let resolved: string;
  try {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      // Symlink: resolve to target and re-validate the resolved path's parent.
      const realPath = realpathSync(absolute);
      const realParent = realpathSync(dirname(realPath));
      if (realParent !== root.path) {
        throw new SessionStateRootError(
          "DATABASE_OUTSIDE_STATE_ROOT",
          "session database symlink target is outside the trusted state root",
        );
      }
      resolved = realPath;
    } else {
      resolved = absolute;
    }
  } catch (error) {
    if (error instanceof SessionStateRootError) throw error;
    // ENOENT is expected for new databases; the parent is already validated.
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw new SessionStateRootError(
        "DATABASE_IDENTITY_CHANGED",
        `session database path resolution failed: ${(error as Error).message}`,
      );
    }
    resolved = absolute;
  }

  return Object.freeze({ path: resolved, name });
}
