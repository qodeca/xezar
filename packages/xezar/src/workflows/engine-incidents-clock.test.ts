import { expect, it, vi } from 'vitest';
import { providerClock } from './engine-incidents.testkit.ts';

it.each([false, true])('quota advancement leaves transport timeout alone (cancelled=%s)', cancelled => {
  const clock = providerClock();
  const abortDelivery = vi.fn();
  const transport = setTimeout(abortDelivery, 60_000);
  try {
    if (cancelled) clearTimeout(transport);
    clock.advanceTo(clock.reset(180) * 1000);
    expect(abortDelivery).not.toHaveBeenCalled();
  } finally {
    clearTimeout(transport);
    clock.restore();
  }
});

it('quota appointments honor their deadline and cancellation, and fire only once', () => {
  const clock = providerClock();
  const due = vi.fn();
  const cancelled = vi.fn();
  const later = vi.fn();
  const start = Date.now();
  clock.timer.schedule(due, 60_000);
  const retired = clock.timer.schedule(cancelled, 60_000);
  clock.timer.schedule(later, 180_000);
  try {
    clock.timer.cancel(retired);
    clock.advanceTo(start + 59_999);
    expect(due).not.toHaveBeenCalled();
    clock.advanceTo(start + 60_000);
    expect(due).toHaveBeenCalledTimes(1);
    expect(cancelled).not.toHaveBeenCalled();
    expect(later).not.toHaveBeenCalled();
    clock.advanceTo(start + 180_000);
    expect(due).toHaveBeenCalledTimes(1);
    expect(cancelled).not.toHaveBeenCalled();
    expect(later).toHaveBeenCalledTimes(1);
  } finally { clock.restore(); }
});
