import { describe, expect, test } from 'claude-code/testing'

import { PROMPT_MODE_VARIABLE, promptModeOf, withPromptMode } from '../hooks/settings'

describe('prompt mode', () => {
  test('reads the variable the way Claude Code does', () => {
    expect(promptModeOf({})).toBe('default')
    expect(promptModeOf({ env: { [PROMPT_MODE_VARIABLE]: '0' } })).toBe('full')
    expect(promptModeOf({ env: { [PROMPT_MODE_VARIABLE]: ' False ' } })).toBe('full')
    expect(promptModeOf({ env: { [PROMPT_MODE_VARIABLE]: '1' } })).toBe('short')
    expect(promptModeOf({ env: { [PROMPT_MODE_VARIABLE]: 'yes' } })).toBe('short')
    expect(promptModeOf({ env: { [PROMPT_MODE_VARIABLE]: 'maybe' } })).toBe('default')
    expect(promptModeOf(null)).toBe('unknown')
  })

  test('each mode writes its own value and leaves every other setting as it was', () => {
    const settings = { outputStyle: 'Concise', env: { OTHER: 'x' } }
    expect(withPromptMode(settings, 'full')).toEqual({ outputStyle: 'Concise', env: { OTHER: 'x', [PROMPT_MODE_VARIABLE]: '0' } })
    expect(withPromptMode(settings, 'short')).toEqual({ outputStyle: 'Concise', env: { OTHER: 'x', [PROMPT_MODE_VARIABLE]: '1' } })
    expect(withPromptMode(withPromptMode(settings, 'short'), 'default')).toEqual(settings)
    expect(settings.env).toEqual({ OTHER: 'x' })
  })

  test('removes the env block it made once it is empty again', () => {
    expect(withPromptMode(withPromptMode({ a: 1 }, 'full'), 'default')).toEqual({ a: 1 })
  })
})
