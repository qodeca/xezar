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
  // `pi` joined on 2026-09-12 with its catalog files (#330 WP4) — the condition the old note
  // here set. The table is now total over `Runner`.
  it('has one entry per config-owning runner, each with settings/mcp/memory groups in stable order', () => {
    expect(AGENT_DESCRIPTORS.map((d) => d.id)).toEqual(['claude', 'codex', 'opencode', 'pi'])
    for (const d of AGENT_DESCRIPTORS) {
      expect(d.groups.map((g) => g.id)).toEqual(['settings', 'mcp', 'memory'])
      expect(d.groups.find((g) => g.id === 'mcp')?.note).toBeTruthy() // every agent says where MCP servers live
    }
  })

  it('membership uses runners[] inclusion — shared files belong to every reader', () => {
    const shared = fileOf({ id: 'project.agents', runners: ['codex', 'opencode'], kind: 'memory', format: 'markdown' })
    expect(descriptorFor('codex').groups.find((g) => g.id === 'memory')!.files(shared)).toBe(true)
    expect(descriptorFor('opencode').groups.find((g) => g.id === 'memory')!.files(shared)).toBe(true)
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
   * pi's own two groups, and the one claim the pane makes that the catalog cannot: pi core reads
   * no MCP config at all — the files are the `pi-mcp-adapter` extension's. Saying so in the group
   * note is what stops the editor implying that filling the file in is enough.
   */
  it('routes pi’s own files into pi’s groups, and says who actually reads the MCP ones', () => {
    const pi = descriptorFor('pi')
    const settings = fileOf({ id: 'pi.user.settings', runners: ['pi'], kind: 'settings' })
    const mcp = fileOf({ id: 'pi.project.mcp', runners: ['pi'], kind: 'mcp', holdsMcp: true })
    const memory = fileOf({ id: 'pi.user.memory', runners: ['pi'], kind: 'memory', format: 'markdown' })
    expect(pi.groups.find((g) => g.id === 'settings')!.files(settings)).toBe(true)
    expect(pi.groups.find((g) => g.id === 'mcp')!.files(mcp)).toBe(true)
    expect(pi.groups.find((g) => g.id === 'memory')!.files(memory)).toBe(true)
    // …and pi's pane does not adopt another agent's file just because the kind matches.
    expect(pi.groups.find((g) => g.id === 'settings')!.files(fileOf({ id: 'claude.user.settings' }))).toBe(false)
    expect(pi.groups.find((g) => g.id === 'mcp')!.note).toContain('pi-mcp-adapter')
  })

  it('descriptorFor throws on an unknown agent id', () => {
    expect(() => descriptorFor('nope' as never)).toThrow(/no agent descriptor/)
  })
})
