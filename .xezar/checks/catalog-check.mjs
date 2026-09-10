// Offline validation of this project's Xezar catalog: the workflow YAML files, the
// project config, and every skill a workflow names.
//
// Why this exists at all. Xezar parses a workflow step with a Zod object that is NOT
// `.strict()` (`packages/xezar/src/workflows/types.ts:13-44` — a plain `z.object`, so the
// inferred type strips), so an unknown key is SILENTLY DROPPED. A typo'd `commmand:`, or
// an invented `when:` / `env:` / `cwd:` that does not exist in the schema, loads clean and
// then does nothing.
// Xezar's own catalog validation therefore proves a file parses; it cannot prove the file
// means what it says. This checker closes that gap by allow-listing keys explicitly.
//
// It is deliberately offline. The cockpit's HTTP catalog endpoint is the operator's tool,
// not a gate: it needs a running server on a port that is not fixed, and it would answer
// a different question anyway.
//
// The YAML accepted here is a strict subset — the shape this project actually authors.
// Anything outside it is a failure, not a silent pass: a checker that guesses would
// reintroduce exactly the problem it exists to prevent.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? process.cwd();
const workflowsDir = join(root, ".xezar/workflows");
const skillsDir = join(root, ".xezar/skills");
const checksDir = join(root, ".xezar/checks");
const configPath = join(root, ".xezar/config.json");

const errors = [];
const notes = [];
const err = (where, message) => errors.push(`${where}: ${message}`);

// --- The schemas, transcribed from the Xezar source ----------------------------------
// `packages/xezar/src/workflows/types.ts:13-44` (step), `:51-60` (file), read at
// 6cd4aaa3605e8bcddf7bafd8f05ac96881ee35cc (`@qodeca/xezar` 0.10.1).
const STEP_KEYS = new Set([
  "id",
  "name",
  "prompt",
  "skill",
  "model",
  "runner",
  "allowedTools",
  "bashAllowlist",
  "command",
  "onFail",
]);
const ON_FAIL_KEYS = new Set(["retry", "max"]);
const FILE_KEYS = new Set(["name", "description", "steps", "skills"]);

// The only skills that may keep `interactive: true` in frontmatter. It is a composer
// SEED, not a lock: it pre-ticks Worktree OFF and Autonomous OFF. That is right for a
// read-only run, which writes nothing and needs no isolated checkout, and wrong for
// everything else now that Xezar owns the worktree.
const READ_ONLY_SKILLS = new Set(["xezar-code-review", "xezar-issue-triage"]);

// `packages/xezar/src/config.ts:33-107`.
const CONFIG_KEYS = new Set([
  "skillsRepos",
  "maxParallel",
  "worktreeRetention",
  "memoryLimitMb",
  "defaultRunner",
  "plannerModel",
  "namerModel",
  "liveTitleUpdates",
  "reviewGate",
  "baseBranch",
  "systemPrompt",
  "defaultModels",
  "modelsLocked",
]);

// --- A strict reader for the subset we author ------------------------------------------
// Top-level `key: value` at column 0; one list of steps, each item opening with `  - `
// at column 2 and continuing at column 4; `onFail` sub-keys at column 6.
function parseWorkflow(text, file) {
  const doc = { steps: null, skills: null };
  let step = null;
  let inOnFail = false;

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1;
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;

    const indent = raw.length - raw.trimStart().length;
    const body = raw.trim();

    const kv = /^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/.exec(body.startsWith("- ") ? body.slice(2) : body);

    if (indent === 0) {
      inOnFail = false;
      step = null;
      if (!kv) {
        err(file, `line ${lineNo}: expected a top-level "key: value", got "${body}"`);
        continue;
      }
      const [, key, value] = kv;
      if (!FILE_KEYS.has(key)) {
        err(file, `line ${lineNo}: unknown top-level key "${key}" — Xezar strips it silently`);
        continue;
      }
      if (key === "steps" || key === "skills") {
        if (value !== "") err(file, `line ${lineNo}: "${key}" must open a block, not carry a value`);
        doc[key] = [];
      } else {
        doc[key] = unquote(value);
      }
      continue;
    }

    if (indent === 2 && body.startsWith("- ")) {
      if (!Array.isArray(doc.steps)) {
        err(file, `line ${lineNo}: a list item appeared before "steps:"`);
        continue;
      }
      inOnFail = false;
      step = { __line: lineNo };
      doc.steps.push(step);
      if (!kv) {
        err(file, `line ${lineNo}: expected "- key: value", got "${body}"`);
        continue;
      }
      assignStepKey(step, kv, file, lineNo);
      continue;
    }

    if (indent === 4 && step) {
      inOnFail = false;
      if (!kv) {
        err(file, `line ${lineNo}: expected "key: value" inside a step, got "${body}"`);
        continue;
      }
      if (kv[1] === "onFail") {
        if (kv[2] !== "") err(file, `line ${lineNo}: "onFail" must open a block, not carry a value`);
        step.onFail = {};
        inOnFail = true;
        continue;
      }
      assignStepKey(step, kv, file, lineNo);
      continue;
    }

    if (indent === 6 && step && inOnFail) {
      if (!kv) {
        err(file, `line ${lineNo}: expected "key: value" inside onFail, got "${body}"`);
        continue;
      }
      const [, key, value] = kv;
      if (!ON_FAIL_KEYS.has(key)) {
        err(file, `line ${lineNo}: unknown onFail key "${key}" — Xezar strips it silently`);
        continue;
      }
      step.onFail[key] = unquote(value);
      continue;
    }

    err(file, `line ${lineNo}: unexpected indentation ${indent} for "${body}"`);
  }
  return doc;
}

function assignStepKey(step, kv, file, lineNo) {
  const [, key, value] = kv;
  if (!STEP_KEYS.has(key)) {
    err(
      file,
      `line ${lineNo}: unknown step key "${key}" — Xezar's step schema strips it silently, so it would do nothing`,
    );
    return;
  }
  step[key] = key === "allowedTools" || key === "bashAllowlist" ? parseInlineList(value) : unquote(value);
}

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length > 1 && trimmed[0] === '"' && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseInlineList(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  return trimmed
    .slice(1, -1)
    .split(",")
    .map((entry) => unquote(entry))
    .filter((entry) => entry !== "");
}

// --- The rules ---------------------------------------------------------------------------
function checkWorkflow(file, doc) {
  if (!doc.name) err(file, 'missing "name"');
  if (Boolean(doc.steps) === Boolean(doc.skills)) {
    err(file, 'a workflow lists either "steps" or "skills", not both');
    return;
  }
  if (!doc.steps) return;
  if (doc.steps.length === 0) err(file, '"steps" is empty');

  const ids = doc.steps.map((s) => s.id);
  const agentIndexes = [];

  doc.steps.forEach((step, index) => {
    const at = `${file} step "${step.id ?? `#${index + 1}`}"`;
    if (!step.id) err(at, "missing an id");
    if (ids.indexOf(step.id) !== index) err(at, "duplicate step id");

    const isCheck = Boolean(step.command);
    const isAgent = Boolean(step.prompt || step.skill);
    if (isCheck === isAgent) {
      err(at, "a step is either an agent step (prompt/skill) or a check step (command), not both");
    }
    if (isAgent) {
      agentIndexes.push(index);
      // Every agent step pins the model: the run engine reads the step's model and never
      // `defaultModels`, so an unpinned step silently runs whatever the composer showed.
      // Model is intentionally inherited from the selected available backend; do not pin a foreign vendor.
      if (step.skill) {
        const skillPath = join(skillsDir, `${step.skill}.md`);
        if (!existsSync(skillPath)) err(at, `names skill "${step.skill}", which has no file at ${skillPath}`);
      }
    }
    if (isCheck) {
      // A check step's command must be a script this repo actually ships, so a renamed or
      // deleted script is a load-time failure rather than a runtime one.
      const script = step.command.split(/\s+/)[0];
      if (script.startsWith(".xezar/checks/") && !existsSync(join(root, script))) {
        err(at, `runs "${script}", which does not exist`);
      }
    }
    if (step.onFail) {
      const target = ids.indexOf(step.onFail.retry);
      if (target === -1 || target >= index) {
        err(at, `onFail.retry must reference an EARLIER step (got "${step.onFail.retry}")`);
      }
    }
  });

  // --- The shared phase contract ------------------------------------------------------------
  // Added 2026-09-09 (issue #116). A workflow that runs the gates is a WRITING workflow, and every
  // writing workflow here has the same spine: isolate, prepare, author, confirm not blocked, gate,
  // seal, hand off. The order is not cosmetic — each step consumes what the one before it
  // established, and a missing or reordered phase produces a run that looks complete and is not.
  // `readiness` before `gates` is the load-bearing pair: it is what makes a BLOCKED task stop
  // before anyone pays for a gate run, and dropping it is invisible in a green transcript.
  const stepIds = doc.steps.map((s) => s.id);
  const at = (id) => stepIds.indexOf(id);
  if (at("gates") !== -1) {
    for (const required of ["preflight", "setup", "readiness", "gates", "evidence", "handoff"]) {
      if (at(required) === -1) {
        err(file, `runs the gates but has no "${required}" step — the writing-workflow phase contract is preflight, setup, agent, readiness, gates, evidence, handoff`);
      }
    }
    const order = ["preflight", "setup", "readiness", "gates", "evidence", "handoff"]
      .map((id) => [id, at(id)])
      .filter(([, i]) => i !== -1);
    for (let i = 1; i < order.length; i++) {
      if (order[i][1] < order[i - 1][1]) {
        err(file, `phase "${order[i][0]}" runs before "${order[i - 1][0]}"; the writing-workflow phases must keep their order`);
      }
    }
  } else if (at("setup") !== -1) {
    // No gates, but it installs dependencies anyway. `worktree-setup.sh` runs a full
    // `npm install`, which is minutes of work and disk a read-only or coordination run never
    // uses. Read-only workflows initialize their evidence without it, deliberately.
    err(file, 'has a "setup" step but no "gates" step — a workflow that does not build or test must not run a full dependency install');
  }

  // The interactivity rule. A run is interactive only when its last step is also its last
  // agent step (`src/workflows/run.ts:2799`). A trailing check step therefore silences
  // XEZ:ASK and XEZ:DONE for the whole run — the single most expensive authoring mistake
  // available here, and invisible in the YAML.
  const lastAgent = agentIndexes[agentIndexes.length - 1];
  if (lastAgent === undefined) {
    err(file, "has no agent step, so it can never report a result");
  } else if (lastAgent !== doc.steps.length - 1) {
    err(
      file,
      `ends with a check step ("${doc.steps[doc.steps.length - 1].id}"). A workflow whose last step is not its last agent step is NOT interactive: XEZ:ASK and XEZ:DONE are silenced for the entire run.`,
    );
  }
}

// --- Run -------------------------------------------------------------------------------
if (!existsSync(workflowsDir)) {
  err(".xezar/workflows", "directory is missing");
} else {
  const files = readdirSync(workflowsDir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();
  if (files.length === 0) err(".xezar/workflows", "no workflow files found");
  for (const file of files) {
    const doc = parseWorkflow(readFileSync(join(workflowsDir, file), "utf8"), file);
    checkWorkflow(file, doc);
  }
  notes.push(`${files.length} workflow file(s) checked`);
}

// Every skill file must be well-formed. That is the whole scope, and the comment used to claim
// more than the code does: it said every skill must be "reachable", which no loop below checks.
// It is not checked because it would be wrong to check — a skill named by no workflow is normal
// here (several are launched straight from the composer), so an orphan rule would reject correct
// configuration. What is validated is the frontmatter: the name matches the filename, a
// description exists, and `interactive: true` appears only on a read-only skill.
if (existsSync(skillsDir)) {
  const skillFiles = readdirSync(skillsDir).filter((f) => f.endsWith(".md"));
  for (const file of skillFiles) {
    const text = readFileSync(join(skillsDir, file), "utf8");
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
    if (!fm) {
      err(`skills/${file}`, "has no YAML frontmatter block");
      continue;
    }
    const name = /^name:\s*(.+)$/m.exec(fm[1])?.[1]?.trim();
    if (!name) err(`skills/${file}`, 'frontmatter has no "name"');
    else if (name !== file.replace(/\.md$/, "")) {
      err(`skills/${file}`, `frontmatter name "${name}" does not match the filename`);
    }
    if (!/^description:\s*\S/m.test(fm[1])) err(`skills/${file}`, 'frontmatter has no "description"');
    // `interactive: true` is a composer SEED: it makes the New Task form pre-tick Worktree
    // OFF and Autonomous OFF (`src/skills.ts:226` reads it; the composer's default
    // resolver turns `interactive !== true` into "inherit" and `=== true` into "off" for
    // both toggles). Under worktree mode a writing skill must not carry it.
    if (/^interactive:\s*true\s*$/m.test(fm[1]) && !READ_ONLY_SKILLS.has(name)) {
      err(
        `skills/${file}`,
        '`interactive: true` seeds the composer\'s Worktree toggle OFF. Only the read-only skills may carry it.',
      );
    }
  }
  notes.push(`${skillFiles.length} skill file(s) checked`);
}

if (!existsSync(configPath)) {
  notes.push("project config absent: engine defaults apply");
} else {
  // A malformed config exits non-zero either way — an uncaught `JSON.parse` throws and node exits
  // 1 — but it used to do so by printing a raw `SyntaxError` stack, which looks like a crash in
  // the checker rather than a diagnosis of the file it was asked to check. The exit code was
  // never the problem; the message was. The parse error text is kept, because "Unexpected token }
  // in JSON at position 62" is the one part of that stack a reader actually needs.
  let config = null;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
    if (config === null || typeof config !== "object" || Array.isArray(config)) {
      err(".xezar/config.json", "is valid JSON but not an object, so it cannot carry any project setting");
      config = null;
    }
  } catch (error) {
    err(".xezar/config.json", `is not valid JSON: ${error.message}`);
  }
  if (config === null) {
    // Every rule below reads a key. Running them against nothing would report a pile of
    // consequences of the one fault already named, which buries it.
    notes.push("project config NOT checked — it could not be parsed (see the failure below)");
  } else {
    for (const key of Object.keys(config)) {
      if (!CONFIG_KEYS.has(key)) err(".xezar/config.json", `unknown key "${key}" — Xezar ignores it`);
    }
    // Both keys below are refused in a COMMITTED project config, but for two different reasons,
    // and the difference is load-bearing: the message has to say the true one.
    //
    // `maxParallel` really is ignored by the engine after migration 001 seeds it into the
    // workspace file ("Legacy per-repo `maxParallel` keys are ignored", `run.ts`), so committing
    // it would document a limit that nothing enforces — worse than no key, because it reads as
    // one.
    //
    // `memoryLimitMb` is NOT ignored, and saying so was wrong from B2 onward: `run.ts` resolves it
    // through `WorkspaceSemaphore.projectMemoryLimitMb(repoRoot)`, and a repo's own value
    // overrides the workspace ceiling for that repo's runs. The refusal stands anyway, on kit
    // POLICY: `.xezar/CLAUDE.md` says the committed project config carries no global resource
    // limits, because this file travels to every checkout and a machine-sized ceiling is a
    // property of a machine, not of the project. Set it per user, where it belongs.
    const REFUSED_IN_PROJECT_CONFIG = {
      maxParallel:
        "The scheduler ignores it: parallelism is workspace state, in ~/.xezar/config.json -> projects[].maxParallel and resources.maxParallel. A committed key here would be a false promise.",
      memoryLimitMb:
        "The engine DOES honour a per-repo value, but the kit does not commit one: a memory ceiling is a property of a machine, not of a project, and this file travels to every checkout. Set it per user, in ~/.xezar/config.json -> resources.memoryLimitMb, or in an uncommitted local config.",
    };
    for (const [key, why] of Object.entries(REFUSED_IN_PROJECT_CONFIG)) {
      if (key in config) {
        err(".xezar/config.json", `must not set \`${key}\`. ${why}`);
      }
    }
    if (config.baseBranch != null && (typeof config.baseBranch !== "string" || !config.baseBranch.trim())) err("config", "baseBranch must be a nonempty string when supplied");
    notes.push("project config checked");
  }
}

if (!existsSync(join(checksDir, "repo-gates.sh"))) err(".xezar/checks", "repo-gates.sh is missing");

for (const note of notes) process.stdout.write(`  ${note}\n`);
if (errors.length > 0) {
  process.stdout.write(`\nCATALOG CHECK FAILED (${errors.length}):\n`);
  for (const line of errors) process.stdout.write(`  - ${line}\n`);
  process.exit(1);
}
process.stdout.write("CATALOG OK\n");
