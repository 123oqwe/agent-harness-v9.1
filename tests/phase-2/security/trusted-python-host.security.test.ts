import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { launchTestOnlyPythonHost } from "../../../session/trusted-python-host.js";

function fixture(source: string) {
  const directory = mkdtempSync(join(tmpdir(), "trusted-python-host-"));
  const path = join(directory, "host.py");
  writeFileSync(path, source, { mode: 0o600 });
  chmodSync(path, 0o600);
  return {
    directory,
    path,
    sha256: createHash("sha256").update(source).digest("hex"),
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function launch(value: ReturnType<typeof fixture>, timeoutMs = 2_000, maxOutputBytes = 1_024) {
  return launchTestOnlyPythonHost({
    host: pathToFileURL(value.path),
    hostSha256: value.sha256,
    request: { action: "probe" },
    requestKeys: ["action"],
    responseKeys: ["ok", "value"],
    timeoutMs,
    maxOutputBytes,
  });
}

describe("trusted Python host boundary", () => {
  it("rejects a symlink host before execution", () => {
    const value = fixture("import json\nprint(json.dumps({'ok': True, 'value': 1}))\n");
    const link = join(value.directory, "host-link.py");
    symlinkSync(value.path, link);
    try {
      expect(() => launchTestOnlyPythonHost({
        host: pathToFileURL(link),
        hostSha256: value.sha256,
        request: { action: "probe" },
        requestKeys: ["action"],
        responseKeys: ["ok", "value"],
      })).toThrow();
    } finally {
      value.close();
    }
  });

  it.each([
    ["malformed", "print('not-json')\n", /malformed/u],
    ["oversized", "import sys\nsys.stdout.write('x' * 4096)\n", /execution failed|output limit/u],
    ["unsafe integer", "import json\nprint(json.dumps({'ok': True, 'value': 2**60}))\n", /unsafe/u],
  ] as const)("rejects %s output", (_name, source, error) => {
    const value = fixture(source);
    try {
      expect(() => launch(value, 2_000, 128)).toThrow(error);
    } finally {
      value.close();
    }
  });

  it("terminates a hung host at the configured deadline", () => {
    const value = fixture("# replaced below\n");
    const marker = join(value.directory, "descendant-survived");
    const source = [
      "import subprocess, time",
      `code = ${JSON.stringify(`import time\ntime.sleep(1)\nopen(${JSON.stringify(marker)}, 'w').write('survived')\n`)}`,
      "subprocess.Popen(['/usr/bin/python3', '-I', '-B', '-E', '-c', code])",
      "time.sleep(10)",
      "",
    ].join("\n");
    writeFileSync(value.path, source, { mode: 0o600 });
    value.sha256 = createHash("sha256").update(source).digest("hex");
    const started = Date.now();
    try {
      expect(() => launch(value, 250)).toThrow(/timed out|timedout|execution failed/iu);
      expect(Date.now() - started).toBeLessThan(3_000);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_200);
      expect(existsSync(marker)).toBe(false);
    } finally {
      value.close();
    }
  });

  it("executes verified bytes even when the named host is exchanged", () => {
    const value = fixture([
      "import json, os",
      `path = ${JSON.stringify("PLACEHOLDER")}`,
      "os.rename(path, path + '.old')",
      "with open(path, 'w') as replacement: replacement.write(\"print('replacement')\\n\")",
      "print(json.dumps({'ok': True, 'value': 1}))",
      "",
    ].join("\n"));
    const source = [
      "import json, os",
      `path = ${JSON.stringify(value.path)}`,
      "os.rename(path, path + '.old')",
      "with open(path, 'w') as replacement: replacement.write(\"print('replacement')\\n\")",
      "print(json.dumps({'ok': True, 'value': 1}))",
      "",
    ].join("\n");
    writeFileSync(value.path, source, { mode: 0o600 });
    value.sha256 = createHash("sha256").update(source).digest("hex");
    try {
      expect(launch(value)).toEqual({ ok: true, value: 1 });
    } finally {
      value.close();
    }
  });
});
