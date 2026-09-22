import type { Runner } from '@qodeca/xezar-contract';

/**
 * How each coding agent is INSTALLED (#838 E5) — the one place that text lives.
 *
 * Two sets of hints used to carry it: the health checks (`backend-detect.ts`) named the install
 * command, and the provider sign-in rows (`provider-auth.ts`, which `discover_project` and
 * `xez providers connect` read) named only the login. Two sources can drift apart, and had: the
 * reason a leader was given for "not installed" named no way to install. Both now read this table.
 *
 * `null` means xezar knows no install command or page for that agent, and every reader says so
 * rather than inventing one.
 */
export type ProviderInstall = { readonly kind: 'command' | 'url'; readonly value: string } | null;

export const PROVIDER_INSTALL: Readonly<Record<Runner, ProviderInstall>> = {
  claude: { kind: 'command', value: 'npm i -g @anthropic-ai/claude-code' },
  codex: { kind: 'command', value: 'npm i -g @openai/codex' },
  opencode: { kind: 'url', value: 'https://opencode.ai' },
  pi: null,
};

/**
 * The install step in the sign-in rows' voice: `Install <name> (<how>), then run <login>.` A
 * command is quoted so a reader copies it exactly; a page is named with "from"; an unknown one is
 * stated as unknown.
 */
export function installThenLogin(provider: Runner, name: string, login: string): string {
  const install = PROVIDER_INSTALL[provider];
  const how =
    install === null
      ? 'xezar knows no install command for it; follow its own instructions'
      : install.kind === 'command'
        ? `\`${install.value}\``
        : `from ${install.value}`;
  return `Install ${name} (${how}), then run \`${login}\`.`;
}

/** The install step in the health checks' voice: ` (<how>)`, or nothing when none is known. */
export function installParenthetical(provider: Runner): string {
  const install = PROVIDER_INSTALL[provider];
  return install === null ? '' : ` (${install.value})`;
}
