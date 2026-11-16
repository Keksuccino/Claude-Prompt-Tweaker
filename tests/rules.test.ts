import { describe, expect, test } from 'claude-code/testing'
import type { PromptComposeSection } from 'claude-code'

import { ADDED_PREFIX, applyPatches, applyRule, composeSections, countMatches, emptyRules, fillOriginal, keptTools, nextAddedId, parseRules, withRule } from '../hooks/rules'

const SECTIONS: PromptComposeSection[] = [
  { id: 'intro', text: 'Intro text', scope: 'shared' },
  { id: 'tools', text: 'Tools text', scope: 'shared' },
  { id: 'memory', text: 'Memory text', scope: 'session' },
]

describe('composeSections', () => {
  test('passes every section on untouched without rules', () => {
    const { sections, actions } = composeSections(SECTIONS, emptyRules())
    expect(sections).toEqual(SECTIONS)
    expect([...actions.values()]).toEqual(['sent', 'sent', 'sent'])
  })

  test('drops, replaces and appends while keeping each section on its cache side', () => {
    let rules = withRule(emptyRules(), 'section', 'tools', { mode: 'drop' })
    rules = withRule(rules, 'section', 'intro', { mode: 'replace', text: 'My intro' })
    rules = { ...rules, added: [{ id: 'custom-1', text: 'Verify before claiming.' }, { id: 'custom-2', text: '  ' }] }
    const { sections, actions } = composeSections(SECTIONS, rules)
    expect(sections).toEqual([
      { id: 'intro', text: 'My intro', scope: 'shared' },
      { id: 'memory', text: 'Memory text', scope: 'session' },
      { id: `${ADDED_PREFIX}custom-1`, text: 'Verify before claiming.', scope: 'session' },
    ])
    expect(actions.get('intro')).toBe('edited')
    expect(actions.get('tools')).toBe('dropped')
    expect(actions.get('memory')).toBe('sent')
  })

  test('sends everything as made while the rules are paused', () => {
    const rules = { ...withRule(emptyRules(), 'section', 'memory', { mode: 'drop' }), isPaused: true, added: [{ id: 'custom-1', text: 'Extra' }] }
    expect(composeSections(SECTIONS, rules).sections).toEqual(SECTIONS)
  })
})

describe('applyRule', () => {
  test('tells an edit apart from a replacement that matches the original', () => {
    expect(applyRule('A', undefined)).toEqual({ text: 'A', action: 'sent' })
    expect(applyRule('A', { mode: 'drop' })).toEqual({ text: null, action: 'dropped' })
    expect(applyRule('A', { mode: 'replace', text: 'B' })).toEqual({ text: 'B', action: 'edited' })
    expect(applyRule('A', { mode: 'replace', text: 'A' })).toEqual({ text: 'A', action: 'sent' })
  })
})

describe('dynamic text', () => {
  test('a full replacement fills in every {{original}} with the current text', () => {
    expect(fillOriginal('Before. {{original}} After {{original}}', 'Live')).toBe('Before. Live After Live')
    expect(applyRule('Path /a', { mode: 'replace', text: '{{original}}\nAlso this.' })).toEqual({ text: 'Path /a\nAlso this.', action: 'edited' })
    expect(applyRule('Path /a', { mode: 'replace', text: '{{original}}' })).toEqual({ text: 'Path /a', action: 'sent' })
  })

  test('find and replace applies its pairs in order to the current text, taking the text literally', () => {
    const patches = [{ find: 'memory at /a', replace: 'memory at $& (.*)' }, { find: '(.*)', replace: 'done' }, { find: '', replace: 'ignored' }]
    expect(applyPatches('Your memory at /a. Your memory at /a.', patches)).toBe('Your memory at $& done. Your memory at $& done.')
    expect(applyRule('Memory at /b', { mode: 'patch', patches: [{ find: 'Memory', replace: 'Notes' }] })).toEqual({ text: 'Notes at /b', action: 'edited' })
    expect(applyRule('Nothing to find', { mode: 'patch', patches: [{ find: 'absent', replace: 'x' }] })).toEqual({ text: 'Nothing to find', action: 'sent' })
  })

  test('counts how often a pair finds its text', () => {
    expect(countMatches('a.b.a.b', 'a.b')).toBe(2)
    expect(countMatches('abc', 'x')).toBe(0)
    expect(countMatches('abc', '')).toBe(0)
  })
})

describe('parseRules', () => {
  test('reads find and replace rules and leaves out broken pairs', () => {
    const rules = parseRules(JSON.stringify({ sections: { a: { mode: 'patch', patches: [{ find: 'x', replace: 'y' }, { find: 1 }] }, b: { mode: 'patch', patches: [] }, c: { mode: 'patch' } } }))
    expect(rules.sections).toEqual({ a: { mode: 'patch', patches: [{ find: 'x', replace: 'y' }] } })
  })

  test('keeps valid rules and leaves out broken ones', () => {
    const rules = parseRules(JSON.stringify({
      isPaused: true,
      sections: { a: { mode: 'drop' }, b: { mode: 'replace', text: 'x' }, c: { mode: 'replace' }, d: 'nope' },
      added: [{ id: 'custom-1', text: 'hi' }, { id: 3 }],
      tools: null,
    }))
    expect(rules.isPaused).toBe(true)
    expect(rules.sections).toEqual({ a: { mode: 'drop' }, b: { mode: 'replace', text: 'x' } })
    expect(rules.added).toEqual([{ id: 'custom-1', text: 'hi' }])
    expect(rules.tools).toEqual({})
  })

  test('falls back to empty rules for JSON that is not an object', () => {
    expect(parseRules('[1, 2]')).toEqual(emptyRules())
  })
})

describe('rule edits', () => {
  test('removing a rule leaves the others in place', () => {
    const rules = withRule(withRule(emptyRules(), 'attachment', 'a', { mode: 'drop' }), 'attachment', 'b', { mode: 'drop' })
    expect(Object.keys(withRule(rules, 'attachment', 'a', undefined).attachments)).toEqual(['b'])
  })

  test('a new section takes the first free number', () => {
    const rules = { ...emptyRules(), added: [{ id: 'custom-1', text: '' }, { id: 'custom-3', text: '' }] }
    expect(nextAddedId(rules)).toBe('custom-2')
  })
})

describe('keptTools', () => {
  const tools = [{ name: 'Bash' }, { name: 'Read' }, { name: 'Edit' }]

  test('leaves out the removed tools, none while paused, and keeps tools whose description is edited', () => {
    const rules = { ...emptyRules(), tools: { Bash: { mode: 'drop' as const }, Edit: { mode: 'replace' as const, text: 'Mine.' } } }
    expect(keptTools(tools, rules).map(tool => tool.name)).toEqual(['Read', 'Edit'])
    expect(keptTools(tools, { ...rules, isPaused: true }).map(tool => tool.name)).toEqual(['Bash', 'Read', 'Edit'])
  })
})
