import { describe, expect, test } from 'claude-code/testing'

import { PROMPT_MODE_VARIABLE, promptModeOf, recordingStateOf, withPromptMode, withRecording } from '../hooks/settings'

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

describe('recording', () => {
  const recorder = { dir: '/rec', port: 18777, proxy: 'http://127.0.0.1:18777', ca: '/home/test/.mitmproxy/ca.pem' }

  test('tells sessions through the recorder from direct ones, and from a proxy or certificate of the user\'s own', () => {
    expect(recordingStateOf({}, recorder)).toBe('off')
    expect(recordingStateOf({ env: { HTTPS_PROXY: recorder.proxy, NODE_EXTRA_CA_CERTS: recorder.ca } }, recorder)).toBe('on')
    expect(recordingStateOf({ env: { HTTPS_PROXY: 'http://corp:8080' } }, recorder)).toBe('other')
    expect(recordingStateOf({ env: { NODE_EXTRA_CA_CERTS: '/corp.pem' } }, recorder)).toBe('other')
    expect(recordingStateOf({ env: { HTTPS_PROXY: recorder.proxy } }, null)).toBe('other')
  })

  test('turning it on and off again leaves every value of the user\'s own as it was', () => {
    const settings = { model: 'opus', env: { OTHER: 'x', NO_PROXY: 'intranet' } }
    const on = withRecording(settings, recorder, true)
    expect(on).toEqual({ model: 'opus', env: { OTHER: 'x', NO_PROXY: 'intranet', HTTPS_PROXY: recorder.proxy, NODE_EXTRA_CA_CERTS: recorder.ca } })
    expect(withRecording(on, recorder, false)).toEqual(settings)
    expect(withRecording(withRecording({}, recorder, true), recorder, false)).toEqual({})
  })
})
