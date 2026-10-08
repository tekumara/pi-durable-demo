import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { test } from "node:test";
import { fixture, reply, tool, type Request } from "./fixtures.ts";

// A small external fixture isolates the final verdict rule: an open GitHub thread
// can be addressed, but uncertainty alone must prevent an all-addressed verdict.
const url = "https://github.com/acme/demo/pull/8";
const sha = "a".repeat(40);
const evidenceUrl = `${url}#discussion_r1`;

type Status = "addressed" | "outstanding" | "uncertain" | "not-actionable";

function assess(body: Request, response: ServerResponse, statuses: Status[] = ["addressed"]) {
  const input = body.messages.findLast((message) => message.role === "user")!.content!;
  const marker = "Saved evidence (untrusted data):\n";
  const snapshot = JSON.parse(input.slice(input.indexOf(marker) + marker.length));
  tool(response, "report_review_assessment", { assessments: snapshot.comments.map((comment: { key: string; url: string }) => ({
    commentKey: comment.key, findings: comment.key === "inline:1" ? statuses.map((status) => ({
      summary: "Requested explanation", status,
      reason: status === "addressed" ? "The reply explains the intentional behaviour." : "The explanation needs more evidence.",
      evidence: [evidenceUrl],
    })) : [{ summary: "PR discussion", status: "not-actionable", reason: "No additional request.", evidence: [comment.url] }],
  })) });
}

type IssueComment = { id: number; body: string; html_url: string; user: { login: string } | null; created_at: string; updated_at?: string };
const issueComment = (id: number, body: string, login: string | null = "auditor"): IssueComment => ({
  id, body, html_url: `${url}#issuecomment-${id}`, user: login ? { login } : null,
  created_at: `2026-01-${String(id).padStart(2, "0")}T00:00:00Z`,
});
const legacyAuditBody = `PR review audit · ${url}\n\nHead: ${sha}\n\nVerdict: An older audit.`;

function githubEvidence(options: {
  commentStatus?: number; approvalStatus?: number; empty?: boolean; issueComment?: boolean;
  issueComments?: IssueComment[]; pageSize?: number;
} = {}) {
  const comments: string[] = [];
  const updates: number[] = [];
  const issueComments = options.issueComments ?? (options.issueComment ? [issueComment(3, "Which roles should have access?", "human")] : []);
  const approvals: { body: string; event: string; commit_id: string }[] = [];
  const state = { headSha: sha, baseSha: sha };
  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    const requestUrl = new URL(request.url!, "http://fixture");
    const path = requestUrl.pathname;
    const json = (value: unknown) => { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(value)); };
    const update = request.method === "PATCH" && path.match(/^\/github\/repos\/acme\/demo\/issues\/comments\/(\d+)$/);
    if (update || (request.method === "POST" && path === "/github/repos/acme/demo/issues/8/comments")) {
      assert.equal(request.headers["content-type"], "application/json");
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(typeof body.body, "string");
      comments.push(body.body);
      const id = update ? Number(update[1]) : Math.max(2, ...issueComments.map((comment) => comment.id)) + 1;
      if (update) updates.push(id);
      response.statusCode = options.commentStatus ?? (update ? 200 : 201);
      if (response.statusCode < 300) {
        if (update) {
          const existing = issueComments.find((comment) => comment.id === id);
          assert.ok(existing, "PATCH must target an existing comment");
          existing.body = body.body;
          existing.updated_at = new Date().toISOString();
        } else issueComments.push({ ...issueComment(id, body.body), created_at: new Date().toISOString() });
      }
      json({ html_url: `${url}#issuecomment-${id}` });
      return;
    }
    if (request.method === "POST" && path === "/github/repos/acme/demo/pulls/8/reviews") {
      assert.equal(request.headers["content-type"], "application/json");
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      approvals.push(body);
      response.statusCode = options.approvalStatus ?? 200;
      json({ state: "APPROVED", commit_id: body.commit_id });
      return;
    }
    assert.equal(request.method, path === "/github/graphql" ? "POST" : "GET");
    if (path === "/github/user") {
      json({ login: "auditor" });
    } else if (path === "/github/graphql") {
      json({ data: { repository: { pullRequest: { reviewThreads: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: options.empty ? [] : [{ isResolved: false, isOutdated: false, comments: { nodes: [{ fullDatabaseId: "1" }] } }],
      } } } } });
    } else if (path.endsWith("/pulls/8")) {
      json({ title: "Explain behaviour", body: "", changed_files: 0,
        head: { sha: state.headSha, repo: { full_name: "acme/demo" } }, base: { sha: state.baseSha, repo: { full_name: "acme/demo" } } });
    } else if (path.endsWith("/pulls/8/comments")) {
      json(options.empty ? [] : [{ id: 1, body: "Why is this intentional?", html_url: evidenceUrl, user: { login: "human" }, created_at: "2026-01-01" },
        { id: 2, in_reply_to_id: 1, body: "This preserves the documented compatibility contract.", html_url: `${url}#discussion_r2`, user: { login: "author" }, created_at: "2026-01-02" }]);
    } else if (path.endsWith("/issues/8/comments")) {
      const page = Number(requestUrl.searchParams.get("page") ?? 1);
      const size = options.pageSize ?? 100;
      if (page * size < issueComments.length) response.setHeader("Link",
        `<http://${request.headers.host}${path}?page=${page + 1}>; rel="next"`);
      json(issueComments.slice((page - 1) * size, page * size));
    } else {
      assert.ok(path.endsWith("/pulls/8/reviews") || path.endsWith("/pulls/8/files"));
      json([]);
    }
  };
  return { handler, comments, updates, issueComments, approvals, state };
}

for (const status of ["addressed", "uncertain"] as const) {
  test(`${status} verdict is read-only by default and gates opt-in approval independently of an open GitHub thread`, { timeout: 20000 }, async (t) => {
    const github = githubEvidence();
    let calls = 0;
    const f = await fixture(t, (body, response) => {
      calls++;
      assess(body, response, [status]);
    }, { entrypoint: resolve("audit.ts"), github: github.handler });
    const verdict = status === "addressed" ? /Verdict: All actionable findings appear addressed/ : /Verdict: Not all actionable findings are addressed/;
    const output = await f.run("", [url]);
    assert.match(output, verdict);
    assert.match(output, /GitHub: 0\/1 inline threads resolved/);
    assert.equal(github.comments.length, 0, "audits must not post without --comment");
    assert.equal(github.approvals.length, 0, "audits must not approve without --approve");

    if (status === "addressed") {
      const firstPost = await f.run("", [url, "--comment", "--apply"]);
      assert.match(firstPost, /Reusing saved assessment/);
      assert.equal(calls, 1, "output flags must not bypass the assessment cache");
      assert.equal(github.comments.length, 1);
      assert.equal(github.approvals.length, 0, "--comment must not imply --approve");
    }
    const posted = status === "addressed"
      ? await f.run("", [url, "local/test", "--comment", "--approve", "--apply"])
      : await f.run(`/audit --approve --comment --force --apply ${url}\n/quit\n`, [], { entrypoint: resolve("agent.ts") });
    assert.match(posted, verdict);
    assert.match(posted, status === "addressed" ? /Verdict comment updated/ : /Verdict comment posted/);
    assert.equal(github.comments.length, status === "addressed" ? 2 : 1);
    assert.match(github.comments[0], verdict);
    assert.ok(github.comments[0].includes(`Head: ${sha}`));
    assert.match(github.comments[0], status === "addressed" ? /1 addressed · 0 outstanding · 0 uncertain/ : /0 addressed · 0 outstanding · 1 uncertain/);
    assert.match(github.comments[0], /saved snapshot, not proof/);
    if (status === "addressed") {
      assert.equal(github.issueComments.length, 1, "repeated posting must update rather than append");
      assert.deepEqual(github.updates, [github.issueComments[0].id]);
      assert.equal(calls, 2, "a posted comment changes the evidence and invalidates the cache");
      assert.equal(github.approvals.length, 1);
      assert.equal(github.approvals[0].event, "APPROVE");
      assert.equal(github.approvals[0].commit_id, sha);
      assert.match(github.approvals[0].body, verdict);
      assert.doesNotMatch(github.comments[0], /Outstanding or uncertain findings|The reply explains the intentional behaviour/);
      assert.match(posted, /PR approved/);
    } else {
      assert.doesNotMatch(posted, /Reusing saved assessment/);
      assert.equal(calls, 2, "--approve, --comment and --force can be combined in chat");
      assert.equal(github.approvals.length, 0);
      assert.match(posted, /Approval skipped/);
    }
  });
}

test("sticky comments replace the latest own audit across pages, preview updates and allow opting out in CLI and chat", { timeout: 20000 }, async (t) => {
  const marker = "<!-- pi-durable-demo:review-audit -->";
  const seeds = [
    { ...issueComment(10, legacyAuditBody), updated_at: "2026-06-01T00:00:00Z" },
    issueComment(11, legacyAuditBody),
    issueComment(12, "An unrelated comment from the same account."),
    issueComment(13, `Someone else's report\n\n${marker}`, "another-auditor"),
    issueComment(14, marker, null),
  ];
  const original = structuredClone(seeds);
  const github = githubEvidence({ issueComments: seeds, pageSize: 2 });
  let status: Status = "uncertain";
  const f = await fixture(t, (body, response) => assess(body, response, [status]), {
    entrypoint: resolve("audit.ts"), github: github.handler,
  });

  const preview = await f.run("", [url, "--comment"]);
  assert.match(preview, /Comment would be updated/);
  assert.equal(github.comments.length, 0);
  assert.deepEqual(github.issueComments, original, "dry-run must not change existing comments");

  const updated = await f.run("", ["--comment", "--apply", url]);
  assert.match(updated, /Verdict comment updated/);
  assert.deepEqual(github.updates, [11], "choose the latest created audit, not the latest edited or unrelated comment");
  assert.equal(github.issueComments.length, 5);
  assert.match(github.issueComments[1].body, /Verdict: Not all actionable findings are addressed/);
  assert.ok(github.issueComments[1].body.endsWith(marker));
  assert.ok(preview.includes(github.issueComments[1].body), "preview must match the replacement body");
  assert.deepEqual(github.issueComments.filter((comment) => comment.id !== 11), original.filter((comment) => comment.id !== 11));

  await f.run("", ["--sticky=false", "--comment", "--apply", url, "local/test"]);
  assert.equal(github.issueComments.length, 6);
  assert.deepEqual(github.updates, [11], "disabling sticky must append even when a matching comment exists");
  await f.run(`/audit ${url} --comment --sticky false --apply\n/quit\n`, [], { entrypoint: resolve("agent.ts") });
  assert.equal(github.issueComments.length, 7, "chat must also support opting out");
  const latest = github.issueComments.at(-1)!;
  latest.body = `An edited audit heading\n\n${marker}`;
  const previousBody = latest.body;

  status = "addressed";
  const replaced = await f.run(`/audit --sticky=true --comment --force --apply ${url}\n/quit\n`, [], { entrypoint: resolve("agent.ts") });
  assert.match(replaced, /Verdict comment updated/);
  assert.deepEqual(github.updates, [11, latest.id]);
  assert.equal(github.issueComments.length, 7);
  assert.notEqual(latest.body, previousBody, "sticky must replace the body, not just find the comment");
  assert.match(latest.body, /Verdict: All actionable findings appear addressed/);
  assert.doesNotMatch(latest.body, /Outstanding or uncertain findings/);

  await f.run("", ["--sticky", "--comment", "--apply", url]);
  assert.deepEqual(github.updates, [11, latest.id, latest.id]);
  assert.equal(github.issueComments.length, 7);
});

test("verdict comments explain every outstanding or uncertain finding with its source and evidence, omitting other finding details", { timeout: 20000 }, async (t) => {
  const github = githubEvidence({ issueComment: true });
  const issueUrl = `${url}#issuecomment-3`;
  const f = await fixture(t, (_body, response) => {
    tool(response, "report_review_assessment", { assessments: [
      { commentKey: "inline:1", findings: [
        { summary: "Missing access check", status: "outstanding",
          reason: "The current code still grants access without checking roles.\u001b", evidence: [evidenceUrl, `${url}#discussion_r2`] },
        { summary: "Null guard", status: "addressed", reason: "The null guard is already fixed.", evidence: [evidenceUrl] },
        { summary: "Duplicate request", status: "not-actionable", reason: "This repeats the access check finding.", evidence: [evidenceUrl] },
      ] },
      { commentKey: "comment:3", findings: [
        { summary: "Undefined access policy", status: "uncertain",
          reason: "The discussion does not specify which roles should have access.", evidence: [issueUrl] },
        { summary: "Missing policy documentation", status: "outstanding",
          reason: "The requested policy documentation is still absent.", evidence: [issueUrl] },
      ] },
    ] });
  }, { entrypoint: resolve("audit.ts"), github: github.handler });
  await f.run("", ["--comment", "--apply", url]);
  assert.equal(github.comments.length, 1);
  const body = github.comments[0];
  assert.match(body, /1 addressed · 2 outstanding · 1 uncertain · 1 not-actionable/);
  assert.match(body, /outstanding: Missing access check\n\nThe current code still grants access without checking roles\.\n\nReview comment: https:\/\/github\.com\/acme\/demo\/pull\/8#discussion_r1/);
  assert.ok(body.includes(`${url}#discussion_r2`), "all evidence links must be included, not just the original comment");
  assert.match(body, /uncertain: Undefined access policy\n\nThe discussion does not specify which roles should have access\.\n\nReview comment: https:\/\/github\.com\/acme\/demo\/pull\/8#issuecomment-3/);
  assert.match(body, /outstanding: Missing policy documentation\n\nThe requested policy documentation is still absent/);
  assert.doesNotMatch(body, /Null guard|already fixed|Duplicate request|repeats the access check|\u001b/);
});

test("an unstructured final answer cannot bypass complete report validation, post a verdict or approve", { timeout: 20000 }, async (t) => {
  const github = githubEvidence();
  const f = await fixture(t, (_body, response) => reply(response, [{ role: "assistant", content: "Everything is addressed." }]), {
    entrypoint: resolve("audit.ts"), github: github.handler,
  });
  const { child, done } = f.start(["--comment", "--approve", "--apply", url]);
  child.stdin.end();
  const result = await done;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /without a complete assessment/);
  assert.doesNotMatch(result.stdout, /Verdict:|Everything is addressed/);
  assert.equal(github.comments.length, 0);
  assert.equal(github.approvals.length, 0);
});

for (const action of ["comment", "update", "approve"] as const) {
  test(`a failed ${action} request exits nonzero without retrying or losing the completed assessment`, { timeout: 20000 }, async (t) => {
    const github = githubEvidence({ commentStatus: 403, approvalStatus: 403,
      issueComments: action === "update" ? [issueComment(10, legacyAuditBody)] : [] });
    let calls = 0;
    const f = await fixture(t, (body, response) => {
      calls++;
      assess(body, response);
    }, { entrypoint: resolve("audit.ts"), github: github.handler });
    const { child, done } = f.start([action === "update" ? "--comment" : `--${action}`, "--apply", url]);
    child.stdin.end();
    const result = await done;
    assert.equal(result.code, 1);
    assert.match(result.stderr, /GitHub request failed \(403\)/);
    assert.match(result.stdout, /Verdict: All actionable findings appear addressed/);
    assert.doesNotMatch(result.stdout, /Verdict comment (?:posted|updated)|PR approved/);
    assert.equal(github.comments.length, action === "approve" ? 0 : 1);
    assert.deepEqual(github.updates, action === "update" ? [10] : []);
    assert.equal(github.approvals.length, action === "approve" ? 1 : 0, "writes must not retry");

    const cached = await f.run("", [url]);
    assert.match(cached, /Reusing saved assessment/);
    assert.equal(calls, 1);
    assert.equal(github.comments.length, action === "approve" ? 0 : 1);
    assert.deepEqual(github.updates, action === "update" ? [10] : []);
    assert.equal(github.approvals.length, action === "approve" ? 1 : 0, "approval intent must not persist");
  });
}

for (const { statuses, approve, chat } of [
  { statuses: ["addressed", "not-actionable"], approve: true, chat: true },
  { statuses: ["addressed", "outstanding"], approve: false, chat: false },
  { statuses: ["addressed", "uncertain"], approve: false, chat: false },
  { statuses: ["not-actionable"], approve: false, chat: false },
  { statuses: [], approve: false, chat: false },
] satisfies { statuses: Status[]; approve: boolean; chat: boolean }[]) {
  test(`--approve --apply ${approve ? "approves" : "skips"} ${statuses.join(" + ") || "an empty audit"} without posting a comment`, { timeout: 20000 }, async (t) => {
    const github = githubEvidence({ empty: !statuses.length });
    const f = await fixture(t, (body, response) => assess(body, response, statuses), { entrypoint: resolve("audit.ts"), github: github.handler });
    const output = chat
      ? await f.run(`/audit --approve --apply ${url}\n/quit\n`, [], { entrypoint: resolve("agent.ts") })
      : await f.run("", ["--approve", "--apply", url]);
    assert.equal(github.comments.length, 0, "--approve must not imply --comment");
    assert.equal(github.approvals.length, approve ? 1 : 0);
    assert.match(output, approve ? /PR approved/ : /Approval skipped/);
    if (approve) {
      assert.equal(github.approvals[0].event, "APPROVE");
      assert.equal(github.approvals[0].commit_id, sha);
      assert.match(github.approvals[0].body, /Verdict: All actionable findings appear addressed/);
    }
  });
}

for (const { flags, status, approve, chat } of [
  { flags: ["--comment"], status: "addressed", approve: false, chat: false },
  { flags: ["--approve"], status: "addressed", approve: true, chat: true },
  { flags: ["--comment", "--approve"], status: "uncertain", approve: false, chat: false },
  { flags: ["--comment", "--approve"], status: "addressed", approve: true, chat: false },
  { flags: [], status: "addressed", approve: false, chat: false },
] satisfies { flags: string[]; status: Status; approve: boolean; chat: boolean }[]) {
  test(`default dry-run previews ${flags.join(" ") || "no mutation flags"} (${status}) and requires --apply on every invocation`, { timeout: 20000 }, async (t) => {
    const github = githubEvidence();
    let calls = 0;
    const f = await fixture(t, (body, response) => {
      calls++;
      assess(body, response, [status]);
    }, { entrypoint: resolve("audit.ts"), github: github.handler });
    const run = () => chat
      ? f.run(`/audit ${flags.join(" ")} ${url}\n/quit\n`, [], { entrypoint: resolve("agent.ts") })
      : f.run("", [...flags, url, "local/test"]);
    const output = await run();
    const preview = output.match(/\[audit:dry-run\] Verdict comment preview:\n\n([\s\S]*?)\n\n\[audit:dry-run\] Comment would/);
    assert.ok(preview, "dry-run must show the exact proposed comment body");
    assert.ok(preview[1].includes(`Head: ${sha}`));
    assert.match(preview[1], status === "addressed" ? /Verdict: All actionable findings appear addressed/ : /Verdict: Not all actionable findings are addressed/);
    assert.match(output, flags.includes("--comment") ? /Comment would be posted/ : /Comment would not be posted/);
    if (flags.includes("--approve")) {
      assert.match(output, approve ? /PR would be approved/ : /Approval would be skipped/);
    } else assert.doesNotMatch(output, /PR would be approved/);
    assert.doesNotMatch(output, /Verdict comment posted|\[audit\] PR approved/);
    assert.equal(github.comments.length, 0);
    assert.equal(github.approvals.length, 0);

    const cached = await run();
    assert.match(cached, /Reusing saved assessment/);
    assert.equal(calls, 1, "dry-run must use and publish the normal assessment cache");
    assert.equal(github.comments.length, 0);
    assert.equal(github.approvals.length, 0, "cached dry-runs must not submit reviews either");

    const applied = chat
      ? await f.run(`/audit --apply ${flags.join(" ")} ${url}\n/quit\n`, [], { entrypoint: resolve("agent.ts") })
      : await f.run("", [...flags, url, "--apply"]);
    assert.doesNotMatch(applied, /\[audit:dry-run\]/);
    assert.equal(github.comments.length, flags.includes("--comment") ? 1 : 0);
    assert.equal(github.approvals.length, approve ? 1 : 0);
    if (flags.includes("--comment")) assert.equal(github.comments[0], preview[1]);
    if (approve) assert.equal(github.approvals[0].body, preview[1]);
    assert.equal(calls, 1);

    await run();
    assert.equal(github.comments.length, flags.includes("--comment") ? 1 : 0);
    assert.equal(github.approvals.length, approve ? 1 : 0, "--apply must not persist to later cached or fresh audits");
  });
}

for (const revision of ["headSha", "baseSha"] as const) {
  for (const apply of [false, true]) {
    test(`--approve${apply ? " --apply" : ""} refuses an otherwise good verdict when ${revision} changes during assessment`, { timeout: 20000 }, async (t) => {
      const github = githubEvidence();
      const f = await fixture(t, (body, response) => {
        github.state[revision] = "b".repeat(40);
        assess(body, response);
      }, { entrypoint: resolve("audit.ts"), github: github.handler });
      const { child, done } = f.start(["--approve", ...(apply ? ["--apply"] : []), url]);
      child.stdin.end();
      const result = await done;
      assert.equal(result.code, 1);
      assert.match(result.stderr, /PR commits changed since the audit snapshot/);
      assert.match(result.stdout, /Verdict: All actionable findings appear addressed/);
      assert.doesNotMatch(result.stdout, /PR would be approved/);
      assert.equal(github.approvals.length, 0);
    });
  }
}
