import { agentHomePaths } from '../paths.ts';
import type { ModelOption } from './runner-model-catalog.ts';
import { readQwenSettings, type QwenSettings } from './qwen-settings.ts';

/**
 * Qwen Code model discovery (#1044): the person's own `modelProviders` entries, read from
 * `<QWEN_HOME>/settings.json`. Only the id, name, auth type and endpoint locality are used; the
 * endpoint key is a variable NAME there and is never read either.
 *
 * Degradation: no settings file is a real "no models" (`[]`), an
 * unreadable one throws so the catalog says the list could not be read.
 */
export async function discoverQwenModels(
  options: { home?: string; read?: (home: string) => QwenSettings } = {},
): Promise<ModelOption[]> {
  const settings = (options.read ?? readQwenSettings)(options.home ?? agentHomePaths().qwen);
  if (settings.status === 'unreadable') throw new Error('Qwen Code settings.json could not be read');
  return qwenModelOptions(settings);
}

/** The picker options for a settings answer, the person's default first. */
export function qwenModelOptions(settings: QwenSettings): ModelOption[] {
  const seen = new Set<string>();
  const options: ModelOption[] = [];
  const ordered = [...settings.models].sort((a, b) => Number(b.id === settings.defaultModel) - Number(a.id === settings.defaultModel));
  for (const model of ordered) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    const option: ModelOption = {
      id: model.id,
      label: model.name ?? model.id,
      description: `${model.authType}${model.id === settings.defaultModel ? ' · your Qwen Code default' : ''}`,
    };
    if (model.local) option.local = true;
    options.push(option);
  }
  return options;
}
