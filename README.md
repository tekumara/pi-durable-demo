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

Run a one-shot, read-only audit:

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

After interruption, run the same PR audit from the same directory to resume its saved snapshot and model. Once an audit finishes, the next invocation creates a fresh snapshot and conversation. Run only one audit per PR per directory at a time; Durable does not lock storage across processes. Chat audits use separate storage and do not replace the coding conversation or its tools.

The one-shot CLI exits 0 when it produces a complete report, even if findings remain outstanding. Operational failures or an incomplete assessment exit 1. The report is not a CI pass/fail signal.

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

The CLI tests use local simulated model and GitHub endpoints with temporary credentials. They exercise all 4 coding tools, streamed output, saved history, and recovery after SIGKILL and SIGTERM. Audit tests cover both entry points, paginated evidence, fork-head code reads, blocked shell calls, report coverage and citations, inconsistent evidence, and restart recovery. They do not contact a real model provider or GitHub.

Pi Durable is experimental. Dependencies are pinned to 1.0.3, with `package-lock.json` included alongside the code.

## References

- [Pi Durable introduction](https://earendil.com/posts/pi-durable)
- [Pi Durable README](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md)
