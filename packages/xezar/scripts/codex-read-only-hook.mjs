#!/usr/bin/env node

// src/core/codex-read-only-hook-entry.ts
import { readFileSync, realpathSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";

// src/core/codex-read-only-hook.ts
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

// src/core/read-only-lock.ts
var ALLOWLIST_RULE = "prefix.entry";
var FIND_ACTIONS = [
  "-exec",
  "-execdir",
  "-delete",
  "-ok",
  "-okdir",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls"
];
var COMMAND_RUNNING_ARGUMENTS = [
  { program: "git", enforcement: "checked", rule: "command.git-reviewed", argumentShapes: ["-c", "--config-env", "--exec-path", "fetch --upload-pack|--exec", "diff|show|log --output|-o", "checkout ... -- <path>"], reason: "git has reviewed arguments that can execute a command or write a file" },
  { program: "find", enforcement: "checked", rule: "command.find-action", argumentShapes: [...FIND_ACTIONS], reason: "find actions can execute another command, delete a path or write a file" },
  { program: "rg", enforcement: "checked", rule: "command.rg-pre", argumentShapes: ["--pre=<command>", "--pre <command>"], reason: "rg --pre executes a command for every searched file" },
  { program: "npm", enforcement: "checked", rule: "command.npm-prefix", argumentShapes: ["--prefix=<directory>", "--prefix <directory>"], reason: "npm --prefix can select a different project and therefore a different script" },
  { program: "bash", enforcement: "argument-safe", rule: "command.argument-safe", argumentShapes: [], reason: "each shipped bash entry fixes the script path before any caller arguments" },
  { program: "sed", enforcement: "never-named", rule: "command.never-named", argumentShapes: [], reason: "sed programs can write files or execute commands and cannot be safely classified as shell words" },
  { program: "awk", enforcement: "never-named", rule: "command.never-named", argumentShapes: [], reason: "awk programs can execute commands and cannot be safely classified as shell words" },
  { program: "grep", enforcement: "argument-safe", rule: "command.argument-safe", argumentShapes: [], reason: "grep has no reviewed argument that executes another command or writes a file" },
  { program: "jq", enforcement: "argument-safe", rule: "command.argument-safe", argumentShapes: [], reason: "jq reads its program as data and has no reviewed command-running argument" },
  { program: "gh", enforcement: "argument-safe", rule: "command.argument-safe", argumentShapes: [], reason: "the shipped gh entries use API operations and templates without local command execution" },
  { program: "node", enforcement: "argument-safe", rule: "command.argument-safe", argumentShapes: [], reason: "each shipped node entry fixes the script path before any caller arguments" },
  { program: "sh", enforcement: "argument-safe", rule: "command.argument-safe", argumentShapes: [], reason: "each shipped sh entry fixes the script path before any caller arguments" },
  { program: "agent-browser", enforcement: "accepted-write", rule: "command.accepted-write", argumentShapes: ["screenshot --full <path>"], reason: "QA and design-review roles intentionally allow browser artifacts, including screenshots at caller-chosen paths" },
  ...["pwd", "ls", "cat", "echo", "printf", "wc", "head", "tail", "diff", "sha256sum", "shasum"].map((program) => ({ program, enforcement: "argument-safe", rule: "command.argument-safe", argumentShapes: [], reason: `${program} has no reviewed argument that executes another command` }))
];
var WRAPPER_COMMANDS = /* @__PURE__ */ new Set([
  "env",
  "timeout",
  "xargs",
  "nohup",
  "exec",
  "eval",
  "command",
  "bash",
  "sh",
  "zsh",
  "nice",
  "caffeinate"
]);
function normalizeBashAllowlist(entries) {
  return entries.map((entry) => entry.trim()).filter(Boolean);
}
function matchesBashAllowlistEntry(command, entry) {
  return command === entry || command.startsWith(entry) && command[entry.length] === " ";
}
function refuse(rule, explanation) {
  return { allowed: false, rule, reason: `Rule ${rule} refused the command: ${explanation}.` };
}
function splitReadOnlyCommand(command) {
  const words = [];
  let text = "";
  let raw = "";
  let quote;
  let started = false;
  const push = () => {
    if (started) words.push({ text, raw });
    text = "";
    raw = "";
    started = false;
  };
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    const next = command[i + 1];
    if (quote === "'") {
      raw += char;
      if (char === "'") quote = void 0;
      else text += char;
      continue;
    }
    if (quote === '"') {
      raw += char;
      if (char === '"') {
        quote = void 0;
        continue;
      }
      if (char === "\\") {
        if (next === void 0 || next === "\n") return refuse("syntax.backslash-line", "a trailing or line-ending backslash changes what the shell receives");
        raw += next;
        text += next;
        i++;
        continue;
      }
      if (char === "`" || char === "$") return refuse("syntax.expansion", "a word the shell still expands cannot be checked safely");
      text += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      raw += char;
      started = true;
      continue;
    }
    if (char === "\\") {
      if (next === void 0 || next === "\n") return refuse("syntax.backslash-line", "a trailing or line-ending backslash changes what the shell receives");
      raw += char + next;
      text += next;
      started = true;
      i++;
      continue;
    }
    if (char === "`" || char === "$" || char === "~" || char === "*" || char === "?" || char === "[" || char === "{" || char === "}") {
      return refuse("syntax.expansion", "a word the shell still expands cannot be checked safely");
    }
    if (char === "&" && next === ">" || char === ">" || char === "<") return refuse("syntax.redirection", `redirection beginning with "${char}${char === "&" ? ">" : ""}" can read from or write to a path`);
    if (char === ";" || char === "&" || char === "|" || char === "\n") return refuse("syntax.compound", `the shell operator ${JSON.stringify(char)} would run more than one simple command`);
    if (char === "(" || char === ")") return refuse("syntax.grouping", `the unquoted token "${char}" can group commands or define a function`);
    if (char === "#" && !started) {
      const newline = command.indexOf("\n", i + 1);
      if (newline >= 0 && command.slice(newline + 1).trim() !== "") return refuse("syntax.compound", "a command after a shell comment would run as another simple command");
      break;
    }
    if (/\s/.test(char)) {
      push();
      continue;
    }
    raw += char;
    text += char;
    started = true;
  }
  if (quote) return refuse("syntax.unclosed-quote", "an unclosed quote cannot be checked safely");
  push();
  if (words.length === 0) return refuse("syntax.empty", "the command is empty");
  return { command: command.trim(), words };
}
function basename(word) {
  return word.slice(word.lastIndexOf("/") + 1);
}
function isLongOptionPrefix(argument, option) {
  const name = argument.split("=", 1)[0] ?? "";
  return name.startsWith("--") && name.length > 2 && option.startsWith(name);
}
var GIT_GLOBAL_OPTIONS_WITH_SEPARATE_VALUE = /* @__PURE__ */ new Set([
  "-C",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix"
]);
function gitSubcommandIndex(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (GIT_GLOBAL_OPTIONS_WITH_SEPARATE_VALUE.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return i;
  }
  return -1;
}
function gitRefusal(words) {
  const args = words.slice(1).map((word) => word.text);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-c" || arg.startsWith("-c") && arg.length > 2 || arg === "--config-env" || arg.startsWith("--config-env=")) {
      return refuse("command.git-config-execution", `${JSON.stringify(arg)} can change Git configuration under a read-only prefix`);
    }
    if (isLongOptionPrefix(arg, "--exec-path")) {
      return refuse("command.git-exec-path", `${JSON.stringify(arg)} can select executable git subcommands`);
    }
  }
  const subcommandIndex = gitSubcommandIndex(args);
  const subcommand = subcommandIndex < 0 ? void 0 : args[subcommandIndex];
  const tail = subcommandIndex < 0 ? [] : args.slice(subcommandIndex + 1);
  if (subcommand === "fetch") {
    for (const argument of tail) {
      if (isLongOptionPrefix(argument, "--upload-pack") || isLongOptionPrefix(argument, "--exec")) {
        return refuse("command.git-fetch-upload-pack", `${JSON.stringify(argument)} supplies a command for git fetch to execute`);
      }
    }
  }
  if (subcommand === "diff" || subcommand === "show" || subcommand === "log") {
    for (let i = 0; i < tail.length; i++) {
      const arg = tail[i];
      if (arg === "--output" || arg.startsWith("--output=") || arg === "-o" || /^-o.+/.test(arg) && arg !== "--") {
        return refuse("command.git-output", `${JSON.stringify(arg)} makes git ${subcommand} write to a file`);
      }
    }
  }
  if (subcommand === "checkout") {
    const separator = tail.indexOf("--");
    if (separator >= 0 && separator < tail.length - 1) {
      return refuse("command.git-checkout-path", "git checkout with paths writes the working tree");
    }
  }
  return void 0;
}
function findRefusal(words) {
  const action = words.slice(1).map((word) => word.text).find((arg) => FIND_ACTIONS.some((name) => arg === name || arg.startsWith(`${name}=`)));
  return action ? refuse("command.find-action", `${JSON.stringify(action)} can execute a command, delete a path or write a file`) : void 0;
}
function rgRefusal(words) {
  const pre = words.slice(1).map((word) => word.text).find((arg) => arg === "--pre" || arg.startsWith("--pre="));
  return pre ? refuse("command.rg-pre", `${JSON.stringify(pre)} supplies a command for rg to execute`) : void 0;
}
function npmRefusal(words) {
  const prefix = words.slice(1).map((word) => word.text).find((arg) => arg === "--prefix" || arg.startsWith("--prefix="));
  return prefix ? refuse("command.npm-prefix", `${JSON.stringify(prefix)} selects a different npm project`) : void 0;
}
var CHECKED_ARGUMENT_DISPATCHERS = { git: gitRefusal, find: findRefusal, rg: rgRefusal, npm: npmRefusal };
var IMPLEMENTED_ARGUMENT_POLICY_PROGRAMS = Object.freeze(COMMAND_RUNNING_ARGUMENTS.map((row) => row.program));
function commandArgumentRefusal(words) {
  const program = basename(words[0]?.text ?? "");
  const policy = COMMAND_RUNNING_ARGUMENTS.find((row) => row.program === program);
  if (policy?.enforcement === "never-named") return refuse("command.never-named", `${program} programs cannot be safely named by a read-only allowlist`);
  if (policy?.enforcement !== "checked") return void 0;
  return CHECKED_ARGUMENT_DISPATCHERS[program](words);
}
function decideReadOnlyCommand(command, entries) {
  const normalized = normalizeBashAllowlist(entries);
  if (normalized.length === 0) return refuse(ALLOWLIST_RULE, "the bashAllowlist has no usable entry");
  const scriptPipe = splitAllowlistedScriptPipe(command, normalized);
  if (scriptPipe) {
    const left = decideReadOnlyCommand(scriptPipe.left, normalized);
    if (!left.allowed) return left;
    return { allowed: true };
  }
  const parsed = splitReadOnlyCommand(command);
  if ("allowed" in parsed) return parsed;
  const [programWord] = parsed.words;
  const program = basename(programWord?.text ?? "");
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(programWord?.text ?? "")) {
    return refuse("syntax.leading-assignment", "a leading environment assignment can alter the command that follows");
  }
  if (WRAPPER_COMMANDS.has(program)) {
    const wrapperNamed = normalized.some((entry) => basename(entry.split(/\s+/, 1)[0] ?? "") === program);
    if (!wrapperNamed) return refuse("syntax.wrapper-command", `${program} can run another command and no entry names that wrapper`);
  }
  const argumentRefusal = commandArgumentRefusal(parsed.words);
  if (argumentRefusal) return argumentRefusal;
  if (!normalized.some((entry) => matchesBashAllowlistEntry(parsed.command, entry))) {
    return refuse(ALLOWLIST_RULE, `${JSON.stringify(parsed.command)} does not match an entry exactly or followed by a literal space`);
  }
  return { allowed: true };
}
function decideReadOnlyShellCall(call, entries) {
  if (call.toolName !== "Bash") {
    const subject = typeof call.toolName === "string" ? `tool ${JSON.stringify(call.toolName)} is not the Bash shell tool` : "the hook payload does not name the Bash shell tool";
    return refuse("payload.tool-name", subject);
  }
  if (typeof call.command !== "string") {
    return refuse("payload.command", "the Bash hook payload has no string command");
  }
  return decideReadOnlyCommand(call.command, entries);
}
function splitAllowlistedScriptPipe(command, entries) {
  let quote;
  let escaped = false;
  let pipe = -1;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = void 0;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "|") {
      if (pipe >= 0 || command[i - 1] === "|" || command[i + 1] === "|") return void 0;
      pipe = i;
    }
  }
  if (pipe < 0) return void 0;
  const left = command.slice(0, pipe).trim();
  const right = command.slice(pipe + 1).trim();
  if (left === "" || !entries.includes(right)) return void 0;
  const parsedRight = splitReadOnlyCommand(right);
  if ("allowed" in parsedRight || parsedRight.words.length !== 2) return void 0;
  const [program, script] = parsedRight.words.map((word) => word.text);
  if (program !== "bash" && program !== "sh" || script === void 0 || script.startsWith("-")) return void 0;
  return { left, right };
}

// src/core/codex-read-only-hook.ts
var CODEX_READ_ONLY_ALLOWLIST_ENV = "__XEZAR_CODEX_READ_ONLY_ALLOWLIST";
var CODEX_READ_ONLY_RUN_ENV = "__XEZAR_CODEX_READ_ONLY_RUN";
var CODEX_READ_ONLY_LOCK_MAX_AGE_MS = 24 * 60 * 60 * 1e3;
function codexReadOnlyLockPath(hookScript, sessionId) {
  const key = createHash("sha256").update(sessionId).digest("hex");
  return join(dirname(hookScript), "locks", `${key}.json`);
}
function codexReadOnlyLockState(payload, record, now = Date.now()) {
  const input = payload && typeof payload === "object" ? payload : {};
  if (!record || typeof record !== "object") return "expired-or-malformed";
  const lock = record;
  const validRecord = lock.version === 1 && typeof lock.sessionId === "string" && typeof lock.cwd === "string" && typeof lock.createdAt === "number" && Number.isFinite(lock.createdAt) && typeof lock.expiresAt === "number" && Number.isFinite(lock.expiresAt) && lock.createdAt <= now && lock.expiresAt > now && lock.expiresAt - lock.createdAt <= CODEX_READ_ONLY_LOCK_MAX_AGE_MS;
  if (!validRecord) return "expired-or-malformed";
  return typeof input.session_id === "string" && lock.sessionId === input.session_id && typeof input.cwd === "string" && lock.cwd === input.cwd ? "active" : "live-mismatch";
}
function decideCodexPreToolUse(payload, entries) {
  const record = payload && typeof payload === "object" ? payload : {};
  const toolInput = record.tool_input && typeof record.tool_input === "object" ? record.tool_input : {};
  return decideReadOnlyShellCall({ toolName: record.tool_name, command: toolInput.command }, entries);
}
function codexHookOutput(decision) {
  if (decision.allowed) return void 0;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: decision.reason
    }
  };
}

// src/core/codex-read-only-hook-entry.ts
async function main() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    payload = void 0;
  }
  const marked = process.env[CODEX_READ_ONLY_RUN_ENV] === "locked";
  if (!marked) {
    const sessionId = payload && typeof payload === "object" ? payload.session_id : void 0;
    if (typeof sessionId !== "string") return;
    const lockPath = codexReadOnlyLockPath(fileURLToPath(import.meta.url), sessionId);
    let record;
    try {
      record = JSON.parse(readFileSync(lockPath, "utf8"));
    } catch {
      return;
    }
    const normalizedPayload = payload && typeof payload === "object" && typeof payload.cwd === "string" ? { ...payload, cwd: realpathSync(payload.cwd) } : payload;
    const lockState = codexReadOnlyLockState(normalizedPayload, record);
    if (lockState === "expired-or-malformed") {
      try {
        unlinkSync(lockPath);
      } catch {
      }
      return;
    }
  }
  let entries = [];
  try {
    const encoded = process.env[CODEX_READ_ONLY_ALLOWLIST_ENV];
    const parsed = encoded === void 0 ? void 0 : JSON.parse(encoded);
    if (marked && Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) entries = parsed;
  } catch {
  }
  const output = codexHookOutput(decideCodexPreToolUse(payload, entries));
  if (output) process.stdout.write(JSON.stringify(output));
}
main().catch((error) => {
  const reason = error instanceof Error ? error.message : String(error);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `Rule hook.adapter refused the command: the read-only hook could not start (${reason}).`
    }
  }));
});
