import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";

type Request = { messages: { role: string; content?: string; tool_calls?: unknown[] }[]; tools: { function: { name: string } }[] };
const entrypoint = resolve("agent.ts");

// Only the LLM endpoint is simulated. The CLI, Pi auth, tools, and SQLite are real.
async function fixture(t: TestContext, respond: (body: Request, response: ServerResponse) => void) {
  const directory = await mkdtemp(join(tmpdir(), "pi-durable-test-"));
  const agentDir = join(directory, "pi");
  const cwd = join(directory, "project");
  await mkdir(agentDir);
  await mkdir(cwd);
  const errors: unknown[] = [];
  const children: ChildProcessWithoutNullStreams[] = [];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer test-key");
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      respond(JSON.parse(Buffer.concat(chunks).toString()), response);
    } catch (error) {
      errors.push(error);
      response.writeHead(500).end("Fixture failed");
    }
  });
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "close");
        child.kill("SIGKILL");
        await exited;
      }
    }
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({ local: { type: "api_key", key: "test-key" } }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "local", defaultModel: "test" }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { local: {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    api: "openai-completions",
    models: [{ id: "test", contextWindow: 128000, maxTokens: 1000 }],
  } } }));

  const start = () => {
    const child = spawn(process.execPath, ["--experimental-strip-types", entrypoint], {
      cwd,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
    });
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    const done = once(child, "close").then(([code, signal]) => ({ code, signal, stdout, stderr }));
    return { child, done };
  };
  const run = async (input: string) => {
    const { child, done } = start();
    child.stdin.end(input);
    const result = await done;
    assert.equal(result.code, 0, result.stderr);
    return result.stdout;
  };
  return { cwd, agentDir, start, run };
}

function reply(response: ServerResponse, deltas: object[], finish = "stop") {
  if (!response.headersSent) response.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const delta of deltas) {
    response.write(`data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  }
  response.end(`data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`);
}

function tool(response: ServerResponse, name: string, args: object) {
  reply(response, [{ role: "assistant", tool_calls: [{ index: 0, id: `call-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }], "tool_calls");
}

test("terminal chat uses saved Pi credentials, coding tools, and persisted history", { timeout: 20000 }, async (t) => {
  let turn = 0;
  const partial = Promise.withResolvers<ServerResponse>();
  const f = await fixture(t, (body, response) => {
    const latest = body.messages.at(-1);
    switch (turn++) {
      case 0:
        assert.deepEqual(body.tools.map((tool) => tool.function.name).sort(), ["bash", "edit", "read", "write"]);
        assert.equal(latest?.content, "make a greeting");
        tool(response, "read", { path: "seed.txt" });
        break;
      case 1:
        assert.match(latest?.content ?? "", /hello/);
        tool(response, "write", { path: "greeting.txt", content: "hello\n" });
        break;
      case 2:
        tool(response, "edit", { path: "greeting.txt", edits: [{ oldText: "hello", newText: "hello world" }] });
        break;
      case 3:
        tool(response, "bash", { command: "cat greeting.txt" });
        break;
      case 4:
        assert.match(latest?.content ?? "", /hello world/);
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ id: "reply", choices: [{ index: 0, delta: { role: "assistant", content: "Greeting " }, finish_reason: null }] })}\n\n`);
        partial.resolve(response);
        break;
      case 5:
        assert.equal(latest?.content, "what did you do?");
        assert.ok(body.messages.some((message) => message.role === "user" && message.content === "make a greeting"));
        assert.ok(body.messages.some((message) => message.role === "assistant" && message.content === "Greeting ready."));
        reply(response, [{ role: "assistant", content: "I made greeting.txt." }]);
        break;
      default:
        assert.fail("Unexpected model request");
    }
  });
  await writeFile(join(f.cwd, "seed.txt"), "hello\n");
  const first = f.start();
  const streamed = new Promise<void>((done) => {
    let output = "";
    const onData = (data: Buffer) => {
      output += data;
      if (output.includes("Greeting ")) {
        first.child.stdout.off("data", onData);
        done();
      }
    };
    first.child.stdout.on("data", onData);
  });
  first.child.stdin.end("make a greeting\n/quit\n");
  const response = await partial.promise;
  await streamed; // The first text must reach the terminal before the response ends.
  reply(response, [{ content: "ready." }]);
  const result = await first.done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(join(f.cwd, "greeting.txt"), "utf8"), "hello world\n");
  assert.equal(result.stdout.split("Greeting ready.").length - 1, 1, "streamed answer must appear exactly once");
  assert.ok(result.stdout.includes("[bash] cat greeting.txt"));
  // A changed Pi default must not replace or prevent using the saved model.
  await writeFile(join(f.agentDir, "settings.json"), JSON.stringify({ defaultProvider: "missing", defaultModel: "missing" }));
  const second = await f.run("what did you do?\n/quit\n");
  assert.ok(second.includes("I made greeting.txt."));
  assert.equal(turn, 6);
});

for (const signal of ["SIGKILL", "SIGTERM"] as const) {
  test(`restart resumes an unfinished turn after ${signal} without resubmitting the input`, { timeout: 20000 }, async (t) => {
    let requests = 0;
    const started = Promise.withResolvers<void>();
    const f = await fixture(t, (body, response) => {
      assert.equal(body.messages.filter((message) => message.role === "user" && message.content === "keep working").length, 1);
      if (++requests === 1) {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ id: "partial", choices: [{ index: 0, delta: { role: "assistant", content: "Starting" }, finish_reason: null }] })}\n\n`);
        started.resolve();
        // Leave the request unfinished until the agent process stops.
      } else {
        reply(response, [{ role: "assistant", content: "Recovered and finished." }]);
      }
    });
    const first = f.start();
    first.child.stdin.write("keep working\n");
    await started.promise;
    first.child.kill(signal);
    const stopped = await first.done;
    if (signal === "SIGTERM") assert.equal(stopped.code, 0, stopped.stderr);
    const output = await f.run("/quit\n");
    assert.ok(output.includes("Recovered and finished."));
    assert.equal(requests, 2);
  });
}
