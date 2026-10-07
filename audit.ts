import { runAudit } from "./auditor.ts";
import { createModelRuntime } from "./model.ts";
import { AUDIT_CLI_USAGE, parseAuditOptions } from "./audit-options.ts";

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(AUDIT_CLI_USAGE);
    console.log("--force bypasses the assessment cache and restarts any unfinished audit.");
    return;
  }
  const { url, requested, force } = parseAuditOptions(args, "cli");
  const cwd = process.cwd();
  const { models, model } = await createModelRuntime(cwd, requested);
  await runAudit(url, { cwd, models, model: { provider: model.provider, modelId: model.id }, force });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
