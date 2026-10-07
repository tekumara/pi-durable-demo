import { parseReviewTarget } from "./reviews.ts";

export const AUDIT_CLI_USAGE = "Usage: npm run audit -- [--force] <GitHub PR URL> [provider/model-id]";

export function parseAuditOptions(args: string[], source: "cli" | "chat") {
  const usage = source === "cli" ? AUDIT_CLI_USAGE : "Usage: /audit [--force] <GitHub PR URL>";
  const unknown = args.find((arg) => arg.startsWith("-") && arg !== "--force");
  if (unknown) throw new Error(`Unknown audit option: ${unknown}\n${usage}`);
  const force = args.filter((arg) => arg === "--force").length;
  if (force > 1) throw new Error(`--force can be supplied only once\n${usage}`);
  const positional = args.filter((arg) => arg !== "--force");
  if (!positional.length || positional.length > (source === "cli" ? 2 : 1)) throw new Error(usage);
  const [url, requested] = positional;
  parseReviewTarget(url); // Reject malformed commands before credentials, storage or network access.
  return { url, requested, force: force === 1 };
}
