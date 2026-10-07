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

Add `--comment` to post the verdict, finding counts, audited head SHA and evidence fetch window as a general PR comment. It also explains each outstanding or uncertain finding, with links to the original comment and supporting evidence:

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

## Outstanding or uncertain findings

### outstanding: Missing access check

The current code still grants access without checking the user's role.

Review comment: https://github.com/owner/repo/pull/42#discussion_r101

Evidence:
- https://github.com/owner/repo/blob/0123456789abcdef0123456789abcdef01234567/src/access.ts#L1-L3

### uncertain: Undefined access policy

The discussion does not specify which roles should have access, so the intended behaviour cannot be verified.

Review comment: https://github.com/owner/repo/pull/42#issuecomment-202

Evidence:
- https://github.com/owner/repo/pull/42#issuecomment-202

This is the agent's assessment of a saved snapshot, not proof of correctness or the PR's current live state.
```

The comment includes details only for `outstanding` and `uncertain` findings. If there are none, it contains the summary only. The terminal report retains explanations and evidence for all findings.

The flag defaults to false. It can appear before or after the URL or CLI model argument, and you can combine it with `--force`. Your GitHub token needs permission to create PR comments.

The host posts only after a complete, validated assessment, including a cache hit. The model remains read-only. Each successful invocation with `--comment` creates a new comment; posting changes the PR discussion and therefore invalidates the evidence cache on the next audit.

Posting is not replayed by Durable, and the flag does not persist across invocations. If posting fails, the CLI exits 1 but retains the completed assessment. After an interruption or ambiguous network failure, check the PR before retrying to avoid duplicate comments.

### Approve when findings are addressed

Add `--approve` to submit a GitHub approval review only when the verdict is "All actionable findings appear addressed":

```sh
npm run audit -- --approve https://github.com/owner/repo/pull/42
```

```text
/audit --approve https://github.com/owner/repo/pull/42
```

The flag defaults to false. Approval requires at least one `addressed` finding and no `outstanding` or `uncertain` findings. Audits with only `not-actionable` findings, or no findings, skip approval. A skipped approval is not an operational failure.

The host submits the approval after a complete, validated assessment, including a cache hit. It rechecks the PR's head and base SHAs before approving and stops if either differs from the saved snapshot. The review is pinned to the audited head SHA and includes the same summary as a verdict comment. Approval assesses the supplied review findings, not the PR's overall correctness or CI status.

`--approve` does not imply `--comment`. You can enable either or both, and combine them with `--force`:

```sh
npm run audit -- --comment --approve https://github.com/owner/repo/pull/42
```

With both flags, the host posts the comment first, then submits the approval if the verdict allows it. Your GitHub token needs permission to submit PR reviews. GitHub does not allow authors to approve their own PRs.

Approvals are not replayed by Durable, and the flag does not persist across invocations. Approval errors exit 1 but retain the completed assessment. A comment already posted by `--comment` remains if approval fails. Check the PR before retrying after an interruption or ambiguous network failure.

### Preview comments and approvals

Add `--dry-run` to show the exact comment body without writing to GitHub. Combine it with `--comment` to preview posting, and `--approve` to show whether the verdict permits approval:

```sh
npm run audit -- --dry-run --comment --approve https://github.com/owner/repo/pull/42
```

```text
/audit --dry-run --comment --approve https://github.com/owner/repo/pull/42
```

The normal report is followed by a labelled comment preview and the planned actions. For an addressed verdict, the action preview looks like this:

```text
[audit:dry-run] Comment would be posted.
[audit:dry-run] PR would be approved at 0123456789abcdef0123456789abcdef01234567
```

For an outstanding, uncertain or no-actionable-findings verdict, the approval preview says it would be skipped. An eligible approval still checks the current head and base SHAs; changed commits stop the dry-run with an error.

The flag defaults to false and does not imply `--comment` or `--approve`. `--dry-run` alone shows the comment body but says it would not be posted. No comments or reviews are created, even when both action flags are set. A dry-run does not test GitHub write permissions or reviewer restrictions.

The audit otherwise runs normally: it fetches evidence, may call the model, saves its assessment and uses the cache. You can combine `--dry-run` with `--force` to reassess fresh evidence. The flag does not persist across invocations.

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

See [Audit database contents](DATABASE.md#audit-database-contents) for the saved evidence, reports, execution state and read-only inspection commands.

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

The CLI tests use local simulated model and GitHub endpoints with temporary credentials. They exercise all 4 coding tools, streamed output, saved history, and recovery after SIGKILL and SIGTERM. Audit tests cover both entry points, paginated evidence, fork-head code reads, blocked shell calls, report coverage and citations, inconsistent evidence, and restart recovery. They also cover opt-in verdict comments and approvals, dry-run previews without GitHub writes, skipped approvals, commit changes before approval, posting failures, cache reuse and invalidation, no expiry, failed reassessment, forced restarts, crashes during fetching and before printing, and stored-state migration. They do not contact a real model provider or GitHub.

Pi Durable is experimental. Dependencies are pinned to 1.0.3, with `package-lock.json` included alongside the code.

## References

- [Pi Durable introduction](https://earendil.com/posts/pi-durable)
- [Pi Durable README](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md)
