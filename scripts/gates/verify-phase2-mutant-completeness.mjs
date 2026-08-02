#!/usr/bin/env node

// This verifier deliberately shares no code with the mutation runner. It
// reconstructs completeness solely from the draft and raw Stryker JSON.
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
};
const safeRelative = (path) => typeof path === "string" && path.length > 0 && !isAbsolute(path) &&
  !path.includes("\\") && !path.includes("\0") && path.split("/").every((part) => part && part !== "." && part !== "..");
const terminal = new Set(["Killed", "Timeout", "Survived", "NoCoverage"]);

export const rebuildIndependentMutantCompleteness = ({ report, readArtifact }) => {
  if (report?.schema_version !== "phase2-mutation-draft/v1" || report?.status !== "PASS" ||
      !Array.isArray(report?.results) || report.results.length !== 64)
    throw new Error("independent completeness requires one passing 64-result draft");
  const ids = report.results.map((result) => result?.requirement_id);
  if (new Set(ids).size !== 64) throw new Error("independent completeness requires 64 unique requirements");
  const rows = [];
  let totalMutants = 0;
  for (const result of report.results) {
    if (!Array.isArray(result.sources) || result.sources.length === 0 || !Array.isArray(result.chunks) ||
        result.chunks.length === 0 || result.expected_chunk_count !== result.chunks.length)
      throw new Error(`${String(result.requirement_id)} has empty sources or a partial chunk plan`);
    const identities = [];
    for (const chunk of result.chunks) {
      if (!safeRelative(chunk.raw_report_path) || chunk.source_file === undefined)
        throw new Error(`${String(chunk.chunk_id)} raw artifact path is unsafe`);
      const bytes = Buffer.from(readArtifact(chunk.raw_report_path));
      if (sha256(bytes) !== chunk.raw_report_sha256)
        throw new Error(`${String(chunk.chunk_id)} raw artifact hash mismatch`);
      const raw = JSON.parse(bytes.toString("utf8"));
      const files = Object.entries(raw?.files ?? {});
      if (files.length !== 1 || files[0][0] !== chunk.source_file)
        throw new Error(`${String(chunk.chunk_id)} raw source differs from the chunk authority`);
      const mutants = files[0][1]?.mutants;
      if (!Array.isArray(mutants) || mutants.length === 0)
        throw new Error(`${String(chunk.chunk_id)} contains zero mutants`);
      for (const mutant of mutants) {
        if (!terminal.has(mutant?.status)) throw new Error(`${String(chunk.chunk_id)} contains a non-terminal mutant`);
        identities.push([result.requirement_id, chunk.chunk_id, chunk.source_file, mutant.id,
          mutant.mutatorName, mutant.location, mutant.replacement, mutant.status]);
      }
      totalMutants += mutants.length;
    }
    const unique = new Set(identities.map(canonicalJson));
    if (unique.size !== identities.length) throw new Error(`${result.requirement_id} contains duplicate mutant identities`);
    rows.push([result.requirement_id, sha256(canonicalJson(identities.sort()))]);
  }
  if (totalMutants === 0) throw new Error("independent completeness contains zero mutants");
  return {
    schema_version: "phase2-mutant-completeness/v1",
    requirements: 64,
    total_mutants: totalMutants,
    mutant_identity_sha256: sha256(canonicalJson(rows.sort())),
  };
};

const root = resolve(process.cwd());
const reportRoot = join(root, "reports/mutation/phase2");
const report = JSON.parse(readFileSync(join(reportRoot, "candidate-report.json"), "utf8"));
const receipt = rebuildIndependentMutantCompleteness({
  report,
  readArtifact: (path) => readFileSync(join(reportRoot, path)),
});
process.stdout.write(`${JSON.stringify(receipt)}\n`);
