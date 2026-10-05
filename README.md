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

## Credentials and tools

The agent reuses Pi's `ModelRuntime` for credentials, OAuth refresh, and custom models. It reads the normal `~/.pi/agent` directory, or the directory set by `PI_CODING_AGENT_DIR`. It does not copy tokens into this repo.

Only Pi Durable's built-in `read`, `write`, `edit`, and `bash` tools are installed. They run directly on your machine as your user, with no sandbox or approval prompts. Use this only with projects and tasks you trust.

Pi extensions, skills, MCP servers, and its full system prompt are not loaded. A short coding instruction tells the model to inspect the project and follow `AGENTS.md` when present.

## Persistence and recovery

Each working directory has one conversation in `.pi-durable/agent.sqlite`. Restart the same command to continue it. Conversation history and the selected model survive restarts.

Ctrl+C or SIGTERM closes the harness without cancelling its unfinished work. On the next launch, `harness.resume()` continues it before accepting another task. An interrupted model request is retried. Interrupted tools rerun only when Pi Durable declares them replay-safe; writes and shell commands are not blindly repeated.

Run only one agent process per working directory. Pi Durable does not provide cross-process storage locking. SQLite's defaults protect against process crashes, but the newest commits can be lost on power failure.

To start a fresh conversation, stop the agent and move or delete `.pi-durable/`. The database contains your prompts, model responses, and tool results, so keep it private and out of version control.

## Check

```sh
npm run check
npm test
```

The CLI tests use a local simulated model endpoint and temporary Pi credentials. They exercise all 4 coding tools, streamed output, saved history, and recovery after SIGKILL and SIGTERM. They do not contact a real model provider.

Pi Durable is experimental. Dependencies are pinned to 1.0.3, with `package-lock.json` included alongside the code.

## References

- [Pi Durable introduction](https://earendil.com/posts/pi-durable)
- [Pi Durable README](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md)
