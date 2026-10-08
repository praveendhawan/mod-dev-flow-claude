/** Checks the command classifier and the approval-quote check. */
import { expect, test } from 'claude-code/testing'

import { classify, said } from './logic'

const kinds = (c: string) => classify(c).map(h => h.kind)

test('classify finds gated actions and ignores docker cargo', () => {
  expect(kinds('git commit -m "x"')).toEqual(['commit'])
  expect(kinds('rtk git push origin x && git status')).toEqual(['push'])
  expect(kinds('cargo test')).toEqual(['cargo'])
  expect(kinds('docker compose run --rm dev cargo test')).toEqual([])
  expect(kinds('git branch -D old')).toEqual(['delete-branch'])
  expect(kinds('glab mr create --fill')).toEqual(['mr'])
  expect(classify('git checkout -b feat/x feat/y')).toEqual([{ kind: 'new-branch', branch: 'feat/x', base: 'feat/y' }])
  expect(kinds('git branch')).toEqual([])
})

test('said needs the quote inside the last prompt', () => {
  expect(said('Yes,  commit it.', 'yes, commit')).toBe(true)
  expect(said('looks fine', 'go ahead')).toBe(false)
  expect(said('anything', 'a')).toBe(false)
})
