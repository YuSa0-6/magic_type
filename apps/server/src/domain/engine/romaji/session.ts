import {
  SINGLE,
  DIGRAPH,
  SOKUON_STANDALONE,
  DOUBLABLE,
  N_BLOCKERS,
  N_SPELLINGS_FULL,
  N_SPELLINGS_RESTRICTED,
} from './table';

export type KeyResult = 'accepted' | 'mistyped' | 'completed';

/**
 * 解釈候補。読みの位置 ki から consumes 文字ぶんのかなを
 * spelling というローマ字で打っている途中(matched 文字まで入力済み)を表す。
 */
interface Candidate {
  readonly ki: number;
  readonly consumes: number;
  readonly spelling: string;
  readonly matched: number;
}

/** ある位置から始まる基本セグメント(拗音優先、次に単独かな) */
interface Segment {
  readonly consumes: number;
  readonly spellings: readonly string[];
}

/**
 * 1つのお題(読み)に対するタイピングセッション。
 *
 * 表記ゆれを動的に全受理するため、有効な解釈候補の集合を NFA として保持し、
 * 打鍵ごとにフィルタする。どの候補の継続キーにもならない打鍵は誤入力として
 * ブロックされ(状態は進まない)、誤入力数として記録される。
 */
export class TypingSession {
  private readonly kana: string;
  private active: Candidate[];
  private typed = '';
  private mistypes = 0;
  private completed = false;
  private readonly freshCache = new Map<number, Candidate[]>();

  constructor(reading: string) {
    if (reading.length === 0) {
      throw new Error('読みが空です');
    }
    this.kana = reading;
    // 全位置が変換可能であることを先に検証する(不明なかなは即エラー)
    this.defaultFrom(0);
    this.active = this.fresh(0);
  }

  /** 1打鍵を処理する */
  acceptKey(key: string): KeyResult {
    if (this.completed) {
      return 'completed';
    }
    const k = key.toLowerCase();
    const survivors: Candidate[] = [];
    const seen = new Set<string>();
    let done = false;

    for (const c of this.active) {
      if (c.spelling[c.matched] !== k) {
        continue;
      }
      const m = c.matched + 1;
      if (m < c.spelling.length) {
        pushUnique(survivors, seen, { ...c, matched: m });
        continue;
      }
      // セグメント完了。読み全体が終わっていれば詠唱完了
      const nki = c.ki + c.consumes;
      if (nki === this.kana.length) {
        done = true;
        break;
      }
      for (const f of this.fresh(nki)) {
        pushUnique(survivors, seen, f);
      }
    }

    if (done) {
      this.typed += k;
      this.completed = true;
      this.active = [];
      return 'completed';
    }
    if (survivors.length === 0) {
      this.mistypes++;
      return 'mistyped';
    }
    this.typed += k;
    this.active = survivors;
    return 'accepted';
  }

  /** 入力済みローマ字 */
  get typedRomaji(): string {
    return this.typed;
  }

  /** 誤入力の累計回数 */
  get mistypeCount(): number {
    return this.mistypes;
  }

  /**
   * 残りの推奨ローマ字列(動的ローマ字ガイド)。
   * 現在の入力に追従し、最優先の解釈候補のルートで残りを表示する。
   */
  get remainingGuide(): string {
    if (this.completed) {
      return '';
    }
    const best = this.active[0];
    return best.spelling.slice(best.matched) + this.defaultFrom(best.ki + best.consumes);
  }

  /** 位置 ki から読みの最後までのデフォルト表記 */
  private defaultFrom(ki: number): string {
    let out = '';
    let i = ki;
    while (i < this.kana.length) {
      const first = this.fresh(i)[0];
      out += first.spelling;
      i += first.consumes;
    }
    return out;
  }

  /** 位置 ki から始まる解釈候補(matched=0)を優先順位順に返す */
  private fresh(ki: number): Candidate[] {
    const cached = this.freshCache.get(ki);
    if (cached) {
      return cached;
    }
    const c = this.kana[ki];
    const out: Candidate[] = [];

    if (c === 'っ') {
      // 子音重ね: 次のセグメントの先頭子音を重ねて「っ」ごと打つ
      const next = this.kana[ki + 1];
      if (next !== undefined && next !== 'っ' && next !== 'ん') {
        for (const seg of baseSegments(this.kana, ki + 1)) {
          for (const s of seg.spellings) {
            if (DOUBLABLE.has(s[0])) {
              out.push({ ki, consumes: 1 + seg.consumes, spelling: s[0] + s, matched: 0 });
            }
          }
        }
      }
      for (const s of SOKUON_STANDALONE) {
        out.push({ ki, consumes: 1, spelling: s, matched: 0 });
      }
    } else if (c === 'ん') {
      const next = this.kana[ki + 1];
      const spellings =
        next !== undefined && !N_BLOCKERS.has(next) ? N_SPELLINGS_FULL : N_SPELLINGS_RESTRICTED;
      for (const s of spellings) {
        out.push({ ki, consumes: 1, spelling: s, matched: 0 });
      }
    } else {
      for (const seg of baseSegments(this.kana, ki)) {
        for (const s of seg.spellings) {
          out.push({ ki, consumes: seg.consumes, spelling: s, matched: 0 });
        }
      }
    }

    if (out.length === 0) {
      throw new Error(`変換できないかなです: ${c} (位置 ${ki})`);
    }
    this.freshCache.set(ki, out);
    return out;
  }
}

/** 拗音(2かな)→単独(1かな)の順でセグメントを列挙する */
function baseSegments(kana: string, ki: number): Segment[] {
  const out: Segment[] = [];
  const digraph = DIGRAPH[kana.slice(ki, ki + 2)];
  if (digraph && ki + 1 < kana.length) {
    out.push({ consumes: 2, spellings: digraph });
  }
  const single = SINGLE[kana[ki]];
  if (single) {
    out.push({ consumes: 1, spellings: single });
  }
  return out;
}

function pushUnique(arr: Candidate[], seen: Set<string>, c: Candidate): void {
  const key = `${c.ki}:${c.consumes}:${c.spelling}:${c.matched}`;
  if (!seen.has(key)) {
    seen.add(key);
    arr.push(c);
  }
}
