#!/usr/bin/env node
// Compares the onboarding manifest with the files in the working tree, and the manifest with the
// local-patch register.
//
//   manifest-drift.mjs [repository-root]
//
// Why this exists. `.xezar/onboarding.json` records a digest and an origin for every file the
// setup installed, so a later upgrade knows how carefully to treat each one. Nothing kept that
// record honest: a file edited in place kept its install-time digest, and an upgrade that trusted
// "copied" would overwrite the edit without a word. This check re-hashes every entry and binds
// every recorded local patch to its entry in `.xezar/LOCAL-PATCHES.md`
// (format: `.xezar/docs/local-patches.md`).
//
// Rules, from the upgrade contract (manifest version 2):
// - a file with no `patch` must hash-match its recorded `sha256`; for the gate runner
//   `.xezar/checks/repo-gates.sh` (origin `adapted`), a gate list the project changed since is
//   a filled-in value, not drift: its three gate assignments are swapped back for the values its
//   `renderInputs` records before the file is hashed a second time (GATE_REGIONS below);
// - a file with a `patch` may differ or be absent: a kit file removed on purpose keeps its entry,
//   and the register entry is the record of the removal;
// - for `owner-file-appended`, only the block from `<!-- xezar:kit:start -->` to
//   `<!-- xezar:kit:end -->`, both markers included, is hashed – the rest is the owner's;
// - a file with `patch: LP-n` needs register entry LP-n listing that path, and the entry must say
//   `Confirmed: yes` – an entry a tool drafted stays red until the owner confirms it;
// - every path a register entry lists needs a manifest entry carrying that patch.
// The project's own documents, its configuration and owner files merged without a kit block
// (NOT_RECORDED below) are not tracked: the project changes them in normal work. A manifest
// written by an earlier 3.1.0 build may still list one; that entry is ignored, said so on stderr,
// and dropped by the next upgrade or onboarding run. An `owner-file-appended` entry is the
// exception: its kit block is the kit's, and it is checked.
// A manifest without `manifestVersion` (version 1, written before 3.1.0) is not enforced: the
// check says so and passes. No manifest at all is not applicable either.
//
// Nothing here is followed: a symbolic link is never read through, and a path that leaves the
// repository is reported, not opened. It reads the working tree, because it is a gate and a pull
// request's own silent edit must fail that pull request.
//
// Output is `NAME=value` lines, parsed after the first `=`, never sourced as shell:
//   drift-status=pass|fail|not-applicable
//   drift=<path> origin=<origin> reason=<hash-mismatch|missing|unregistered-patch|unconfirmed-patch|register-without-manifest>
// A path the manifest does not know prints `origin=none`. Explanations go to stderr.
// Exit: 0 pass or not-applicable, 1 fail, 2 the manifest or register cannot be parsed.
// No dependencies: `node:` built-ins only.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST = ".xezar/onboarding.json";
const REGISTER = ".xezar/LOCAL-PATCHES.md";
const ORIGINS = ["copied", "adapted", "generated", "owner-file-appended"];
const FIELDS = ["Files", "Reason", "Upstream", "Since", "Confirmed"];
const HEX64 = /^[0-9a-f]{64}$/;
const PATCH_ID = /^LP-[0-9]+$/;
const START = "<!-- xezar:kit:start -->";
// Kept equal to NOT_RECORDED in the upgrade tool's lib/policy.mjs (the collection's tests bind
// them): the four configuration files, the project's documents, and the owner files merged
// without a kit block. Every CLAUDE.md, at any depth, is a project document too (notRecorded).
const NOT_RECORDED = [
  ".xezar/pipeline/config.json",
  ".xezar/config.json",
  ".xezar/pipeline/labels.json",
  ".xezar/routing.json",
  "AGENTS.md",
  "SDLC.md",
  "CODE_REVIEW.md",
  "BACKWARD_COMPATIBILITY.md",
  "SECURITY.md",
  ".mcp.json",
  ".codex/config.toml",
  ".gitignore",
];
const notRecorded = (path, origin) =>
  origin !== "owner-file-appended" &&
  (NOT_RECORDED.includes(path) || path === "CLAUDE.md" || path.endsWith("/CLAUDE.md"));
const END = "<!-- xezar:kit:end -->";

const say = (line) => process.stdout.write(`${line}\n`);
const explain = (line) => process.stderr.write(`manifest-drift: ${line}\n`);
const unparseable = (line) => {
  explain(line);
  process.exit(2);
};

if (process.argv.length > 3) unparseable("usage: manifest-drift.mjs [repository-root]");
const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const root = realpathSync(process.argv[2] ? resolve(process.argv[2]) : scriptRoot);

// A manifest key or register path: repo-relative, no `..` segment, no backslash.
const safePath = (p) =>
  typeof p === "string" && p.length > 0 && !p.startsWith("/") && !p.includes("\\") &&
  !p.split("/").some((part) => part === ".." || part === "");

// --- the manifest ------------------------------------------------------------------------------
const manifestPath = join(root, MANIFEST);
if (!existsSync(manifestPath)) {
  say("drift-status=not-applicable");
  explain(`no ${MANIFEST} in this project, so there is nothing to compare`);
  process.exit(0);
}
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (error) {
  unparseable(`${MANIFEST} is not valid JSON: ${error.message}`);
}
if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest))
  unparseable(`${MANIFEST} is not a JSON object`);
if (!("manifestVersion" in manifest)) {
  say("drift-status=not-applicable");
  explain(
    `${MANIFEST} is manifest version 1, which records no trustworthy per-file digests. ` +
    "The 3.1.0 upgrade writes version 2; this check enforces from then on.",
  );
  process.exit(0);
}
if (!Number.isInteger(manifest.manifestVersion) || manifest.manifestVersion < 2)
  unparseable(`${MANIFEST}: manifestVersion must be an integer of 2 or more`);
const files = manifest.files;
if (files === null || typeof files !== "object" || Array.isArray(files))
  unparseable(`${MANIFEST}: "files" must be an object`);
for (const [path, entry] of Object.entries(files)) {
  if (!safePath(path)) unparseable(`${MANIFEST}: "${path}" is not a repository-relative path`);
  if (entry === null || typeof entry !== "object" || Array.isArray(entry))
    unparseable(`${MANIFEST}: the entry for ${path} is not an object`);
  if (typeof entry.sha256 !== "string" || !HEX64.test(entry.sha256))
    unparseable(`${MANIFEST}: the entry for ${path} has no 64-hex sha256`);
  if (!ORIGINS.includes(entry.origin))
    unparseable(`${MANIFEST}: the entry for ${path} has origin "${entry.origin}", not one of ${ORIGINS.join(", ")}`);
  if ("patch" in entry && (typeof entry.patch !== "string" || !PATCH_ID.test(entry.patch)))
    unparseable(`${MANIFEST}: the entry for ${path} has patch "${entry.patch}", not LP-<n>`);
}

// --- the register ------------------------------------------------------------------------------
// One heading per entry, then bullet fields; the entry runs to the next `## ` heading. Text
// between entries is ignored. All five fields are required, once each.
const register = new Map();
const registerPath = join(root, REGISTER);
if (existsSync(registerPath)) {
  let current = null;
  const close = () => {
    if (!current) return;
    for (const field of FIELDS)
      if (!(field in current.fields)) unparseable(`${REGISTER}: ${current.id} has no "${field}:" line`);
    const f = current.fields;
    if (!/^(yes|no)$/.test(f.Confirmed)) unparseable(`${REGISTER}: ${current.id} Confirmed must be yes or no`);
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(f.Since)) unparseable(`${REGISTER}: ${current.id} Since must be YYYY-MM-DD`);
    if (!/^(local only|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[0-9]+)$/.test(f.Upstream))
      unparseable(`${REGISTER}: ${current.id} Upstream must be <owner>/<repo>#<n> or "local only"`);
    const paths = f.Files.split(",").map((p) => p.trim());
    for (const p of paths) if (!safePath(p)) unparseable(`${REGISTER}: ${current.id} lists "${p}", not a repository-relative path`);
    register.set(current.id, { files: paths, confirmed: f.Confirmed === "yes" });
    current = null;
  };
  for (const line of readFileSync(registerPath, "utf8").split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      close();
      const heading = /^## (LP-[0-9]+) [–-] (.+)$/.exec(line);
      if (heading) {
        if (register.has(heading[1])) unparseable(`${REGISTER}: ${heading[1]} appears twice`);
        current = { id: heading[1], fields: {} };
      } else if (/^## LP-/.test(line)) {
        unparseable(`${REGISTER}: "${line}" does not match "## LP-<n> – <title>"`);
      }
      continue;
    }
    if (!current) continue;
    const field = /^- (Files|Reason|Upstream|Since|Confirmed): (.+)$/.exec(line);
    if (!field) continue;
    if (field[1] in current.fields) unparseable(`${REGISTER}: ${current.id} has "${field[1]}:" twice`);
    current.fields[field[1]] = field[2].trim();
  }
  close();
}

// --- comparing ---------------------------------------------------------------------------------
// The gate runner's own gate list: the three assignments onboarding writes for the project (its
// references/write.md §2). Kept equal to RENDERED_REGIONS in the upgrade tool's
// lib/rewrites.mjs (the collection's tests bind them), which records each value in
// `renderInputs` under its key: the text between the array's `(` and `)`, or the rest of the
// lanes line after `=`. A changed gate list is still a trust-boundary change that needs a
// security review; it is the project's value, like the commands in `validation.commands`.
const GATE_RUNNER = ".xezar/checks/repo-gates.sh";
const GATE_REGIONS = [
  { key: "GATE_NAMES", re: /^(GATE_NAMES=\()([\s\S]*?)(\)[ \t]*$)/m },
  { key: "GATE_COMMANDS", re: /^(GATE_COMMANDS=\()([\s\S]*?)(\)[ \t]*$)/m },
  { key: "GATE_APPLICATION_LANES", re: /^(GATE_APPLICATION_LANES=)(.*)()$/m },
];
// The gate runner with its recorded gate list put back, or null when that cannot be done: not
// the gate runner, no recorded value for a region, or the region is missing from the file.
function recordedGateList(path, entry, bytes) {
  const inputs = entry.renderInputs;
  if (path !== GATE_RUNNER || entry.origin !== "adapted" || inputs === null || typeof inputs !== "object") return null;
  let text = bytes.toString("utf8");
  let restored = 0;
  for (const { key, re } of GATE_REGIONS) {
    if (typeof inputs[key] !== "string") continue;
    if (!re.test(text)) return null;
    text = text.replace(re, (_, head, _value, tail) => `${head}${inputs[key]}${tail}`);
    restored += 1;
  }
  return restored ? createHash("sha256").update(text, "utf8").digest("hex") : null;
}

const within = (candidate) => {
  const rel = relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

// The digest of what the tree holds for this entry, or a reason it has none.
function digest(path, origin) {
  const full = join(root, path);
  let stat;
  try {
    stat = lstatSync(full);
  } catch {
    return { reason: "missing" };
  }
  // A link is not the installed file, and reading through one could leave the repository.
  if (!stat.isFile()) return { reason: "hash-mismatch", note: "is not a regular file" };
  let real;
  try {
    real = realpathSync(full);
  } catch {
    return { reason: "missing" };
  }
  if (!within(real)) return { reason: "hash-mismatch", note: "resolves outside the repository" };
  const raw = readFileSync(real);
  // Text is compared with LF line endings (upgrade contract §1 → Digests), so a CRLF checkout
  // (core.autocrlf on Windows) matches; a NUL byte in the first 8000 bytes means binary, hashed as
  // it is. The raw digest is kept too: an earlier install may have recorded one over CRLF bytes.
  const lf = raw.subarray(0, 8000).includes(0) ? raw : Buffer.from(raw.toString("latin1").replaceAll("\r\n", "\n"), "latin1");
  const bytes = recordedBytes(lf, origin);
  const rawBytes = recordedBytes(raw, origin);
  if (bytes === null || rawBytes === null) return { reason: "hash-mismatch", note: "does not hold exactly one kit block" };
  const sha = (b) => createHash("sha256").update(b).digest("hex");
  return { sha256: sha(bytes), bytes, rawSha256: sha(rawBytes), rawBytes };
}

// What a manifest entry is recorded over: the whole file, or for an appended owner file only the
// kit's block. null when an owner file does not hold exactly one kit block.
function recordedBytes(bytes, origin) {
  if (origin !== "owner-file-appended") return bytes;
  const text = bytes.toString("utf8");
  const start = text.indexOf(START);
  const end = start < 0 ? -1 : text.indexOf(END, start);
  if (start < 0 || end < 0 || text.indexOf(START, start + 1) >= 0) return null;
  return Buffer.from(text.slice(start, end + END.length), "utf8");
}

// The variant of `seen` the record was taken over: the LF one, unless only the raw bytes match
// (plainly, or with the recorded gate list put back). The checks below then run on it unchanged.
function recordedVariant(seen, path, entry) {
  if (seen.reason || seen.sha256 === entry.sha256) return seen;
  const raw = { sha256: seen.rawSha256, bytes: seen.rawBytes };
  if (raw.sha256 === entry.sha256) return raw;
  if (recordedGateList(path, entry, seen.bytes) === entry.sha256) return seen;
  if (recordedGateList(path, entry, raw.bytes) === entry.sha256) return raw;
  return seen;
}

const drift = [];
const report = (path, origin, reason, note) => {
  drift.push(`drift=${path} origin=${origin} reason=${reason}`);
  if (note) explain(`${path}: ${note}`);
};

for (const [path, entry] of Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
  if (notRecorded(path, entry.origin)) {
    explain(`${path}: the project's own file is not tracked; its manifest entry is ignored`);
    continue;
  }
  const seen = recordedVariant(digest(path, entry.origin), path, entry);
  // A patched file may be absent: the register entry records a deliberate removal.
  if (seen.reason === "missing" && !entry.patch) {
    report(path, entry.origin, "missing", "recorded in the manifest, absent from the tree");
    continue;
  }
  if (entry.patch) {
    const lp = register.get(entry.patch);
    if (!lp || !lp.files.includes(path)) {
      report(path, entry.origin, "unregistered-patch", `names ${entry.patch}, which ${lp ? "does not list this file" : `is not in ${REGISTER}`}`);
    } else if (!lp.confirmed) {
      report(path, entry.origin, "unconfirmed-patch", `${entry.patch} says Confirmed: no; the owner confirms it by changing that to yes`);
    }
    continue;
  }
  if (seen.reason) report(path, entry.origin, seen.reason, seen.note);
  else if (seen.sha256 !== entry.sha256 && recordedGateList(path, entry, seen.bytes) === entry.sha256)
    explain(`${path}: its gate list differs from the one recorded; that is the project's own value, not drift`);
  else if (seen.sha256 !== entry.sha256)
    report(path, entry.origin, "hash-mismatch", `changed since it was recorded; record the change in ${REGISTER} or restore the file`);
}

for (const [id, lp] of register) {
  for (const path of lp.files) {
    const entry = files[path];
    if (notRecorded(path, entry?.origin)) continue; // not tracked, so nothing to bind
    if (!entry || entry.patch !== id)
      report(path, entry ? entry.origin : "none", "register-without-manifest", `${id} lists it, but its manifest entry does not carry patch ${id}`);
  }
}

say(`drift-status=${drift.length ? "fail" : "pass"}`);
for (const line of drift) say(line);
process.exit(drift.length ? 1 : 0);
