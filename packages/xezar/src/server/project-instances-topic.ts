import type { ProjectInstance, ProjectInstancesTopic } from '@qodeca/xezar-contract';
import type { LivenessProject } from './instance-liveness.ts';
import type { TopicPublisher } from './ws.ts';

/**
 * The `project-instances` topic on the WebSocket bus (#796, found in QA of #467 PR 4): the derived
 * `instance` answer of every registry row, live, for the "Other projects" band.
 *
 * That field is the one part of a registry row that changes with NOTHING this cockpit did. Another
 * xezar on this machine starts or stops; the registry file is untouched, so no workspace event
 * fires and the band's one page-load read of `GET /api/v1/projects` is frozen for the life of the
 * page. Two consequences, both reproduced in QA: a row that was answered `checking` (the honest
 * first read of a remembered address — the probe runs off the request rather than blocking the
 * list) sits on `checking…` forever, and a project that stops keeps offering a link to a dead
 * address.
 *
 * Demand-driven like `health` and `mcp-leader`, which is the whole reason this is a topic and not
 * a `refetchInterval` (AGENTS.md § Real-time events): nothing runs until a cockpit holds it — the
 * hub calls `start` at 0→1 and its returned stop at 1→0 — so a background `xezar serve` with no
 * tab open probes nothing, and N tabs cost one publisher rather than N polls.
 *
 * Two properties are load-bearing and each has a named break in the test file beside this one:
 *
 * - **The snapshot is a SETTLED answer, never `checking`.** `InstanceLiveness.answer` returns the
 *   cache and kicks a bounded probe off the request; a derive that did not wait would hand a
 *   just-subscribed cockpit the same `checking` the page-load read gave it
 *   (`BREAK-796-SNAPSHOT-DOES-NOT-SETTLE`).
 * - **A tick publishes only when the map CHANGED.** Every subscriber's reducer wakes on a frame,
 *   and the steady state of this topic is "nothing moved" (`BREAK-796-PUBLISH-EVERY-TICK`).
 *
 * Hosted mode publishes `{projects: {}}` and probes nothing: this server sees no writer claim on a
 * machine it does not run on, and the ports it could reach are its own host's. It is the same
 * decision the route makes by omitting `instance` altogether, taken at the same place — `read`
 * answers `null` and the derive never reaches the liveness checker.
 */

/** The backstop cadence — the same 5 s `health` and `mcp-leader` re-read on. The probe behind it
 *  is cheaper than either: `InstanceLiveness` caches each answer for ten seconds, so alternate
 *  ticks are a map read and no socket at all. */
export const PROJECT_INSTANCES_RECHECK_MS = 5_000;

/** What one derive needs from the liveness checker. A structural type, not the class: the topic
 *  shares the app's ONE `InstanceLiveness` (so the topic and `GET /api/v1/projects` can never
 *  disagree), and a test drives the five states through its own probe instead of a real socket. */
export interface InstanceAnswers {
  answer(project: LivenessProject, bootProjectId: string | undefined): ProjectInstance;
  /** Every probe started so far has finished. Bounded: one probe is capped at
   *  `HEALTH_PROBE_TIMEOUT_MS`, and they run concurrently. */
  settled(): Promise<void>;
}

export interface ProjectInstancesTopicDeps {
  /**
   * The rows to answer for and this process's own project, read fresh each derive so a project
   * added or removed while a cockpit is open is in (or out of) the next frame.
   *
   * `null` means this server does not look at all — hosted mode — and is answered with an empty
   * map rather than with an absent one, so "nothing is running" and "I did not look" stay the two
   * different things they are on the wire.
   */
  readonly read: () => Promise<{
    projects: readonly LivenessProject[];
    bootProject: string;
  } | null>;
  readonly liveness: InstanceAnswers;
  readonly recheckMs?: number;
}

export function projectInstancesTopic(deps: ProjectInstancesTopicDeps): TopicPublisher {
  const derive = async (): Promise<ProjectInstancesTopic> => {
    const read = await deps.read();
    if (read === null) return { projects: {} };
    // Two passes over the same rows, and the pair is the point. The first asks every row, which
    // starts a bounded probe for each stale one; `settled` then waits for all of them at once; the
    // second reads what they proved. One pass would answer from the cache the request arrived
    // with, which for a freshly booted cockpit is `checking` for every row.
    for (const project of read.projects) deps.liveness.answer(project, read.bootProject);
    await deps.liveness.settled();
    const projects: Record<string, ProjectInstance> = {};
    // Sorted, so two derivations of the same state serialize identically and "changed" means
    // changed rather than "the registry listed them in another order".
    for (const project of [...read.projects].sort((a, b) => a.id.localeCompare(b.id))) {
      projects[project.id] = deps.liveness.answer(project, read.bootProject);
    }
    return { projects };
  };

  return {
    snapshot: derive,
    start(publish) {
      let running = true;
      // `null` until the first derive lands: that one PRIMES the comparison rather than publishing,
      // because the subscriber that caused this start already received the same map as its
      // snapshot. Publishing it again would be a frame carrying no news, which is the habit this
      // topic exists to avoid.
      let last: string | null = null;
      let inFlight = false;
      const tick = (): void => {
        // A derive outliving its interval (a probe at its 300 ms bound, several rows) must not
        // stack: the next tick is 5 s away and will see whatever this one proved.
        if (!running || inFlight) return;
        inFlight = true;
        void derive()
          .then((next) => {
            // A derive that started before the last subscriber left has nothing to publish to.
            if (!running) return;
            const body = JSON.stringify(next);
            const previous = last;
            last = body;
            if (previous !== null && previous !== body) publish(next);
          })
          // An unreadable registry or a throwing probe is skipped, never thrown: this runs on an
          // interval, where a rejection would be unhandled. The next tick tries again, and `last`
          // is untouched so the next successful derive is compared against real news.
          .catch(() => undefined)
          .finally(() => {
            inFlight = false;
          });
      };
      tick(); // prime at once, so the first tick that can publish is one cadence away, not two
      const timer = setInterval(tick, deps.recheckMs ?? PROJECT_INSTANCES_RECHECK_MS);
      timer.unref?.(); // never the reason the process stays up
      return () => {
        running = false;
        clearInterval(timer);
      };
    },
  };
}
