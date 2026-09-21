import { describe, expect, it } from 'vitest';
import { skillsRefreshResponseSchema, skillsRefreshSourceSchema } from './skills.ts';

/**
 * `POST /skills/refresh`'s per-source outcome (#771, tightened by the #789 review).
 *
 * The first round declared the discriminant in prose and left the schema flat
 * (`ok: z.boolean(), reason: z.string().optional()`). That shape accepts two things the route
 * cannot emit and no reader can handle: a failure with no reason, which forces the cockpit to
 * invent fallback text, and a success carrying a failure sentence. Mutual contract parity stayed
 * green because the ROUTE was typed through the same broad definition — a type check cannot
 * catch a schema that is wider than the truth, so the falsification lives here, at `safeParse`.
 */
describe('skillsRefreshSourceSchema', () => {
  it('accepts the two shapes the route actually emits', () => {
    expect(skillsRefreshSourceSchema.safeParse({ repo: 'git@host:org/skills.git', ok: true }).success).toBe(true);
    expect(
      skillsRefreshSourceSchema.safeParse({ repo: 'git@host:org/skills.git', ok: false, reason: 'git fetch failed' })
        .success,
    ).toBe(true);
  });

  it('REFUSES a failure with no reason — the reader would have to invent one', () => {
    expect(skillsRefreshSourceSchema.safeParse({ repo: 'r', ok: false }).success).toBe(false);
  });

  it('REFUSES a success carrying a reason — a completed refresh has nothing to explain', () => {
    expect(skillsRefreshSourceSchema.safeParse({ repo: 'r', ok: true, reason: 'failure' }).success).toBe(false);
  });

  it('refuses a missing or non-boolean discriminant outright', () => {
    expect(skillsRefreshSourceSchema.safeParse({ repo: 'r' }).success).toBe(false);
    expect(skillsRefreshSourceSchema.safeParse({ repo: 'r', ok: 'true' }).success).toBe(false);
  });

  it('carries the same discriminant through the response it is embedded in', () => {
    expect(skillsRefreshResponseSchema.safeParse({ skills: [], sources: [{ repo: 'r', ok: false }] }).success).toBe(
      false,
    );
    expect(
      skillsRefreshResponseSchema.safeParse({ skills: [], sources: [{ repo: 'r', ok: false, reason: 'offline' }] })
        .success,
    ).toBe(true);
  });
});
