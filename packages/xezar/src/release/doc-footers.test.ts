import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TEST_DIR_RM_OPTIONS } from '../../test/helpers/platform.ts';
import { footerPages, footerVersions, readDocFooters, stampDocFooters, stampFooterText } from './doc-footers.ts';

const page = (title: string, footer?: string) =>
  `# ${title}\n\nA short page about getting started.\n${footer === undefined ? '' : `\nDescribes xezar ${footer}.\n`}`;

describe('stampFooterText', () => {
  it('rewrites every footer line to the new version', () => {
    const text = `${page('Overview', '1.2.3')}\nMore notes.\n\nDescribes xezar 1.0.0.\n`;
    const stamped = stampFooterText(text, '1.3.0');
    expect(footerVersions(stamped)).toEqual(['1.3.0', '1.3.0']);
    expect(stamped).toBe(`${page('Overview', '1.3.0')}\nMore notes.\n\nDescribes xezar 1.3.0.\n`);
  });

  it('leaves a mention that is not a whole footer line alone', () => {
    const text = 'This page Describes xezar 1.2.3. in passing.\n  Describes xezar 1.2.3.\nDescribes xezar 1.2.3. More\n';
    expect(stampFooterText(text, '2.0.0')).toBe(text);
  });

  it('keeps Windows line endings', () => {
    const text = '# Overview\r\n\r\nDescribes xezar 1.2.3.\r\n';
    expect(stampFooterText(text, '1.2.4')).toBe('# Overview\r\n\r\nDescribes xezar 1.2.4.\r\n');
  });

  it('writes the version literally, never as a replacement pattern', () => {
    expect(stampFooterText(page('Overview', '1.2.3'), '$&')).toBe(page('Overview', '$&'));
  });

  it('refuses a version a footer could not read back', () => {
    expect(() => stampFooterText(page('Overview', '1.2.3'), '')).toThrow(/cannot stamp/);
    expect(() => stampFooterText(page('Overview', '1.2.3'), '1.2.3 beta')).toThrow(/cannot stamp/);
  });
});

describe('documentation pages on disk', () => {
  let root: string;
  const write = (rel: string, text: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text, 'utf8');
  };
  const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'xez-doc-footers-'));
    write('docs/overview.md', page('Overview', '1.2.3'));
    write('docs/guide/01-start.md', page('Start', '1.2.3'));
    write('docs/guide/02-current.md', page('Already current', '1.3.0'));
    write('docs/guide/README.md', page('Contents'));
    write('docs/guide/features/nested.md', page('Nested, not a dated record', '1.2.3'));
    write('docs/features/2020-01-01-record.md', page('Dated record', '0.9.0'));
    write('docs/lessons/a-lesson.md', page('Dated lesson', '0.9.0'));
    write('docs/notes.txt', 'Describes xezar 1.2.3.\n');
    write('README.md', page('Outside the documentation root', '1.2.3'));
  });
  afterEach(() => rmSync(root, TEST_DIR_RM_OPTIONS));

  it('lists the Markdown pages under docs/, skipping only the top-level dated records', () => {
    expect(footerPages(root)).toEqual([
      'docs/guide/01-start.md',
      'docs/guide/02-current.md',
      'docs/guide/README.md',
      'docs/guide/features/nested.md',
      'docs/overview.md',
    ]);
  });

  it('reads every footer with its page', () => {
    expect(readDocFooters(root)).toEqual([
      { file: 'docs/guide/01-start.md', version: '1.2.3' },
      { file: 'docs/guide/02-current.md', version: '1.3.0' },
      { file: 'docs/guide/features/nested.md', version: '1.2.3' },
      { file: 'docs/overview.md', version: '1.2.3' },
    ]);
  });

  it('restamps the stale footers in place and names exactly the pages it changed', () => {
    expect(stampDocFooters(root, '1.3.0')).toEqual([
      'docs/guide/01-start.md',
      'docs/guide/features/nested.md',
      'docs/overview.md',
    ]);
    expect(readDocFooters(root).map((footer) => footer.version)).toEqual(['1.3.0', '1.3.0', '1.3.0', '1.3.0']);
    expect(read('docs/guide/01-start.md')).toBe(page('Start', '1.3.0'));
    // Untouched: the dated records, a page with no footer, a non-Markdown file, and anything
    // outside the documentation root.
    expect(read('docs/features/2020-01-01-record.md')).toBe(page('Dated record', '0.9.0'));
    expect(read('docs/lessons/a-lesson.md')).toBe(page('Dated lesson', '0.9.0'));
    expect(read('docs/guide/README.md')).toBe(page('Contents'));
    expect(read('docs/notes.txt')).toBe('Describes xezar 1.2.3.\n');
    expect(read('README.md')).toBe(page('Outside the documentation root', '1.2.3'));
  });

  it('changes nothing when every footer already names the version', () => {
    stampDocFooters(root, '1.3.0');
    expect(stampDocFooters(root, '1.3.0')).toEqual([]);
  });

  it('fails when there is no documentation root, rather than stamping nothing', () => {
    rmSync(join(root, 'docs'), TEST_DIR_RM_OPTIONS);
    expect(() => stampDocFooters(root, '1.3.0')).toThrow();
  });
});
