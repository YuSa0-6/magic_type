import { describe, it, expect } from 'vitest';
import { BattleEngine } from './battle';
import { STARTER_DECK } from './cards';

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
 * シード12345での初期配置(STARTER_DECK基準):
 *   手札 = [meteor(18), gale(6), gale(6), blaze(10)]
 *   山札(引く順) = thunder(11), spark(5), spark(5), meteor(18), blaze(10), thunder(11)
 */
const SEED = 12345;

/** 各カードのデフォルトローマ字(動的ガイドの全文) */
const ROMAJI: Record<string, string> = {
  spark: 'akakihibanayohazikero',
  gale: 'kazenoyaibayokakenukero',
  blaze: 'uzumakuhonooyotekiwotutumikome',
  thunder: 'tenkuunoikazutiyotekiwoturanuke',
  meteor: 'tennyorihurisosoguryuuseiyotekiwoutikudake',
};

/** シード固定でエンジンを作る */
function makeEngine(targetHp?: number): BattleEngine {
  return new BattleEngine(STARTER_DECK, { targetHp, rng: mulberry32(SEED) });
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
  it('手札4枚・山札6枚・捨て札0・HP50で始まる', () => {
    const engine = makeEngine();
    const snap = engine.snapshot(0);
    expect(snap.targetHp).toBe(50);
    expect(snap.targetMaxHp).toBe(50);
    expect(snap.hand).toHaveLength(4);
    expect(snap.drawPileCount).toBe(6);
    expect(snap.discardPileCount).toBe(0);
    expect(snap.selectedIndex).toBeNull();
    expect(snap.finished).toBe(false);
    expect(snap.clearTimeMs).toBeNull();
  });

  it('固定シードで手札が決まる', () => {
    const engine = makeEngine();
    const ids = engine.snapshot(0).hand.map((c) => c.id);
    expect(ids).toEqual(['meteor', 'gale', 'gale', 'blaze']);
  });

  it('start 前は経過時間0、start で開始時刻を記録する', () => {
    const engine = makeEngine();
    expect(engine.snapshot(1000).elapsedMs).toBe(0);
    engine.start(1000);
    expect(engine.snapshot(1500).elapsedMs).toBe(500);
  });

  it('start は二重に呼んでも最初の時刻を保つ', () => {
    const engine = makeEngine();
    engine.start(1000);
    engine.start(9999);
    expect(engine.snapshot(1500).elapsedMs).toBe(500);
  });
});

describe('カード選択(構え)', () => {
  it('選択するとお題のローマ字ガイドが表示される', () => {
    const engine = makeEngine();
    engine.start(0);
    engine.selectCard(1, 0); // gale
    const snap = engine.snapshot(0);
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
    engine.selectCard(1, 0); // gale(damage6, cooldown1500)
    const result = castFull(engine, 'gale', 1000);
    expect(result).toBe('activated');

    const snap = engine.snapshot(1000);
    expect(snap.targetHp).toBe(44); // 50 - 6
    expect(snap.discardPileCount).toBe(1); // gale が捨て札へ
    expect(snap.drawPileCount).toBe(5); // 1枚補充で6→5
    expect(snap.hand).toHaveLength(4); // 手札は4枚維持
    expect(snap.selectedIndex).toBeNull(); // 選択解除
    expect(snap.cooldownRemainingMs).toBe(1500); // クールダウン開始
  });

  it('補充されるカードは山札の先頭(thunder)', () => {
    const engine = makeEngine();
    engine.start(0);
    engine.selectCard(1, 0); // 手札index1 を発動
    castFull(engine, 'gale', 1000);
    expect(engine.snapshot(1000).hand[1].id).toBe('thunder');
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
    engine.selectCard(1, 0); // gale(damage6)
    // 詠唱開始前に誤入力を2回はさむ
    expect(engine.pressKey('x', 100)).toBe('mistyped');
    expect(engine.pressKey('z', 100)).toBe('mistyped');
    expect(engine.snapshot(100).castMistypes).toBe(2);
    castFull(engine, 'gale', 1000);
    expect(engine.snapshot(1000).targetHp).toBe(50 - (6 - 2)); // ダメージ4
  });

  it('ダメージは誤入力が多くても下限1を下回らない', () => {
    const engine = makeEngine();
    engine.start(0);
    engine.selectCard(1, 0); // gale(damage6)
    // 10回誤入力 → 6-10 だが下限1
    for (let i = 0; i < 10; i++) {
      engine.pressKey('q', 100);
    }
    castFull(engine, 'gale', 1000);
    expect(engine.snapshot(1000).targetHp).toBe(49); // 50 - 1
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
    expect(engine.snapshot(30).typedRomaji).toBe('ka');
    expect(engine.snapshot(30).castMistypes).toBe(1);

    engine.selectCard(3, 40); // blaze へ切り替え
    const snap = engine.snapshot(40);
    expect(snap.selectedIndex).toBe(3);
    expect(snap.typedRomaji).toBe(''); // 進捗リセット
    expect(snap.castMistypes).toBe(0); // 誤入力もリセット
    expect(snap.remainingGuide).toBe(ROMAJI.blaze);
  });

  it('同じカードを選び直しても進捗は失われない', () => {
    const engine = makeEngine();
    engine.start(0);
    engine.selectCard(1, 0);
    engine.pressKey('k', 10);
    engine.pressKey('a', 20);
    engine.selectCard(1, 30); // 同じキーをもう一度押した(無視される)
    const snap = engine.snapshot(30);
    expect(snap.typedRomaji).toBe('ka');
    expect(snap.selectedIndex).toBe(1);
  });

  it('切り替えても統計の総誤入力数は計上済みのまま残る', () => {
    const engine = makeEngine();
    engine.start(0);
    engine.selectCard(1, 0);
    engine.pressKey('x', 10); // 誤入力1(統計に計上)
    engine.selectCard(3, 20); // blaze へ切り替え(現詠唱のカウントはリセット)
    expect(engine.snapshot(20).castMistypes).toBe(0);
    expect(engine.stats().totalMistypes).toBe(1); // 累計には残る
  });
});

describe('クールダウン', () => {
  it('クールダウン中は pressKey が blocked、明けたら打てる', () => {
    const engine = makeEngine();
    engine.start(0);
    engine.selectCard(1, 0);
    castFull(engine, 'gale', 1000); // 発動 → 1000+1500=2500 までクールダウン

    // クールダウン中に別カードを選んでも打鍵はブロックされる
    engine.selectCard(0, 1200); // meteor を構える(選択は可能)
    expect(engine.pressKey('t', 1200)).toBe('blocked');
    expect(engine.snapshot(1200).typedRomaji).toBe(''); // 状態は進まない

    // クールダウン明け(2500以降)から打てる
    expect(engine.pressKey('t', 2500)).toBe('accepted');
  });

  it('クールダウン中でも selectCard は可能', () => {
    const engine = makeEngine();
    engine.start(0);
    engine.selectCard(1, 0);
    castFull(engine, 'gale', 1000);
    engine.selectCard(0, 1200); // クールダウン中
    expect(engine.snapshot(1200).selectedIndex).toBe(0);
    expect(engine.snapshot(1200).cooldownRemainingMs).toBe(1300); // 2500 - 1200
  });

  it('カード未選択の打鍵は blocked(誤入力に数えない)', () => {
    const engine = makeEngine();
    engine.start(0);
    expect(engine.pressKey('k', 0)).toBe('blocked');
    expect(engine.stats().totalMistypes).toBe(0);
  });
});

describe('山札枯渇→捨て札シャッフルでループ', () => {
  it('山札を引き切ると捨て札がシャッフルされて山札に戻る', () => {
    // HPを高くして終了させずに何度も発動する
    const engine = makeEngine(1000);
    engine.start(0);
    let t = 0;
    // 山札6枚 → 7回発動すると7枚目の補充で捨て札の再シャッフルが起きる
    for (let n = 0; n < 7; n++) {
      // 常に手札index0のカードを発動する
      const cardId = engine.snapshot(t).hand[0].id;
      engine.selectCard(0, t);
      t += 1;
      castFull(engine, cardId, t);
      t += 2000; // クールダウンを必ず越える
    }
    const snap = engine.snapshot(t);
    // 6回目までで山札6枚を引き切り捨て札6枚。7回目の発動は
    // 捨て札へ1枚足して(計7枚)から補充するため、空の山札に捨て札7枚が
    // シャッフルで戻り、そこから1枚引かれる: 山札 = 7 - 1 = 6、捨て札 = 0
    expect(snap.discardPileCount).toBe(0);
    expect(snap.drawPileCount).toBe(6);
    expect(snap.hand).toHaveLength(4);
  });
});

describe('終了', () => {
  it('HP0以下で finished、clearTimeMs を記録する', () => {
    const engine = makeEngine(18); // meteor 1発(damage18)で倒せる
    engine.start(0);
    engine.selectCard(0, 0); // meteor
    castFull(engine, 'meteor', 3000);
    const snap = engine.snapshot(3000);
    expect(snap.targetHp).toBe(0);
    expect(snap.finished).toBe(true);
    expect(snap.clearTimeMs).toBe(3000); // start(0) から発動(3000)まで
  });

  it('HPは0未満にならず0で止まる', () => {
    const engine = makeEngine(10); // meteor(18) で過剰ダメージ
    engine.start(0);
    engine.selectCard(0, 0);
    castFull(engine, 'meteor', 1000);
    expect(engine.snapshot(1000).targetHp).toBe(0);
  });

  it('終了後の操作はすべて blocked / 無視される', () => {
    const engine = makeEngine(18);
    engine.start(0);
    engine.selectCard(0, 0);
    castFull(engine, 'meteor', 1000);
    expect(engine.finished).toBe(true);

    // 以後の打鍵は blocked
    expect(engine.pressKey('k', 2000)).toBe('blocked');
    // 選択も無視される(選択中インデックスは null のまま)
    engine.selectCard(1, 2000);
    expect(engine.snapshot(2000).selectedIndex).toBeNull();
    // クリアタイムは固定
    expect(engine.snapshot(5000).clearTimeMs).toBe(1000);
  });
});

describe('イベントログと統計', () => {
  it('発動・誤入力・選択・終了イベントが記録される', () => {
    const engine = makeEngine(5); // gale 1発(誤入力1で damage5)で倒す
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
      expect(activated.damage).toBe(5); // 6 - 1誤入力
      expect(activated.mistypes).toBe(1);
    }
  });

  it('stats はカード種別ごとに発動回数・平均詠唱時間・合計ダメージを集計する', () => {
    const engine = makeEngine(1000);
    engine.start(0);

    // gale を2回発動する(手札index1, 補充されたカードの位置に依存しないよう毎回探す)
    function activateGaleAt(firstMs: number, lastMs: number): void {
      const idx = engine.snapshot(firstMs).hand.findIndex((c) => c.id === 'gale');
      engine.selectCard(idx, firstMs);
      const romaji = ROMAJI.gale;
      for (let i = 0; i < romaji.length; i++) {
        engine.pressKey(romaji[i], i === 0 ? firstMs : lastMs);
      }
    }
    activateGaleAt(1000, 2000); // 詠唱時間1000
    activateGaleAt(4000, 4600); // 詠唱時間600

    const stats = engine.stats();
    const gale = stats.perCard.find((s) => s.cardId === 'gale');
    expect(gale).toBeDefined();
    expect(gale?.activations).toBe(2);
    expect(gale?.totalDamage).toBe(12); // 6 + 6
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
