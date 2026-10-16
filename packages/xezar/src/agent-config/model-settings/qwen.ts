import { firstConfiguredModel, readNativeSettingsFiles } from './shared.ts';
import type { AgentModelSettingsStrategy } from './types.ts';

/**
 * Qwen Code's native default model: `model.name` in its settings, the project file over the
 * person's own (#1044). The id is a `modelProviders` entry's own id and is used verbatim.
 */
export const qwenModelSettingsStrategy: AgentModelSettingsStrategy = {
  runner: 'qwen',
  async read(repoRoot, env) {
    return { model: firstConfiguredModel(await readNativeSettingsFiles('qwen', repoRoot, env)) };
  },
};
