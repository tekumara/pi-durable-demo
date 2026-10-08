import { parseReviewTarget } from "./reviews.ts";

export const AUDIT_CLI_USAGE = "Usage: pronto [--force] [--comment] [--sticky[=true|false]] [--approve] [--dry-run] <GitHub PR URL> [provider/model-id]";

export function parseAuditOptions(args: string[], source: "cli" | "chat") {
  const usage = source === "cli" ? AUDIT_CLI_USAGE : "Usage: /audit [--force] [--comment] [--sticky[=true|false]] [--approve] [--dry-run] <GitHub PR URL>";
  const flags = ["--force", "--comment", "--sticky", "--approve", "--dry-run"];
  const supplied = new Set<string>();
  const positional: string[] = [];
  let sticky = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) { positional.push(arg); continue; }
    const flag = arg.startsWith("--sticky=") ? "--sticky" : arg;
    if (!flags.includes(flag)) throw new Error(`Unknown audit option: ${arg}\n${usage}`);
    if (supplied.has(flag)) throw new Error(`${flag} can be supplied only once\n${usage}`);
    supplied.add(flag);
    if (flag === "--sticky") {
      const value = arg.startsWith("--sticky=") ? arg.slice("--sticky=".length)
        : ["true", "false"].includes(args[i + 1]) ? args[++i] : "true";
      if (value !== "true" && value !== "false") throw new Error(`--sticky must be true or false\n${usage}`);
      sticky = value === "true";
    }
  }
  if (!positional.length || positional.length > (source === "cli" ? 2 : 1)) throw new Error(usage);
  const [url, requested] = positional;
  parseReviewTarget(url); // Reject malformed commands before credentials, storage or network access.
  return { url, requested, force: supplied.has("--force"), comment: supplied.has("--comment"), sticky,
    approve: supplied.has("--approve"), dryRun: supplied.has("--dry-run") };
}
