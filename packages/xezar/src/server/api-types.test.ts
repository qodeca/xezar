import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CheckoutProgressEvent, RunEvent as WebRunEvent } from '@qodeca/xezar-api-client';
import type {
  UiBackend as WebUiBackend,
  ToolStatus as WebToolStatus,
  ToolKind as WebToolKind,
  StopReason as WebStopReason,
  PlanStatus as WebPlanStatus,
  PlanEntry as WebPlanEntry,
  TokenUsage as WebTokenUsage,
  FileDiff as WebFileDiff,
  ToolLocation as WebToolLocation,
  PermissionOptionKind as WebPermissionOptionKind,
  PermissionOption as WebPermissionOption,
  UiMessageItem as WebUiMessageItem,
  UiReasoningItem as WebUiReasoningItem,
  UiToolItem as WebUiToolItem,
  UiItem as WebUiItem,
  UiSessionStartedEvent as WebUiSessionStartedEvent,
  UiSessionEndedEvent as WebUiSessionEndedEvent,
  UiSessionErrorEvent as WebUiSessionErrorEvent,
  UiTurnStartedEvent as WebUiTurnStartedEvent,
  UiTurnCompletedEvent as WebUiTurnCompletedEvent,
  UiItemStartedEvent as WebUiItemStartedEvent,
  UiItemDeltaEvent as WebUiItemDeltaEvent,
  UiItemUpdatedEvent as WebUiItemUpdatedEvent,
  UiItemCompletedEvent as WebUiItemCompletedEvent,
  UiPlanUpdatedEvent as WebUiPlanUpdatedEvent,
  UiPermissionRequestedEvent as WebUiPermissionRequestedEvent,
  UiPermissionResolvedEvent as WebUiPermissionResolvedEvent,
  UiAskOption as WebUiAskOption,
  UiAskQuestion as WebUiAskQuestion,
  UiAskRequestedEvent as WebUiAskRequestedEvent,
  UiUsageUpdatedEvent as WebUiUsageUpdatedEvent,
  UiImageEvent as WebUiImageEvent,
  UiEvent as WebUiEvent,
  UiEventType as WebUiEventType,
} from '@qodeca/xezar-api-client';
import type { RunEvent } from '../runs/store.ts';
import type {
  UiBackend,
  ToolStatus,
  ToolKind,
  StopReason,
  PlanStatus,
  PlanEntry,
  TokenUsage,
  FileDiff,
  ToolLocation,
  PermissionOptionKind,
  PermissionOption,
  UiMessageItem,
  UiReasoningItem,
  UiToolItem,
  UiItem,
  UiSessionStartedEvent,
  UiSessionEndedEvent,
  UiSessionErrorEvent,
  UiTurnStartedEvent,
  UiTurnCompletedEvent,
  UiItemStartedEvent,
  UiItemDeltaEvent,
  UiItemUpdatedEvent,
  UiItemCompletedEvent,
  UiPlanUpdatedEvent,
  UiPermissionRequestedEvent,
  UiPermissionResolvedEvent,
  UiAskOption,
  UiAskQuestion,
  UiAskRequestedEvent,
  UiUsageUpdatedEvent,
  UiImageEvent,
  UiEvent,
  UiEventType,
} from '../core/ui-events.ts';

/**
 * What is left of the hand-written mirror — and only that.
 *
 * This file used to pin 58 shapes, because every response type was declared twice: once by the
 * server and once by hand in the api-client. `@qodeca/xezar-contract` removed the
 * duplication, and `contract-parity*.test.ts` now checks each schema against the ROUTE it
 * describes, which is a strictly better comparison — the route IS the wire, whereas the pairs
 * below compare against the server's internal types.
 *
 * That distinction is why the retired assertions could not simply be repointed at the contract.
 * The contract describes what a client receives, and `JSON.stringify` drops an undefined value,
 * so `foo?: T` there is correct even where the server's in-memory type says `foo: T | undefined`.
 * `ExactKeys` reads that as drift; it is not — the two are describing different things. Pointing
 * the old guard at the contract would have manufactured failures and taught the next person to
 * loosen it.
 *
 * Two shapes genuinely cannot be derived from a route, so they stay hand-mirrored and stay
 * guarded here. Both are SSE FRAME payloads delivered over `text/event-stream`, which Hono types
 * as a string body — the frame shape is invisible to `InferResponseType`.
 *
 * The v2 `UiEvent` protocol is the third, and it went UNGUARDED between the day the contract
 * package landed and #190. `packages/api-client/src/protocol/ui-events.ts` is a hand-kept copy of
 * `core/ui-events.ts`; the pair that pinned it was retired with the other 57, and nothing replaced
 * it, so the server and the cockpit compiled against two files nobody compared. They had not
 * drifted — but `AGENT_PROTOCOL.md` §9 tells a new runner to add `UiBackend` "and its mirror",
 * which is exactly the edit that needed the guard. The whole surface is pinned below.
 */
describe('the shapes that cannot come from a route are still mirrored faithfully', () => {
  /** Mutual assignability. `[…]` wrappers stop a naked union from distributing. */
  type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
  /** Key-set equality — `Exact` alone is blind to a missing OPTIONAL property (#472). */
  type ExactKeys<A, B> = Exact<keyof A, keyof B>;

  const guards = {
    /** `GET /api/v1/runs/:id/events` and `/api/v1/events` — the run event stream. */
    runEvent: true satisfies Exact<RunEvent, WebRunEvent>,
  };

  /**
   * Every export of the v2 protocol, pinned in both directions (#190).
   *
   * An interface gets `ExactKeys` as well, because `Exact` alone is blind to a property that is
   * OPTIONAL on one side and absent on the other — assignability ignores it in both directions
   * (#472). A union or a string-literal alias gets `Exact` only: `keyof` a union is just the keys
   * its members share, so `ExactKeys` there would compare something neither file declares.
   */
  const protocolGuards = {
    UiBackend: true satisfies Exact<UiBackend, WebUiBackend>,
    ToolStatus: true satisfies Exact<ToolStatus, WebToolStatus>,
    ToolKind: true satisfies Exact<ToolKind, WebToolKind>,
    StopReason: true satisfies Exact<StopReason, WebStopReason>,
    PlanStatus: true satisfies Exact<PlanStatus, WebPlanStatus>,
    PlanEntry: [true, true] satisfies [Exact<PlanEntry, WebPlanEntry>, ExactKeys<PlanEntry, WebPlanEntry>],
    TokenUsage: [true, true] satisfies [Exact<TokenUsage, WebTokenUsage>, ExactKeys<TokenUsage, WebTokenUsage>],
    FileDiff: [true, true] satisfies [Exact<FileDiff, WebFileDiff>, ExactKeys<FileDiff, WebFileDiff>],
    ToolLocation: [true, true] satisfies [Exact<ToolLocation, WebToolLocation>, ExactKeys<ToolLocation, WebToolLocation>],
    PermissionOptionKind: true satisfies Exact<PermissionOptionKind, WebPermissionOptionKind>,
    PermissionOption: [true, true] satisfies [Exact<PermissionOption, WebPermissionOption>, ExactKeys<PermissionOption, WebPermissionOption>],
    UiMessageItem: [true, true] satisfies [Exact<UiMessageItem, WebUiMessageItem>, ExactKeys<UiMessageItem, WebUiMessageItem>],
    UiReasoningItem: [true, true] satisfies [Exact<UiReasoningItem, WebUiReasoningItem>, ExactKeys<UiReasoningItem, WebUiReasoningItem>],
    UiToolItem: [true, true] satisfies [Exact<UiToolItem, WebUiToolItem>, ExactKeys<UiToolItem, WebUiToolItem>],
    UiItem: true satisfies Exact<UiItem, WebUiItem>,
    UiSessionStartedEvent: [true, true] satisfies [Exact<UiSessionStartedEvent, WebUiSessionStartedEvent>, ExactKeys<UiSessionStartedEvent, WebUiSessionStartedEvent>],
    UiSessionEndedEvent: [true, true] satisfies [Exact<UiSessionEndedEvent, WebUiSessionEndedEvent>, ExactKeys<UiSessionEndedEvent, WebUiSessionEndedEvent>],
    UiSessionErrorEvent: [true, true] satisfies [Exact<UiSessionErrorEvent, WebUiSessionErrorEvent>, ExactKeys<UiSessionErrorEvent, WebUiSessionErrorEvent>],
    UiTurnStartedEvent: [true, true] satisfies [Exact<UiTurnStartedEvent, WebUiTurnStartedEvent>, ExactKeys<UiTurnStartedEvent, WebUiTurnStartedEvent>],
    UiTurnCompletedEvent: [true, true] satisfies [Exact<UiTurnCompletedEvent, WebUiTurnCompletedEvent>, ExactKeys<UiTurnCompletedEvent, WebUiTurnCompletedEvent>],
    UiItemStartedEvent: [true, true] satisfies [Exact<UiItemStartedEvent, WebUiItemStartedEvent>, ExactKeys<UiItemStartedEvent, WebUiItemStartedEvent>],
    UiItemDeltaEvent: [true, true] satisfies [Exact<UiItemDeltaEvent, WebUiItemDeltaEvent>, ExactKeys<UiItemDeltaEvent, WebUiItemDeltaEvent>],
    UiItemUpdatedEvent: [true, true] satisfies [Exact<UiItemUpdatedEvent, WebUiItemUpdatedEvent>, ExactKeys<UiItemUpdatedEvent, WebUiItemUpdatedEvent>],
    UiItemCompletedEvent: [true, true] satisfies [Exact<UiItemCompletedEvent, WebUiItemCompletedEvent>, ExactKeys<UiItemCompletedEvent, WebUiItemCompletedEvent>],
    UiPlanUpdatedEvent: [true, true] satisfies [Exact<UiPlanUpdatedEvent, WebUiPlanUpdatedEvent>, ExactKeys<UiPlanUpdatedEvent, WebUiPlanUpdatedEvent>],
    UiPermissionRequestedEvent: [true, true] satisfies [Exact<UiPermissionRequestedEvent, WebUiPermissionRequestedEvent>, ExactKeys<UiPermissionRequestedEvent, WebUiPermissionRequestedEvent>],
    UiPermissionResolvedEvent: [true, true] satisfies [Exact<UiPermissionResolvedEvent, WebUiPermissionResolvedEvent>, ExactKeys<UiPermissionResolvedEvent, WebUiPermissionResolvedEvent>],
    UiAskOption: [true, true] satisfies [Exact<UiAskOption, WebUiAskOption>, ExactKeys<UiAskOption, WebUiAskOption>],
    UiAskQuestion: [true, true] satisfies [Exact<UiAskQuestion, WebUiAskQuestion>, ExactKeys<UiAskQuestion, WebUiAskQuestion>],
    UiAskRequestedEvent: [true, true] satisfies [Exact<UiAskRequestedEvent, WebUiAskRequestedEvent>, ExactKeys<UiAskRequestedEvent, WebUiAskRequestedEvent>],
    UiUsageUpdatedEvent: [true, true] satisfies [Exact<UiUsageUpdatedEvent, WebUiUsageUpdatedEvent>, ExactKeys<UiUsageUpdatedEvent, WebUiUsageUpdatedEvent>],
    UiImageEvent: [true, true] satisfies [Exact<UiImageEvent, WebUiImageEvent>, ExactKeys<UiImageEvent, WebUiImageEvent>],
    UiEvent: true satisfies Exact<UiEvent, WebUiEvent>,
    UiEventType: true satisfies Exact<UiEventType, WebUiEventType>,
  };

  /**
   * No `ExactKeys` pair here, deliberately. `RunEvent` carries a string index signature, and
   * TypeScript reports `keyof` of an interface with one as `string | number` while the zod loose
   * object infers `string` — a difference in how the two are spelled, not in what they accept
   * (`Exact` above passes both ways). `ExactKeys` exists to catch a MISSING OPTIONAL property
   * (#472), which cannot happen on a type that already accepts arbitrary keys, so pinning it
   * here would fail forever while proving nothing.
   */
  type _KeysNotApplicable = ExactKeys<{ a: 1 }, { a: 1 }>;

  it('holds every pair above', () => {
    expect(Object.values(protocolGuards).flat().every(Boolean)).toBe(true);
    // The compiler does the real work. This only stops a future edit from deleting the pairs and
    // leaving a green file that checks nothing.
    expect(Object.keys(guards).length).toBeGreaterThan(0);
    expect(Object.values(guards).every(Boolean)).toBe(true);
  });

  it('pins every export of the protocol, so a new one cannot arrive unguarded', () => {
    // The pairs above are hand-written, which means the real failure mode is a type added to
    // both files and paired in neither. Only the source text can catch that, so read it.
    const exportsOf = (url: string): string[] =>
      [...readFileSync(fileURLToPath(new URL(url, import.meta.url)), 'utf8')
        .matchAll(/^export (?:type|interface) (\w+)/gm)].map((m) => m[1]!).sort();

    const server = exportsOf('../core/ui-events.ts');
    const mirror = exportsOf('../../../api-client/src/protocol/ui-events.ts');

    // A name in one file and not the other is the drift itself, before any shape is compared.
    expect(mirror).toEqual(server);
    expect(Object.keys(protocolGuards).sort()).toEqual(server);
  });

  it('records why the other SSE shape has no pair here', () => {
    // `checkout-progress` frames are assembled inline in the workspace-events handler, so there
    // is no server-side type to pin the mirror against. Noted so its absence above reads as
    // deliberate rather than as an oversight.
    const phases: CheckoutProgressEvent['phase'][] = ['cloning', 'done', 'error'];
    expect(phases).toHaveLength(3);
  });
});
