import { describe, it, expect } from 'vitest';
import { BattleEngine } from './battle';
import { CARDS } from './cards';

/**
 * エンジン機構テスト用の固定デッキ(全10種×各2枚=20枚)。
 * 製品の STARTER_DECK(15枚)とは独立に、決定論シャッフルの golden 値を固定するため
 * ここでローカルに 20 枚デッキを定義する(STARTER_DECK の構成変更でこのテストが壊れない)。
 */
const TEST_DECK = CARDS.flatMap((card) => [card, card]);

/**
 * 決定論的な疑似乱数(mulberry32)。固定シードで山札のシャッフルを再現する。
 * これによりどのカードが手札・山札に来るかをテストで確定できる。
 */
function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * シード12345での初期配置(TEST_DECK 基準, 20枚):
 *   手札 = [abyss(16), gale(5), blaze(8), ray(10)]
 *   山札(引く順) = meteor(14), abyss(16), wave(3), blaze(8), thunder(9), ray(10), ...(計16枚)
 */
const SEED = 12345;

/** 各カードのデフォルトローマ字(動的ガイドの全文) */
const ROMAJI: Record<string, string> = {
  wave: 'aranamiyotekiwonome',
  spark: 'akakihibanayohazikero',
  gale: 'kazenoyaibayokakenukero',
  frost: 'koorinooriyotekiwotoraero',
  blaze: 'uzumakuhonooyotekiwotutumikome',
  thunder: 'tenkuunoikazutiyotekiwoturanuke',
  ray: 'kagayakeruhikarinoyayotekiwoutinuke',
  chasm: 'yuruginakidaitiyotekiwotiteihetosizume',
  meteor: 'tennyorihurisosoguryuuseiyotekiwoutikudake',
  abyss: 'narakunosokoyorihaiagarutokoyamiyotekiwomusibame',
};

/** シード固定でエンジンを作る */
function makeEngine(targetHp?: number): BattleEngine {
  return new BattleEngine(TEST_DECK, { targetHp, rng: mulberry32(SEED) });
}

/**
 * 指定カードのローマ字を順に打鍵して詠唱を打ち切る。
 * 全打鍵を時刻 atMs で行う(発動時刻=詠唱開始時刻=atMs となり詠唱時間は0)。
 * 詠唱時間を検証したいテストでは個別に時刻を制御する。返り値は最後の打鍵結果。
 */
function castFull(engine: BattleEngine, cardId: string, atMs: number): string {
  const romaji = ROMAJI[cardId];
  let last = '';
  for (let i = 0; i < romaji.length; i++) {
    last = engine.pressKey(romaji[i], atMs);
  }
  return last;
}

describe('初期状態', () => {
  it('手札4枚・山札16枚・捨て札0・HP80で始まる', () => {
    const engine = makeEngine();
    const snap = engine.snapshotState();
    expect(snap.targetHp).toBe(80);
    expect(snap.targetMaxHp).toBe(80);
    expect(snap.hand).toHaveLength(4);
    expect(snap.drawPileCount).toBe(16);
    expect(snap.discardPileCount).toBe(0);
    expect(snap.selectedIndex).toBeNull();
    expect(snap.finished).toBe(false);
    expect(snap.clearTimeMs).toBeNull();
  });

  it('固定シードで手札が決まる', () => {
    const engine = makeEngine();
    const ids = engine.snapshotState().hand.map((c) => c.id);
    expect(ids).toEqual(['abyss', 'gale', 'blaze', 'ray']);
  });

  it('start 前は経過時間0、start で開始時刻を記録する', () => {
    const engine = makeEngine();
    expect(engine.snapshotTimers(1000).elapsedMs).toBe(0);
    engine.start(1000);
    expect(engine.snapshotTimers(1500).elapsedMs).toBe(500);
  });

  it('start は二重に呼んでも最初の時刻を保つ', () => {
    const engine = makeEngine();
    engine.start(1000);
    engine.start(9999);
    expect(engine.snapshotTimers(1500).elapsedMs).toBe(500);
  });
});

describe('カード選択(構え)', () => {
  it('選択するとお題のローマ字ガイドが表示される', () => {
    const engine = makeEngine();
    engine.start(0);
    engine.selectCard(1, 0); // gale
    const snap = engine.snapshotState();
    expect(snap.selectedIndex).toBe(1);
    expect(snap.remainingGuide).toBe(ROMAJI.gale);
    expect(snap.typedRomaji).toBe('');
    expect(snap.castMistypes).toBe(0);
  });

  it('範囲外インデックスは例外', () => {
    const engine = makeEngine();
    expect(() => engine.selectCard(4, 0)).toThrow();
    expect(() => engine.selectCard(-1, 0)).toThrow();
  });
});

describe('詠唱→発動', () => {
  it('打ち切るとダメージ・捨て札・補充・クールダウン開始が起きる', () => {
    const engine = makeEngine();
    engine.start(0);
    engine.selectCard(1, 0); // gale(damage5, cooldown1500)
    const result = castFull(engine, 'gale', 1000);
    expect(result).toBe('activated');

    const snap = engine.snapshotState();
    expect(snap.targetHp).toBe(75); // 80 - 5
    expect(snap.discardPileCount).toBe(1); // gale が捨て札へ
    expect(snap.drawPileCount).toBe(15); // 1枚補充で16→15
    expect(snap.hand).toHaveLength(4); // 手札は4枚維持
    expect(snap.selectedIndex).toBeNull(); // 選択解除
    expect(engine.snapshotTimers(1000).cooldownRemainingMs).toBe(1500); // クールダウン開始
  });

  it('補充されるカードは山札の先頭(meteor)', () => {
    const engine = makeEngine();
    engine.start(0);
    engine.selectCard(1, 0); // 手札index1 を発動
    castFull(engine, 'gale', 1000);
    expect(engine.snapshotState().hand[1].id).toBe('meteor');
  });

  it('詠唱時間は最初の受理打鍵から発動打鍵まで(選択時点ではない)', () => {
    const engine = makeEngine();
    engine.start(0);
    engine.selectCard(1, 0); // 選択は時刻0
    const romaji = ROMAJI.gale;
    // 最初の打鍵を時刻5000、最後の打鍵を時刻6000にする
    for (let i = 0; i < romaji.length; i++) {
      const t = i === 0 ? 5000 : 6000;
      engine.pressKey(romaji[i], t);
    }
    const activated = engine.events.find((e) => e.type === 'activated');
    expect(activated).toBeDefined();
    if (activated?.type === 'activated') {
      expect(activated.castTimeMs).toBe(1000); // 6000 - 5000
    }
  });
});

describe('誤入力によるダメージ減衰', () => {
  it('誤入力数だけダメージが減る', () => {
    const engine = makeEngine();
    engine.start(0);
    engine.selectCard(1, 0); // gale(damage5)
    // 詠唱開始前に誤入力を2回はさむ
    expect(engine.pressKey('x', 100)).toBe('mistyped');
    expect(engine.pressKey('z', 100)).toBe('mistyped');
    expect(engine.snapshotState().castMistypes).toBe(2);
    castFull(engine, 'gale', 1000);
    expect(engine.snapshotState().targetHp).toBe(80 - (5 - 2)); // ダメージ3
  });

  it('ダメージは誤入力が多くても下限1を下回らない', () => {
    const engine = makeEngine();
    engine.start(0);
    engine.selectCard(1, 0); // gale(damage5)
    // 10回誤入力 → 5-10 だが下限1
    for (let i = 0; i < 10; i++) {
      engine.pressKey('q', 100);
    }
    castFull(engine, 'gale', 1000);
    expect(engine.snapshotState().targetHp).toBe(79); // 80 - 1
  });
});

describe('カード切り替えで進捗リセット', () => {
  it('詠唱中に別カードへ切り替えると入力進捗と誤入力カウントがリセットされる', () => {
    const engine = makeEngine();
    engine.start(0);
    engine.selectCard(1, 0); // gale
    engine.pressKey('k', 10); // kazen... の途中まで
    engine.pressKey('a', 20);
    engine.pressKey('x', 30); // 誤入力1
    expect(engine.snapshotState().typedRomaji).toBe('ka');
    expect(engine.snapshotState().castMistypes).toBe(1);

    engine.selectCard(3, 40); // ray へ切り替え
    const snap = engine.snapshotState();
    expect(snap.selectedIndex).toBe(3);
    expect(snap.typedRomaji).toBe(''); // 進捗リセット
    expect(snap.castMistypes).toBe(0); // 誤入力もリセット
    expect(snap.remainingGuide).toBe(ROMAJI.ray);
  });

  it('同じカードを選び直しても進捗は失われない', () => {
    const engine = makeEngine();
    engine.start(0);
    engine.selectCard(1, 0);
    engine.pressKey('k', 10);
    engine.pressKey('a', 20);
    engine.selectCard(1, 30); // 同じキーをもう一度押した(無視される)
    const snap = engine.snapshotState();
    expect(snap.typedRomaji).toBe('ka');
    expect(snap.selectedIndex).toBe(1);
  });

  it('切り替えても統計の総誤入力数は計上済みのまま残る', () => {
    const engine = makeEngine();
    engine.start(0);
    engine.selectCard(1, 0);
    engine.pressKey('x', 10); // 誤入力1(統計に計上)
    engine.selectCard(3, 20); // ray へ切り替え(現詠唱のカウントはリセット)
    expect(engine.snapshotState().castMistypes).toBe(0);
    expect(engine.stats().totalMistypes).toBe(1); // 累計には残る
  });
});

describe('クールダウン', () => {
  it('クールダウン中の打鍵は先行入力としてバッファされ即時には進まない(ADR 0007)', () => {
    const engine = makeEngine();
    engine.start(0);
    engine.selectCard(1, 0);
    castFull(engine, 'gale', 1000); // 発動 → 1000+1500=2500 までクールダウン

    // クールダウン中に別カードを構えて打鍵すると 'buffered'(捨てられない)
    engine.selectCard(0, 1200); // abyss を構える(選択は可能)
    expect(engine.pressKey('n', 1200)).toBe('buffered');
    expect(engine.snapshotState().typedRomaji).toBe(''); // この時点では進まない

    // クールダウン明け(2500以降)の生打鍵は、まず保留中の先行入力('n')を
    // 順序通り流してから扱われる(pressKey 先頭の drainTypeahead)。
    // よって buffered の 'n' で 'n' まで進み、続く正しい打鍵 'a' が受理される。
    expect(engine.pressKey('a', 2500)).toBe('accepted');
    expect(engine.snapshotState().typedRomaji).toBe('na'); // abyss = narakuno...
  });

  it('クールダウン中でも selectCard は可能', () => {
    const engine = makeEngine();
    engine.start(0);
    engine.selectCard(1, 0);
    castFull(engine, 'gale', 1000);
    engine.selectCard(0, 1200); // クールダウン中
    expect(engine.snapshotState().selectedIndex).toBe(0);
    expect(engine.snapshotTimers(1200).cooldownRemainingMs).toBe(1300); // 2500 - 1200
  });

  it('カード未選択の打鍵は blocked(誤入力に数えない)', () => {
    const engine = makeEngine();
    engine.start(0);
    expect(engine.pressKey('k', 0)).toBe('blocked');
    expect(engine.stats().totalMistypes).toBe(0);
  });
});

describe('先行入力(type-ahead, ADR 0007)', () => {
  /** 発動してクールダウンに入った状態を作り、index0(abyss)を構える */
  function setupCooldownWithReady(): BattleEngine {
    const engine = makeEngine();
    engine.start(0);
    engine.selectCard(1, 0); // gale
    castFull(engine, 'gale', 1000); // 発動 → 1000+1500=2500 までクールダウン
    engine.selectCard(0, 1200); // abyss を構える(クールダウン中)
    return engine;
  }

  it('クールダウン中の構え済み打鍵は buffered を返し typedRomaji は進まない', () => {
    const engine = setupCooldownWithReady();
    // abyss = narakuno... の先頭 'n','a','r' を先行入力
    expect(engine.pressKey('n', 1200)).toBe('buffered');
    expect(engine.pressKey('a', 1250)).toBe('buffered');
    expect(engine.pressKey('r', 1300)).toBe('buffered');
    expect(engine.snapshotState().typedRomaji).toBe(''); // まだ進まない
  });

  it('クールダウン明けに drainTypeahead でバッファが受理され typedRomaji が進む', () => {
    const engine = setupCooldownWithReady();
    engine.pressKey('n', 1200);
    engine.pressKey('a', 1250);
    engine.pressKey('r', 1300);

    // クールダウン中のドレインは何もしない(空配列)
    expect(engine.drainTypeahead(2000)).toEqual([]);
    expect(engine.snapshotState().typedRomaji).toBe('');

    // クールダウン明け(2500以降)にドレインすると 'nar' の3打鍵が受理される
    expect(engine.drainTypeahead(2500)).toEqual(['accepted', 'accepted', 'accepted']);
    expect(engine.snapshotState().typedRomaji).toBe('nar');
  });

  it('先行入力で始めた詠唱の castTimeMs はクールダウン明けから測られ、打鍵時刻に遡らない', () => {
    // HPを高くして abyss の発動が終了を起こさないようにする
    const engine = makeEngine(1000);
    engine.start(0);
    engine.selectCard(1, 0); // gale
    castFull(engine, 'gale', 1000); // 発動 → 1000+1500=2500 までクールダウン
    engine.selectCard(0, 1200); // abyss を構える(クールダウン中)。手札に abyss は残っている

    // クールダウン中(1200〜)に abyss の先頭2打鍵 'na' を先行入力する。
    // (先頭だけで受理時刻の検証には十分)
    expect(engine.pressKey('n', 1200)).toBe('buffered');
    expect(engine.pressKey('a', 1300)).toBe('buffered');

    // クールダウン明け(2500)にドレイン。受理時刻=2500 で castStartedAtMs が確定する。
    expect(engine.drainTypeahead(2500)).toEqual(['accepted', 'accepted']);
    expect(engine.snapshotState().typedRomaji).toBe('na'); // abyss = narakuno...

    // 残りを時刻3000で打ち切る。詠唱時間 = 3000 - 2500 = 500。
    // もし受理時刻が元の打鍵(1200)に遡っていたら 3000 - 1200 = 1800 になってしまう。
    const rest = ROMAJI.abyss.slice(2);
    let last = '';
    for (const k of rest) {
      last = engine.pressKey(k, 3000);
    }
    expect(last).toBe('activated');

    const abyss = engine.events
      .filter((e) => e.type === 'activated')
      .find((e) => e.type === 'activated' && e.cardId === 'abyss' && e.atMs === 3000);
    expect(abyss).toBeDefined();
    if (abyss?.type === 'activated') {
      expect(abyss.castTimeMs).toBe(500); // クールダウン明け(2500)から発動(3000)まで
    }
  });

  it('現実的な長さの先行入力(上限64以内)は無音破棄されず全て受理される', () => {
    const engine = setupCooldownWithReady();
    // abyss = narakuno... の読み全文(ローマ字)を先行入力しても上限64に収まる
    const full = ROMAJI.abyss; // 48文字 < 64
    for (const k of full) {
      expect(engine.pressKey(k, 1200)).toBe('buffered');
    }
    // 明けにドレインすると全文が順序通り受理され、最後の打鍵で発動する。
    // (発動でセッションが消えるため typedRomaji は空になる)
    const drained = engine.drainTypeahead(2500);
    expect(drained.length).toBe(full.length);
    expect(drained[drained.length - 1]).toBe('activated');
    const activated = engine.events.find((e) => e.type === 'activated' && e.cardId === 'abyss');
    expect(activated).toBeDefined();
  });

  it('クールダウン明け直後の生打鍵は保留中の先行入力を先に流すので打鍵順が逆転しない', () => {
    // 修正1の回帰テスト。pressKey 先頭の drainTypeahead が無いと、
    // クールダウン明け〜次 tick の窓でバッファ済み打鍵より後の生打鍵が先に適用され、
    // 打鍵順が逆転して偽の mistyped が計上される(以前は mistypeCount===1 になっていた)。
    const engine = setupCooldownWithReady(); // abyss = narakuno... を構えてクールダウン中

    // クールダウン中(〜2500)に先頭2打鍵 'na' を先行入力(buffered)。drainTypeahead は呼ばない。
    expect(engine.pressKey('n', 1200)).toBe('buffered');
    expect(engine.pressKey('a', 1300)).toBe('buffered');
    expect(engine.snapshotState().typedRomaji).toBe(''); // まだ進まない

    // クールダウン明け(2500)に次の正しい打鍵 'r' を生入力する。
    // pressKey 先頭で 'na' が順序通り流れた後に 'r' が受理され、'nar' になる。
    expect(engine.pressKey('r', 2500)).toBe('accepted');

    const snap = engine.snapshotState();
    expect(snap.typedRomaji).toBe('nar'); // 意図順のプレフィックス
    expect(snap.castMistypes).toBe(0); // 順序逆転による偽 mistyped が起きない(修正前は 1)
  });

  it('別カードへ構え直すと typeahead がクリアされる', () => {
    const engine = setupCooldownWithReady();
    engine.pressKey('n', 1200);
    engine.pressKey('a', 1250);
    // 別カード(index1: meteor)へ構え直す → バッファは進捗ごとリセット
    engine.selectCard(1, 1300);

    // ドレインしても受理する先行入力は残っていない(空配列)
    expect(engine.drainTypeahead(2500)).toEqual([]);
    expect(engine.snapshotState().typedRomaji).toBe('');
  });
});

describe('山札枯渇→捨て札シャッフルでループ', () => {
  it('山札を引き切ると捨て札がシャッフルされて山札に戻る', () => {
    // HPを高くして終了させずに何度も発動する
    const engine = makeEngine(1000);
    engine.start(0);
    let t = 0;
    // 山札16枚 → 17回発動すると17枚目の補充で捨て札の再シャッフルが起きる
    for (let n = 0; n < 17; n++) {
      // 常に手札index0のカードを発動する
      const cardId = engine.snapshotState().hand[0].id;
      engine.selectCard(0, t);
      t += 1;
      castFull(engine, cardId, t);
      t += 2000; // クールダウンを必ず越える
    }
    const snap = engine.snapshotState();
    // 16回目までで山札16枚を引き切り捨て札16枚。17回目の発動は
    // 捨て札へ1枚足して(計17枚)から補充するため、空の山札に捨て札17枚が
    // シャッフルで戻り、そこから1枚引かれる: 山札 = 17 - 1 = 16、捨て札 = 0
    expect(snap.discardPileCount).toBe(0);
    expect(snap.drawPileCount).toBe(16);
    expect(snap.hand).toHaveLength(4);
  });
});

describe('終了', () => {
  it('HP0以下で finished、clearTimeMs を記録する', () => {
    const engine = makeEngine(16); // abyss 1発(damage16)で倒せる
    engine.start(0);
    engine.selectCard(0, 0); // abyss
    castFull(engine, 'abyss', 3000);
    const snap = engine.snapshotState();
    expect(snap.targetHp).toBe(0);
    expect(snap.finished).toBe(true);
    expect(snap.clearTimeMs).toBe(3000); // start(0) から発動(3000)まで
  });

  it('HPは0未満にならず0で止まる', () => {
    const engine = makeEngine(10); // abyss(16) で過剰ダメージ
    engine.start(0);
    engine.selectCard(0, 0);
    castFull(engine, 'abyss', 1000);
    expect(engine.snapshotState().targetHp).toBe(0);
  });

  it('終了後の操作はすべて blocked / 無視される', () => {
    const engine = makeEngine(16);
    engine.start(0);
    engine.selectCard(0, 0);
    castFull(engine, 'abyss', 1000);
    expect(engine.finished).toBe(true);

    // 以後の打鍵は blocked
    expect(engine.pressKey('k', 2000)).toBe('blocked');
    // 選択も無視される(選択中インデックスは null のまま)
    engine.selectCard(1, 2000);
    expect(engine.snapshotState().selectedIndex).toBeNull();
    // クリアタイムは固定
    expect(engine.snapshotState().clearTimeMs).toBe(1000);
  });
});

describe('イベントログと統計', () => {
  it('発動・誤入力・選択・終了イベントが記録される', () => {
    const engine = makeEngine(4); // gale 1発(誤入力1で damage4)で倒す
    engine.start(0);
    engine.selectCard(1, 0); // gale
    engine.pressKey('x', 5); // 誤入力1
    castFull(engine, 'gale', 1000);

    const types = engine.events.map((e) => e.type);
    expect(types).toContain('started');
    expect(types).toContain('selected');
    expect(types).toContain('mistyped');
    expect(types).toContain('activated');
    expect(types).toContain('finished');

    const activated = engine.events.find((e) => e.type === 'activated');
    if (activated?.type === 'activated') {
      expect(activated.cardId).toBe('gale');
      expect(activated.damage).toBe(4); // 5 - 1誤入力
      expect(activated.mistypes).toBe(1);
    }
  });

  it('stats はカード種別ごとに発動回数・平均詠唱時間・合計ダメージを集計する', () => {
    const engine = makeEngine(1000);
    engine.start(0);

    // 単調増加する時刻 clock 上で操作する(クールダウンを必ず越えるよう進める)。
    let clock = 0;

    // 別カードを1枚発動して山札を回す。gale 以外の発動は stats の gale 集計に影響しない。
    function activateFiller(): void {
      const card = engine.snapshotState().hand[0];
      engine.selectCard(0, clock);
      clock += 1;
      const r = ROMAJI[card.id];
      for (let i = 0; i < r.length; i++) {
        engine.pressKey(r[i], clock);
      }
      clock += 2000; // クールダウンを越える
    }

    // gale を1回発動する(手札に無ければ別カードを発動して引き寄せる)。
    // 詠唱時間 = castMs となるよう、最初の打鍵と残りの打鍵で時刻を分ける。
    function activateGale(castMs: number): void {
      while (engine.snapshotState().hand.findIndex((c) => c.id === 'gale') === -1) {
        activateFiller();
      }
      const idx = engine.snapshotState().hand.findIndex((c) => c.id === 'gale');
      engine.selectCard(idx, clock);
      const firstMs = clock;
      const lastMs = clock + castMs;
      const romaji = ROMAJI.gale;
      for (let i = 0; i < romaji.length; i++) {
        engine.pressKey(romaji[i], i === 0 ? firstMs : lastMs);
      }
      clock = lastMs + 2000; // クールダウンを越える
    }

    activateGale(1000); // 詠唱時間1000
    activateGale(600); // 詠唱時間600

    const stats = engine.stats();
    const gale = stats.perCard.find((s) => s.cardId === 'gale');
    expect(gale).toBeDefined();
    expect(gale?.activations).toBe(2);
    expect(gale?.totalDamage).toBe(10); // 5 + 5
    expect(gale?.averageCastTimeMs).toBe(800); // (1000 + 600) / 2
  });

  it('総誤入力数は全詠唱を通じて累計される', () => {
    const engine = makeEngine(1000);
    engine.start(0);
    engine.selectCard(1, 0);
    engine.pressKey('x', 1);
    engine.pressKey('z', 2);
    castFull(engine, 'gale', 1000);
    expect(engine.stats().totalMistypes).toBe(2);
  });
});
