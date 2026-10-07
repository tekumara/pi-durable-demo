import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { test } from "node:test";
import { fixture, reply, tool } from "./fixtures.ts";

// A small external fixture isolates the final verdict rule: an open GitHub thread
// can be addressed, but uncertainty alone must prevent an all-addressed verdict.
const url = "https://github.com/acme/demo/pull/8";
const sha = "a".repeat(40);
const evidenceUrl = `${url}#discussion_r1`;

function githubEvidence(commentStatus = 201) {
  const comments: string[] = [];
  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    const path = new URL(request.url!, "http://fixture").pathname;
    const json = (value: unknown) => { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(value)); };
    if (request.method === "POST" && path === "/github/repos/acme/demo/issues/8/comments") {
      assert.equal(request.headers["content-type"], "application/json");
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(typeof body.body, "string");
      comments.push(body.body);
      response.statusCode = commentStatus;
      json({ html_url: `${url}#issuecomment-3` });
      return;
    }
    assert.equal(request.method, path === "/github/graphql" ? "POST" : "GET");
    if (path === "/github/graphql") {
      json({ data: { repository: { pullRequest: { reviewThreads: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [{ isResolved: false, isOutdated: false, comments: { nodes: [{ fullDatabaseId: "1" }] } }],
      } } } } });
    } else if (path.endsWith("/pulls/8")) {
      json({ title: "Explain behaviour", body: "", changed_files: 0,
        head: { sha, repo: { full_name: "acme/demo" } }, base: { sha, repo: { full_name: "acme/demo" } } });
    } else if (path.endsWith("/pulls/8/comments")) {
      json([{ id: 1, body: "Why is this intentional?", html_url: evidenceUrl, user: { login: "human" }, created_at: "2026-01-01" },
        { id: 2, in_reply_to_id: 1, body: "This preserves the documented compatibility contract.", html_url: `${url}#discussion_r2`, user: { login: "author" }, created_at: "2026-01-02" }]);
    } else {
      assert.ok(path.endsWith("/issues/8/comments") || path.endsWith("/pulls/8/reviews") || path.endsWith("/pulls/8/files"));
      json([]);
    }
  };
  return { handler, comments };
}

for (const status of ["addressed", "uncertain"] as const) {
  test(`${status} verdict is read-only by default and can be posted independently of an open GitHub thread`, { timeout: 20000 }, async (t) => {
    const github = githubEvidence();
    let calls = 0;
    const f = await fixture(t, (_body, response) => {
      calls++;
      tool(response, "report_review_assessment", { assessments: [{ commentKey: "inline:1", findings: [{
        summary: "Requested explanation", status,
        reason: status === "addressed" ? "The reply explains the intentional behaviour." : "The explanation needs more evidence.",
        evidence: [evidenceUrl],
      }] }] });
    }, { entrypoint: resolve("audit.ts"), github: github.handler });
    const verdict = status === "addressed" ? /Verdict: All actionable findings appear addressed/ : /Verdict: Not all actionable findings are addressed/;
    const output = await f.run("", [url]);
    assert.match(output, verdict);
    assert.match(output, /GitHub: 0\/1 inline threads resolved/);
    assert.equal(github.comments.length, 0, "audits must not post without --comment");

    const posted = status === "addressed"
      ? await f.run("", [url, "local/test", "--comment"])
      : await f.run(`/audit --comment --force ${url}\n/quit\n`, [], { entrypoint: resolve("agent.ts") });
    assert.match(posted, verdict);
    assert.match(posted, /Verdict comment posted/);
    assert.equal(github.comments.length, 1);
    assert.match(github.comments[0], verdict);
    assert.ok(github.comments[0].includes(`Head: ${sha}`));
    assert.match(github.comments[0], status === "addressed" ? /1 addressed · 0 outstanding · 0 uncertain/ : /0 addressed · 0 outstanding · 1 uncertain/);
    assert.match(github.comments[0], /saved snapshot, not proof/);
    if (status === "addressed") {
      assert.match(posted, /Reusing saved assessment/);
      assert.equal(calls, 1, "--comment must not bypass the assessment cache");
    } else {
      assert.doesNotMatch(posted, /Reusing saved assessment/);
      assert.equal(calls, 2, "--comment and --force can be combined in chat");
    }
  });
}

test("an unstructured final answer cannot bypass complete report validation or post a verdict", { timeout: 20000 }, async (t) => {
  const github = githubEvidence();
  const f = await fixture(t, (_body, response) => reply(response, [{ role: "assistant", content: "Everything is addressed." }]), {
    entrypoint: resolve("audit.ts"), github: github.handler,
  });
  const { child, done } = f.start(["--comment", url]);
  child.stdin.end();
  const result = await done;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /without a complete assessment/);
  assert.doesNotMatch(result.stdout, /Verdict:|Everything is addressed/);
  assert.equal(github.comments.length, 0);
});

test("a failed comment request exits nonzero without retrying or losing the completed assessment", { timeout: 20000 }, async (t) => {
  const github = githubEvidence(403);
  let calls = 0;
  const f = await fixture(t, (_body, response) => {
    calls++;
    tool(response, "report_review_assessment", { assessments: [{ commentKey: "inline:1", findings: [{
      summary: "Requested explanation", status: "addressed", reason: "The reply explains the intentional behaviour.", evidence: [evidenceUrl],
    }] }] });
  }, { entrypoint: resolve("audit.ts"), github: github.handler });
  const { child, done } = f.start(["--comment", url]);
  child.stdin.end();
  const result = await done;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /GitHub request failed \(403\)/);
  assert.match(result.stdout, /Verdict: All actionable findings appear addressed/);
  assert.doesNotMatch(result.stdout, /Verdict comment posted/);
  assert.equal(github.comments.length, 1, "posting must not retry an uncertain write");

  const cached = await f.run("", [url]);
  assert.match(cached, /Reusing saved assessment/);
  assert.equal(calls, 1);
  assert.equal(github.comments.length, 1, "posting intent must not persist to invocations without --comment");
});
