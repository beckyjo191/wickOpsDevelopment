// One-shot test runner for the inventoryApi migration logic.
// Why this exists: Node 20 can't strip TypeScript natively (that's 22+), and
// we don't want a heavy test framework. So this script uses esbuild (already
// a dev-dep) to bundle the test file + its imports into a temp .mjs file,
// then invokes Node's built-in `--test` runner on it.
//
// Usage: node scripts/run-migration-tests.mjs

import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = "amplify/functions/inventoryApi/src/__tests__/migration.test.ts";
const tmp = mkdtempSync(join(tmpdir(), "wickops-test-"));
const out = join(tmp, "migration.test.mjs");

try {
  await build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile: out,
    // Bundle the AWS SDK in too — even though planMigration is pure, the
    // module-level imports still need to resolve. The bundle is ~3MB but
    // it's a transient test artifact, not a deploy artifact.
  });

  const node = spawn("node", ["--test", out], { stdio: "inherit" });
  await new Promise((resolve, reject) => {
    node.on("exit", (code) => {
      if (code === 0) resolve(undefined);
      else reject(new Error(`tests exited with code ${code}`));
    });
    node.on("error", reject);
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
