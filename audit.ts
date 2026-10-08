#!/usr/bin/env -S node --experimental-strip-types
import { runAudit } from "./auditor.ts";
import { createModelRuntime } from "./model.ts";
import { AUDIT_CLI_USAGE, parseAuditOptions, resolveAuditUrl } from "./audit-options.ts";

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(AUDIT_CLI_USAGE);
    console.log("Without a target, selects the current branch's PR using gh pr view. Branch and number selection require gh; explicit URLs need no checkout.");
    console.log("--force bypasses the assessment cache and restarts any unfinished audit.");
    console.log("--comment posts the verdict to the PR after a complete assessment (default: false).");
    console.log("--sticky updates the latest verdict comment from your GitHub account (default: true; --sticky=false creates a new comment).");
    console.log("--approve approves the PR only if all actionable findings appear addressed (default: false).");
    console.log("--dry-run previews the comment and approval decision without writing to GitHub (default: false).");
    return;
  }
  const { selector, requested, force, comment, sticky, approve, dryRun } = parseAuditOptions(args, "cli");
  const cwd = process.cwd();
  const url = await resolveAuditUrl(selector, cwd);
  const { models, model } = await createModelRuntime(cwd, requested);
  await runAudit(url, { cwd, models, model: { provider: model.provider, modelId: model.id }, force, comment, sticky, approve, dryRun });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
