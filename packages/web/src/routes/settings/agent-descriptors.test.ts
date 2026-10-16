import { describe, expect, it } from 'vitest'

import type { AgentConfigFile } from '@qodeca/xezar-api-client'
import { AGENT_DESCRIPTORS, descriptorFor } from './agent-descriptors'

/** The descriptor table driving Settings → Agent config (spec 2026-07-17-agent-config-by-agent). */

function fileOf(over: Partial<AgentConfigFile> & Pick<AgentConfigFile, 'id'>): AgentConfigFile {
  return {
    label: over.id,
    runners: ['claude'],
    kind: 'settings',
    scope: 'project',
    format: 'json',
    tracked: 'tracked',
    seeded: false,
    holdsMcp: false,
    precedence: 'p',
    docsUrl: 'https://example.com',
    path: `/repo/${over.id}`,
    exists: true,
    size: 1,
    version: 'v1',
    writable: true,
    ...over,
  }
}

describe('AGENT_DESCRIPTORS', () => {
  // The table is total over `Runner`.
  it('has one entry per config-owning runner, each with settings/mcp/memory groups in stable order', () => {
    expect(AGENT_DESCRIPTORS.map((d) => d.id)).toEqual(['claude', 'codex', 'qwen'])
    for (const d of AGENT_DESCRIPTORS) {
      expect(d.groups.map((g) => g.id)).toEqual(['settings', 'mcp', 'memory'])
      expect(d.groups.find((g) => g.id === 'mcp')?.note).toBeTruthy() // every agent says where MCP servers live
    }
  })

  it('membership uses runners[] inclusion — shared files belong to every reader', () => {
    const shared = fileOf({ id: 'project.agents', runners: ['codex', 'qwen'], kind: 'memory', format: 'markdown' })
    expect(descriptorFor('codex').groups.find((g) => g.id === 'memory')!.files(shared)).toBe(true)
    expect(descriptorFor('qwen').groups.find((g) => g.id === 'memory')!.files(shared)).toBe(true)
    expect(descriptorFor('claude').groups.find((g) => g.id === 'memory')!.files(shared)).toBe(false)
  })

  it('holdsMcp promotes a file into the MCP group without leaving its own kind', () => {
    const codexConfig = fileOf({ id: 'codex.project.config', runners: ['codex'], kind: 'settings', holdsMcp: true })
    const codex = descriptorFor('codex')
    expect(codex.groups.find((g) => g.id === 'settings')!.files(codexConfig)).toBe(true)
    expect(codex.groups.find((g) => g.id === 'mcp')!.files(codexConfig)).toBe(true)
    expect(codex.groups.find((g) => g.id === 'memory')!.files(codexConfig)).toBe(false)
  })

  it('a dedicated mcp-kind file lands in the MCP group only', () => {
    const mcpJson = fileOf({ id: 'claude.project.mcp', kind: 'mcp', holdsMcp: true })
    const claude = descriptorFor('claude')
    expect(claude.groups.find((g) => g.id === 'mcp')!.files(mcpJson)).toBe(true)
    expect(claude.groups.find((g) => g.id === 'settings')!.files(mcpJson)).toBe(false)
  })

  /**
   * Qwen Code's own groups, and the one claim the pane makes that the catalog cannot: its MCP
   * servers live inside its settings file, under one key. Saying so in the group note is what
   * stops the pane implying a separate MCP file exists.
   */
  it('routes Qwen Code’s own files into its groups, and says where its MCP servers live', () => {
    const qwen = descriptorFor('qwen')
    const settings = fileOf({ id: 'qwen.user.settings', runners: ['qwen'], kind: 'settings', holdsMcp: true })
    const memory = fileOf({ id: 'qwen.user.memory', runners: ['qwen'], kind: 'memory', format: 'markdown' })
    expect(qwen.groups.find((g) => g.id === 'settings')!.files(settings)).toBe(true)
    expect(qwen.groups.find((g) => g.id === 'mcp')!.files(settings)).toBe(true)
    expect(qwen.groups.find((g) => g.id === 'memory')!.files(memory)).toBe(true)
    // …and Qwen Code's pane does not adopt another agent's file just because the kind matches.
    expect(qwen.groups.find((g) => g.id === 'settings')!.files(fileOf({ id: 'claude.user.settings' }))).toBe(false)
    expect(qwen.groups.find((g) => g.id === 'mcp')!.note).toContain('mcpServers')
  })

  it('descriptorFor throws on an unknown agent id', () => {
    expect(() => descriptorFor('nope' as never)).toThrow(/no agent descriptor/)
  })
})
