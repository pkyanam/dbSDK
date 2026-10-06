#!/usr/bin/env node
// scripts/license-pack-check.mjs — packed-tarball legal artifact check.
// Packs a fresh npm tarball and asserts that LICENSE, NOTICE, and
// THIRD_PARTY_NOTICES.md are present and byte-identical (sha256) to the
// canonical root copies. No network; no publish.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const pkgDir = new URL("..", import.meta.url).pathname; // packages/dbsdk
const repoRoot = path.resolve(pkgDir, "..", "..");
const FILES = ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"];

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

const work = mkdtempSync(path.join(tmpdir(), "dbsdk-license-pack-check."));
try {
  execFileSync("npm", ["pack", "--pack-destination", work], { cwd: pkgDir, stdio: "ignore" });
  const tgz = path.join(work, "dbsdk-0.1.0.tgz");
  const listing = execFileSync("tar", ["tzf", tgz], { encoding: "utf8" }).split("\n");

  for (const f of FILES) {
    const entry = `package/${f}`;
    if (!listing.includes(entry)) {
      console.error(`FAIL: ${f} missing from packed tarball`);
      process.exit(1);
    }
    execFileSync("tar", ["xzf", tgz, "-C", work, entry], { stdio: "ignore" });
    const packed = sha256(readFileSync(path.join(work, entry)));
    const canonical = sha256(readFileSync(path.join(repoRoot, f)));
    if (packed !== canonical) {
      console.error(`FAIL: packed ${f} sha256 ${packed} != canonical root ${canonical}`);
      process.exit(1);
    }
    console.log(`OK: ${f} packed and byte-identical to canonical root (${packed.slice(0, 16)}…)`);
  }
  console.log("license pack check PASSED");
} finally {
  rmSync(work, { recursive: true, force: true });
}
