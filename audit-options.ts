import { parseReviewTarget } from "./reviews.ts";

export const AUDIT_CLI_USAGE = "Usage: npm run audit -- [--force] [--comment] [--approve] [--dry-run] <GitHub PR URL> [provider/model-id]";

export function parseAuditOptions(args: string[], source: "cli" | "chat") {
  const usage = source === "cli" ? AUDIT_CLI_USAGE : "Usage: /audit [--force] [--comment] [--approve] [--dry-run] <GitHub PR URL>";
  const flags = ["--force", "--comment", "--approve", "--dry-run"];
  const unknown = args.find((arg) => arg.startsWith("-") && !flags.includes(arg));
  if (unknown) throw new Error(`Unknown audit option: ${unknown}\n${usage}`);
  for (const flag of flags) {
    if (args.filter((arg) => arg === flag).length > 1) throw new Error(`${flag} can be supplied only once\n${usage}`);
  }
  const positional = args.filter((arg) => !flags.includes(arg));
  if (!positional.length || positional.length > (source === "cli" ? 2 : 1)) throw new Error(usage);
  const [url, requested] = positional;
  parseReviewTarget(url); // Reject malformed commands before credentials, storage or network access.
  return { url, requested, force: args.includes("--force"), comment: args.includes("--comment"),
    approve: args.includes("--approve"), dryRun: args.includes("--dry-run") };
}
