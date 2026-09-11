// THE MCP TOOL REGISTRY — EXTENDED BY APPEND ONLY.
//
// Every Phase 3 tool issue (#91–#98 and their siblings) adds exactly two lines here
// and nothing else:
//   1. one import line at the END of the import block below, and
//   2. one entry at the END of the `tools` array.
// Do not reorder, regroup, sort, reformat or rename anything already in this file.
//
// Why: nine tasks edit this file in parallel, each on its own branch. When every
// change is a pure append at the same two places, any merge conflict here is
// mechanical — keep both sides, one line each — and can never hide a semantic
// clash. Any other edit (sorting, a helper, a second array, a reflowed line) turns
// nine mechanical merges into nine real conflicts.
//
// A tool lives in its own file under this directory and exports one named
// `McpTool` built with `defineTool` (see ../tool.ts). Tools run inside the xezar
// service, never in the bridge. Names must be unique, snake_case and must not
// shadow the bridge's built-in `health` tool — `index.test.ts` beside this file
// fails the suite otherwise. The empty registry is valid: the bridge still
// handshakes and lists `health`.
import type { McpTool } from '../tool.ts';
import { taskReadsTool } from './task-reads.ts';
import { executionControlTool } from './execution-control.ts';
import { discoverProjectTool } from './discovery.ts';
import { organiseWorkTool } from './work-organisation.ts';
import { taskCreateTool } from './task-create.ts';
import { projectConfigTool } from './project-config.ts';

export const tools: readonly McpTool[] = [
  taskReadsTool,
  executionControlTool,
  discoverProjectTool,
  organiseWorkTool,
  taskCreateTool,
  projectConfigTool,
];
