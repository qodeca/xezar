import { describe, expect, it } from 'vitest';
import {
  CliSettingsError,
  DEFAULT_PORT,
  parseCliInvocation,
  parsePortValue,
  resolveCliSettings,
  resolveNextStartCli,
  type CliFlags,
} from './cli-settings.ts';

/**
 * The precedence and validation rules of #467 PR 2 (analysis § 6(e), both tables).
 *
 * Each `named break:` case describes a deliberate defect this file must detect. They were
 * proven red against that defect before the resolver was written — the PR body records the
 * exact failures.
 */

/** An invocation with nothing set, so a case only has to name what it is testing. */
function invoke(flags: CliFlags = {}, env: NodeJS.ProcessEnv = {}) {
  return parseCliInvocation(flags, env);
}

describe('port precedence', () => {
  it('named break `memory-over-flag`: an explicit --port beats a remembered port', () => {
    const settings = resolveCliSettings(invoke({ port: '4321' }), { rememberedPort: 4500 });
    expect(settings.port.value).toBe(4321);
    expect(settings.port.source).toBe('flag');
    // `--port 4321` is the documented way back to the old start point, so this case is also
    // the compatibility promise of the BACKWARD_COMPATIBILITY entry.
    expect(settings.port.explicit).toBe(true);
  });

  it('named break `memory-over-flag`: an explicit --port beats a project port and XEZ_PORT', () => {
    const settings = resolveCliSettings(invoke({ port: '5000' }, { XEZ_PORT: '4700' }), {
      projectPort: 4400,
      rememberedPort: 4500,
    });
    expect(settings.port.value).toBe(5000);
  });

  it('named break `env-over-stored`: the project port beats XEZ_PORT', () => {
    const settings = resolveCliSettings(invoke({}, { XEZ_PORT: '4700' }), {
      projectPort: 4400,
      rememberedPort: 4500,
    });
    expect(settings.port.value).toBe(4400);
    expect(settings.port.source).toBe('project');
  });

  it('XEZ_PORT beats the remembered port', () => {
    const settings = resolveCliSettings(invoke({}, { XEZ_PORT: '4700' }), { rememberedPort: 4500 });
    expect(settings.port.value).toBe(4700);
    expect(settings.port.source).toBe('env');
  });

  it('the remembered port beats the 4321 default', () => {
    const settings = resolveCliSettings(invoke(), { rememberedPort: 4500 });
    expect(settings.port.value).toBe(4500);
    expect(settings.port.source).toBe('memory');
    // Not explicit: only a start from memory or from the default skips other projects' ports.
    expect(settings.port.explicit).toBe(false);
  });

  it('nothing set starts at 4321', () => {
    const settings = resolveCliSettings(invoke());
    expect(settings.port).toEqual({
      value: DEFAULT_PORT,
      source: 'default',
      explicit: false,
      ephemeral: false,
    });
  });

  it('--port 0 stays ephemeral and ignores memory', () => {
    const settings = resolveCliSettings(invoke({ port: '0' }), {
      projectPort: 4400,
      rememberedPort: 4500,
    });
    expect(settings.port.value).toBe(0);
    expect(settings.port.ephemeral).toBe(true);
  });

  it('a remembered 0 is not a port to return to', () => {
    // An older xezar (or a hand edit) could leave a 0 behind. Starting "at any port" is not a
    // memory, so the default takes over rather than asking the OS for a fresh random one.
    const settings = resolveCliSettings(invoke(), { rememberedPort: 0 });
    expect(settings.port.value).toBe(DEFAULT_PORT);
    expect(settings.port.source).toBe('default');
  });
});

describe('explicit values are refused, not degraded', () => {
  const badPorts = ['43a1', '99999', '-1', '1.5', '', ' ', '0x10', '1e3', '+80', '4321 4322'];
  for (const raw of badPorts) {
    it(`--port ${JSON.stringify(raw)} refuses with the accepted values`, () => {
      expect(() => invoke({ port: raw })).toThrow(CliSettingsError);
      expect(() => invoke({ port: raw })).toThrow(/must be a whole number from 0 to 65535/);
    });
  }

  it('65535 is accepted and 65536 is not', () => {
    expect(invoke({ port: '65535' }).flagPort).toBe(65535);
    expect(() => invoke({ port: '65536' })).toThrow(CliSettingsError);
  });

  it('XEZ_PORT is explicit too — a typo in a shell profile refuses the start', () => {
    expect(() => invoke({}, { XEZ_PORT: '99999' })).toThrow(/XEZ_PORT must be a whole number/);
  });

  it('an empty XEZ_PORT is absent, not a zero', () => {
    expect(invoke({}, { XEZ_PORT: '' }).envPort).toBeUndefined();
  });

  it('a bad enum names every accepted value', () => {
    expect(() => invoke({ output: 'fancy' })).toThrow('--output must be one of auto, lines, rich — got “fancy”.');
    expect(() => invoke({ color: 'sometimes' })).toThrow(/--color must be one of auto, always, never/);
    expect(() => invoke({ logLevel: 'verbose' })).toThrow(/--log-level must be one of debug, info, warn, error/);
    expect(() => invoke({}, { XEZ_LOG_LEVEL: 'verbose' })).toThrow(/XEZ_LOG_LEVEL must be one of/);
  });
});

describe('output and log level: CLI > stored > env > default', () => {
  it('named break `env-over-stored`: a stored output beats XEZ_OUTPUT', () => {
    const settings = resolveCliSettings(invoke({}, { XEZ_OUTPUT: 'rich' }), {
      workspace: { output: 'lines' },
    });
    expect(settings.output).toBe('lines');
  });

  it('named break `env-over-stored`: a stored log level beats XEZ_LOG_LEVEL', () => {
    const settings = resolveCliSettings(invoke({}, { XEZ_LOG_LEVEL: 'debug' }), {
      workspace: { logLevel: 'warn' },
    });
    expect(settings.effectiveLogLevel).toBe('warn');
  });

  it('a flag beats both', () => {
    const settings = resolveCliSettings(
      invoke({ output: 'rich', logLevel: 'debug' }, { XEZ_OUTPUT: 'lines', XEZ_LOG_LEVEL: 'error' }),
      { workspace: { output: 'lines', logLevel: 'error' } },
    );
    expect(settings.output).toBe('rich');
    expect(settings.logLevel).toBe('debug');
  });

  it('the environment is used when nothing is stored', () => {
    const settings = resolveCliSettings(invoke({}, { XEZ_OUTPUT: 'rich', XEZ_LOG_LEVEL: 'debug' }));
    expect(settings.output).toBe('rich');
    expect(settings.logLevel).toBe('debug');
  });

  it('nothing set is auto/info', () => {
    const settings = resolveCliSettings(invoke());
    expect(settings.output).toBe('auto');
    expect(settings.logLevel).toBe('info');
    expect(settings.effectiveLogLevel).toBe('info');
  });
});

describe('colour: transport > --color > NO_COLOR > stored > XEZ_COLOR > auto', () => {
  it('--color beats NO_COLOR', () => {
    const settings = resolveCliSettings(invoke({ color: 'always' }, { NO_COLOR: '1' }));
    expect(settings.color).toBe('always');
    expect(settings.colorEnabled).toBe(true);
  });

  it('NO_COLOR beats a stored colour and XEZ_COLOR', () => {
    const settings = resolveCliSettings(invoke({}, { NO_COLOR: '1', XEZ_COLOR: 'always' }), {
      workspace: { color: 'always' },
    });
    expect(settings.color).toBe('never');
    expect(settings.colorEnabled).toBe(false);
  });

  it('an empty NO_COLOR is not set — the published rule is presence with a value', () => {
    const settings = resolveCliSettings(invoke({}, { NO_COLOR: '', XEZ_COLOR: 'always' }));
    expect(settings.color).toBe('always');
  });

  it('a stored colour beats XEZ_COLOR', () => {
    const settings = resolveCliSettings(invoke({}, { XEZ_COLOR: 'always' }), {
      workspace: { color: 'never' },
    });
    expect(settings.color).toBe('never');
  });

  it('auto follows the transport, and a plain transport beats even --color always', () => {
    expect(resolveCliSettings(invoke(), {}, { isTty: true }).colorEnabled).toBe(true);
    expect(resolveCliSettings(invoke(), {}, { isTty: false }).colorEnabled).toBe(false);
    expect(
      resolveCliSettings(invoke({ color: 'always' }), {}, { isTty: true, plainTransport: true })
        .colorEnabled,
    ).toBe(false);
  });
});

describe('quiet', () => {
  it('--quiet > XEZ_QUIET > false', () => {
    expect(resolveCliSettings(invoke()).quiet).toBe(false);
    expect(resolveCliSettings(invoke({}, { XEZ_QUIET: '1' })).quiet).toBe(true);
    expect(resolveCliSettings(invoke({ quiet: true }, { XEZ_QUIET: '0' })).quiet).toBe(true);
    // Only the exact `1` turns it on, like every other 0/1 variable in this repo.
    expect(resolveCliSettings(invoke({}, { XEZ_QUIET: 'true' })).quiet).toBe(false);
  });

  it('quiet raises the threshold but never lowers one that was set higher', () => {
    expect(resolveCliSettings(invoke({ quiet: true })).effectiveLogLevel).toBe('warn');
    expect(
      resolveCliSettings(invoke({ quiet: true, logLevel: 'error' })).effectiveLogLevel,
    ).toBe('error');
    expect(
      resolveCliSettings(invoke({ quiet: true, logLevel: 'debug' })).effectiveLogLevel,
    ).toBe('warn');
  });
});

describe('stored values degrade to absent with one warning', () => {
  it('a mangled stored port is ignored and named', () => {
    const settings = resolveCliSettings(invoke(), { projectPort: 'abc', rememberedPort: 4500 });
    expect(settings.port.value).toBe(4500);
    expect(settings.warnings).toEqual([
      expect.stringContaining('projects[].cli.port is “abc”'),
    ]);
  });

  it('a mangled stored enum is ignored and named, and the environment takes over', () => {
    const settings = resolveCliSettings(invoke({}, { XEZ_OUTPUT: 'rich' }), {
      workspace: { output: 'fancy', color: 42, logLevel: null },
    });
    expect(settings.output).toBe('rich');
    expect(settings.color).toBe('auto');
    expect(settings.logLevel).toBe('info');
    // `null` is absent, not broken — only the two real values warn.
    expect(settings.warnings).toHaveLength(2);
  });

  it('a stored value never refuses the start', () => {
    expect(() =>
      resolveCliSettings(invoke(), { projectPort: -7, workspace: { logLevel: 'shout' } }),
    ).not.toThrow();
  });
});

describe('parsePortValue', () => {
  it('accepts whole numbers in range in both spellings', () => {
    expect(parsePortValue('0')).toBe(0);
    expect(parsePortValue(4321)).toBe(4321);
    expect(parsePortValue(' 4321 ')).toBe(4321);
  });

  it('rejects everything that is not one', () => {
    for (const raw of [NaN, 1.5, -1, 65536, '', 'x', null, undefined, {}, [], true, Infinity]) {
      expect(parsePortValue(raw)).toBeNull();
    }
  });
});

/**
 * The instance mode (#467 PR 1, spec § 2.1–2.2). Four rows of precedence and the two
 * failure modes, each proven red against the named break the PR body records.
 */
describe('instance mode precedence', () => {
  it('AC-1.1 nothing set resolves the workspace default', () => {
    // The 2026-09-20 owner decision: `workspace` stays the default, `project` is opt-in.
    expect(resolveCliSettings(invoke()).instance).toBe('workspace');
  });

  it('--instance beats the stored key and the environment', () => {
    const settings = resolveCliSettings(
      invoke({ instance: 'project' }, { XEZ_INSTANCE: 'workspace' }),
      { workspace: { instance: 'workspace' } },
    );
    expect(settings.instance).toBe('project');
  });

  it('AC-1.2 named break `env-beats-stored`: the stored key beats XEZ_INSTANCE', () => {
    // A variable exported once in a shell profile must not outrank a saved preference —
    // the same rule `output` and `logLevel` follow.
    const settings = resolveCliSettings(invoke({}, { XEZ_INSTANCE: 'workspace' }), {
      workspace: { instance: 'project' },
    });
    expect(settings.instance).toBe('project');
  });

  it('XEZ_INSTANCE beats the default', () => {
    expect(resolveCliSettings(invoke({}, { XEZ_INSTANCE: 'project' })).instance).toBe('project');
  });

  it('an empty XEZ_INSTANCE is absent, not a value', () => {
    expect(resolveCliSettings(invoke({}, { XEZ_INSTANCE: '   ' })).instance).toBe('workspace');
  });

  it('AC-1.3 named break `explicit-bad-value-passes`: --instance projekt refuses, naming both values', () => {
    expect(() => invoke({ instance: 'projekt' })).toThrow(CliSettingsError);
    expect(() => invoke({ instance: 'projekt' })).toThrow(/--instance must be one of project, workspace/);
  });

  it('AC-1.3 XEZ_INSTANCE is explicit too — a typo in a shell profile refuses the start', () => {
    expect(() => invoke({}, { XEZ_INSTANCE: 'projekt' })).toThrow(CliSettingsError);
    expect(() => invoke({}, { XEZ_INSTANCE: 'projekt' })).toThrow(
      /XEZ_INSTANCE must be one of project, workspace/,
    );
  });

  it('AC-1.4 named break `stored-bad-value-refuses`: a mangled cli.instance degrades with exactly one warning', () => {
    const settings = resolveCliSettings(invoke(), { workspace: { instance: 'projekt' } });
    expect(settings.instance).toBe('workspace');
    expect(settings.warnings).toEqual([expect.stringContaining('cli.instance is “projekt”')]);
  });

  it('AC-1.4 a mangled cli.instance never throws, and the environment takes over', () => {
    const settings = resolveCliSettings(invoke({}, { XEZ_INSTANCE: 'project' }), {
      workspace: { instance: 'projekt' },
    });
    expect(settings.instance).toBe('project');
    expect(settings.warnings).toHaveLength(1);
  });

  it('an absent stored key is silent — absence is not a defect', () => {
    const settings = resolveCliSettings(invoke(), { workspace: { instance: null } });
    expect(settings.instance).toBe('workspace');
    expect(settings.warnings).toEqual([]);
  });
});

/**
 * #467 PR 5: what the Settings route reports for the NEXT plain start. It hands a flag-less
 * invocation to `resolveCliSettings`, so these pin the parts that are its own: the lenient
 * environment, the stored value parsed, and which layer decided.
 */
describe('resolveNextStartCli', () => {
  it('reports the defaults, with nothing stored and nothing set', () => {
    expect(resolveNextStartCli(undefined, {})).toEqual({
      instance: { stored: null, effective: 'workspace', source: 'default' },
      output: { stored: null, effective: 'auto', source: 'default' },
      color: { stored: null, effective: 'auto', source: 'default' },
      logLevel: { stored: null, effective: 'info', source: 'default' },
    });
  });

  it('stored beats the variable, and the variable beats the default', () => {
    const next = resolveNextStartCli(
      { instance: 'workspace', output: 'rich' },
      { XEZ_INSTANCE: 'project', XEZ_OUTPUT: 'lines', XEZ_LOG_LEVEL: 'warn', XEZ_COLOR: 'always' },
    );
    expect(next.instance).toEqual({ stored: 'workspace', effective: 'workspace', source: 'stored' });
    expect(next.output).toEqual({ stored: 'rich', effective: 'rich', source: 'stored' });
    expect(next.logLevel).toEqual({ stored: null, effective: 'warn', source: 'env' });
    expect(next.color).toEqual({ stored: null, effective: 'always', source: 'env' });
  });

  it('NO_COLOR outranks a stored colour and is named as the source', () => {
    expect(resolveNextStartCli({ color: 'always' }, { NO_COLOR: '1' }).color).toEqual({
      stored: 'always',
      effective: 'never',
      source: 'no-color',
    });
  });

  /** A settings read is not a start: a bad variable reads as unset rather than throwing (A9 is the start's). */
  it('reads a bad stored value or a bad variable as absent, and never throws', () => {
    const next = resolveNextStartCli({ instance: 'projekt', logLevel: 7 }, { XEZ_INSTANCE: 'both', XEZ_OUTPUT: '' });
    expect(next.instance).toEqual({ stored: null, effective: 'workspace', source: 'default' });
    expect(next.logLevel).toEqual({ stored: null, effective: 'info', source: 'default' });
    expect(next.output.source).toBe('default');
  });
});
