# Minimal Pi Durable coding agent

A plain terminal chat in [`agent.ts`](agent.ts). It uses Pi Durable for the conversation, tool calls, SQLite persistence, and recovery. There is no full-screen TUI, server, or subagent system.

## Run

You need Node.js 22.19 or newer and an existing Pi login. If needed, run `pi` and use `/login` first.

```sh
npm install --ignore-scripts
npm start
```

The agent uses your saved Pi default model, or the first available model if there is no usable default. The selected model is shown at startup. Choose a specific model with:

```sh
npm start -- provider/model-id
```

For example, use a provider and model listed by Pi's `/model` command. A model argument also changes the model of an existing conversation.

Type a task at `you>`. Answers stream as plain text. Tool calls show their name and file path or command. Enter `/quit` to exit.

To work on another project, run the script from that directory:

```sh
cd /path/to/project
node --experimental-strip-types /path/to/pi-durable-demo/agent.ts
```

## Audit a pull request

Run a one-shot audit (read-only by default):

```sh
npm run audit -- https://github.com/owner/repo/pull/42
```

Or type this in the chat agent:

```text
/audit https://github.com/owner/repo/pull/42
```

The CLI accepts an optional `provider/model-id` after the URL. Chat audits use the chat agent's model. Both entry points call the same auditor. You do not need a local checkout of the PR.

Authenticate with `gh auth login`, `GITHUB_TOKEN`, or `GH_TOKEN`. The token needs read access to the target PR and its code, including a fork's head repository. `agent-reviews` 1.1.0 is a pinned npm dependency, imported directly; its CLI is not launched. Its authentication and proxy helpers may invoke `gh` or `curl`. `GITHUB_API_URL` and `GITHUB_GRAPHQL_URL` support enterprise and API-compatible endpoints.

The controller fetches evidence before asking the model to assess it:

- all inline comments and replies, general PR comments, and non-empty human and bot review summaries
- actual inline-thread resolution and outdated state through paginated GitHub GraphQL queries
- changed files and available patches, plus the head and base commit SHAs

Answered and resolved findings remain in scope. Boilerplate is included for the agent to classify rather than discarded by a filter. The audit stops if the changed-file list is incomplete or the head or base SHA changes during fetching. Comments can still change during the fetch window; the report records that window and is not a live-state guarantee.

The model can read remote text files at those pinned commits, including the fork head. It cannot execute shell commands, access local files, edit code, post comments, or resolve threads. Unsupported or inaccessible evidence should produce an `uncertain` assessment, not a guessed fix.

The terminal report lists each comment and its findings as `addressed`, `outstanding`, `uncertain`, or `not-actionable`, with explanations and evidence links. GitHub thread resolution is reported separately. A resolved thread or a reply claiming a fix is not proof that the code addresses the finding. The host checks comment coverage and evidence references before printing a verdict. Assessment of the findings remains the model's judgement.

No separate JSON or Markdown report file is written. Each PR has a SQLite session under `.pi-durable/audits/`. The evidence is saved both in a Durable document and as a submitted conversation input; remote file reads become tool results. The structured assessment is also retained in the session. Private review text and code are sent to your selected model provider and saved locally, so protect this directory.

### Post a verdict comment

Add `--comment` to post the verdict, finding counts, audited head SHA and evidence fetch window as a general PR comment:

```sh
npm run audit -- --comment https://github.com/owner/repo/pull/42
```

```text
/audit --comment https://github.com/owner/repo/pull/42
```

Example comment:

```text
PR review audit · https://github.com/owner/repo/pull/42

Head: 0123456789abcdef0123456789abcdef01234567

Evidence fetched: 2026-06-01T12:00:00.000Z to 2026-06-01T12:00:03.000Z

Verdict: Not all actionable findings are addressed.

Findings: 4 addressed · 1 outstanding · 1 uncertain · 2 not-actionable

GitHub: 3/5 inline threads resolved (0 unknown). PR-level comments and review summaries have no thread-resolution state.

This is the agent's assessment of a saved snapshot, not proof of correctness or the PR's current live state.
```

The comment contains the summary only. Per-finding explanations and evidence links remain in the terminal report.

The flag defaults to false. It can appear before or after the URL or CLI model argument, and you can combine it with `--force`. Your GitHub token needs permission to create PR comments.

The host posts only after a complete, validated assessment, including a cache hit. The model remains read-only. Each successful invocation with `--comment` creates a new comment; posting changes the PR discussion and therefore invalidates the evidence cache on the next audit.

Posting is not replayed by Durable, and the flag does not persist across invocations. If posting fails, the CLI exits 1 but retains the completed assessment. After an interruption or ambiguous network failure, check the PR before retrying to avoid duplicate comments.

### Assessment caching and restart

A normal invocation follows this flow:

```text
Open Durable storage
          ↓
Unfinished audit?
    ├─ yes → Resume its saved snapshot and submission
    └─ no  → Fetch current evidence and compute fingerprint
                         ↓
                 Match latest successful assessment?
                   ├─ yes → Record recheck and print saved report
                   └─ no  → Save new snapshot and conversation
                                      ↓
                              Run the agent and validate assessment
                                      ↓
                              Commit completion and cache publication
                                      ↓
                              Print report
```

`--force`, or a saved restart intent, overrides this flow. It cancels any unfinished attempt, fetches fresh evidence and skips cache lookup.

After interruption, run the same PR audit from the same directory to resume its saved snapshot and model.

After completion, the auditor fetches current evidence and compares it with the latest successful assessment. It reuses that assessment when the evidence and assessment policy match. A cache hit makes no model requests. The terminal shows when the assessment was saved and when the evidence was rechecked.

The fingerprint includes:

- head and base SHAs and repository identities
- comment, reply and review text, metadata and thread state
- PR title, description, changed files and patches
- model ID, API, endpoint, token limits and sampling settings
- auditor version, thinking level, prompts and tool schemas

Snapshot IDs, fetch times and collection order do not affect the fingerprint. Matching assessments do not expire. Only the latest successful assessment is eligible for reuse, although older conversations remain stored. Success means a complete, validated report, even if findings remain outstanding or uncertain. Failed attempts do not replace the cache.

To request a new assessment, use `--force`:

```sh
npm run audit -- --force https://github.com/owner/repo/pull/42
```

```text
/audit --force https://github.com/owner/repo/pull/42
```

The flag can appear before or after the URL or CLI model argument. It bypasses the cache. If an audit is unfinished, it cancels that attempt and starts again with fresh evidence. The controller saves its restart intent and selected model before cancelling or fetching. Once saved, they survive interruption before the new snapshot is admitted. Once that snapshot is saved, a normal invocation resumes the new attempt. Repeating `--force` deliberately restarts again.

Use `--force` after a temporary evidence-access failure, when revisiting a time-sensitive finding, or when a model alias changes behind its ID.

Cache pointers, fingerprints and recheck receipts live in Durable storage. Completion and cache publication share one transaction. If the process dies before printing a completed report, the next invocation can reuse it after checking the evidence. Terminal output is not exactly-once delivery.

Existing sessions migrate without deleting their history. Assessments created before caching are not automatically eligible for reuse. If an unfinished audit resumes under a changed assessment policy, it can finish but cannot publish a mixed-policy cache entry. A successful but uncacheable assessment clears the cache slot rather than falling back to an older success. When changing tool behaviour, validation rules or dependency defaults, bump `AUDITOR_VERSION` in `auditor.ts`. Prompt and tool-schema changes invalidate the cache automatically.

Run only one audit per PR per directory at a time; Durable does not lock storage across processes. Chat audits use separate storage and do not replace the coding conversation or its tools.

The one-shot CLI exits 0 when it produces a complete report, even if findings remain outstanding. Operational failures or an incomplete assessment exit 1. The report is not a CI pass/fail signal.

### Audit database contents

Each PR has one database at `.pi-durable/audits/<target-hash>.sqlite`, shared by the CLI and chat command. It can contain several audit conversations. The coding conversation remains separate in `.pi-durable/agent.sqlite`.

Each newly admitted audit attempt creates an independent conversation. Its evidence and identity are saved together, before submitting work to the model.

The application stores these logical documents, not separate tables for each kind:

| Document kind | Scope | Contents |
| --- | --- | --- |
| `app.review-audit` | Conversation | `snapshot`: PR details, pinned commits, comments, replies, thread states, changed files and patches. `report`: accepted assessments, initially `null`. `inspected`: URLs of remote file ranges read by tools. |
| `app.review-audit-identity` | Conversation | `fingerprint`: evidence and policy hash. `policy`: model and auditor configuration hash. Older conversations may not have this document. |
| `app.review-audit-runs` | Session | `active`: latest admitted conversation ID. `complete`: whether that attempt has settled, including failure or cancellation. `restartModel`: saved force-restart intent, otherwise `null`. `latestSuccess`: eligible cached conversation ID, fingerprint, publication time (`assessedAt`) and last evidence-check time (`lastCheckedAt`), otherwise `null`. |

Each assessment in `report` has a `commentKey` and a `findings` array. Each finding contains `summary`, `status`, `reason` and `evidence` URLs. The overall verdict and counts are calculated when printing; they are not additional report fields.

Once the input is placed, the conversation transcript also contains the full snapshot as a user message. Committed model responses and tool results follow it. Remote file excerpts appear in file-tool results; this is not a local PR checkout. Accepted assessment arguments appear in the assistant's `report_review_assessment` call. That tool's result is an acknowledgement, while the accepted assessment is mirrored in `app.review-audit.report`. Rejected report proposals can also appear in the transcript.

Expect these changes across invocations:

| Event | Database effect |
| --- | --- |
| New audit after a cache miss | New conversation, evidence snapshot and identity; then submission, model and tool records, and an accepted report if successful. Older conversations remain stored. |
| Resume an unfinished audit | Same conversation and snapshot. The stable `review-audit:<snapshot.id>` request ID avoids a duplicate submission. Recovery updates task state and can add further model and tool entries. |
| Reuse an unchanged assessment | No new conversation, submission or assessment. Append an `app.review-audit-recheck` entry to the cached conversation and update `lastCheckedAt`. The receipt records the fingerprint, new check's snapshot ID and fetch window, not another full snapshot. Original evidence and report remain unchanged. |
| Force a restart | Save restart intent, cancel unfinished work if present, then create a new conversation when fresh evidence is admitted. Keep the cancelled conversation's existing evidence and transcript. |
| Failed attempt | Keep any admitted conversation and its partial history. The report may remain `null`; the previous successful cache is not replaced. |

A report can be saved before its submission finishes. Its presence alone does not establish a successful audit. Before the initial evidence is admitted, an interrupted fetch leaves no new conversation or snapshot, although a force-restart intent may already be saved.

In SQLite, `conversations` identifies attempts, `entries` holds transcript and recheck records, `submissions` holds request IDs and status, and `tasks` holds execution state. Tool memos support recovery while a task is live; they are removed when its outcome is decided. `documents` identifies application and built-in `pi.*` documents. Their JSON values are stored in `document_revisions` as bases or deltas. Use Durable's snapshot API to read a materialised value rather than treating the latest delta as the whole document.

For read-only inspection with Node's built-in SQLite, replace `<target-hash>` with the hash in the database filename:

```sh
DB=".pi-durable/audits/<target-hash>.sqlite" node --input-type=module <<'JS'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.DB, { readOnly: true });
try {
  const queries = [
    `SELECT id FROM conversations ORDER BY id`,
    `SELECT id, conversation_id, status,
            json_extract(record, '$.requestId') AS request_id
     FROM submissions ORDER BY id`,
    `SELECT id, json_extract(record, '$.kind') AS kind, scope_kind, owner_id
     FROM documents WHERE retired_at IS NULL ORDER BY id`,
    `SELECT id, conversation_id, json_extract(record, '$.kind') AS kind
     FROM entries ORDER BY id`,
  ];
  for (const query of queries) {
    console.log(query);
    console.table(db.prepare(query).all());
  }
} finally {
  db.close();
}
JS
```

Conversation IDs are numeric database identities, not PR numbers. These application documents retain their latest value per scope; they are not a complete history of every document edit. Separate older audit conversations still retain their snapshots and reports.

## Credentials and tools

The agent reuses Pi's `ModelRuntime` for credentials, OAuth refresh, and custom models. It reads the normal `~/.pi/agent` directory, or the directory set by `PI_CODING_AGENT_DIR`. It does not copy tokens into this repo.

The normal chat installs Pi Durable's built-in `read`, `write`, `edit`, and `bash` tools. They run directly on your machine as your user, with no sandbox or approval prompts. Use this only with projects and tasks you trust. The separate auditor has only remote-read and reporting tools.

Pi extensions, skills, MCP servers, and its full system prompt are not loaded. A short coding instruction tells the model to inspect the project and follow `AGENTS.md` when present.

## Persistence and recovery

The coding chat has one conversation per working directory in `.pi-durable/agent.sqlite`. Restart the same command to continue it. Conversation history and the selected model survive restarts.

Ctrl+C or SIGTERM closes the harness without cancelling its unfinished work. On the next launch, `harness.resume()` continues it before accepting another task. An interrupted model request is retried. Interrupted tools rerun only when Pi Durable declares them replay-safe; writes and shell commands are not blindly repeated.

Run only one agent process per working directory. Pi Durable does not provide cross-process storage locking. SQLite's defaults protect against process crashes, but the newest commits can be lost on power failure.

To start a fresh conversation, stop the agent and move or delete `.pi-durable/`. The database contains your prompts, model responses, and tool results, so keep it private and out of version control.

## Check

```sh
npm run check
npm test
```

The CLI tests use local simulated model and GitHub endpoints with temporary credentials. They exercise all 4 coding tools, streamed output, saved history, and recovery after SIGKILL and SIGTERM. Audit tests cover both entry points, paginated evidence, fork-head code reads, blocked shell calls, report coverage and citations, inconsistent evidence, and restart recovery. They also cover opt-in verdict comments, posting failures, cache reuse and invalidation, no expiry, failed reassessment, forced restarts, crashes during fetching and before printing, and stored-state migration. They do not contact a real model provider or GitHub.

Pi Durable is experimental. Dependencies are pinned to 1.0.3, with `package-lock.json` included alongside the code.

## References

- [Pi Durable introduction](https://earendil.com/posts/pi-durable)
- [Pi Durable README](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md)
