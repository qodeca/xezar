import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, readTestEnv } from './agent-browser'

const artifactsDir = resolve(import.meta.dirname, '../../../.local/qa/artifacts_e2e')
const sessionId = `e2e-settings-monitoring-${process.pid}`
const DESKTOP = { width: 1440, height: 900 }

interface WorkspaceConfig {
  resources: {
    maxMonitoringSessions: number
    monitoringWakeIntervalMinutes: number | null
  }
}

let browser: AgentBrowser
let baseUrl: string
let original: WorkspaceConfig['resources']

async function workspaceConfig(): Promise<WorkspaceConfig> {
  const response = await fetch(`${baseUrl}/api/v1/workspace/config`)
  if (!response.ok) throw new Error(`workspace config failed: ${response.status}`)
  return response.json() as Promise<WorkspaceConfig>
}

async function putResources(resources: Partial<WorkspaceConfig['resources']>): Promise<void> {
  const response = await fetch(`${baseUrl}/api/v1/workspace/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ resources }),
  })
  if (!response.ok) throw new Error(`workspace config update failed: ${response.status}`)
}

/** Polls the saved config every 250 ms, `attempts` times; true once `check` holds. */
async function resourcesReach(check: (resources: WorkspaceConfig['resources']) => boolean, attempts = 40): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (check((await workspaceConfig()).resources)) return true
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  return false
}

async function waitForResources(check: (resources: WorkspaceConfig['resources']) => boolean): Promise<void> {
  if (!(await resourcesReach(check))) throw new Error('workspace resources never reached the expected state')
}

function choose(selector: string, value: string): void {
  browser.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)})
    if (!(element instanceof HTMLSelectElement)) throw new Error('select not found')
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    setter?.call(element, ${JSON.stringify(value)})
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
}

function gotoResources(): void {
  browser.goto(`${baseUrl}/settings/global/resources`)
  browser.waitForFunction(`document.querySelector('[data-slot="resources-section"]') !== null`)
}

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  original = (await workspaceConfig()).resources
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(DESKTOP.width, DESKTOP.height)
})

afterAll(async () => {
  if (original) await putResources({
    maxMonitoringSessions: original.maxMonitoringSessions,
    monitoringWakeIntervalMinutes: original.monitoringWakeIntervalMinutes,
  })
  browser?.close()
})

describe('global Resources monitoring controls', () => {
  it('persists capacity and interval mode through a cold reload', async () => {
    gotoResources()
    choose('[data-slot="resources-max-monitoring"]', '3')
    await waitForResources((resources) => resources.maxMonitoringSessions === 3)

    // The capacity write above invalidates the workspace config, and the refetch that lands a
    // moment later re-renders this form from the server's value — wiping a number typed into
    // the freshly mounted input. Type until it holds, exactly as a reader would, and only then
    // reach for Save (which stays disabled while the field still matches what is saved). The
    // refetch can still land between the typing and the click, leaving the click on a disabled
    // button (1 run in 4 on Windows, #1137), so a save the server never saw is retried.
    for (let attempt = 1; ; attempt += 1) {
      choose('[data-slot="resources-monitoring-wake-mode"]', 'interval')
      browser.waitForFunction(`(() => {
        const input = document.querySelector('[data-slot="resources-monitoring-wake-interval"]')
        if (input === null) return false
        if (input.value === '7') return true
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        setter.call(input, '7')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return false
      })()`)
      browser.waitForFunction(
        `document.querySelector('[data-action="resources-save-monitoring-wake"]:not([disabled])') !== null`,
      )
      browser.click('[data-action="resources-save-monitoring-wake"]')
      if (await resourcesReach((resources) => resources.monitoringWakeIntervalMinutes === 7, 16)) break
      if (attempt === 3) throw new Error('the wake interval save never reached the server in 3 attempts')
    }

    gotoResources()
    expect(String(browser.evaluate(`document.querySelector('[data-slot="resources-max-monitoring"]').value`))).toBe('3')
    expect(String(browser.evaluate(`document.querySelector('[data-slot="resources-monitoring-wake-mode"]').value`))).toBe('interval')
    expect(String(browser.evaluate(`document.querySelector('[data-slot="resources-monitoring-wake-interval"]').value`))).toBe('7')
    expect(browser.text('[data-slot="resources-section"]')).toContain('Capacity:')
    expect(browser.text('[data-slot="resources-section"]')).toContain('3 monitoring')
    browser.screenshot(`${artifactsDir}/settings-monitoring-controls.png`)
  })
})
