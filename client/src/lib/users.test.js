import { describe, it, expect } from 'vitest'
import { filterUsernames } from './users.js'

const ALL = ['alice', 'bob', 'carol', 'malcolm', 'mallory']

describe('filterUsernames', () => {
  it('returns everyone for an empty query', () => {
    expect(filterUsernames(ALL, '')).toEqual(ALL)
    expect(filterUsernames(ALL, '   ')).toEqual(ALL)
  })

  it('excludes given usernames (owner, already-shared)', () => {
    expect(filterUsernames(ALL, '', ['alice', 'bob'])).toEqual(['carol', 'malcolm', 'mallory'])
  })

  it('matches case-insensitively', () => {
    expect(filterUsernames(ALL, 'ALI')).toEqual(['alice'])
  })

  it('ranks prefix matches before substring matches', () => {
    expect(filterUsernames(ALL, 'mal')).toEqual(['malcolm', 'mallory'])
    expect(filterUsernames(ALL, 'al')).toEqual(['alice', 'malcolm', 'mallory'])
  })

  it('returns empty when nothing matches', () => {
    expect(filterUsernames(ALL, 'zzz')).toEqual([])
  })
})
