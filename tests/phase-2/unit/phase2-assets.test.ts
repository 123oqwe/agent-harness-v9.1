import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  checkPhase2Assets,
  DEFAULT_REPOSITORY_ROOT,
  // @ts-expect-error The production checker intentionally ships as plain Node ESM.
} from "../../../scripts/gates/check-phase2-assets.mjs";

const checkerPath = resolve(
  process.cwd(),
  "scripts/gates/check-phase2-assets.mjs",
);
const temporaryRoots: string[] = [];

const createRepositoryCopy = () => {
  const root = mkdtempSync(join(tmpdir(), "phase2-assets-"));
  temporaryRoots.push(root);
  for (const path of [
    "verification/gates/phase2-gate.json",
    "evals",
    "data-tests",
    "fixtures/phase-2/assets",
    "scripts/gates/check-phase2-assets.mjs",
  ]) {
    const source = resolve(process.cwd(), path);
    const destination = resolve(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true });
  }
  chmodSync(resolve(root, "scripts/gates/check-phase2-assets.mjs"), 0o755);
  return root;
};

const readJson = (path: string) =>
  JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

const writeJson = (path: string, value: unknown) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");

const runChecker = (root: string, mode: "bootstrap" | "release") =>
  spawnSync(process.execPath, [checkerPath, "--root", root, "--mode", mode], {
    encoding: "utf8",
    shell: false,
    timeout: 10_000,
    maxBuffer: 256 * 1024,
  });

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("Phase 2 executable asset contracts", () => {
  it("accepts the checked-in bootstrap contracts without claiming release readiness", () => {
    const result = checkPhase2Assets({
      mode: "bootstrap",
      repositoryRoot: DEFAULT_REPOSITORY_ROOT,
    });

    expect(result.errors).toEqual([]);
    expect(result.releaseReady).toBe(false);
    expect(result.evaluations).toBe(7);
    expect(result.dataManifests).toBe(3);
    expect(result.warnings).toContain(
      "consented-staging dataset is unavailable; release verification remains blocked",
    );
    expect(result.warnings).toContain(
      "public-benchmarks dataset is bootstrap-only; release verification remains blocked",
    );
  });

  it("fails release verification closed while authorized staging data is unavailable", () => {
    const result = checkPhase2Assets({
      mode: "release",
      repositoryRoot: DEFAULT_REPOSITORY_ROOT,
    });

    expect(result.releaseReady).toBe(false);
    expect(result.errors).toContain(
      "consented-staging dataset is unavailable; release verification remains blocked",
    );
    expect(result.errors).toContain(
      "public-benchmarks dataset is bootstrap-only; release verification remains blocked",
    );
  });

  it.each([
    ["missing eval", "evals/writing/phase-2.yaml"],
    ["missing data manifest", "data-tests/synthetic/phase-2/manifest.json"],
    ["missing input", "fixtures/phase-2/assets/evals/coding.json"],
  ])("rejects %s", (_label, relativePath) => {
    const root = createRepositoryCopy();
    rmSync(resolve(root, relativePath));
    expect(
      checkPhase2Assets({ mode: "bootstrap", repositoryRoot: root }).errors,
    ).toContain(`missing required asset: ${relativePath}`);
  });

  it("rejects empty, malformed, unknown-key and unlinked eval contracts", () => {
    const root = createRepositoryCopy();
    const evalPath = resolve(root, "evals/writing/phase-2.yaml");
    writeFileSync(evalPath, "", "utf8");
    expect(
      checkPhase2Assets({ mode: "bootstrap", repositoryRoot: root }).errors,
    ).toContain("empty asset: evals/writing/phase-2.yaml");

    writeFileSync(evalPath, "{broken", "utf8");
    expect(
      checkPhase2Assets({
        mode: "bootstrap",
        repositoryRoot: root,
      }).errors.some((error: string) =>
        error.startsWith(
          "invalid safe YAML/JSON at evals/writing/phase-2.yaml:",
        ),
      ),
    ).toBe(true);

    cpSync(resolve(process.cwd(), "evals/writing/phase-2.yaml"), evalPath);
    const evaluation = readJson(evalPath);
    evaluation.unknown = true;
    writeJson(evalPath, evaluation);
    expect(
      checkPhase2Assets({ mode: "bootstrap", repositoryRoot: root }).errors,
    ).toContain("evals/writing/phase-2.yaml has unknown key: unknown");

    delete evaluation.unknown;
    evaluation.requirement_ids = ["AH-UNKNOWN-001"];
    writeJson(evalPath, evaluation);
    expect(
      checkPhase2Assets({
        mode: "bootstrap",
        repositoryRoot: root,
      }).errors.some((error: string) =>
        error.includes("does not exactly match authority links"),
      ),
    ).toBe(true);
  });

  it.each([
    ["tag", "!!js/function >\n  function () { return true }\n"],
    ["anchor", "root: &root {value: 1}\ncopy: *root\n"],
  ])(
    "rejects YAML %s syntax outside the declared JSON subset",
    (_label, source) => {
      const root = createRepositoryCopy();
      const evalPath = resolve(root, "evals/writing/phase-2.yaml");
      writeFileSync(evalPath, source, "utf8");

      expect(
        checkPhase2Assets({
          mode: "bootstrap",
          repositoryRoot: root,
        }).errors.some((error: string) =>
          error.startsWith(
            "invalid safe YAML/JSON at evals/writing/phase-2.yaml:",
          ),
        ),
      ).toBe(true);
    },
  );

  it("rejects duplicate requirement links and incomplete deterministic graders", () => {
    const root = createRepositoryCopy();
    const evalPath = resolve(root, "evals/planning/phase-2.yaml");
    const evaluation = readJson(evalPath);
    const ids = evaluation.requirement_ids as string[];
    evaluation.requirement_ids = [ids[0], ids[0]];
    writeJson(evalPath, evaluation);
    expect(
      checkPhase2Assets({ mode: "bootstrap", repositoryRoot: root }).errors,
    ).toContain(
      "evals/planning/phase-2.yaml has duplicate requirement link: AH-UI-PLANNING-001",
    );

    cpSync(resolve(process.cwd(), "evals/planning/phase-2.yaml"), evalPath);
    const incomplete = readJson(evalPath);
    incomplete.grader = { type: "json_assertions_v1", assertions: [] };
    writeJson(evalPath, incomplete);
    expect(
      checkPhase2Assets({ mode: "bootstrap", repositoryRoot: root }).errors,
    ).toContain(
      "evals/planning/phase-2.yaml grader assertions must be non-empty",
    );
  });

  it("executes deterministic fixture assertions and checks fixture hashes", () => {
    const root = createRepositoryCopy();
    const inputPath = resolve(
      root,
      "fixtures/phase-2/assets/evals/research.json",
    );
    const input = readJson(inputPath);
    input.domain = "tampered";
    writeJson(inputPath, input);
    const errors = checkPhase2Assets({
      mode: "bootstrap",
      repositoryRoot: root,
    }).errors;

    expect(errors).toContain(
      "evals/research/phase-2.yaml input checksum does not match fixtures/phase-2/assets/evals/research.json",
    );
    expect(errors).toContain(
      "evals/research/phase-2.yaml grader assertion failed at $.domain",
    );
  });

  it("requires forbidden effects and evidence fields", () => {
    const root = createRepositoryCopy();
    const evalPath = resolve(root, "evals/multimodal/phase-2.yaml");
    const evaluation = readJson(evalPath);
    evaluation.forbidden_effects = [];
    evaluation.evidence_fields = [];
    writeJson(evalPath, evaluation);
    const errors = checkPhase2Assets({
      mode: "bootstrap",
      repositoryRoot: root,
    }).errors;
    expect(errors).toContain(
      "evals/multimodal/phase-2.yaml forbidden_effects must be non-empty",
    );
    expect(errors).toContain(
      "evals/multimodal/phase-2.yaml evidence_fields must include case_id, requirement_ids, fixture_sha256, grader_results, forbidden_effects, and evidence_path",
    );
  });

  it("rejects empty forbidden effects and kind-specific unknown data keys", () => {
    const root = createRepositoryCopy();
    const evalPath = resolve(root, "evals/writing/phase-2.yaml");
    const evaluation = readJson(evalPath);
    evaluation.forbidden_effects = [""];
    writeJson(evalPath, evaluation);

    const manifestPath = resolve(
      root,
      "data-tests/synthetic/phase-2/manifest.json",
    );
    const manifest = readJson(manifestPath);
    (manifest.dataset as Record<string, unknown>).release_ready = false;
    writeJson(manifestPath, manifest);

    const errors = checkPhase2Assets({
      mode: "bootstrap",
      repositoryRoot: root,
    }).errors;
    expect(errors).toContain(
      "evals/writing/phase-2.yaml forbidden_effects must contain non-empty strings",
    );
    expect(errors).toContain(
      "data-tests/synthetic/phase-2/manifest.json dataset has unknown key: release_ready",
    );
  });

  it.each([
    ["license", ""],
    ["checksum", { algorithm: "sha256", value: "" }],
    ["tenant", ""],
    ["provenance", {}],
  ])("rejects invalid data %s", (field, value) => {
    const root = createRepositoryCopy();
    const manifestPath = resolve(
      root,
      "data-tests/synthetic/phase-2/manifest.json",
    );
    const manifest = readJson(manifestPath);
    (manifest.dataset as Record<string, unknown>)[field] = value;
    writeJson(manifestPath, manifest);
    expect(
      checkPhase2Assets({
        mode: "bootstrap",
        repositoryRoot: root,
      }).errors.some((error: string) => error.includes(`dataset ${field}`)),
    ).toBe(true);
  });

  it("rejects non-executable expected runners", () => {
    const root = createRepositoryCopy();
    const runner = resolve(root, "scripts/gates/check-phase2-assets.mjs");
    chmodSync(runner, 0o644);
    expect(
      checkPhase2Assets({ mode: "bootstrap", repositoryRoot: root }).errors,
    ).toContain(
      "data-tests/synthetic/phase-2/manifest.json expected_runner is not executable: scripts/gates/check-phase2-assets.mjs",
    );
  });

  it.each(["../outside.json", "/tmp/outside.json"])(
    "rejects unsafe asset path %s",
    (unsafePath) => {
      const root = createRepositoryCopy();
      const evalPath = resolve(root, "evals/coding/phase-2.yaml");
      const evaluation = readJson(evalPath);
      (evaluation.input as Record<string, unknown>).path = unsafePath;
      writeJson(evalPath, evaluation);
      expect(
        checkPhase2Assets({
          mode: "bootstrap",
          repositoryRoot: root,
        }).errors.some((error: string) =>
          error.includes("unsafe repository-relative path"),
        ),
      ).toBe(true);
    },
  );

  it("rejects symlinks that escape the repository", () => {
    const root = createRepositoryCopy();
    const outside = resolve(dirname(root), "phase2-assets-outside.json");
    writeFileSync(outside, '{"domain":"coding"}\n', "utf8");
    const inputPath = resolve(
      root,
      "fixtures/phase-2/assets/evals/coding.json",
    );
    rmSync(inputPath);
    symlinkSync(outside, inputPath);
    try {
      expect(
        checkPhase2Assets({ mode: "bootstrap", repositoryRoot: root }).errors,
      ).toContain(
        "evals/coding/phase-2.yaml input escapes repository through symlink: fixtures/phase-2/assets/evals/coding.json",
      );
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it("runs the real CLI in bootstrap and release modes", () => {
    const root = createRepositoryCopy();
    const bootstrap = runChecker(root, "bootstrap");
    expect(bootstrap.status).toBe(0);
    expect(JSON.parse(bootstrap.stdout)).toMatchObject({
      mode: "bootstrap",
      errors: [],
      releaseReady: false,
    });

    const release = runChecker(root, "release");
    expect(release.status).toBe(1);
    expect(JSON.parse(release.stdout).errors).toContain(
      "consented-staging dataset is unavailable; release verification remains blocked",
    );
  });

  it("makes the CLI fail closed for missing, malformed, and tampered assets", () => {
    const root = createRepositoryCopy();
    rmSync(resolve(root, "evals/documents/phase-2.yaml"));
    expect(runChecker(root, "bootstrap").status).toBe(1);

    cpSync(
      resolve(process.cwd(), "evals/documents/phase-2.yaml"),
      resolve(root, "evals/documents/phase-2.yaml"),
    );
    writeFileSync(
      resolve(root, "data-tests/public-benchmarks/phase-2/manifest.json"),
      "{malformed",
      "utf8",
    );
    expect(runChecker(root, "bootstrap").status).toBe(1);

    cpSync(
      resolve(
        process.cwd(),
        "data-tests/public-benchmarks/phase-2/manifest.json",
      ),
      resolve(root, "data-tests/public-benchmarks/phase-2/manifest.json"),
    );
    writeFileSync(
      resolve(root, "fixtures/phase-2/assets/data/public-benchmark.json"),
      '{"tampered":true}\n',
      "utf8",
    );
    expect(runChecker(root, "bootstrap").status).toBe(1);
  });
});
