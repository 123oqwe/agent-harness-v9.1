import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setInterval, setTimeout } from "node:timers";

const stateDirectory = process.argv[2];
const markerDelayMs = Number.parseInt(process.argv[3], 10);

process.on("SIGTERM", () => {});
writeFileSync(join(stateDirectory, "grandchild.pid"), `${process.pid}\n`);
setTimeout(() => {
  writeFileSync(join(stateDirectory, "late-marker"), "orphan survived\n");
}, markerDelayMs);
setInterval(() => {}, 1_000);
