import { describe, it, expect } from 'vitest';
import { parseClientMessage } from './protocol.ts';

describe('parseClientMessage(クライアントメッセージ検証)', () => {
  it('join(code 有/無)を受理する', () => {
    expect(parseClientMessage({ type: 'join' })).toEqual({ type: 'join', code: undefined });
    expect(parseClientMessage({ type: 'join', code: 'ABC123' })).toEqual({
      type: 'join',
      code: 'ABC123',
    });
  });

  it('submitDeck は文字列配列のみ受理する', () => {
    expect(parseClientMessage({ type: 'submitDeck', deckIds: ['wave', 'spark'] })).toEqual({
      type: 'submitDeck',
      deckIds: ['wave', 'spark'],
    });
    expect(parseClientMessage({ type: 'submitDeck', deckIds: [1, 2] })).toBeNull();
    expect(parseClientMessage({ type: 'submitDeck' })).toBeNull();
  });

  it('ready を受理する', () => {
    expect(parseClientMessage({ type: 'ready' })).toEqual({ type: 'ready' });
  });

  it('input(select / press の混在バッチ)を受理する', () => {
    const commands = [
      { kind: 'select', handIndex: 2, atMs: 100 },
      { kind: 'press', key: 'k', atMs: 110 },
    ];
    expect(parseClientMessage({ type: 'input', commands })).toEqual({ type: 'input', commands });
  });

  it('input の commands が配列でない / 要素が不正なら null', () => {
    expect(parseClientMessage({ type: 'input' })).toBeNull();
    expect(parseClientMessage({ type: 'input', commands: 'x' })).toBeNull();
    // atMs 欠落
    expect(
      parseClientMessage({ type: 'input', commands: [{ kind: 'press', key: 'k' }] })
    ).toBeNull();
    // 未知 kind
    expect(
      parseClientMessage({ type: 'input', commands: [{ kind: 'attack', atMs: 1 }] })
    ).toBeNull();
    // select の handIndex が非整数
    expect(
      parseClientMessage({ type: 'input', commands: [{ kind: 'select', handIndex: 1.5, atMs: 1 }] })
    ).toBeNull();
    // press の key が文字列でない
    expect(
      parseClientMessage({ type: 'input', commands: [{ kind: 'press', key: 9, atMs: 1 }] })
    ).toBeNull();
    // atMs が非有限
    expect(
      parseClientMessage({
        type: 'input',
        commands: [{ kind: 'press', key: 'k', atMs: Infinity }],
      })
    ).toBeNull();
  });

  it('input の空 commands は受理する(空バッチは合法)', () => {
    expect(parseClientMessage({ type: 'input', commands: [] })).toEqual({
      type: 'input',
      commands: [],
    });
  });

  it('未知 type / 非オブジェクト / null は null', () => {
    expect(parseClientMessage({ type: 'attack' })).toBeNull();
    expect(parseClientMessage('ready')).toBeNull();
    expect(parseClientMessage(null)).toBeNull();
    expect(parseClientMessage(42)).toBeNull();
  });

  it('join の code が文字列以外なら null', () => {
    expect(parseClientMessage({ type: 'join', code: 123 })).toBeNull();
  });
});
