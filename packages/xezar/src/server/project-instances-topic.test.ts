import { describe, expect, it } from 'vitest';
import type { ProjectInstance, ProjectInstancesTopic } from '@qodeca/xezar-contract';
import { InstanceLiveness, type ProbeAnswer } from './instance-liveness.ts';
import {
  projectInstancesTopic,
  type InstanceAnswers,
  type ProjectInstancesTopicDeps,
} from './project-instances-topic.ts';

/**
 * The `project-instances` topic (#796, found in QA of #467 PR 4).
 *
 * The defect it closes is not a wrong answer but a frozen one: the band that renders
 * `ProjectListEntry.instance` reads it once at page load, and the honest first answer for a
 * project with a remembered address is `checking` — so a cockpit opened while `xez` is still
 * booting renders `checking…` for every other project and never asks again, and a project that
 * stops keeps its link to a dead port.
 *
 * Two named breaks live here:
 *
 * - `BREAK-796-SNAPSHOT-DOES-NOT-SETTLE` — drop the `await settled()` from the derive and the
 *   snapshot hands a just-subscribed cockpit the same `checking` its page-load read gave it.
 * - `BREAK-796-PUBLISH-EVERY-TICK` — publish on every tick rather than on a change and every
 *   subscriber's reducer wakes every five seconds for news nobody had.
 *
 * And the demand-driven property the whole bus exists for: the publisher runs between `start` and
 * the stop it returns, and not one tick outside them.
 */

const BOOT = 'xezar';

/** A registry the way `read` hands it over: two siblings with a remembered address, one without. */
const ROWS = [
  { id: BOOT, root: '/p/xezar', lastListen: { host: '127.0.0.1', port: 4400 } },
  { id: 'shop', root: '/p/shop', lastListen: { host: '127.0.0.1', port: 4401 } },
  { id: 'blog', root: '/p/blog', lastListen: undefined },
];

/** A liveness checker driven by a mutable "which ports answer" set, so a case can stop and start a
 *  sibling between two ticks the way the QA reproduction did. */
function liveness(answering: Set<number>, claims: Set<string> = new Set()) {
  let probes = 0;
  const checker = new InstanceLiveness({
    probe: async ({ port }): Promise<ProbeAnswer> => {
      probes += 1;
      if (!answering.has(port)) return { kind: 'no-answer' };
      // The identity check is the route's, not this topic's: port 4401 is shop's cockpit.
      return { kind: 'named', bootProject: port === 4401 ? 'shop' : 'blog' };
    },
    claimLive: (root) => claims.has(root),
    // Zero, so a case controls staleness by its own calls rather than by a clock: every derive
    // re-probes, which is what makes "stop the sibling, tick again" a two-line test.
    cacheMs: 0,
  });
  return { checker, probes: () => probes };
}

function topic(deps: Partial<ProjectInstancesTopicDeps> & { liveness: InstanceAnswers }) {
  return projectInstancesTopic({
    read: async () => ({ projects: ROWS, bootProject: BOOT }),
    recheckMs: 5,
    ...deps,
  });
}

const states = (frame: ProjectInstancesTopic): Record<string, ProjectInstance['state']> =>
  Object.fromEntries(Object.entries(frame.projects).map(([id, value]) => [id, value.state]));

describe('project-instances topic', () => {
  it('answers a subscriber with SETTLED liveness, never the page-load `checking`', async () => {
    const { checker } = liveness(new Set([4401]));
    // The page-load read: `GET /api/v1/projects` answers from the cache and probes off the
    // request, so shop is `checking` and stays that way for the life of the page (#796).
    expect(checker.answer(ROWS[1]!, BOOT).state).toBe('checking');

    // BREAK-796-SNAPSHOT-DOES-NOT-SETTLE: without the `await settled()` this reads `checking` too.
    const frame = (await topic({ liveness: checker }).snapshot()) as ProjectInstancesTopic;
    expect(states(frame)).toEqual({ [BOOT]: 'this', shop: 'running', blog: 'stopped' });
    expect(frame.projects.shop?.url).toBe('http://127.0.0.1:4401/p/shop/');
  });

  it('publishes when a sibling stops and again when it starts, and nothing in between', async () => {
    const answering = new Set([4401]);
    const { checker } = liveness(answering);
    const published: ProjectInstancesTopic[] = [];
    const stop = topic({ liveness: checker }).start((data) => published.push(data as ProjectInstancesTopic));
    try {
      // The priming derive, then a tick with nothing new. BREAK-796-PUBLISH-EVERY-TICK makes this
      // non-empty.
      await ticks(3);
      expect(published).toHaveLength(0);

      answering.delete(4401); // the sibling's cockpit exits
      await ticks(3);
      expect(published).toHaveLength(1);
      expect(states(published[0]!).shop).toBe('stopped');

      answering.add(4401); // and comes back
      await ticks(3);
      expect(published).toHaveLength(2);
      expect(states(published[1]!).shop).toBe('running');
    } finally {
      stop();
    }
  });

  it('runs no probe before `start` and none after its stop', async () => {
    const answering = new Set([4401]);
    const { checker, probes } = liveness(answering);
    const publisher = topic({ liveness: checker });
    await ticks(3);
    expect(probes()).toBe(0); // registered, unsubscribed: a background `xezar serve` costs nothing

    const stop = publisher.start(() => undefined);
    await ticks(3);
    const whileHeld = probes();
    expect(whileHeld).toBeGreaterThan(0);

    stop();
    await ticks(4);
    expect(probes()).toBe(whileHeld); // the 1→0 stop really stopped the timer
  });

  it('publishes the empty map in hosted mode, and asks the liveness checker nothing', async () => {
    const { checker, probes } = liveness(new Set([4401]));
    const frame = (await topic({ liveness: checker, read: async () => null }).snapshot()) as ProjectInstancesTopic;
    expect(frame).toEqual({ projects: {} });
    expect(probes()).toBe(0);
  });

  it('skips a derive that throws and publishes the next good one', async () => {
    const answering = new Set([4401]);
    const { checker } = liveness(answering);
    let broken = true;
    const published: ProjectInstancesTopic[] = [];
    const stop = topic({
      liveness: checker,
      read: async () => {
        if (broken) throw new Error('unreadable registry');
        return { projects: ROWS, bootProject: BOOT };
      },
    }).start((data) => published.push(data as ProjectInstancesTopic));
    try {
      await ticks(3);
      expect(published).toHaveLength(0); // a throwing interval callback must not reach the process

      // Nothing was primed, so the first derive that works primes rather than publishes, and the
      // one after it carries the change — which is the same contract a healthy start has.
      broken = false;
      await ticks(2);
      answering.delete(4401);
      await ticks(3);
      expect(published).toHaveLength(1);
      expect(states(published[0]!).shop).toBe('stopped');
    } finally {
      stop();
    }
  });

  it('keys a frame by project id, sorted, so "changed" is not "reordered"', async () => {
    const { checker } = liveness(new Set());
    const frame = (await topic({
      liveness: checker,
      read: async () => ({ projects: [...ROWS].reverse(), bootProject: BOOT }),
    }).snapshot()) as ProjectInstancesTopic;
    expect(Object.keys(frame.projects)).toEqual(['blog', 'shop', BOOT].sort());
  });
});

/** Let the 5 ms interval fire `n` times, with the microtask queue drained between each. A real
 *  timer rather than a fake one on purpose: the derive awaits a probe and a `settled()`, so a
 *  faked `setInterval` with nothing advancing the clock would deadlock exactly the way
 *  `health-topic.test.ts` explains. 5 ms × a handful is far inside the default budget. */
async function ticks(n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) await new Promise((resolve) => setTimeout(resolve, 6));
}
