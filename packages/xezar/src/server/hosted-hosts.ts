import { listServerInstances } from '../server-install/state.ts';
import { normalizeHostname } from './capabilities.ts';

/**
 * Which `Host` names a hosted cockpit answers to (#426 follow-up).
 *
 * Hosted mode used to skip the Host check entirely. That is only safe when the
 * listener is unreachable from a browser on the same machine — and the
 * installers keep the cockpit on loopback behind a local proxy (nginx, ngrok),
 * so a browser on that machine can still reach it under a foreign name. The
 * `Host` header is the one value page script cannot choose, so it stays the
 * discriminator, exactly as in local mode.
 *
 * The allowed names are DISCOVERED, never configured (AGENTS.md § Zero config):
 * the installer already records each instance's public domain (`domain`,
 * `publicUrl`) in the host-level state it writes under the xezar home, and the
 * service runs as the same user, so an existing install keeps working after an
 * upgrade without touching its unit or plist. An ngrok install without a
 * reserved domain gets a fresh hostname on every restart; those always sit
 * under ngrok's own zones, whose DNS no third party controls.
 *
 * When nothing on this host records a public name (a hand-run `XEZ_REMOTE=1`,
 * an install whose domain was never entered), there is nothing to compare
 * against, so the check stays open there — `allowsHost` answers `undefined`
 * and the caller logs that once.
 */

/** ngrok-owned base domains (https://ngrok.com/docs/domains, 2026-10-18). */
const NGROK_ZONES = ['ngrok-free.app', 'ngrok-free.dev', 'ngrok-free.pizza', 'ngrok.app', 'ngrok.dev', 'ngrok.pizza', 'ngrok.io'];

const IPV4_LITERAL = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/** True for an IP-literal hostname (canonical `normalizeHostname` output).
 *  A browser sends an IP literal as `Host` only after connecting to that very
 *  address, so such a request cannot be a re-pointed name. */
export function isIpLiteralHostname(hostname: string): boolean {
  return IPV4_LITERAL.test(hostname) || hostname.includes(':');
}

export interface HostedHostPolicy {
  /** Exact public names recorded by the installer. */
  names: Set<string>;
  /** An ngrok install is recorded: names under ngrok's zones are its tunnel. */
  ngrok: boolean;
}

/** Read the public names every recorded install on this host answers on. Never throws. */
export function hostedHostPolicy(): HostedHostPolicy {
  const names = new Set<string>();
  let ngrok = false;
  let instances: ReturnType<typeof listServerInstances> = [];
  try {
    instances = listServerInstances();
  } catch {
    instances = [];
  }
  for (const { state } of instances) {
    if (!state.platform || state.dryRun) continue;
    if (state.platform === 'macosx-ngrok') ngrok = true;
    const domain = state.domain ? normalizeHostname(state.domain.trim()) : '';
    if (domain) names.add(domain);
    if (state.publicUrl) {
      try {
        const fromUrl = normalizeHostname(new URL(state.publicUrl).host);
        if (fromUrl) names.add(fromUrl);
      } catch {
        // display-only field; an unparseable value adds nothing
      }
    }
  }
  return { names, ngrok };
}

/**
 * Whether a hosted cockpit should serve a request whose canonical, non-loopback
 * `Host` hostname is `hostname`. `true` / `false` when the host records what it
 * answers on; `undefined` when it records nothing (the check cannot decide).
 */
export function allowsHost(hostname: string, policy: HostedHostPolicy = hostedHostPolicy()): boolean | undefined {
  if (!hostname) return policy.names.size > 0 || policy.ngrok ? false : undefined;
  if (isIpLiteralHostname(hostname)) return true;
  if (policy.names.size === 0 && !policy.ngrok) return undefined;
  if (policy.names.has(hostname)) return true;
  return policy.ngrok && NGROK_ZONES.some((zone) => hostname.endsWith(`.${zone}`));
}
