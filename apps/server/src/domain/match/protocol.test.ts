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
