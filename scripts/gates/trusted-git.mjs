import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  realpathSync,
  statSync,
} from "node:fs";

const CANDIDATES = Object.freeze([
  "/usr/bin/git",
  "/usr/local/bin/git",
  "/opt/homebrew/bin/git",
]);

const resolveTrustedGit = () => {
  for (const candidate of CANDIDATES) {
    try {
      const executable = realpathSync(candidate);
      accessSync(executable, constants.X_OK);
      if (statSync(executable).isFile()) return executable;
    } catch {
      // Continue through the fixed, non-PATH candidate list.
    }
  }
  throw new Error("trusted absolute git executable is unavailable");
};

export const TRUSTED_GIT_EXECUTABLE = resolveTrustedGit();

const gitEnvironment = () =>
  Object.fromEntries(
    ["HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"].flatMap((name) =>
      typeof process.env[name] === "string" ? [[name, process.env[name]]] : [],
    ),
  );

export const spawnTrustedGitSync = (args, options = {}) =>
  spawnSync(TRUSTED_GIT_EXECUTABLE, args, {
    env: gitEnvironment(),
    shell: false,
    ...options,
  });
