/**
 * Pure Qwen Code stream-json → protocol-v2 mapper (#1044). Qwen Code's headless output
 * (`-o stream-json`) follows Claude Code's frame shapes, so this is a port of
 * `claude-ui-mapper.ts`; the differences, all measured on Qwen Code 0.25.2:
 *
 * - every turn is its own `qwen` process (`--resume` joins them), so every turn opens with a
 *   fresh `system/init`. Only the first becomes `session.started`;
 * - built-in tool names are snake_case (`run_shell_command`, `write_file`, `todo_write`, …);
 * - a deferred tool is called through the `tool_call` bridge, `{ name, arguments }`: the item
 *   shows the tool it names, under the bridge call's id (which sub-agent frames reference as
 *   `parent_tool_use_id`);
 * - the plan tool is `todo_write` with `{ todos: [{ id, content, status }] }`;
 * - a refused tool call comes back as an `is_error` result whose text says so — a permission rule
 *   (`… was denied by permission rules …`) or xezar's own hook (`QWEN_HOOK_REFUSAL_PREFIX`) —
 *   and is `declined`, not `failed`;
 * - result usage reports `input_tokens` INCLUDING the cached part, plus `total_tokens`; the v2
 *   `TokenUsage` keeps Claude Code's meaning (`input` without the cache read);
 * - an error result carries `error.message` and no `result`; a provider failure can also arrive
 *   as `[API Error: …]` text inside the turn.
 *
 * Contract and robustness rules as for every mapper (AGENT_PROTOCOL.md § 4): never throws,
 * unknown frames map to nothing, state is explicit and never mutated.
 */

import type {
  FileDiff,
  PlanEntry,
  PlanStatus,
  StopReason,
  TokenUsage,
  ToolLocation,
  UiEvent,
  UiMessageItem,
  UiReasoningItem,
  UiSessionStartedEvent,
  UiToolItem,
  UiTurnCompletedEvent,
  UiUsageUpdatedEvent,
} from './ui-events.ts';
import { toolDisplay } from './tool-display.ts';
import { stringifyToolResultContent, toolResultImageBlocks } from './claude-ui-mapper.ts';
import { QWEN_HOOK_REFUSAL_PREFIX } from './qwen-tool-policy.ts';

/** The prefix Qwen Code puts on a provider failure it reports as assistant text. */
export const QWEN_API_ERROR_PREFIX = '[API Error';

export interface QwenUiMapperState {
  readonly fallbackSessionId?: string;
  readonly sessionStarted: boolean;
  readonly pendingTurnIds: readonly string[];
  readonly turnSeq: number;
  readonly currentTurnId: string | null;
  readonly itemSeq: number;
  /** Session-scoped, as in the Claude mapper: guards the `result` text fallback. */
  readonly sawAssistantText: boolean;
  /** True once this turn's assistant text began with {@link QWEN_API_ERROR_PREFIX}. */
  readonly turnApiError: boolean;
  readonly openTools: ReadonlyMap<string, UiToolItem>;
  /**
   * Calls a tool result already closed as `declined`, with the refusal's own text. Qwen Code lists
   * the same call again in the turn's `permission_denials`; that second report carries no reason,
   * and emitting it would replace the item and lose the reason, so it is skipped.
   */
  readonly declinedIds: ReadonlySet<string>;
  /** USD for a turn's raw usage — xezar computes it (Qwen Code reports none). */
  readonly priceTurn?: (usage: TokenUsage) => number | undefined;
}

export interface QwenUiMapping {
  events: UiEvent[];
  state: QwenUiMapperState;
}

export function createQwenUiState(
  opts: { fallbackSessionId?: string; priceTurn?: (usage: TokenUsage) => number | undefined } = {},
): QwenUiMapperState {
  return {
    fallbackSessionId: opts.fallbackSessionId,
    sessionStarted: false,
    pendingTurnIds: [],
    turnSeq: 0,
    currentTurnId: null,
    itemSeq: 0,
    sawAssistantText: false,
    turnApiError: false,
    openTools: new Map(),
    declinedIds: new Set(),
    ...(opts.priceTurn ? { priceTurn: opts.priceTurn } : {}),
  };
}

/** A turn begins when the runner starts the turn's process; queued until the first init. */
export function qwenTurnStarted(state: QwenUiMapperState): QwenUiMapping {
  const turnId = `turn_${state.turnSeq + 1}`;
  const next = { ...state, turnSeq: state.turnSeq + 1, currentTurnId: turnId, turnApiError: false };
  if (!state.sessionStarted) {
    return { events: [], state: { ...next, pendingTurnIds: [...state.pendingTurnIds, turnId] } };
  }
  return { events: [{ type: 'turn.started', turnId }], state: next };
}

/** Fold one parsed stream-json frame into v2 events. Never throws. */
export function mapQwenMessage(msg: unknown, state: QwenUiMapperState): QwenUiMapping {
  if (!isRecord(msg)) return { events: [], state };
  switch (msg.type) {
    case 'system':
      return msg.subtype === 'init' ? mapInit(msg, state) : { events: [], state };
    case 'assistant':
      return mapAssistant(msg, state);
    case 'user':
      return mapToolResults(msg, state);
    case 'result':
      return mapResult(msg, state);
    default:
      // stream_event (goal state, partial messages), … — nothing to render.
      return { events: [], state };
  }
}

function mapInit(msg: Record<string, unknown>, state: QwenUiMapperState): QwenUiMapping {
  // Every turn's process sends its own init; the session started once.
  if (state.sessionStarted) return { events: [], state };
  const event: UiSessionStartedEvent = {
    type: 'session.started',
    sessionId: str(msg.session_id) ?? state.fallbackSessionId ?? '',
    backend: 'qwen',
  };
  const model = str(msg.model);
  if (model !== undefined) event.model = model;
  const cwd = str(msg.cwd);
  if (cwd !== undefined) event.cwd = cwd;
  if (Array.isArray(msg.tools)) {
    event.tools = msg.tools.filter((tool): tool is string => typeof tool === 'string');
  }
  const events: UiEvent[] = [event];
  for (const turnId of state.pendingTurnIds) events.push({ type: 'turn.started', turnId });
  return { events, state: { ...state, sessionStarted: true, pendingTurnIds: [] } };
}

/** A `tool_call` bridge call shows the tool it names; anything else is itself. */
export function unwrapQwenToolCall(name: string, input: unknown): { name: string; input: unknown } {
  if (name !== 'tool_call' || !isRecord(input) || typeof input.name !== 'string' || input.name === '') {
    return { name, input };
  }
  return { name: input.name, input: input.arguments };
}

function mapAssistant(msg: Record<string, unknown>, state: QwenUiMapperState): QwenUiMapping {
  const content = messageContent(msg);
  const parentItemId = str(msg.parent_tool_use_id);
  const events: UiEvent[] = [];
  let itemSeq = state.itemSeq;
  let openTools: Map<string, UiToolItem> | null = null;
  let sawAssistantText = state.sawAssistantText;
  let turnApiError = state.turnApiError;

  for (const raw of content) {
    if (!isRecord(raw)) continue;
    if (raw.type === 'text' && typeof raw.text === 'string') {
      sawAssistantText = true;
      if (parentItemId === undefined && raw.text.trimStart().startsWith(QWEN_API_ERROR_PREFIX)) turnApiError = true;
      const item: UiMessageItem = { kind: 'message', id: `item_${++itemSeq}`, role: 'assistant', text: raw.text };
      if (parentItemId !== undefined) item.parentItemId = parentItemId;
      events.push({ type: 'item.started', item }, { type: 'item.completed', item });
    } else if (raw.type === 'thinking' && typeof raw.thinking === 'string' && raw.thinking.trim() !== '') {
      const item: UiReasoningItem = { kind: 'reasoning', id: `item_${++itemSeq}`, text: raw.thinking };
      if (parentItemId !== undefined) item.parentItemId = parentItemId;
      events.push({ type: 'item.started', item }, { type: 'item.completed', item });
    } else if (raw.type === 'tool_use' && typeof raw.id === 'string' && typeof raw.name === 'string') {
      const tool = unwrapQwenToolCall(raw.name, raw.input);
      const display = toolDisplay(tool.name, tool.input);
      const item: UiToolItem = {
        kind: 'tool',
        id: raw.id,
        name: tool.name,
        toolKind: display.toolKind,
        title: display.title,
        status: 'running',
      };
      if (tool.input !== undefined) item.input = tool.input;
      const edit = editArtifacts(tool.name, tool.input);
      if (edit) {
        if (edit.diffs) item.diffs = edit.diffs;
        item.locations = edit.locations;
      }
      if (parentItemId !== undefined) item.parentItemId = parentItemId;
      events.push({ type: 'item.started', item });
      // The plan is the main agent's: a sub-agent's todo list is its own and must not replace it.
      if (tool.name === 'todo_write' && parentItemId === undefined) {
        const entries = planEntries(tool.input);
        if (entries) events.push({ type: 'plan.updated', entries });
      }
      openTools ??= new Map(state.openTools);
      openTools.set(raw.id, item);
    }
  }

  if (events.length === 0) return { events, state };
  return {
    events,
    state: { ...state, itemSeq, openTools: openTools ?? state.openTools, sawAssistantText, turnApiError },
  };
}

/** `edit` carries the replacement inline; `write_file` the whole new content. */
function editArtifacts(name: string, input: unknown): { diffs?: FileDiff[]; locations: ToolLocation[] } | undefined {
  if (name !== 'edit' && name !== 'write_file') return undefined;
  if (!isRecord(input) || typeof input.file_path !== 'string' || input.file_path === '') return undefined;
  const path = input.file_path;
  const locations: ToolLocation[] = [{ path }];
  if (name === 'edit') {
    if (typeof input.old_string === 'string' && typeof input.new_string === 'string') {
      return { diffs: [{ path, oldText: input.old_string, newText: input.new_string }], locations };
    }
    return { locations };
  }
  const diff: FileDiff = { path, oldText: null };
  if (typeof input.content === 'string') diff.newText = input.content;
  return { diffs: [diff], locations };
}

const PLAN_STATUSES: readonly PlanStatus[] = ['pending', 'in_progress', 'completed', 'cancelled'];

/** `todo_write` input → plan entries (full replacement; an empty list is a valid plan). */
function planEntries(input: unknown): PlanEntry[] | undefined {
  if (!isRecord(input) || !Array.isArray(input.todos)) return undefined;
  const entries: PlanEntry[] = [];
  for (const todo of input.todos) {
    if (!isRecord(todo) || typeof todo.content !== 'string' || todo.content.trim() === '') continue;
    // An unknown status degrades to pending, so a todo the agent wrote stays on screen (§ 10).
    const status = PLAN_STATUSES.find((s) => s === todo.status) ?? 'pending';
    const entry: PlanEntry = { content: todo.content, status };
    if (typeof todo.activeForm === 'string' && todo.activeForm !== '') entry.activeForm = todo.activeForm;
    entries.push(entry);
  }
  return entries;
}

/** A refused call: Qwen Code's own permission rules, or xezar's hook. */
export function isQwenRefusal(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith(QWEN_HOOK_REFUSAL_PREFIX) || /\binvocation was denied by permission rules\b/.test(trimmed);
}

function mapToolResults(msg: Record<string, unknown>, state: QwenUiMapperState): QwenUiMapping {
  const content = messageContent(msg);
  const parentItemId = str(msg.parent_tool_use_id);
  const events: UiEvent[] = [];
  let openTools: Map<string, UiToolItem> | null = null;
  let declinedIds: Set<string> | null = null;

  for (const raw of content) {
    if (!isRecord(raw) || raw.type !== 'tool_result' || typeof raw.tool_use_id !== 'string') continue;
    const open = (openTools ?? state.openTools).get(raw.tool_use_id);
    const item: UiToolItem = open
      ? { ...open }
      : { kind: 'tool', id: raw.tool_use_id, name: 'unknown', toolKind: 'other', title: 'Tool', status: 'running' };
    if (!open && parentItemId !== undefined) item.parentItemId = parentItemId;
    const text = stringifyToolResultContent(raw.content);
    if (raw.is_error === true) {
      item.status = isQwenRefusal(text) ? 'declined' : 'failed';
      item.error = text;
      if (item.status === 'declined') (declinedIds ??= new Set(state.declinedIds)).add(raw.tool_use_id);
    } else {
      item.status = 'completed';
      item.output = text;
    }
    events.push({ type: 'item.completed', item });
    for (const img of toolResultImageBlocks(raw.content)) {
      events.push({ type: 'image', itemId: raw.tool_use_id, mediaType: img.media_type, data: img.data });
    }
    openTools ??= new Map(state.openTools);
    openTools.delete(raw.tool_use_id);
  }

  if (events.length === 0) return { events, state };
  return { events, state: { ...state, openTools: openTools ?? state.openTools, declinedIds: declinedIds ?? state.declinedIds } };
}

function mapResult(msg: Record<string, unknown>, state: QwenUiMapperState): QwenUiMapping {
  const events: UiEvent[] = [];
  let itemSeq = state.itemSeq;
  let turnSeq = state.turnSeq;
  let openTools: Map<string, UiToolItem> | null = null;

  if (Array.isArray(msg.permission_denials)) {
    for (const raw of msg.permission_denials) {
      if (!isRecord(raw) || typeof raw.tool_name !== 'string') continue;
      const id = typeof raw.tool_use_id === 'string' ? raw.tool_use_id : `item_${++itemSeq}`;
      if (state.declinedIds.has(id)) continue;
      const open = (openTools ?? state.openTools).get(id);
      let item: UiToolItem;
      if (open) {
        item = { ...open, status: 'declined' };
        openTools ??= new Map(state.openTools);
        openTools.delete(id);
      } else {
        const tool = unwrapQwenToolCall(raw.tool_name, raw.tool_input);
        const display = toolDisplay(tool.name, tool.input);
        item = { kind: 'tool', id, name: tool.name, toolKind: display.toolKind, title: display.title, status: 'declined' };
        if (tool.input !== undefined) item.input = tool.input;
      }
      events.push({ type: 'item.completed', item });
    }
  }

  let sawAssistantText = state.sawAssistantText;
  if (!sawAssistantText && typeof msg.result === 'string' && msg.result !== '') {
    sawAssistantText = true;
    const item: UiMessageItem = { kind: 'message', id: `item_${++itemSeq}`, role: 'assistant', text: msg.result };
    events.push({ type: 'item.started', item }, { type: 'item.completed', item });
  }

  const turnId = state.currentTurnId ?? `turn_${++turnSeq}`;
  const usage = qwenTokenUsage(msg.usage);
  const costUsd = usage && state.priceTurn ? state.priceTurn(usage) : undefined;
  const stopReason: StopReason = state.turnApiError ? 'error' : resultStopReason(msg);
  const turnEvent: UiTurnCompletedEvent = { type: 'turn.completed', turnId, stopReason };
  if (usage) turnEvent.usage = usage;
  if (costUsd !== undefined) turnEvent.costUsd = costUsd;
  events.push(turnEvent);
  if (usage) {
    const usageEvent: UiUsageUpdatedEvent = { type: 'usage.updated', usage };
    if (costUsd !== undefined) usageEvent.costUsd = costUsd;
    events.push(usageEvent);
  }

  return {
    events,
    state: {
      ...state,
      itemSeq,
      turnSeq,
      currentTurnId: null,
      turnApiError: false,
      openTools: openTools ?? state.openTools,
      sawAssistantText,
    },
  };
}

function resultStopReason(msg: Record<string, unknown>): StopReason {
  switch (msg.subtype) {
    case 'success':
      return msg.is_error === true ? 'error' : 'end_turn';
    case 'error_max_turns':
      return 'max_tokens';
    case 'error_during_execution':
      return 'error';
    default:
      return msg.is_error === true ? 'error' : 'end_turn';
  }
}

/**
 * Qwen Code's result usage in Claude Code's terms. Qwen's `input_tokens` includes the cached
 * part (`input_tokens + output_tokens === total_tokens` on every measured frame), so `input`
 * drops the cache read; `total` is Qwen's own total when it sent one.
 */
export function qwenTokenUsage(usage: unknown): TokenUsage | undefined {
  if (!isRecord(usage)) return undefined;
  const rawInput = num(usage.input_tokens) ?? 0;
  const output = num(usage.output_tokens) ?? 0;
  const cacheRead = num(usage.cache_read_input_tokens);
  const input = Math.max(0, rawInput - (cacheRead ?? 0));
  const result: TokenUsage = { input, output, total: num(usage.total_tokens) ?? rawInput + output };
  if (cacheRead !== undefined) result.cacheRead = cacheRead;
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageContent(msg: Record<string, unknown>): unknown[] {
  const message = isRecord(msg.message) ? msg.message : undefined;
  return message && Array.isArray(message.content) ? message.content : [];
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
