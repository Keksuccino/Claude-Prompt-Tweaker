import { describe, expect, test } from 'claude-code/testing'

import { newMessageCount, parseSummaries } from '../hooks/recordings'
import type { Exchange } from '../types'

function exchangeWith(messages: string[]): Exchange {
  return { request: { headers: [], body: { messages } }, response: { headers: [], body: null } } as unknown as Exchange
}

describe('parseSummaries', () => {
  test('lists the newest exchange first and leaves out a line that does not parse', () => {
    const lines = [JSON.stringify({ n: 1, at: 100 }), '{"n": 2, "at"', JSON.stringify({ n: 3, at: 300 }), JSON.stringify({ n: 2, at: 200 }), '']
    expect(parseSummaries(lines.join('\n')).map(one => one.n)).toEqual([3, 2, 1])
  })
})

describe('newMessageCount', () => {
  test('counts what follows the messages a request shares with the one before it', () => {
    expect(newMessageCount(exchangeWith(['a', 'b', 'c']), exchangeWith(['a']))).toBe(2)
    expect(newMessageCount(exchangeWith(['a', 'b']), null)).toBe(2)
    // A compaction rewrites the conversation from its start: every message is new.
    expect(newMessageCount(exchangeWith(['s', 'c']), exchangeWith(['a', 'b']))).toBe(2)
    expect(newMessageCount(exchangeWith(['a', 'b']), exchangeWith(['a', 'b']))).toBe(0)
  })
})
