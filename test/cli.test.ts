import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);

test("npm link exposes pronto from source outside the checkout", { timeout: 20000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pronto-cli-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const prefix = join(directory, "global");
  const source = resolve(".");
  await exec("npm", ["link", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"], {
    cwd: source,
    env: { ...process.env, npm_config_prefix: prefix, npm_config_cache: join(directory, "cache") },
  });
  assert.equal(await realpath(join(prefix, "lib", "node_modules", "pronto")), await realpath(source),
    "global installation must link to this checkout, not a copied package");
  const { stdout } = await exec(join(prefix, "bin", "pronto"), ["--help"], { cwd: directory });
  assert.match(stdout, /^Usage: pronto /m);
});
