import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

// agent-reviews has no public library entry point. Keep its pinned internal imports here.
const require = createRequire(import.meta.url);
const { fetchPRComments } = require("agent-reviews/lib/comments.js") as {
  fetchPRComments(owner: string, repo: string, pr: number, token: string, fetcher: typeof fetch): Promise<{
    reviewComments: RawComment[]; issueComments: RawComment[]; reviews: RawComment[];
  }>;
};
const { getGitHubToken, getProxyFetch } = require("agent-reviews/lib/github.js") as {
  getGitHubToken(): string | null;
  getProxyFetch(): typeof fetch;
};

type RawComment = {
  id: number; user: { login: string } | null; body: string | null; html_url: string;
  created_at?: string; submitted_at?: string; updated_at?: string; state?: string;
  in_reply_to_id?: number; path?: string; line?: number | null; original_line?: number | null; diff_hunk?: string;
};
export type ReviewTarget = { owner: string; repo: string; pr: number; url: string };
export type ReviewComment = {
  key: string; kind: "inline" | "comment" | "review"; author: string; body: string; url: string;
  createdAt: string; updatedAt: string; path: string | null; line: number | null; diffHunk: string | null;
  reviewState: string | null; thread: { resolved: boolean; outdated: boolean } | null;
  replies: { author: string; body: string; url: string; createdAt: string }[];
};
export type ReviewSnapshot = {
  id: string; target: ReviewTarget; startedAt: string; fetchedAt: string; title: string; description: string;
  headSha: string; headRepository: string; baseSha: string; baseRepository: string;
  comments: ReviewComment[];
  files: { path: string; previousPath: string | null; status: string; patch: string | null }[];
};
type PullRequest = {
  title: string; body: string | null; changed_files: number;
  head: { sha: string; repo: { full_name: string } | null };
  base: { sha: string; repo: { full_name: string } | null };
};
type ThreadPage = { data?: { repository?: { pullRequest?: { reviewThreads: {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: { isResolved: boolean; isOutdated: boolean; comments: { nodes: { fullDatabaseId: number | string | null }[] } }[];
} } } }; errors?: { message: string }[] };

export function parseReviewTarget(value: string): ReviewTarget {
  const url = new URL(value);
  const configuredHost = process.env.GITHUB_API_URL ? new URL(process.env.GITHUB_API_URL).hostname : "github.com";
  const match = url.pathname.match(/^\/([\w-]+)\/([\w.-]+)\/pull\/([1-9]\d*)\/?$/);
  if (url.protocol !== "https:" || !["github.com", configuredHost].includes(url.hostname)
    || url.username || url.password || url.port || url.search || url.hash || !match
    || !Number.isSafeInteger(Number(match[3]))) {
    throw new Error("Expected a GitHub PR URL: https://github.com/owner/repo/pull/42");
  }
  return { owner: match[1]!, repo: match[2]!, pr: Number(match[3]), url: `${url.origin}${url.pathname.replace(/\/$/, "")}` };
}

function github() {
  const token = getGitHubToken();
  if (!token) throw new Error("GitHub authentication required. Run gh auth login or set GITHUB_TOKEN/GH_TOKEN.");
  const base = (process.env.GITHUB_API_URL || "https://api.github.com").trim().replace(/\/+$/, "");
  const graphql = process.env.GITHUB_GRAPHQL_URL?.trim().replace(/\/+$/, "")
    || (base.endsWith("/api/v3") ? base.replace(/\/api\/v3$/, "/api/graphql") : `${base}/graphql`);
  const proxyFetch = getProxyFetch();
  // Paginated REST links must not send the token to another origin.
  const fetcher: typeof fetch = (input, options = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).origin !== new URL(base).origin) throw new Error("Unexpected GitHub REST origin");
    return proxyFetch(input, { ...options, signal: AbortSignal.timeout(30_000) });
  };
  async function request<T>(url: string, body?: object): Promise<T> {
    const response = await proxyFetch(url, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "pi-durable-auditor",
        ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub request failed (${response.status}): ${new URL(url).pathname}`);
    return response.json() as Promise<T>;
  }
  async function pages<T>(path: string): Promise<T[]> {
    const values: T[] = [];
    let url: string | null = `${base}${path}`;
    const seen = new Set<string>();
    while (url) {
      if (seen.has(url)) throw new Error("Repeated GitHub pagination link");
      seen.add(url);
      const response: Response = await fetcher(url, { headers: {
        Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "pi-durable-auditor",
      } });
      if (!response.ok) throw new Error(`GitHub pagination failed (${response.status})`);
      values.push(...await response.json() as T[]);
      url = response.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
    }
    return values;
  }
  return { token, base, graphql, fetcher, request, pages };
}

export async function fetchReviewSnapshot(target: ReviewTarget): Promise<ReviewSnapshot> {
  const client = github();
  const path = `/repos/${target.owner}/${target.repo}/pulls/${target.pr}`;
  const startedAt = new Date().toISOString();
  const pr = await client.request<PullRequest>(`${client.base}${path}`);
  if (!pr.head.repo || !pr.base.repo || !/^[a-f\d]{40}$/i.test(pr.head.sha) || !/^[a-f\d]{40}$/i.test(pr.base.sha)) {
    throw new Error("PR repositories or immutable commit SHAs are unavailable");
  }
  const [raw, files] = await Promise.all([
    fetchPRComments(target.owner, target.repo, target.pr, client.token, client.fetcher),
    client.pages<{ filename: string; previous_filename?: string; status: string; patch?: string }>(`${path}/files?per_page=100`),
  ]);
  if (files.length !== pr.changed_files) throw new Error("GitHub did not return the complete changed-file list; audit stopped");

  const threads = new Map<string, { resolved: boolean; outdated: boolean }>();
  let cursor: string | null = null;
  const cursors = new Set<string>();
  do {
    const result: ThreadPage = await client.request(client.graphql, {
      query: `query($owner:String!,$repo:String!,$pr:Int!,$cursor:String) {
        repository(owner:$owner,name:$repo) { pullRequest(number:$pr) {
          reviewThreads(first:100,after:$cursor) {
            pageInfo { hasNextPage endCursor }
            nodes { isResolved isOutdated comments(first:1) { nodes { fullDatabaseId } } }
          }
        } }
      }`,
      variables: { owner: target.owner, repo: target.repo, pr: target.pr, cursor },
    });
    if (result.errors?.length) throw new Error(`GitHub GraphQL: ${result.errors.map((e) => e.message).join("; ")}`);
    const page = result.data?.repository?.pullRequest?.reviewThreads;
    if (!page) throw new Error("GitHub review threads are unavailable");
    for (const thread of page.nodes) {
      const id = thread.comments.nodes[0]?.fullDatabaseId;
      if (id !== undefined && id !== null) threads.set(String(id), { resolved: thread.isResolved, outdated: thread.isOutdated });
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    if (page.pageInfo.hasNextPage && (!cursor || cursors.has(cursor))) throw new Error("Incomplete GitHub thread pagination");
    if (cursor) cursors.add(cursor);
  } while (cursor);

  // Preserve bodies and review summaries. Let the auditor classify boilerplate, not a heuristic filter.
  const groups: [ReviewComment["kind"], RawComment[]][] = [
    ["inline", raw.reviewComments.filter((c) => !c.in_reply_to_id)],
    ["comment", raw.issueComments],
    ["review", raw.reviews.filter((c) => c.body?.trim())],
  ];
  const comments: ReviewComment[] = groups.flatMap(([kind, list]) => list.map((c) => ({
    key: `${kind}:${c.id}`, kind, author: c.user?.login ?? "unknown", body: c.body ?? "", url: c.html_url,
    createdAt: c.created_at ?? c.submitted_at ?? "", updatedAt: c.updated_at ?? c.created_at ?? c.submitted_at ?? "",
    path: c.path ?? null, line: c.line ?? c.original_line ?? null, diffHunk: c.diff_hunk ?? null,
    reviewState: c.state ?? null, thread: kind === "inline" ? threads.get(String(c.id)) ?? null : null,
    replies: kind === "inline" ? raw.reviewComments.filter((r) => r.in_reply_to_id === c.id).map((r) => ({
      author: r.user?.login ?? "unknown", body: r.body ?? "", url: r.html_url, createdAt: r.created_at ?? "",
    })) : [],
  })));
  const latest = await client.request<PullRequest>(`${client.base}${path}`);
  if (latest.head.sha !== pr.head.sha || latest.base.sha !== pr.base.sha) {
    throw new Error("PR commits changed while fetching evidence. Run the audit again.");
  }
  return {
    id: randomUUID(), target, startedAt, fetchedAt: new Date().toISOString(), title: pr.title, description: pr.body ?? "",
    headSha: pr.head.sha, headRepository: pr.head.repo.full_name, baseSha: pr.base.sha, baseRepository: pr.base.repo.full_name,
    comments, files: files.map((f) => ({ path: f.filename, previousPath: f.previous_filename ?? null, status: f.status, patch: f.patch ?? null })),
  };
}

export async function postReviewComment(target: ReviewTarget, body: string): Promise<void> {
  const client = github();
  await client.request(`${client.base}/repos/${target.owner}/${target.repo}/issues/${target.pr}/comments`, { body });
}

export async function readGithubFile(snapshot: ReviewSnapshot, path: string, revision: "head" | "base", offset: number, limit: number) {
  if (path.split("/").some((part) => !part || part === "." || part === "..") || path.includes("\\") || path.startsWith("/")) {
    throw new Error("Expected a repository-relative file path without traversal");
  }
  const client = github();
  const sha = revision === "head" ? snapshot.headSha : snapshot.baseSha;
  const repository = revision === "head" ? snapshot.headRepository : snapshot.baseRepository;
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const file = await client.request<{ type: string; size: number; encoding: string; content?: string }>(
    `${client.base}/repos/${repository}/contents/${encodedPath}?ref=${sha}`,
  );
  if (file.type !== "file" || file.size > 1_000_000 || file.encoding !== "base64" || typeof file.content !== "string") {
    throw new Error("File is not a supported text file (maximum 1 MB). Mark findings uncertain if needed.");
  }
  const text = Buffer.from(file.content, "base64").toString("utf8");
  if (text.includes("\0")) throw new Error("Binary files are not supported");
  const lines = text.split("\n");
  if (offset > lines.length) throw new Error(`Offset exceeds file length (${lines.length} lines)`);
  const selected = lines.slice(offset - 1, offset - 1 + limit);
  const content = selected.map((line, i) => `${offset + i}: ${line}`).join("\n");
  if (Buffer.byteLength(content) > 24_000) throw new Error("Selected lines exceed 24 KB. Request fewer lines.");
  const end = offset + selected.length - 1;
  return {
    path, revision, sha, offset, end, totalLines: lines.length, hasMore: end < lines.length, content,
    url: `${new URL(snapshot.target.url).origin}/${repository}/blob/${sha}/${encodedPath}#L${offset}-L${end}`,
  };
}
