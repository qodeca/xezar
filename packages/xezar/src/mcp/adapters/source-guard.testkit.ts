// The adapters' source guards (`claude-code.test.ts`, `qwen-code.test.ts`) read an adapter's own
// file as text and forbid a process, an environment read or a Node import in it. The nightly MCP
// mutation run (#377) hands those tests Stryker's instrumented copy of the file, whose header reads
// `g.process.env`, so a guard over the raw text fails that run's dry run and its whole shard
// measures nothing (#436 for Claude Code; the Qwen Code guard did the same on every night since it
// landed, #443). Both guards read the file through `guardedCode`. A testkit rather than a helper
// inside one test file, because importing a `.test.ts` file would run its suite twice; `*.testkit.ts`
// is outside the mutation scope and the coverage floor.

/**
 * The adapter's code as the source guard reads it: comments removed, and — because the nightly
 * mutation run (#377) hands the test Stryker's instrumented copy — Stryker's injected helper
 * functions removed too. Their mutant-selection helper reads `g.process.env`, which is Stryker's,
 * not the adapter's (#436). Only whole `function stry<Kind>_<hash>(…) { … }` declarations go; the
 * `stryMutAct_…`/`stryCov_…` calls stay, since they wrap the adapter's own expressions.
 */
export function guardedCode(source: string): string {
  let code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const helper = /function stry(?:NS|Cov|MutAct)_\w+\s*\([^)]*\)\s*\{/;
  for (let m = helper.exec(code); m; m = helper.exec(code)) {
    let depth = 0;
    let end = m.index + m[0].length - 1;
    for (; end < code.length; end++) {
      if (code[end] === '{') depth++;
      else if (code[end] === '}' && --depth === 0) break;
    }
    code = code.slice(0, m.index) + code.slice(end + 1);
  }
  return code;
}

/** Stryker 9's instrumentation header, as its instrumenter printed it for `claude-code.ts` (#436). */
export const STRYKER_HEADER = `function stryNS_9fa48() {
  var g = typeof globalThis === 'object' && globalThis && globalThis.Math === Math && globalThis || new Function("return this")();
  var ns = g.__stryker__ || (g.__stryker__ = {});
  if (ns.activeMutant === undefined && g.process && g.process.env && g.process.env.__STRYKER_ACTIVE_MUTANT__) {
    ns.activeMutant = g.process.env.__STRYKER_ACTIVE_MUTANT__;
  }
  function retrieveNS() {
    return ns;
  }
  stryNS_9fa48 = retrieveNS;
  return retrieveNS();
}
stryNS_9fa48();
function stryCov_9fa48() {
  var ns = stryNS_9fa48();
  var cov = ns.mutantCoverage || (ns.mutantCoverage = {
    static: {},
    perTest: {}
  });
  function cover() {
    var c = cov.static;
    if (ns.currentTestId) {
      c = cov.perTest[ns.currentTestId] = cov.perTest[ns.currentTestId] || {};
    }
    var a = arguments;
    for (var i = 0; i < a.length; i++) {
      c[a[i]] = (c[a[i]] || 0) + 1;
    }
  }
  stryCov_9fa48 = cover;
  cover.apply(null, arguments);
}
function stryMutAct_9fa48(id) {
  var ns = stryNS_9fa48();
  function isActive(id) {
    if (ns.activeMutant === id) {
      if (ns.hitCount !== void 0 && ++ns.hitCount > ns.hitLimit) {
        throw new Error('Stryker: Hit count limit reached (' + ns.hitCount + ')');
      }
      return true;
    }
    return false;
  }
  stryMutAct_9fa48 = isActive;
  return isActive(id);
}
`;
