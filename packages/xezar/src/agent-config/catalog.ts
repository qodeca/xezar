import { join } from 'node:path';
import type { RunnerId } from '../core/agent-runner.ts';

/**
 * The catalog of coding-agent config files xezar can surface and edit. This file is the ONLY place
 * vendor knowledge lives: where each agent keeps its files, at which scope, in
 * what format, and — the load-bearing part — the vendor's OWN documented
 * precedence, quoted so a UI label never claims a merge xezar does not perform.
 *
 * Hardcoding is the design. xezar's value here is knowing where the files are
 * and what the docs say; an unknown file is not shown rather than guessed at.
 * A raw editor cannot drift on a vendor's *schema*; it can drift on *paths and
 * precedence strings*, so every entry carries a `docsUrl` and this table is the
 * single maintenance surface. Facts verified against primary docs 2026-07-16;
 * the pi block against the docs shipped with pi 0.85.1 on 2026-09-12 (#330 WP4).
 *
 * WHAT MAY GO IN THIS TABLE AT ALL. An entry is a file the API hands to a caller
 * verbatim and writes back verbatim, so a file that can hold a credential is not
 * eligible however useful editing it would be (F-15: no secret in a tool
 * response). Two files in pi's home are excluded for exactly that reason and
 * must stay excluded:
 *
 *   - `auth.json` — pi's stored provider credentials.
 *   - `models.json` — pi's custom-provider catalogue. Each provider entry carries
 *     its own `apiKey`, verified on a real 0.85.1 home on 2026-09-12. #152's
 *     model discovery reads this file and deliberately touches only `name`,
 *     `models[].id` and `models[].name` (`core/pi-model-catalog.ts`); handing the
 *     WHOLE file to a caller, which is what a catalog entry does, would ship the
 *     key. Wanting a model editor is not a reason to catalog it.
 *
 * `mcp.json` IS eligible on the same terms as the three MCP files already here:
 * an MCP server definition can carry a token in `env`/`headers`, and Claude's
 * `.mcp.json`, Codex's `[mcp_servers]` and OpenCode's `"mcp"` key have always
 * been in this table with that property. A user typing a secret into a config
 * file is not the same risk as xezar cataloging a file whose PURPOSE is secrets.
 */

export type ConfigFormat = 'json' | 'jsonc' | 'toml' | 'markdown';
export type ConfigScope = 'user' | 'project' | 'local';
/** `settings` = behavior knobs; `memory` = instruction/markdown; `mcp` = a dedicated MCP file. */
export type ConfigKind = 'settings' | 'memory' | 'mcp';
/**
 * Git status *by convention* — it drives the honest label, it is not read from
 * git. The seed path re-checks with `git check-ignore` before trusting it.
 */
export type ConfigTracked = 'tracked' | 'gitignored' | 'outside-repo';

/** Resolved home directories per agent, injected so the catalog stays pure and testable. */
export interface AgentHomePaths {
  /** `~/.claude` */
  claude: string;
  /** `$CODEX_HOME` or `~/.codex` */
  codex: string;
  /** `$XDG_CONFIG_HOME/opencode` or `~/.config/opencode` */
  opencodeConfig: string;
  /**
   * `$PI_CODING_AGENT_DIR` or `~/.pi/agent` — pi's whole per-user directory (`models.json`,
   * `settings.json`, and `auth.json`, which `account-identity.ts` reads for its non-secret
   * credential metadata and nothing else). The variable IS documented and the binary does read
   * it (re-verified against pi 0.85.1, 2026-09-12, #329); the note that used to sit here denying
   * it was wrong, and dated 2026-09-10.
   *
   * `CONFIG_FILES` resolves `pi.user.settings`, `pi.user.mcp` and `pi.user.memory` through this
   * slot (#330 WP4), which is also what makes a pi ACCOUNT's files resolve inside the account's
   * folder: `accountFiles` in `server/server.ts` patches this slot via `accountHomePatch`. Model
   * discovery (#152) reads the same slot. It lives here so pi's home is derived in the one place
   * every other agent's is. `auth.json` and `models.json` sit in this dir and are deliberately
   * NOT catalog entries — see the file header.
   */
  pi: string;
}

export interface ConfigFileDef {
  /** Stable, opaque, URL-safe. The ONLY thing a client may name (traversal-proof). */
  id: string;
  /** Every runner that reads this file. `<repo>/AGENTS.md` is one file, two readers. */
  runners: RunnerId[];
  kind: ConfigKind;
  scope: ConfigScope;
  /** Absolute path, resolved per request so `$CODEX_HOME`/`$XDG_CONFIG_HOME` are honoured. */
  resolve: (repoRoot: string, home: AgentHomePaths) => string;
  /** What the user sees, e.g. `~/.claude/settings.json`, `.claude/settings.local.json`. */
  label: string;
  format: ConfigFormat;
  tracked: ConfigTracked;
  /** True only for Claude's gitignored personal layer — the files seeded into a run's worktree. */
  seeded?: boolean;
  /** True when this file holds MCP server definitions (drives the MCP section's filter). */
  holdsMcp?: boolean;
  /** Top-level native setting that supplies the agent's new-session model, when present. */
  modelKey?: string;
  /** Native model keys checked in precedence order, including nested `env.*` settings. */
  modelKeys?: readonly string[];
  /** Native provider key paired with the model, when the vendor separates the two. */
  modelProviderKey?: string;
  /** Higher values win when resolving a native default model across config scopes. */
  modelPriority?: number;
  /** VERBATIM from the vendor docs. Never computed, never generic. */
  precedence: string;
  /** Documented mid-run reload behaviour, or undefined when the vendor is silent. */
  hotReload?: string;
  docsUrl: string;
}

const CLAUDE_SETTINGS_DOCS = 'https://code.claude.com/docs/en/settings';
const CLAUDE_MEMORY_DOCS = 'https://code.claude.com/docs/en/memory';
const CLAUDE_MCP_DOCS = 'https://code.claude.com/docs/en/mcp';
const CODEX_CONFIG_DOCS = 'https://developers.openai.com/codex/config-reference';
const CODEX_AGENTS_DOCS = 'https://developers.openai.com/codex/guides/agents-md';
const OPENCODE_CONFIG_DOCS = 'https://opencode.ai/docs/config/';
const OPENCODE_RULES_DOCS = 'https://opencode.ai/docs/rules/';
/**
 * pi ships its docs INSIDE the npm package (`docs/` in `@earendil-works/pi-coding-agent`) and
 * `pi.dev` serves no docs site — `https://pi.dev/docs/settings` is a 404, checked 2026-09-12. The
 * source repo is therefore the only stable public URL for the same text. Quotes below are from the
 * copy shipped with 0.85.1.
 */
const PI_SETTINGS_DOCS = 'https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md';
const PI_USAGE_DOCS = 'https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/usage.md';
/**
 * pi core reads NO MCP config: MCP arrives through the third-party `pi-mcp-adapter` extension
 * (#341/#343 shipped the cockpit's setup card for it), so the adapter's README is the vendor doc
 * for these two files and pi's own docs never mention `mcp.json`. Verified against
 * `pi-mcp-adapter@2.32.1` on 2026-09-12.
 */
const PI_MCP_DOCS = 'https://github.com/nicobailon/pi-mcp-adapter';
/**
 * The adapter's own ordering sentence and list, quoted rather than restated because the two pi MCP
 * entries have to agree about it and a paraphrase in one of them would be the drift this table
 * exists to prevent. It is also the sentence WP3's setup card (#343) built its “yours wins” claim
 * on, so the two surfaces now quote one string.
 */
const PI_MCP_PRECEDENCE =
  '“Precedence is (later entries win): 1. ~/.config/mcp/mcp.json 2. ~/.agents/mcp.json 3. ~/.agents/mcp/mcp.json 4. <Pi agent dir>/mcp.json 5. .mcp.json 6. .pi/mcp.json”.';

/**
 * The table. Order is presentation order: per runner, then user → project →
 * local so each scope ladder reads top (broad) to bottom (specific).
 */
export const CONFIG_FILES: ConfigFileDef[] = [
  // ---- Claude Code ----
  {
    id: 'claude.user.settings',
    runners: ['claude'],
    kind: 'settings',
    scope: 'user',
    resolve: (_repo, home) => join(home.claude, 'settings.json'),
    label: '~/.claude/settings.json',
    format: 'json',
    tracked: 'outside-repo',
    modelKey: 'model',
    modelKeys: ['env.ANTHROPIC_MODEL', 'model'],
    modelPriority: 1,
    precedence:
      'Lowest priority. Project and local settings override it key by key — except permission rules, which merge across all scopes.',
    hotReload: 'Edits to most keys — including permissions and hooks — apply to a running session without a restart.',
    docsUrl: CLAUDE_SETTINGS_DOCS,
  },
  {
    id: 'claude.project.settings',
    runners: ['claude'],
    kind: 'settings',
    scope: 'project',
    resolve: (repo) => join(repo, '.claude', 'settings.json'),
    label: '.claude/settings.json',
    format: 'json',
    tracked: 'tracked',
    modelKey: 'model',
    modelKeys: ['env.ANTHROPIC_MODEL', 'model'],
    modelPriority: 2,
    precedence:
      'Overrides user settings key by key (permission rules merge). Local settings override this.',
    hotReload: 'Edits to most keys — including permissions and hooks — apply to a running session without a restart.',
    docsUrl: CLAUDE_SETTINGS_DOCS,
  },
  {
    id: 'claude.local.settings',
    runners: ['claude'],
    kind: 'settings',
    scope: 'local',
    resolve: (repo) => join(repo, '.claude', 'settings.local.json'),
    label: '.claude/settings.local.json',
    format: 'json',
    tracked: 'gitignored',
    seeded: true,
    modelKey: 'model',
    modelKeys: ['env.ANTHROPIC_MODEL', 'model'],
    modelPriority: 3,
    precedence:
      'Highest of the file scopes — overrides project and user (permission rules merge). Git-ignored; copied into each run’s worktree so it takes effect immediately.',
    hotReload: 'Edits to most keys — including permissions and hooks — apply to a running session without a restart.',
    docsUrl: CLAUDE_SETTINGS_DOCS,
  },
  {
    id: 'claude.project.mcp',
    runners: ['claude'],
    kind: 'mcp',
    scope: 'project',
    resolve: (repo) => join(repo, '.mcp.json'),
    label: '.mcp.json',
    format: 'json',
    tracked: 'tracked',
    holdsMcp: true,
    precedence:
      'Project-scoped MCP servers (key: mcpServers), shared via version control. Each requires approval before use; user- and local-scoped servers live in ~/.claude.json, which xezar does not edit.',
    docsUrl: CLAUDE_MCP_DOCS,
  },
  {
    id: 'claude.user.memory',
    runners: ['claude'],
    kind: 'memory',
    scope: 'user',
    resolve: (_repo, home) => join(home.claude, 'CLAUDE.md'),
    label: '~/.claude/CLAUDE.md',
    format: 'markdown',
    tracked: 'outside-repo',
    precedence: 'Not overridden — every CLAUDE.md that loads is concatenated, this user file first.',
    docsUrl: CLAUDE_MEMORY_DOCS,
  },
  {
    id: 'claude.project.memory',
    runners: ['claude'],
    kind: 'memory',
    scope: 'project',
    resolve: (repo) => join(repo, 'CLAUDE.md'),
    label: 'CLAUDE.md',
    format: 'markdown',
    tracked: 'tracked',
    precedence:
      'Concatenated after the user file, not replacing it. Claude does not read AGENTS.md — import it here with @AGENTS.md. Runs read the committed copy.',
    docsUrl: CLAUDE_MEMORY_DOCS,
  },
  {
    id: 'claude.local.memory',
    runners: ['claude'],
    kind: 'memory',
    scope: 'local',
    resolve: (repo) => join(repo, 'CLAUDE.local.md'),
    label: 'CLAUDE.local.md',
    format: 'markdown',
    tracked: 'gitignored',
    seeded: true,
    precedence:
      'Loads alongside CLAUDE.md, concatenated last. Git-ignored; copied into each run’s worktree so it takes effect immediately.',
    docsUrl: CLAUDE_MEMORY_DOCS,
  },

  // ---- Codex ----
  {
    id: 'codex.user.config',
    runners: ['codex'],
    kind: 'settings',
    scope: 'user',
    resolve: (_repo, home) => join(home.codex, 'config.toml'),
    label: '~/.codex/config.toml',
    format: 'toml',
    tracked: 'outside-repo',
    holdsMcp: true,
    modelKey: 'model',
    modelProviderKey: 'model_provider',
    modelPriority: 1,
    precedence:
      'User-level defaults. A trusted project’s .codex/config.toml overrides these; some keys (provider, auth, telemetry) cannot be overridden at project scope. MCP servers live here under [mcp_servers.<id>].',
    docsUrl: CODEX_CONFIG_DOCS,
  },
  {
    id: 'codex.project.config',
    runners: ['codex'],
    kind: 'settings',
    scope: 'project',
    resolve: (repo) => join(repo, '.codex', 'config.toml'),
    label: '.codex/config.toml',
    format: 'toml',
    tracked: 'tracked',
    modelKey: 'model',
    modelPriority: 2,
    holdsMcp: true,
    precedence:
      'Applies only in projects you have trusted. Some keys (provider, auth, telemetry) cannot be overridden here. MCP servers go under [mcp_servers.<id>]. Runs read the committed copy.',
    docsUrl: CODEX_CONFIG_DOCS,
  },
  {
    id: 'codex.user.memory',
    runners: ['codex'],
    kind: 'memory',
    scope: 'user',
    resolve: (_repo, home) => join(home.codex, 'AGENTS.md'),
    label: '~/.codex/AGENTS.md',
    format: 'markdown',
    tracked: 'outside-repo',
    precedence:
      'Global instructions, read first (an AGENTS.override.md beside it wins if present). Project AGENTS.md files are concatenated after and override it.',
    docsUrl: CODEX_AGENTS_DOCS,
  },

  // ---- OpenCode ----
  {
    id: 'opencode.user.config',
    runners: ['opencode'],
    kind: 'settings',
    scope: 'user',
    resolve: (_repo, home) => join(home.opencodeConfig, 'opencode.json'),
    label: '~/.config/opencode/opencode.json',
    format: 'jsonc',
    tracked: 'outside-repo',
    holdsMcp: true,
    modelKey: 'model',
    modelPriority: 1,
    precedence:
      'Global config. Merged with the project config, not replaced — later configs override earlier ones only for conflicting keys. MCP servers live under the "mcp" key.',
    docsUrl: OPENCODE_CONFIG_DOCS,
  },
  {
    id: 'opencode.project.config',
    runners: ['opencode'],
    kind: 'settings',
    scope: 'project',
    resolve: (repo) => join(repo, 'opencode.json'),
    label: 'opencode.json',
    format: 'jsonc',
    tracked: 'tracked',
    holdsMcp: true,
    modelKey: 'model',
    modelPriority: 2,
    precedence:
      'Merged over the global config per conflicting key (not a wholesale replace). MCP servers live under the "mcp" key. Runs read the committed copy.',
    docsUrl: OPENCODE_CONFIG_DOCS,
  },
  {
    id: 'opencode.user.memory',
    runners: ['opencode'],
    kind: 'memory',
    scope: 'user',
    resolve: (_repo, home) => join(home.opencodeConfig, 'AGENTS.md'),
    label: '~/.config/opencode/AGENTS.md',
    format: 'markdown',
    tracked: 'outside-repo',
    precedence:
      'Global rules. First match wins across scopes: if a project AGENTS.md exists, this global file is not read at all.',
    docsUrl: OPENCODE_RULES_DOCS,
  },

  // ---- pi (#330 WP4) ----
  // Two files pi itself reads (settings, context) and two the `pi-mcp-adapter` extension reads.
  // Nothing else in `~/.pi/agent` is listed: `auth.json` and `models.json` both hold credentials
  // (file header), and `models-store.json`, `mcp-cache.json`, `trust.json` and `sessions/` are
  // pi's own runtime state rather than config a person edits.
  //
  // No pi entry carries `modelKey`/`modelPriority`, so `readNativeSettingsFiles('pi', …)` still
  // finds nothing and `piModelSettingsStrategy` still reports "no native default". That is
  // deliberate and is NOT an oversight to fix by adding the key: pi's model ids are
  // `provider/model` composites (`core/pi-model-catalog.ts`, and `pi --model` is handed one),
  // while its settings split the halves across `defaultProvider` and `defaultModel`, so
  // `modelKey: 'defaultModel'` alone would report a bare half that `pi --model` does not name.
  // And `.pi/settings.json` only applies in a folder pi has TRUSTED, a decision recorded in
  // `~/.pi/agent/trust.json` that xezar does not read, so a project-scope model default would be
  // a claim xezar cannot check. Wiring pi's native default is its own change: compose the two
  // halves the way `model-settings/codex.ts` already does, and settle the trust question first.
  {
    id: 'pi.user.settings',
    runners: ['pi'],
    kind: 'settings',
    scope: 'user',
    resolve: (_repo, home) => join(home.pi, 'settings.json'),
    label: '~/.pi/agent/settings.json',
    format: 'json',
    tracked: 'outside-repo',
    precedence:
      'Global (all projects). “Pi uses JSON settings files with project settings overriding global settings.” A project’s .pi/settings.json overrides this, but only in a folder pi has trusted; defaultProjectTrust and httpProxy are marked “Global setting only” and cannot be overridden at project scope.',
    docsUrl: PI_SETTINGS_DOCS,
  },
  {
    id: 'pi.project.settings',
    runners: ['pi'],
    kind: 'settings',
    scope: 'project',
    resolve: (repo) => join(repo, '.pi', 'settings.json'),
    label: '.pi/settings.json',
    format: 'json',
    tracked: 'tracked',
    precedence:
      'Project (current directory), overriding the global file key by key. Read ONLY in a folder pi has trusted: “Trusting a project allows pi to load .pi/settings.json and .pi resources” — until then pi ignores this file, and non-interactive runs (-p, --mode json, --mode rpc) never prompt and fall back to defaultProjectTrust, which defaults to “ask” and therefore ignores it. Runs read the committed copy.',
    docsUrl: PI_SETTINGS_DOCS,
  },
  {
    id: 'pi.user.mcp',
    runners: ['pi'],
    kind: 'mcp',
    scope: 'user',
    resolve: (_repo, home) => join(home.pi, 'mcp.json'),
    label: '~/.pi/agent/mcp.json',
    format: 'json',
    tracked: 'outside-repo',
    holdsMcp: true,
    precedence: `Pi global override — 4th of six sources, so both project files beat it. ${PI_MCP_PRECEDENCE} Read by the pi-mcp-adapter extension, not by pi itself: with the extension not installed pi reads no MCP config at all.`,
    docsUrl: PI_MCP_DOCS,
  },
  {
    id: 'pi.project.mcp',
    runners: ['pi'],
    kind: 'mcp',
    scope: 'project',
    resolve: (repo) => join(repo, '.pi', 'mcp.json'),
    label: '.pi/mcp.json',
    format: 'json',
    tracked: 'tracked',
    holdsMcp: true,
    precedence: `Pi project override — the HIGHEST of the six sources. ${PI_MCP_PRECEDENCE} Read by the pi-mcp-adapter extension, not by pi itself. Runs read the committed copy.`,
    docsUrl: PI_MCP_DOCS,
  },
  {
    id: 'pi.user.memory',
    runners: ['pi'],
    kind: 'memory',
    scope: 'user',
    resolve: (_repo, home) => join(home.pi, 'AGENTS.md'),
    label: '~/.pi/agent/AGENTS.md',
    format: 'markdown',
    tracked: 'outside-repo',
    precedence:
      'Global instructions, loaded first and not replaced by a project file: “Pi loads AGENTS.md or CLAUDE.md at startup from: ~/.pi/agent/AGENTS.md for global instructions, parent directories, walking up from the current working directory, the current directory.” pi therefore also reads this repo’s AGENTS.md and CLAUDE.md; those entries stay listed under the vendors whose precedence rules they carry.',
    docsUrl: PI_USAGE_DOCS,
  },

  // ---- Shared: <repo>/AGENTS.md is read by BOTH Codex and OpenCode ----
  {
    id: 'project.agents',
    runners: ['codex', 'opencode'],
    kind: 'memory',
    scope: 'project',
    resolve: (repo) => join(repo, 'AGENTS.md'),
    label: 'AGENTS.md',
    format: 'markdown',
    tracked: 'tracked',
    precedence:
      'Read by Codex and OpenCode (Claude ignores it). Codex concatenates it root-down; OpenCode uses the first match and prefers it over CLAUDE.md. Runs read the committed copy.',
    docsUrl: OPENCODE_RULES_DOCS,
  },
];

/** The whole catalog. */
export function listConfigFiles(): ConfigFileDef[] {
  return CONFIG_FILES;
}

/** Look up one entry by its stable id, or undefined when the id is unknown. */
export function findConfigFile(id: string): ConfigFileDef | undefined {
  return CONFIG_FILES.find((f) => f.id === id);
}
