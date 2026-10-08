import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, realpath, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry } from "@earendil-works/pi-durable";
import { openStateHarness } from "../state.ts";
import { fixture, reply } from "./fixtures.ts";

for (const location of ["override", "xdg", "home", "relative-xdg"] as const) {
  test(`chat stores private user state using ${location} path selection`, { timeout: 20_000 }, async (t) => {
    const f = await fixture(t, () => assert.fail("Opening an idle chat must not call the model"));
    const home = join(f.directory, "home");
    const xdg = join(f.directory, "xdg-state");
    const env = { HOME: home, PRONTO_STATE_DIR: location === "override" ? f.stateDir : "",
      XDG_STATE_HOME: location === "relative-xdg" ? "relative-state" : location === "home" ? "" : xdg };
    await f.run("/quit\n", [], { env });
    const root = location === "override" ? f.stateDir : location === "xdg" ? join(xdg, "pronto")
      : join(home, ".local", "state", "pronto");
    // The documented path is a storage contract, independent of the production path resolver.
    const key = createHash("sha256").update(await realpath(f.cwd)).digest("hex").slice(0, 20);
    const database = join(root, "chats", `${key}.sqlite`);
    assert.ok((await stat(database)).size > 0);
    assert.equal((await stat(database)).mode & 0o777, 0o600);
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    assert.equal((await stat(join(root, "chats"))).mode & 0o777, 0o700);
    await assert.rejects(readdir(join(f.cwd, ".pi-durable")), { code: "ENOENT" });
    if (location !== "override") await assert.rejects(readdir(f.stateDir), { code: "ENOENT" });
    if (location !== "xdg") await assert.rejects(readdir(xdg), { code: "ENOENT" });
  });
}

test("a relative PRONTO_STATE_DIR is rejected instead of creating directory-local state", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, () => assert.fail("Invalid storage configuration must not reach the model"));
  const { child, done } = f.start([], { env: { PRONTO_STATE_DIR: "relative-state" } });
  child.stdin.end("/quit\n");
  const result = await done;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /PRONTO_STATE_DIR must be an absolute path/);
  await assert.rejects(readdir(join(f.cwd, "relative-state")), { code: "ENOENT" });
  await assert.rejects(readdir(f.stateDir), { code: "ENOENT" });
});

test("failed harness initialisation releases ownership without needing a process restart", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, () => assert.fail("Storage initialisation must not call the model"));
  const previous = process.env.PRONTO_STATE_DIR;
  process.env.PRONTO_STATE_DIR = f.stateDir;
  try {
    const target = { kind: "chat", cwd: f.cwd } as const;
    const options = { models: createModels(), registry: createRegistry() };
    const cancelled = new AbortController();
    cancelled.abort(new Error("Cancelled startup"));
    await assert.rejects(openStateHarness(target, options, withAbortSignal(cancelled.signal, BACKGROUND_CONTEXT)), /Cancelled startup/);
    const harness = await openStateHarness(target, options, BACKGROUND_CONTEXT);
    await harness.close(BACKGROUND_CONTEXT);
  } finally {
    if (previous === undefined) delete process.env.PRONTO_STATE_DIR;
    else process.env.PRONTO_STATE_DIR = previous;
  }
});

test("chat history is separate per working directory but shared through a symlink alias", { timeout: 20_000 }, async (t) => {
  let calls = 0;
  const f = await fixture(t, (body, response) => {
    const prompts = body.messages.filter((message) => message.role === "user").map((message) => message.content);
    switch (++calls) {
      case 1:
        assert.deepEqual(prompts, ["remember project one"]);
        break;
      case 2:
        assert.deepEqual(prompts, ["remember project two"]);
        break;
      case 3:
        assert.deepEqual(prompts, ["remember project one", "recall"]);
        break;
      default: assert.fail("Unexpected model call");
    }
    reply(response, [{ role: "assistant", content: "Remembered." }]);
  });
  const otherCwd = join(f.directory, "other-worktree");
  const alias = join(f.directory, "project-alias");
  await mkdir(otherCwd);
  await symlink(f.cwd, alias, "dir");
  await f.run("remember project one\n/quit\n");
  await f.run("remember project two\n/quit\n", [], { cwd: otherCwd });
  await f.run("recall\n/quit\n", [], { cwd: alias });
  assert.equal(calls, 3);
  assert.equal((await readdir(join(f.stateDir, "chats"))).filter((file) => file.endsWith(".sqlite")).length, 2);
});
