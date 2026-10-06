import { runAudit } from "./auditor.ts";
import { createModelRuntime } from "./model.ts";
import { parseReviewTarget } from "./reviews.ts";

async function main() {
  const [url, requested, ...extra] = process.argv.slice(2);
  if (!url || extra.length || url === "--help" || url === "-h") {
    console.log("Usage: npm run audit -- <GitHub PR URL> [provider/model-id]");
    if (!url || extra.length) process.exitCode = 1;
    return;
  }
  parseReviewTarget(url); // Validate before credentials, storage, or network access.
  const cwd = process.cwd();
  const { models, model } = await createModelRuntime(cwd, requested);
  await runAudit(url, { cwd, models, model: { provider: model.provider, modelId: model.id } });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
