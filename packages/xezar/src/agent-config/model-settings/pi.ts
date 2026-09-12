import { firstConfiguredModel, readNativeSettingsFiles } from './shared.ts';
import type { AgentModelSettingsStrategy } from './types.ts';

/**
 * pi's native-settings policy, expressed the same way every other runner's is.
 *
 * The catalog names pi's settings files as of #330 WP4, but neither carries `modelKey` or
 * `modelPriority`, so `readNativeSettingsFiles` still selects none and this still reports "no
 * native default" — the cockpit falls back to xezar's own preset for pi, as it does for a runner
 * whose config file the user has never written.
 *
 * That is a deliberate hold, not a leftover. Adding `modelKey: 'defaultModel'` would make this
 * report the BARE half of a pi model id: pi's ids are `provider/model` composites
 * (`core/pi-model-catalog.ts` builds them, and `pi --model` is handed one), while `settings.json`
 * splits them across `defaultProvider` and `defaultModel`. Honoring pi's native default means
 * composing the two halves the way `codex.ts` already does — plus settling what a PROJECT-scope
 * default means when pi only loads `.pi/settings.json` in a folder it has trusted, a decision in
 * `~/.pi/agent/trust.json` that xezar does not read. `catalog.ts`'s pi block carries the same note.
 */
export const piModelSettingsStrategy: AgentModelSettingsStrategy = {
  runner: 'pi',
  async read(repoRoot, env) {
    return { model: firstConfiguredModel(await readNativeSettingsFiles('pi', repoRoot, env)) };
  },
};
