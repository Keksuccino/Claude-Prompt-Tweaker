import { describe, expect, test } from 'claude-code/testing'

import { changingTexts, clipText, emptyCatalog, emptyHistory, MAX_HISTORY_ITEMS, MAX_TEXT_LENGTH, mergeCatalog, recordSighting, textKey, withInferredVariants } from '../hooks/history'
import type { HistoryItem } from '../types'

describe('recordSighting', () => {
  test('counts a repeat and keeps a changed text or outcome apart', () => {
    const history = emptyHistory('s', '/w', 1)
    const seen = { kind: 'attachment' as const, name: 'output_style', hash: 'h1', length: 10, action: 'sent' as const }
    recordSighting(history, seen, 5)
    recordSighting(history, seen, 9)
    recordSighting(history, { ...seen, action: 'dropped' }, 10)
    recordSighting(history, { ...seen, hash: 'h2' }, 11)
    expect(history.items.map(item => [item.hash, item.action, item.count, item.firstAt, item.lastAt])).toEqual([
      ['h1', 'sent', 2, 5, 9],
      ['h1', 'dropped', 1, 10, 10],
      ['h2', 'sent', 1, 11, 11],
    ])
    expect(history.lastAt).toBe(11)
  })

  test('counts only injected messages, and an unknown count stays unknown', () => {
    const history = emptyHistory('s', '/w', 1)
    const section = { kind: 'section' as const, name: 'memory', hash: 'h1', length: 10, action: 'sent' as const }
    recordSighting(history, section, 5)
    recordSighting(history, section, 9)
    history.items.push({ kind: 'attachment', name: 'date', hash: 'h2', length: 6, action: 'sent', firstAt: 2, lastAt: 3, count: 0 })
    recordSighting(history, { kind: 'attachment', name: 'date', hash: 'h2', length: 6, action: 'sent' }, 12)
    expect(history.items.map(item => [item.kind, item.count, item.lastAt])).toEqual([
      ['section', 0, 9],
      ['attachment', 0, 12],
    ])
  })

  test('gives up the item seen longest ago once full', () => {
    const history = emptyHistory('s', '/w', 0)
    for (let index = 0; index <= MAX_HISTORY_ITEMS; index++) {
      recordSighting(history, { kind: 'section', name: `n${index}`, hash: `h${index}`, length: 1, action: 'sent' }, index + 1)
    }
    expect(history.items.length).toBe(MAX_HISTORY_ITEMS)
    expect(history.items.some(item => item.name === 'n0')).toBe(false)
  })
})

describe('clipText', () => {
  test('keeps short texts whole and says how much a long one lost', () => {
    expect(clipText('short')).toBe('short')
    const clipped = clipText('x'.repeat(MAX_TEXT_LENGTH + 5))
    expect(clipped.startsWith('x'.repeat(MAX_TEXT_LENGTH))).toBe(true)
    expect(clipped.length > MAX_TEXT_LENGTH).toBe(true)
    expect(clipped.endsWith(']')).toBe(true)
  })
})

describe('mergeCatalog', () => {
  const snapshot = (model: string, lastAt: number, text = 'text') => ({ order: ['a'], sections: { a: { text, lastAt } }, model, lastAt })

  test('keeps the newer prompt of each version and follows the newest version', () => {
    const stored = { ...emptyCatalog(), prompts: { full: snapshot('old-full', 5), lean: snapshot('old-lean', 1) }, lastVariant: 'full' as const }
    const ours = { ...emptyCatalog(), prompts: { lean: snapshot('new-lean', 9, 'new') }, lastVariant: 'lean' as const }
    const merged = mergeCatalog(stored, ours)
    expect(merged.prompts.full?.model).toBe('old-full')
    expect(merged.prompts.lean?.model).toBe('new-lean')
    expect(merged.lastVariant).toBe('lean')
  })

  test('keeps the sections either side remembers, with the newer prompt\'s order', () => {
    const stored = { ...emptyCatalog(), prompts: { lean: { order: ['a', 'rare'], sections: { a: { text: 'old', lastAt: 1 }, rare: { text: 'sometimes', lastAt: 1 } }, model: 'm', lastAt: 1 } } }
    const ours = { ...emptyCatalog(), prompts: { lean: { order: ['a'], sections: { a: { text: 'new', lastAt: 2 } }, model: 'm', lastAt: 2 } } }
    const merged = mergeCatalog(stored, ours).prompts.lean
    expect(merged?.order).toEqual(['a'])
    expect(merged?.sections).toEqual({ a: { text: 'new', lastAt: 2 }, rare: { text: 'sometimes', lastAt: 1 } })
  })

  test('another session\'s newer prompt wins over this session\'s older one', () => {
    const stored = { ...emptyCatalog(), prompts: { lean: snapshot('theirs', 8) }, lastVariant: 'lean' as const }
    const ours = { ...emptyCatalog(), prompts: { lean: snapshot('mine', 3) }, lastVariant: 'lean' as const }
    expect(mergeCatalog(stored, ours).prompts.lean?.model).toBe('theirs')
  })

  test('keeps the later sighting per item and the stored context order when this session saw none', () => {
    const stored = { ...emptyCatalog(), attachments: { a: { text: 'old', lastAt: 1 }, b: { text: 'kept', lastAt: 1 } }, contextOrder: ['claudeMd'] }
    const ours = { ...emptyCatalog(), attachments: { a: { text: 'new', lastAt: 2 } } }
    const merged = mergeCatalog(stored, ours)
    expect(merged.attachments).toEqual({ a: { text: 'new', lastAt: 2 }, b: { text: 'kept', lastAt: 1 } })
    expect(merged.contextOrder).toEqual(['claudeMd'])
    expect(merged.lastVariant).toBeNull()
  })
})

describe('changingTexts', () => {
  test('marks an item whose text differed between sightings, per prompt version', () => {
    const first = emptyHistory('s1', '/w', 0)
    const second = emptyHistory('s2', '/w', 0)
    const seen = { kind: 'section' as const, name: 'memory', length: 1, action: 'sent' as const }
    recordSighting(first, { ...seen, hash: 'a', variant: 'lean' }, 1)
    recordSighting(second, { ...seen, hash: 'b', variant: 'lean' }, 2)
    recordSighting(first, { ...seen, name: 'pronouns', hash: 'p', variant: 'lean' }, 1)
    recordSighting(second, { ...seen, name: 'pronouns', hash: 'p', variant: 'lean' }, 2)
    recordSighting(first, { ...seen, name: 'action_caution', hash: 'short', variant: 'lean' }, 1)
    recordSighting(second, { ...seen, name: 'action_caution', hash: 'long', variant: 'full' }, 2)

    expect([...changingTexts([first, second])]).toEqual([textKey('section', 'memory', 'lean')])
  })
})

describe('withInferredVariants', () => {
  const item = (name: string, variant?: 'lean' | 'full', kind: 'section' | 'context' = 'section'): HistoryItem => ({ kind, name, hash: name, length: 1, action: 'sent', firstAt: 1, lastAt: 1, count: 0, ...(variant === undefined ? {} : { variant }) })

  test('places the sections without a version in the version whose opening section is among them', () => {
    const items = [item('lean_body'), item('fable_identity'), item('memory', 'full'), item('claudeMd', undefined, 'context')]
    expect(withInferredVariants(items).map(one => [one.name, one.variant])).toEqual([['lean_body', 'lean'], ['fable_identity', 'lean'], ['memory', 'full'], ['claudeMd', undefined]])
    expect(withInferredVariants([item('intro'), item('doing_tasks')]).map(one => one.variant)).toEqual(['full', 'full'])
  })

  test('leaves them without one when no opening section, or both, tells the version', () => {
    expect(withInferredVariants([item('fable_identity')]).map(one => one.variant)).toEqual([undefined])
    expect(withInferredVariants([item('lean_body'), item('intro'), item('memory')]).map(one => one.variant)).toEqual([undefined, undefined, undefined])
  })
})
