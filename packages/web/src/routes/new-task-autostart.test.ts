import { describe, expect, it } from 'vitest'

import { deepLinkToast, unknownSkillPrefillText } from './new-task-autostart'

describe('deepLinkToast', () => {
  it('an unknown skill is called out honestly, and still asks for Start', () => {
    expect(deepLinkToast('ghost')).toEqual({
      message: 'Unknown skill "ghost" — the link filled in the form for quick-task; press Start to begin',
      tone: 'danger',
    })
  })
  it('a plain fill is a quiet hint that Start is needed', () => {
    expect(deepLinkToast('')).toEqual({
      message: 'The link filled in the form — press Start to begin',
      tone: 'default',
    })
  })
})

it('unknownSkillPrefillText is byte-for-byte the legacy embedding', () => {
  expect(unknownSkillPrefillText('xez-fix', 'https://x')).toBe('Use the "xez-fix" skill on: https://x')
})
