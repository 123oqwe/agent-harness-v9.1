import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  mkdtempSync,
  mkdirSync,
  openSync,
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

const fileSha256 = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

const runChecker = (root: string, mode: "bootstrap" | "release") =>
  spawnSync(process.execPath, [checkerPath, "--root", root, "--mode", mode], {
    encoding: "utf8",
    shell: false,
    timeout: 30_000,
    maxBuffer: 256 * 1024,
  });

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("Phase 2 executable asset contracts", { timeout: 30_000 }, () => {
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
    expect(result.errors).toContain(
      "data-tests/public-benchmarks/phase-2/manifest.json execution_runner_status is not_implemented; release verification remains blocked",
    );
    expect(result.errors).toContain(
      "data-tests/consented-staging/phase-2/manifest.json execution_runner_status is not_implemented; release verification remains blocked",
    );
  });

  it("declares the data execution runner honestly and binds the contract checker bytes", () => {
    const checksum = fileSha256(checkerPath);
    for (const kind of [
      "synthetic",
      "public-benchmarks",
      "consented-staging",
    ]) {
      const manifest = readJson(
        resolve(`data-tests/${kind}/phase-2/manifest.json`),
      );
      // Synthetic dataset has an implemented runner; external datasets remain not_implemented
      expect(manifest.execution_runner_status).toBe(
        kind === "synthetic" ? "implemented" : "not_implemented",
      );
      expect(
        (manifest.dataset as Record<string, unknown>).contract_checker,
      ).toEqual({
        path: "scripts/gates/check-phase2-assets.mjs",
        sha256: checksum,
        role: "asset-contract-validator",
      });
    }
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

  it.each([
    [
      "authority",
      "verification/gates/phase2-gate.json",
      '"phase": 2',
      '"phase": 99, "phase": 2',
      'duplicate object key "phase"',
    ],
    [
      "eval",
      "evals/writing/phase-2.yaml",
      '"path": "fixtures/phase-2/assets/evals/writing.json"',
      '"path": "../outside.json", "path": "fixtures/phase-2/assets/evals/writing.json"',
      'duplicate object key "path"',
    ],
    [
      "data",
      "data-tests/synthetic/phase-2/manifest.json",
      '"license": "CC0-1.0"',
      '"license": "UNLICENSED", "license": "CC0-1.0"',
      'duplicate object key "license"',
    ],
  ])(
    "rejects malicious-then-legal duplicate JSON keys in %s assets",
    (_kind, relativePath, search, replacement, expected) => {
      const root = createRepositoryCopy();
      const path = resolve(root, relativePath);
      const source = readFileSync(path, "utf8");
      expect(source).toContain(search);
      writeFileSync(path, source.replace(search, replacement), "utf8");

      expect(
        checkPhase2Assets({
          mode: "bootstrap",
          repositoryRoot: root,
        }).errors.some((error: string) => error.includes(expected)),
      ).toBe(true);
    },
  );

  it("enforces JSON asset size and nesting limits before parsing", () => {
    const root = createRepositoryCopy();
    const writingPath = resolve(root, "evals/writing/phase-2.yaml");
    writeFileSync(
      writingPath,
      JSON.stringify({ padding: "x".repeat(1_048_577) }),
      "utf8",
    );
    expect(
      checkPhase2Assets({ mode: "bootstrap", repositoryRoot: root }).errors,
    ).toContain(
      "invalid safe YAML/JSON at evals/writing/phase-2.yaml: asset exceeds 1048576 byte limit",
    );

    const deep = `${'{"nested":'.repeat(65)}null${"}".repeat(65)}`;
    writeFileSync(writingPath, deep, "utf8");
    expect(
      checkPhase2Assets({
        mode: "bootstrap",
        repositoryRoot: root,
      }).errors.some((error: string) =>
        error.includes("JSON nesting exceeds 64"),
      ),
    ).toBe(true);
  });

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

  it("rejects a synchronized authority and eval tamper", () => {
    const root = createRepositoryCopy();
    const authorityPath = resolve(root, "verification/gates/phase2-gate.json");
    const authority = readJson(authorityPath);
    const requirements = authority.requirements as Array<
      Record<string, unknown>
    >;
    const planning = requirements.find(
      (requirement) => requirement.id === "AH-UI-PLANNING-001",
    );
    if (!planning) throw new Error("authority fixture is missing planning");
    (planning.eval_suites as string[]).push("evals/writing/phase-2.yaml");
    writeJson(authorityPath, authority);

    const writingPath = resolve(root, "evals/writing/phase-2.yaml");
    const writing = readJson(writingPath);
    (writing.requirement_ids as string[]).push("AH-UI-PLANNING-001");
    writeJson(writingPath, writing);

    expect(
      checkPhase2Assets({
        mode: "bootstrap",
        repositoryRoot: root,
      }).errors.some((error: string) =>
        error.startsWith(
          "invalid frozen Phase 2 authority: manifest canonical SHA-256 does not match frozen authority",
        ),
      ),
    ).toBe(true);
  });

  it.each([
    [
      "manifest",
      "evals/writing/phase-2.yaml",
      "evals/planning/phase-2.yaml",
      "evals/writing/phase-2.yaml contains forbidden symlink: evals/writing/phase-2.yaml",
    ],
    [
      "input",
      "fixtures/phase-2/assets/evals/writing.json",
      "fixtures/phase-2/assets/evals/planning.json",
      "evals/writing/phase-2.yaml input contains forbidden symlink: fixtures/phase-2/assets/evals/writing.json",
    ],
    [
      "dataset",
      "fixtures/phase-2/assets/data/public-benchmark.json",
      "fixtures/phase-2/assets/data/synthetic.json",
      "data-tests/public-benchmarks/phase-2/manifest.json dataset path contains forbidden symlink: fixtures/phase-2/assets/data/public-benchmark.json",
    ],
    [
      "runner",
      "scripts/gates/check-phase2-assets.mjs",
      "scripts/gates/check-phase2-assets-runner-copy.mjs",
      "data-tests/synthetic/phase-2/manifest.json contract_checker contains forbidden symlink: scripts/gates/check-phase2-assets.mjs",
    ],
  ])(
    "rejects repository-internal %s symlinks",
    (_kind, link, target, message) => {
      const root = createRepositoryCopy();
      const linkPath = resolve(root, link);
      const targetPath = resolve(root, target);
      if (_kind === "runner") cpSync(linkPath, targetPath);
      rmSync(linkPath);
      symlinkSync(targetPath, linkPath);

      expect(
        checkPhase2Assets({ mode: "bootstrap", repositoryRoot: root }).errors,
      ).toContain(message);
    },
  );

  it("rejects a symlink swap injected between path validation and fd open", () => {
    const root = createRepositoryCopy();
    const target = resolve(root, "fixtures/phase-2/assets/evals/writing.json");
    const replacement = resolve(
      root,
      "fixtures/phase-2/assets/evals/planning.json",
    );
    let injected = false;
    const result = checkPhase2Assets({
      mode: "bootstrap",
      repositoryRoot: root,
      fileSystem: {
        openSync(path: string, flags: number) {
          if (path === target && !injected) {
            rmSync(path);
            symlinkSync(replacement, path);
            injected = true;
          }
          return openSync(path, flags);
        },
      },
    });

    expect(injected).toBe(true);
    expect(
      result.errors.some((error: string) =>
        error.startsWith(
          "cannot securely open input fixtures/phase-2/assets/evals/writing.json:",
        ),
      ),
    ).toBe(true);
  });

  it.each([
    ["synthetic", "UNLICENSED", "CC0-1.0"],
    ["public-benchmarks", "MIT", "CC0-1.0"],
    ["consented-staging", "CC0-1.0", "CONSENT-REQUIRED"],
  ])("enforces the %s license contract", (kind, license, expected) => {
    const root = createRepositoryCopy();
    const manifestPath = resolve(
      root,
      `data-tests/${kind}/phase-2/manifest.json`,
    );
    const manifest = readJson(manifestPath);
    (manifest.dataset as Record<string, unknown>).license = license;
    writeJson(manifestPath, manifest);

    expect(
      checkPhase2Assets({ mode: "bootstrap", repositoryRoot: root }).errors,
    ).toContain(
      `data-tests/${kind}/phase-2/manifest.json dataset license must be ${expected}`,
    );
  });

  it("enforces frozen domain effects and exact evidence fields", () => {
    const root = createRepositoryCopy();
    const researchPath = resolve(root, "evals/research/phase-2.yaml");
    const research = readJson(researchPath);
    research.forbidden_effects = [
      "requirement_verified",
      "evidence_pass",
      "external_side_effect",
      "shell_access",
    ];
    research.evidence_fields = [
      "case_id",
      "requirement_ids",
      "fixture_sha256",
      "grader_results",
      "forbidden_effects",
      "evidence_path",
      "evidence_path",
      "unknown",
    ];
    writeJson(researchPath, research);

    const errors = checkPhase2Assets({
      mode: "bootstrap",
      repositoryRoot: root,
    }).errors;
    expect(errors).toContain(
      "evals/research/phase-2.yaml forbidden_effects has unknown value: shell_access",
    );
    expect(errors).toContain(
      "evals/research/phase-2.yaml forbidden_effects is missing required value: network_request",
    );
    expect(errors).toContain(
      "evals/research/phase-2.yaml evidence_fields has duplicate value: evidence_path",
    );
    expect(errors).toContain(
      "evals/research/phase-2.yaml evidence_fields has unknown value: unknown",
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

  it("rejects non-executable contract checkers", () => {
    const root = createRepositoryCopy();
    const runner = resolve(root, "scripts/gates/check-phase2-assets.mjs");
    chmodSync(runner, 0o644);
    expect(
      checkPhase2Assets({ mode: "bootstrap", repositoryRoot: root }).errors,
    ).toContain(
      "data-tests/synthetic/phase-2/manifest.json contract_checker is not executable: scripts/gates/check-phase2-assets.mjs",
    );
  });

  it("requires operating-system X_OK access for the contract checker", () => {
    const root = createRepositoryCopy();
    const result = checkPhase2Assets({
      mode: "bootstrap",
      repositoryRoot: root,
      fileSystem: {
        accessSync(path: string) {
          if (path.endsWith("scripts/gates/check-phase2-assets.mjs")) {
            throw new Error("EACCES");
          }
        },
      },
    });

    expect(result.errors).toContain(
      "data-tests/synthetic/phase-2/manifest.json contract_checker is not executable: scripts/gates/check-phase2-assets.mjs",
    );
  });

  it.each(["path", "sha256", "role"])(
    "rejects a tampered contract checker %s",
    (field) => {
      const root = createRepositoryCopy();
      const manifestPath = resolve(
        root,
        "data-tests/synthetic/phase-2/manifest.json",
      );
      const manifest = readJson(manifestPath);
      const dataset = manifest.dataset as Record<string, unknown>;
      const fakePath = "fixtures/phase-2/assets/data/executable-fake.json";
      const fakeAbsolute = resolve(root, fakePath);
      writeFileSync(fakeAbsolute, '{"not":"a contract checker"}\n', "utf8");
      chmodSync(fakeAbsolute, 0o755);
      const contractChecker = {
        path: "scripts/gates/check-phase2-assets.mjs",
        sha256: fileSha256(
          resolve(root, "scripts/gates/check-phase2-assets.mjs"),
        ),
        role: "asset-contract-validator",
      };
      if (field === "path") {
        contractChecker.path = fakePath;
        contractChecker.sha256 = fileSha256(fakeAbsolute);
      } else if (field === "sha256") contractChecker.sha256 = "0".repeat(64);
      else contractChecker.role = "data-eval-runner";
      dataset.contract_checker = contractChecker;
      manifest.execution_runner_status = "not_implemented";
      writeJson(manifestPath, manifest);

      const errors = checkPhase2Assets({
        mode: "bootstrap",
        repositoryRoot: root,
      }).errors;
      expect(
        errors.some((error: string) =>
          error.includes(`contract_checker ${field}`),
        ),
      ).toBe(true);
    },
  );

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
        "evals/coding/phase-2.yaml input contains forbidden symlink: fixtures/phase-2/assets/evals/coding.json",
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

  it("runs as the CLI through a symlink and rejects duplicate flags", () => {
    const root = createRepositoryCopy();
    const linkedChecker = resolve(root, "phase2-assets-checker-link.mjs");
    symlinkSync(checkerPath, linkedChecker);
    const linkedRelease = spawnSync(
      process.execPath,
      [linkedChecker, "--root", root, "--mode", "release"],
      { encoding: "utf8", shell: false, timeout: 10_000 },
    );
    expect(linkedRelease.status).toBe(1);
    expect(JSON.parse(linkedRelease.stdout)).toMatchObject({
      mode: "release",
      releaseReady: false,
    });

    const duplicateMode = spawnSync(
      process.execPath,
      [checkerPath, "--root", root, "--mode", "release", "--mode", "bootstrap"],
      { encoding: "utf8", shell: false, timeout: 10_000 },
    );
    expect(duplicateMode.status).toBe(1);
    expect(JSON.parse(duplicateMode.stdout).errors).toContain(
      "duplicate argument: --mode",
    );

    const duplicateRoot = spawnSync(
      process.execPath,
      [checkerPath, "--root", root, "--root", root, "--mode", "release"],
      { encoding: "utf8", shell: false, timeout: 10_000 },
    );
    expect(duplicateRoot.status).toBe(1);
    expect(JSON.parse(duplicateRoot.stdout).errors).toContain(
      "duplicate argument: --root",
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
