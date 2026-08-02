import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setInterval } from "node:timers";

const stateDirectory = process.argv[2];
const markerDelayMs = process.argv[3];
const grandchildPath = join(import.meta.dirname, "process-tree-grandchild.mjs");

process.on("SIGTERM", () => {});
writeFileSync(join(stateDirectory, "parent.pid"), `${process.pid}\n`);
writeFileSync(
  join(stateDirectory, "partial-report.json"),
  `${JSON.stringify({ schemaVersion: "1.0", files: {} })}\n`,
);
spawn(process.execPath, [grandchildPath, stateDirectory, markerDelayMs], {
  stdio: "inherit",
});
setInterval(() => {}, 1_000);
