import { describe, expect, it } from 'vitest';
import { discoverPiModels, parsePiModels } from './pi-model-catalog.ts';

/**
 * The host shape #152 was reported on: pi configured with exactly ONE provider serving exactly
 * one model, and none of the three ids the picker used to hard-code. Kept verbatim (minus the
 * `apiKey`, which discovery must never touch) so the regression it pins is the real one.
 */
const MODELS_JSON = JSON.stringify({
  providers: {
    'dgx-spark': {
      name: 'DGX Spark',
      baseUrl: 'http://example.invalid/v1',
      apiKey: 'MUST-NEVER-BE-READ',
      api: 'openai-completions',
      compat: true,
      models: [{ id: 'deepseek-v4-flash-vision' }],
    },
  },
});

const SETTINGS_JSON = JSON.stringify({
  defaultProvider: 'dgx-spark',
  defaultModel: 'deepseek-v4-flash-vision',
  theme: 'dark',
});

/** A reader over an in-memory `~/.pi/agent`, so no case ever touches a real home. */
function reader(files: Record<string, string>) {
  return (path: string): Promise<string> => {
    const name = path.split('/').pop() ?? '';
    const body = files[name];
    if (body === undefined) {
      const error = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      return Promise.reject(error);
    }
    return Promise.resolve(body);
  };
}

describe('pi model discovery (#152)', () => {
  it('lists the models pi is configured with, as `provider/model`', async () => {
    const models = await discoverPiModels({
      home: '/fake/.pi/agent',
      readFile: reader({ 'models.json': MODELS_JSON, 'settings.json': SETTINGS_JSON }),
    });
    expect(models.map((m) => m.id)).toEqual(['dgx-spark/deepseek-v4-flash-vision']);
    expect(models[0]?.description).toBe('via DGX Spark');
  });

  it('offers nothing the host has not configured', async () => {
    // The exact defect: three vendor ids the picker used to hard-code, on a host with neither
    // provider. Discovery may not invent them back.
    const models = await discoverPiModels({
      home: '/fake/.pi/agent',
      readFile: reader({ 'models.json': MODELS_JSON, 'settings.json': SETTINGS_JSON }),
    });
    const ids = models.map((m) => m.id);
    for (const invented of ['anthropic/claude-opus-4-8', 'anthropic/claude-sonnet-5', 'openai/gpt-5.1']) {
      expect(ids).not.toContain(invented);
    }
  });

  it('never reads a credential into a picker entry', async () => {
    const models = await discoverPiModels({
      home: '/fake/.pi/agent',
      readFile: reader({ 'models.json': MODELS_JSON, 'settings.json': SETTINGS_JSON }),
    });
    expect(JSON.stringify(models)).not.toContain('MUST-NEVER-BE-READ');
    expect(JSON.stringify(models)).not.toContain('apiKey');
  });

  it('reads `auth.json` never — only the two files it names', async () => {
    const touched: string[] = [];
    await discoverPiModels({
      home: '/fake/.pi/agent',
      readFile: (path) => {
        touched.push(path.split('/').pop() ?? '');
        return reader({ 'models.json': MODELS_JSON, 'settings.json': SETTINGS_JSON })(path);
      },
    });
    expect(touched).toEqual(['models.json', 'settings.json']);
  });

  it('degrades to no models when pi has no config at all', async () => {
    // The zero-config path: pi installed, nothing configured. An empty catalog leaves the picker
    // showing `auto` alone, and the route still answers.
    await expect(discoverPiModels({ home: '/fake/.pi/agent', readFile: reader({}) })).resolves.toEqual([]);
  });

  it('reports unavailable rather than "no models" when the config cannot be read', async () => {
    const denied = (): Promise<string> => {
      const error = new Error('EACCES') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      return Promise.reject(error);
    };
    await expect(discoverPiModels({ home: '/fake/.pi/agent', readFile: denied })).rejects.toThrow(
      /could not be read/,
    );
  });

  it('reports unavailable on a config it cannot parse', async () => {
    await expect(
      discoverPiModels({ home: '/fake/.pi/agent', readFile: reader({ 'models.json': '{ truncated' }) }),
    ).rejects.toThrow(/not valid JSON/);
  });

  it('reports unavailable on a shape with no providers key', async () => {
    await expect(
      discoverPiModels({ home: '/fake/.pi/agent', readFile: reader({ 'models.json': '{"schema":9}' }) }),
    ).rejects.toThrow(/no providers/);
  });

  it('a configured but empty provider list is a real "no models", not a failure', async () => {
    const models = await discoverPiModels({
      home: '/fake/.pi/agent',
      readFile: reader({ 'models.json': '{"providers":{}}' }),
    });
    expect(models).toEqual([]);
  });

  it('survives a missing, unreadable or broken settings.json — it only orders', async () => {
    const withoutSettings = await discoverPiModels({
      home: '/fake/.pi/agent',
      readFile: reader({ 'models.json': MODELS_JSON }),
    });
    expect(withoutSettings.map((m) => m.id)).toEqual(['dgx-spark/deepseek-v4-flash-vision']);
    expect(parsePiModels(MODELS_JSON, '{ not json').map((m) => m.id)).toEqual([
      'dgx-spark/deepseek-v4-flash-vision',
    ]);
  });
});

describe('parsePiModels', () => {
  const TWO_PROVIDERS = JSON.stringify({
    providers: {
      alpha: { name: 'Alpha', models: [{ id: 'a-one' }, { id: 'a-two' }] },
      beta: { models: [{ id: 'b-one' }] },
    },
  });

  it('preserves the file order and falls back to the provider id as the label', () => {
    expect(parsePiModels(TWO_PROVIDERS)).toEqual([
      { id: 'alpha/a-one', label: 'alpha/a-one', description: 'via Alpha' },
      { id: 'alpha/a-two', label: 'alpha/a-two', description: 'via Alpha' },
      { id: 'beta/b-one', label: 'beta/b-one', description: 'via beta' },
    ]);
  });

  it('floats pi’s own default pair to the front', () => {
    const ids = parsePiModels(
      TWO_PROVIDERS,
      JSON.stringify({ defaultProvider: 'beta', defaultModel: 'b-one' }),
    ).map((m) => m.id);
    expect(ids).toEqual(['beta/b-one', 'alpha/a-one', 'alpha/a-two']);
  });

  it('ignores a default naming a model the providers do not serve', () => {
    const ids = parsePiModels(
      TWO_PROVIDERS,
      JSON.stringify({ defaultProvider: 'gone', defaultModel: 'nothing' }),
    ).map((m) => m.id);
    expect(ids).toEqual(['alpha/a-one', 'alpha/a-two', 'beta/b-one']);
  });

  it('skips entries it cannot read rather than guessing at them', () => {
    const messy = JSON.stringify({
      providers: {
        good: { models: [{ id: 'ok' }, { id: '' }, { name: 'no id' }, 'not-an-object', null] },
        'bad name!': { models: [{ id: 'ok' }] },
        alsoBad: { models: 'not-an-array' },
        nullish: null,
      },
    });
    expect(parsePiModels(messy).map((m) => m.id)).toEqual(['good/ok']);
  });

  it('de-duplicates a provider that lists the same model twice', () => {
    const dupes = JSON.stringify({ providers: { p: { models: [{ id: 'm' }, { id: 'm' }] } } });
    expect(parsePiModels(dupes).map((m) => m.id)).toEqual(['p/m']);
  });

  it('refuses a provider list past the size cap', () => {
    const many = Array.from({ length: 501 }, (_, i) => ({ id: `m${i}` }));
    expect(() => parsePiModels(JSON.stringify({ providers: { p: { models: many } } }))).toThrow(
      /size limit/,
    );
  });
});
