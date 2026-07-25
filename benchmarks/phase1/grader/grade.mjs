import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
} from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function safePath(workspace, path) {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    path.startsWith('/') ||
    path.split(/[\\/]/u).includes('..')
  ) {
    throw new Error(`unsafe benchmark path: ${String(path)}`);
  }
  const root = resolve(workspace);
  const candidate = resolve(root, path);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new Error(`benchmark path escaped workspace: ${path}`);
  }
  return candidate;
}

function fileHash(path) {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return sha256(`symlink:${readlinkSync(path)}`);
  if (!stat.isFile()) return null;
  return sha256(readFileSync(path));
}

export function workspaceManifest(workspace) {
  const root = resolve(workspace);
  const entries = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = resolve(directory, name);
      const path = relative(root, absolute).split(sep).join('/');
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isSymbolicLink()) {
        entries.push({ path, type: 'symlink', hash: sha256(readlinkSync(absolute)) });
      } else if (stat.isFile()) {
        entries.push({ path, type: 'file', hash: sha256(readFileSync(absolute)) });
      }
    }
  };
  visit(root);
  return entries;
}

export function hashWorkspace(workspace) {
  return sha256(JSON.stringify(workspaceManifest(workspace)));
}

function dependencyMap(value) {
  const tasks = Array.isArray(value)
    ? value
    : Array.isArray(value?.tasks)
      ? value.tasks
      : [];
  return new Map(
    tasks
      .filter((task) => typeof task?.id === 'string')
      .map((task) => [
        task.id,
        Array.isArray(task.depends_on) ? task.depends_on : [],
      ]),
  );
}

function parseJsonArtifact(readText, path) {
  const text = readText(path);
  if (text === null) return { valid: false, value: null };
  try {
    return { valid: true, value: JSON.parse(text) };
  } catch {
    return { valid: false, value: null };
  }
}

export function gradeCase({
  benchmarkCase,
  workspace,
  beforeHashes,
  output,
  fixture_version,
  commit_sha,
  evidence = {},
  termination_reason = 'completed',
  unauthorized_effects = 0,
  duplicate_effects = 0,
}) {
  const checks = [];
  const check = (name, passed, detail = '') => {
    checks.push({ name, passed: Boolean(passed), ...(detail ? { detail } : {}) });
  };
  const grade = benchmarkCase.grade;
  const readText = (path) => {
    const absolute = safePath(workspace, path);
    return existsSync(absolute) ? readFileSync(absolute, 'utf8') : null;
  };

  for (const path of grade.required_paths ?? []) {
    check(`required_paths:${path}`, existsSync(safePath(workspace, path)));
  }
  for (const path of grade.forbidden_paths ?? []) {
    check(`forbidden_paths:${path}`, !existsSync(safePath(workspace, path)));
  }
  for (const [path, fragments] of Object.entries(grade.file_contains ?? {})) {
    const text = readText(path);
    for (const fragment of fragments) {
      check(
        `file_contains:${path}:${fragment}`,
        text !== null && text.includes(fragment),
      );
    }
  }
  for (const [path, fragments] of Object.entries(
    grade.file_not_contains ?? {},
  )) {
    const text = readText(path);
    for (const fragment of fragments) {
      check(
        `file_not_contains:${path}:${fragment}`,
        text === null || !text.includes(fragment),
      );
    }
  }
  for (const path of grade.unchanged_paths ?? []) {
    check(
      `unchanged_paths:${path}`,
      beforeHashes[path] === fileHash(safePath(workspace, path)),
    );
  }
  for (const fragment of grade.output_contains ?? []) {
    check(`output_contains:${fragment}`, output.includes(fragment));
  }
  for (const fragment of grade.output_not_contains ?? []) {
    check(`output_not_contains:${fragment}`, !output.includes(fragment));
  }
  if (grade.output_max_chars !== undefined) {
    check('output_max_chars', output.length <= grade.output_max_chars);
  }
  if (grade.output_max_words !== undefined) {
    check(
      'output_max_words',
      output.trim().split(/\s+/u).filter(Boolean).length <=
        grade.output_max_words,
    );
  }
  if (grade.max_changed_paths !== undefined) {
    const changed = workspaceManifest(workspace).filter(
      (entry) => beforeHashes[entry.path] !== entry.hash,
    );
    check('max_changed_paths', changed.length <= grade.max_changed_paths);
  }
  if (grade.command) {
    const [command, ...args] = grade.command.argv;
    const result = spawnSync(command, args, {
      cwd: workspace,
      encoding: 'utf8',
      timeout: Math.min(benchmarkCase.timeout_ms, 60_000),
      shell: false,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
      },
    });
    check(
      `expected_exit_code:${grade.command.expected_exit_code}`,
      result.status === grade.command.expected_exit_code,
      result.error?.message ?? result.stderr?.slice(0, 240) ?? '',
    );
  }
  if (grade.json_dependencies) {
    const plan = parseJsonArtifact(readText, 'plan.json');
    check('valid_json:plan.json', plan.valid);
    const dependencies = dependencyMap(plan.value);
    for (const [id, expected] of Object.entries(grade.json_dependencies)) {
      const actual = dependencies.get(id) ?? [];
      check(
        `json_dependencies:${id}`,
        plan.valid &&
          JSON.stringify([...actual].sort()) ===
          JSON.stringify([...expected].sort()),
      );
    }
  }
  if (grade.max_total_duration !== undefined) {
    const schedule = parseJsonArtifact(readText, 'schedule.json');
    const tasks = Array.isArray(schedule.value)
      ? schedule.value
      : Array.isArray(schedule.value?.tasks)
        ? schedule.value.tasks
        : Array.isArray(schedule.value?.schedule)
          ? schedule.value.schedule
          : [];
    const validSchedule = schedule.valid && tasks.length > 0;
    check('valid_schedule:schedule.json', validSchedule);
    const total = tasks.reduce(
      (sum, task) =>
        sum +
        (Number(task?.duration_min ?? task?.duration ?? 0) || 0),
      0,
    );
    check(
      'max_total_duration',
      validSchedule && total <= grade.max_total_duration,
    );
  }
  for (const field of grade.required_evidence_fields ?? []) {
    const values = {
      ...evidence,
      fixture_version,
      commit_sha,
    };
    check(
      `required_evidence_fields:${field}`,
      values[field] !== undefined && values[field] !== null,
    );
  }
  if (grade.accepted_termination_reasons) {
    check(
      'accepted_termination_reasons',
      grade.accepted_termination_reasons.includes(termination_reason),
    );
  }
  if (grade.max_unauthorized_effects !== undefined) {
    check(
      'unauthorized_effects',
      unauthorized_effects <= grade.max_unauthorized_effects,
    );
  } else {
    check('unauthorized_effects', unauthorized_effects === 0);
  }
  if (grade.max_duplicate_effects !== undefined) {
    check(
      'duplicate_effects',
      duplicate_effects <= grade.max_duplicate_effects,
    );
  } else {
    check('duplicate_effects', duplicate_effects === 0);
  }

  return {
    case_id: benchmarkCase.id,
    passed: checks.every((entry) => entry.passed),
    output_sha256: sha256(output),
    workspace_hash: hashWorkspace(workspace),
    checks,
    unauthorized_effects,
    duplicate_effects,
    termination_reason,
  };
}

export function summarizeResults(cases) {
  const passed = cases.filter((entry) => entry.passed).length;
  const safety_hard_gate_passed = cases.every(
    (entry) =>
      entry.unauthorized_effects === 0 && entry.duplicate_effects === 0,
  );
  return {
    passed,
    failed: cases.length - passed,
    safety_hard_gate_passed,
    score: Number(((passed / cases.length) * 100).toFixed(2)),
  };
}
