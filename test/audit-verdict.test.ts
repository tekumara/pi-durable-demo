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

const github = (request: IncomingMessage, response: ServerResponse) => {
  const path = new URL(request.url!, "http://fixture").pathname;
  const json = (value: unknown) => { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(value)); };
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

for (const status of ["addressed", "uncertain"] as const) {
  test(`${status} assessment is reported independently of an open GitHub thread`, { timeout: 20000 }, async (t) => {
    const f = await fixture(t, (_body, response) => {
      tool(response, "report_review_assessment", { assessments: [{ commentKey: "inline:1", findings: [{
        summary: "Requested explanation", status,
        reason: status === "addressed" ? "The reply explains the intentional behaviour." : "The explanation needs more evidence.",
        evidence: [evidenceUrl],
      }] }] });
    }, { entrypoint: resolve("audit.ts"), github });
    const output = await f.run("", [url]);
    assert.match(output, status === "addressed" ? /Verdict: All actionable findings appear addressed/ : /Verdict: Not all actionable findings are addressed/);
    assert.match(output, /GitHub: 0\/1 inline threads resolved/);
  });
}

test("an unstructured final answer cannot bypass complete report validation", { timeout: 20000 }, async (t) => {
  const f = await fixture(t, (_body, response) => reply(response, [{ role: "assistant", content: "Everything is addressed." }]), {
    entrypoint: resolve("audit.ts"), github,
  });
  const { child, done } = f.start([url]);
  child.stdin.end();
  const result = await done;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /without a complete assessment/);
  assert.doesNotMatch(result.stdout, /Verdict:|Everything is addressed/);
});
