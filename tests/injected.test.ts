import { describe, expect, test } from 'claude-code/testing'

import { INSTRUCTIONS, injectedName, injectedText, REREAD_INSTRUCTIONS } from '../hooks/injected'

describe('injectedName', () => {
  test('keeps every opening Claude Code gives a re-read copy apart from the instructions a conversation starts with', () => {
    expect(injectedName(INSTRUCTIONS, 'Codebase and user instructions are shown below.')).toBe(INSTRUCTIONS)
    expect(injectedName(INSTRUCTIONS, 'Instruction files were re-read after the account changed; these differ from their earlier copies')).toBe(REREAD_INSTRUCTIONS)
    expect(injectedName(INSTRUCTIONS, 'These instruction files changed — each replaces its earlier copy')).toBe(REREAD_INSTRUCTIONS)
    expect(injectedName(INSTRUCTIONS, 'Instructions no longer present: /work/CLAUDE.md')).toBe(REREAD_INSTRUCTIONS)
  })

  test('leaves every other type as it is, whatever its text', () => {
    expect(injectedName('nested_memory', 'Instruction files were re-read when this session started')).toBe('nested_memory')
    expect(injectedName('date', 'Today.')).toBe('date')
  })
})

describe('injectedText', () => {
  test('unwraps each text block and joins them as prompt.attachment does', () => {
    const content = [
      { type: 'text', text: '<system-reminder>\nFirst.\n</system-reminder>' },
      { type: 'image', source: {} },
      { type: 'text', text: '<system-reminder>\nSecond.\n</system-reminder>' },
    ]
    expect(injectedText(content)).toBe('First.\nSecond.')
  })

  test('keeps a text without the wrapper as it is', () => {
    expect(injectedText([{ type: 'text', text: 'Plain.' }])).toBe('Plain.')
    expect(injectedText([{ type: 'text', text: '<system-reminder>\nOnly opened.' }])).toBe('<system-reminder>\nOnly opened.')
    expect(injectedText([])).toBe('')
  })
})
