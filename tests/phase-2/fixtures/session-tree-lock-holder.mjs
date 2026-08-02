import Database from "better-sqlite3";

const [dbPath, holdMillisecondsText] = process.argv.slice(2);
if (!dbPath) throw new Error("database path is required");
const holdMilliseconds = Number(holdMillisecondsText ?? "250");
if (!Number.isSafeInteger(holdMilliseconds) || holdMilliseconds < 1) {
  throw new Error("hold duration must be a positive safe integer");
}

const database = new Database(dbPath);
database.pragma("busy_timeout = 5000");
database.exec("BEGIN IMMEDIATE");
process.stdout.write("LOCKED\n");
setTimeout(() => {
  database.exec("COMMIT");
  database.close();
}, holdMilliseconds);
