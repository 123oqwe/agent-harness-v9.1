import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const stateDirectory = process.argv[2];
const markerDelayMs = process.argv[3];
const grandchildPath = join(import.meta.dirname, "process-tree-grandchild.mjs");

writeFileSync(join(stateDirectory, "parent.pid"), `${process.pid}\n`);
writeFileSync(
  join(stateDirectory, "partial-report.json"),
  `${JSON.stringify({ schemaVersion: "1.0", files: {} })}\n`,
);
const grandchild = spawn(
  process.execPath,
  [grandchildPath, stateDirectory, markerDelayMs],
  { stdio: "inherit" },
);
grandchild.unref();
const grandchildPidPath = join(stateDirectory, "grandchild.pid");
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
const readyDeadline = Date.now() + 1_000;
while (!existsSync(grandchildPidPath) && Date.now() < readyDeadline) {
  Atomics.wait(waitBuffer, 0, 0, 10);
}
if (!existsSync(grandchildPidPath)) {
  throw new Error("grandchild did not become ready");
}
process.exit(0);
