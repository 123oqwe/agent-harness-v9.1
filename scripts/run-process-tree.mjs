import { spawn } from "node:child_process";
import { clearTimeout, setTimeout } from "node:timers";

const defaultTerminationGraceMs = 250;
const defaultKillWaitMs = 1_000;
const defaultNormalExitGraceMs = 100;
const processGroupPollMs = 10;

function positiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

export function assertProcessTreePlatform(platform = process.platform) {
  if (platform === "win32") {
    throw new Error(
      "process-tree termination is unsupported on win32; refusing to spawn",
    );
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function closeChildStdio(child) {
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    if (!stream || stream.destroyed) continue;
    if (typeof stream.unpipe === "function") stream.unpipe();
    stream.destroy();
  }
}

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

async function waitForProcessGroupGone(pid, deadline) {
  while (processGroupExists(pid)) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;
    await delay(Math.min(processGroupPollMs, remainingMs));
  }
  return true;
}

async function waitForExitBefore(exitPromise, deadline, killWaitMs) {
  const remainingMs = Math.max(1, deadline - Date.now());
  let deadlineTimer;
  try {
    return await Promise.race([
      exitPromise,
      new Promise((_, rejectDeadline) => {
        deadlineTimer = setTimeout(
          () =>
            rejectDeadline(
              new Error(
                `process did not exit within ${killWaitMs}ms of SIGKILL`,
              ),
            ),
          remainingMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(deadlineTimer);
  }
}

async function terminateProcessTree(
  child,
  exitPromise,
  terminationGraceMs,
  killWaitMs,
) {
  const pid = child.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("spawned process has no valid process-group id");
  }
  signalProcessGroup(pid, "SIGTERM");
  await delay(terminationGraceMs);
  signalProcessGroup(pid, "SIGKILL");
  closeChildStdio(child);

  const deadline = Date.now() + killWaitMs;
  await waitForExitBefore(exitPromise, deadline, killWaitMs);
  if (!(await waitForProcessGroupGone(pid, deadline))) {
    throw new Error(
      `process group ${pid} survived ${killWaitMs}ms after SIGKILL`,
    );
  }
}

export async function runProcessTree(executable, args, options) {
  assertProcessTreePlatform();
  const timeoutMs = positiveSafeInteger(options.timeoutMs, "timeoutMs");
  const terminationGraceMs = positiveSafeInteger(
    options.terminationGraceMs ?? defaultTerminationGraceMs,
    "terminationGraceMs",
  );
  const killWaitMs = positiveSafeInteger(
    options.killWaitMs ?? defaultKillWaitMs,
    "killWaitMs",
  );
  const normalExitGraceMs = positiveSafeInteger(
    options.normalExitGraceMs ?? defaultNormalExitGraceMs,
    "normalExitGraceMs",
  );
  if (options.signal?.aborted) {
    throw new Error("process tree aborted before spawn");
  }

  const child = spawn(executable, args, {
    cwd: options.cwd,
    detached: true,
    env: options.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });

  const exitPromise = new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (status, signal) => resolveExit({ status, signal }));
  });
  let requestTermination;
  const terminationRequest = new Promise((resolveTermination) => {
    requestTermination = resolveTermination;
  });
  const timeout = setTimeout(
    () => requestTermination({ reason: "timeout" }),
    timeoutMs,
  );
  const onAbort = () => requestTermination({ reason: "abort" });
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const first = await Promise.race([
      exitPromise.then(
        (result) => ({ kind: "exit", result }),
        (error) => ({ kind: "error", error }),
      ),
      terminationRequest.then((request) => ({ kind: "terminate", request })),
    ]);
    const pid = child.pid;
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new Error("spawned process has no valid process-group id");
    }
    if (first.kind === "error") throw first.error;
    if (first.kind === "exit") {
      const groupGone = await waitForProcessGroupGone(
        pid,
        Date.now() + normalExitGraceMs,
      );
      if (groupGone) return first.result;
      await terminateProcessTree(
        child,
        exitPromise,
        terminationGraceMs,
        killWaitMs,
      );
      throw new Error("process tree exited but left descendant processes");
    }

    await terminateProcessTree(
      child,
      exitPromise,
      terminationGraceMs,
      killWaitMs,
    );
    if (first.request.reason === "timeout") {
      throw new Error(`process tree timed out after ${timeoutMs}ms`);
    }
    throw new Error("process tree was aborted");
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
    closeChildStdio(child);
  }
}
