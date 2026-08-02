import { writeFileSync } from "node:fs";

writeFileSync(
  process.argv[2],
  `${JSON.stringify({ schemaVersion: "1.0", files: {} })}\n`,
);
