// Headless sim for Morton & Krum: SPEC vs GEN with bigrams + REPEAT,
// mirroring web/index.html's AI logic. Used to tune the AI's bigram-claim
// behavior (target: ~1 claim/game/AI, occasionally 2; SPEC vs GEN win rate
// stays near 50/50).
//
// Usage:
//   node sim/sim_bigram.js                     # default 2000 games
//   N_TRIALS=5000 node sim/sim_bigram.js
//   AI_BIGRAM_BASE_THRESHOLD=2 AI_BIGRAM_PER_CLAIM_PENALTY=6 \
//       node sim/sim_bigram.js                  # override the tunables
//   SWEEP=1 node sim/sim_bigram.js              # parameter sweep

const fs = require('fs');
const path = require('path');
const HTML_PATH = path.resolve(__dirname, '..', 'web', 'index.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

// --- Pull literal data structures from index.html ---
function extract(name) {
  const re = new RegExp(`const\\s+${name}\\s*=\\s*`);
  const m = re.exec(html);
  if (!m) throw new Error(`Could not find ${name}`);
  let i = m.index + m[0].length, depth = 0, str = null, start = i;
  for (; i < html.length; i++) {
    const c = html[i];
    if (str) {
      if (c === str && html[i - 1] !== '\\') str = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { str = c; continue; }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  return html.slice(start, i);
}
const PROMPTS = eval('(' + extract('PROMPTS') + ')');
const TEMPLATES = eval('(' + extract('TEMPLATES') + ')');

// --- Constants kept in sync with index.html ---
const POOL_DEF = [[5,1],[4,2],[3,3],[2,4],[1,4],[0,6],[-1,4],[-2,3]];
const TOKEN_MIN = -2, TOKEN_MAX = 5, EMPTY_POOL_PENALTY = -4, RETURN = "_";
const NUM_STATIONS = 6, START_COAL = 30;
const LETTER_PRIORITY = "ETAOINSRHLDCUMFPGWYBVKJXQZ";
const BIGRAMS = ["ER","AR","OU","EA","ST","GH","CK","CH"];
const BIGRAM_BONUS = 5, REPEAT_BONUS = 2, REPEAT_TOKEN = "REPEAT";
const SPEC_TRADE_THRESHOLD = 4;
let AI_BIGRAM_BASE_THRESHOLD = parseFloat(process.env.AI_BIGRAM_BASE_THRESHOLD ?? "2");
let AI_BIGRAM_PER_CLAIM_PENALTY = parseFloat(process.env.AI_BIGRAM_PER_CLAIM_PENALTY ?? "6");

function bigramOccurrences(w, bg) {
  let c = 0, i = 0;
  while (i <= w.length - 2) {
    if (w[i] === bg[0] && w[i+1] === bg[1]) { c++; i += 2; } else i++;
  }
  return c;
}
const BIGRAM_FREQ_BY_CAT = (() => {
  const out = {};
  for (const cat of Object.keys(PROMPTS)) {
    const list = PROMPTS[cat], inner = {};
    for (const bg of BIGRAMS) {
      let total = 0;
      for (const w of list) total += bigramOccurrences(w, bg);
      inner[bg] = list.length ? total / list.length : 0;
    }
    out[cat] = inner;
  }
  return out;
})();
const REPEAT_FREQ_BY_CAT = (() => {
  const out = {};
  for (const cat of Object.keys(PROMPTS)) {
    const list = PROMPTS[cat];
    let total = 0;
    for (const w of list) {
      let c = 0;
      for (let i = 1; i < w.length; i++) if (w[i] === w[i-1]) c++;
      total += c;
    }
    out[cat] = list.length ? total / list.length : 0;
  }
  return out;
})();
function bigramUsesAhead(bg, fromStation, cards) {
  let total = 0;
  for (let s = fromStation; s <= NUM_STATIONS; s++) {
    const t = cards[s - 1].template;
    total += (BIGRAM_FREQ_BY_CAT[t.a]?.[bg] || 0) + (BIGRAM_FREQ_BY_CAT[t.b]?.[bg] || 0);
  }
  return total;
}
function repeatUsesAhead(fromStation, cards) {
  let total = 0;
  for (let s = fromStation; s <= NUM_STATIONS; s++) {
    const t = cards[s - 1].template;
    total += (REPEAT_FREQ_BY_CAT[t.a] || 0) + (REPEAT_FREQ_BY_CAT[t.b] || 0);
  }
  return total;
}

// --- Pool / player / scoring (mirrors index.html) ---
function buildPool() {
  const p = []; let id = 0;
  for (const [v, c] of POOL_DEF) for (let i = 0; i < c; i++) p.push({ id: id++, val: v });
  for (let i = p.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  return p;
}
function makePlayer(idx, strategy) {
  const pool = buildPool();
  return { idx, strategy, coal: START_COAL, score: 0, assigned: {}, pool,
           nextTokenId: pool.length, claimedBigrams: [], bigramAssigned: {} };
}
function poolCounts(p) {
  const c = {}; for (const t of p.pool) c[t.val] = (c[t.val] || 0) + 1; return c;
}
function splitToken(p, v) {
  if (v < TOKEN_MIN + 1 || v > TOKEN_MAX) return false;
  const i = p.pool.findIndex(t => t.val === v); if (i < 0) return false;
  p.pool.splice(i, 1);
  p.pool.push({ id: p.nextTokenId++, val: v - 1 });
  p.pool.push({ id: p.nextTokenId++, val: v - 1 });
  return true;
}
function mergeTokens(p, v) {
  if (v < TOKEN_MIN || v > TOKEN_MAX - 1) return false;
  const idx = [];
  for (let i = 0; i < p.pool.length && idx.length < 2; i++)
    if (p.pool[i].val === v) idx.push(i);
  if (idx.length < 2) return false;
  p.pool.splice(idx[1], 1); p.pool.splice(idx[0], 1);
  p.pool.push({ id: p.nextTokenId++, val: v + 1 });
  return true;
}
function aiOptimizePool(p, threshold) {
  let guard = 60;
  while (guard-- > 0) {
    const c = poolCounts(p);
    let bsv = null, bsd = -Infinity;
    for (let n = TOKEN_MIN + 1; n <= TOKEN_MAX; n++) {
      const d = n - 2; if ((c[n] || 0) >= 1 && d > bsd) { bsd = d; bsv = n; }
    }
    let bmv = null, bmd = -Infinity;
    for (let n = TOKEN_MIN; n <= TOKEN_MAX - 1; n++) {
      const d = 1 - n; if ((c[n] || 0) >= 2 && d > bmd) { bmd = d; bmv = n; }
    }
    if (bsv == null || bmv == null) break;
    if (bsd + bmd < threshold) break;
    splitToken(p, bsv);
    const c2 = poolCounts(p);
    let mv = null, md = -Infinity;
    for (let n = TOKEN_MIN; n <= TOKEN_MAX - 1; n++) {
      const d = 1 - n; if ((c2[n] || 0) >= 2 && d > md) { md = d; mv = n; }
    }
    if (mv == null) break;
    mergeTokens(p, mv);
  }
}
function strategyOppWeight(p) {
  return p.strategy === "specialist" ? 0.4 : p.strategy === "generalist" ? 1.0 : 0.7;
}
function scoreWordForPlayer(w, p) {
  const fallback = p.pool.length
    ? p.pool.reduce((a, b) => a + b.val, 0) / p.pool.length : EMPTY_POOL_PENALTY;
  const valOf = c => (c in p.assigned) ? p.assigned[c] : fallback;
  const bgVal = bg => (bg in p.bigramAssigned) ? p.bigramAssigned[bg] + BIGRAM_BONUS : fallback + BIGRAM_BONUS;
  const repeatVal = () => (REPEAT_TOKEN in p.bigramAssigned) ? p.bigramAssigned[REPEAT_TOKEN] + REPEAT_BONUS : fallback + REPEAT_BONUS;
  const hasRepeat = p.claimedBigrams.includes(REPEAT_TOKEN);
  let s = 0, i = 0;
  while (i < w.length) {
    let mb = null;
    if (i <= w.length - 2) {
      const n2 = w.slice(i, i + 2);
      if (p.claimedBigrams.includes(n2)) mb = n2;
    }
    if (mb) { s += bgVal(mb); i += 2; }
    else if (hasRepeat && i > 0 && w[i] === w[i - 1]) { s += repeatVal(); i++; }
    else { s += valOf(w[i]); i++; }
  }
  s += (RETURN in p.assigned) ? p.assigned[RETURN] : fallback;
  return s;
}
function netScore(w, p, opp) {
  return scoreWordForPlayer(w, p) - strategyOppWeight(p) * scoreWordForPlayer(w, opp);
}

// --- AI decisions ---
function aiBid(p, opp, station, card) {
  const remaining = NUM_STATIONS - station + 1;
  if (remaining <= 0) return 0;
  const t = card.template;
  const best = k => {
    let m = -Infinity;
    for (const w of PROMPTS[k]) m = Math.max(m, netScore(w, p, opp));
    return m;
  };
  const sa = best(t.a), sb = best(t.b);
  const valueOfControl = Math.max(2, Math.abs(sa - sb) + 4);
  const fairShare = p.coal / remaining;
  const target = Math.min(fairShare + valueOfControl - 2, p.coal);
  const jitter = (Math.random() - 0.4) * 3;
  let bid = Math.round(target + jitter);
  return Math.max(0, Math.min(bid, p.coal, opp.coal + 2));
}
function aiPickAction(playerIdx, allowBigram, gameState, station) {
  const p = gameState.players[playerIdx], opp = gameState.players[1 - playerIdx];
  const tpl = gameState.card.template;
  const wordOptions = [];
  for (const slot of [0, 1]) {
    if (gameState.card.picks[slot] != null) continue;
    const cat = slot === 0 ? tpl.a : tpl.b;
    for (const w of PROMPTS[cat]) wordOptions.push({ s: netScore(w, p, opp), slot, w });
  }
  const bestWordScore = Math.max(...wordOptions.map(x => x.s));
  const top = wordOptions.filter(x => x.s >= bestWordScore - 0.5);
  const wordPick = top[Math.floor(Math.random() * top.length)];
  if (!allowBigram || gameState.bigramPool.length === 0) {
    return { kind: "word", slot: wordPick.slot, word: wordPick.w };
  }
  const avgPoolVal = p.pool.length
    ? p.pool.reduce((a, b) => a + b.val, 0) / p.pool.length : EMPTY_POOL_PENALTY;
  const letterVal = c => (c in p.assigned) ? p.assigned[c] : avgPoolVal;
  let bestBg = null;
  for (const bg of gameState.bigramPool) {
    let expectedUses, letterCost, bonus;
    if (bg === REPEAT_TOKEN) {
      expectedUses = repeatUsesAhead(station, gameState.cards);
      letterCost = avgPoolVal;
      bonus = REPEAT_BONUS;
    } else {
      expectedUses = bigramUsesAhead(bg, station, gameState.cards);
      letterCost = letterVal(bg[0]) + letterVal(bg[1]);
      bonus = BIGRAM_BONUS;
    }
    const perUseGain = (0 + bonus) - letterCost;
    const ev = expectedUses * perUseGain;
    if (bestBg == null || ev > bestBg.ev) bestBg = { bg, ev };
  }
  const claimed = p.claimedBigrams.length;
  const threshold = AI_BIGRAM_BASE_THRESHOLD + claimed * AI_BIGRAM_PER_CLAIM_PENALTY;
  if (bestBg && bestBg.ev > threshold) return { kind: "bigram", bg: bestBg.bg };
  return { kind: "word", slot: wordPick.slot, word: wordPick.w };
}
function neededTargets(p, picks) {
  if (p.pool.length === 0) return [];
  const out = new Set();
  for (const w of picks) if (w) for (const c of w) if (!(c in p.assigned)) out.add(c);
  if (picks.some(Boolean) && !(RETURN in p.assigned)) out.add(RETURN);
  for (const bg of p.claimedBigrams) if (!(bg in p.bigramAssigned)) out.add(bg);
  return [...out];
}
function letterRank(c, freq) {
  if (c === RETURN) return -100;
  const r = LETTER_PRIORITY.indexOf(c);
  const base = r < 0 ? 30 : r;
  return base - 4 * (freq || 0);
}
function targetRank(c, freq, station, cards) {
  if (c === REPEAT_TOKEN) {
    const eu = repeatUsesAhead(station, cards);
    return -10 - eu * REPEAT_BONUS;
  }
  if (c.length === 2) {
    const eu = bigramUsesAhead(c, station, cards);
    return -10 - eu * BIGRAM_BONUS;
  }
  return letterRank(c, freq);
}
function aiAssign(p, opp, stationsLeft, picks, station, cards) {
  const th = p.strategy === "specialist" ? SPEC_TRADE_THRESHOLD : 1;
  aiOptimizePool(p, th);
  const need = neededTargets(p, picks);
  if (need.length === 0) return;
  const freq = {};
  for (const w of picks) if (w) for (const c of w) freq[c] = (freq[c] || 0) + 1;
  const boldnessBase = stationsLeft / NUM_STATIONS;
  const boldnessMul = p.strategy === "specialist" ? 1.0 :
                      p.strategy === "generalist" ? 1.2 : 1.0;
  const boldness = boldnessBase * boldnessMul;
  const oppPenalty = c => {
    if (c.length !== 1) return 0;
    const v = opp.assigned[c]; if (v == null) return 0;
    return Math.max(0, v) * 0.6;
  };
  const decoratedNeed = need.map(c => ({
    c,
    k: targetRank(c, freq[c], station, cards) + oppPenalty(c)
       + (Math.random() - 0.5) * (1 + 4 * boldness)
  }));
  decoratedNeed.sort((a, b) => a.k - b.k);
  const sortedNeed = decoratedNeed.map(x => x.c);
  const decoratedTokens = p.pool.map(t => ({
    t, k: t.val + (Math.random() - 0.5) * (0.5 + 2 * boldness)
  }));
  decoratedTokens.sort((a, b) => b.k - a.k);
  const sortedTokens = decoratedTokens.map(x => x.t);
  const lim = Math.min(sortedNeed.length, sortedTokens.length);
  for (let i = 0; i < lim; i++) {
    if (p.pool.length === 0) break;
    const c = sortedNeed[i], tok = sortedTokens[i];
    const ti = p.pool.findIndex(t => t.id === tok.id);
    if (ti >= 0) {
      const v = p.pool[ti].val;
      if (c.length === 1) p.assigned[c] = v;
      else p.bigramAssigned[c] = v;
      p.pool.splice(ti, 1);
    }
  }
}
function scoreRound(p, picks) {
  let total = 0;
  const fallback = p.pool.length
    ? p.pool.reduce((a, b) => a + b.val, 0) / p.pool.length : EMPTY_POOL_PENALTY;
  const valOf = c => (c in p.assigned) ? p.assigned[c] : fallback;
  const hasRepeat = p.claimedBigrams.includes(REPEAT_TOKEN);
  for (const w of picks) {
    if (!w) continue;
    let i = 0;
    while (i < w.length) {
      let mb = null;
      if (i <= w.length - 2) {
        const n2 = w.slice(i, i + 2);
        if (p.claimedBigrams.includes(n2) && (n2 in p.bigramAssigned)) mb = n2;
      }
      if (mb) { total += p.bigramAssigned[mb] + BIGRAM_BONUS; i += 2; }
      else if (hasRepeat && i > 0 && w[i] === w[i - 1] && (REPEAT_TOKEN in p.bigramAssigned)) {
        total += p.bigramAssigned[REPEAT_TOKEN] + REPEAT_BONUS; i++;
      }
      else { total += valOf(w[i]); i++; }
    }
    total += (RETURN in p.assigned) ? p.assigned[RETURN] : fallback;
  }
  return total;
}
function pickAllCards() {
  const pool = [...TEMPLATES];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, NUM_STATIONS).map(tpl => ({ template: tpl, picks: [null, null] }));
}

function simGame() {
  const players = [makePlayer(0, "specialist"), makePlayer(1, "generalist")];
  const cards = pickAllCards();
  const gameState = { players, bigramPool: [...BIGRAMS, REPEAT_TOKEN], card: null, cards };
  for (let s = 1; s <= NUM_STATIONS; s++) {
    gameState.card = cards[s - 1];
    const stationsLeft = NUM_STATIONS - s;
    const b0 = aiBid(players[0], players[1], s, gameState.card);
    const b1 = aiBid(players[1], players[0], s, gameState.card);
    players[0].coal -= b0; players[1].coal -= b1;
    const winner = b0 > b1 ? 0 : b1 > b0 ? 1 : 0;
    const passOneActed = [false, false], wordPickedBy = [false, false];
    let pickPass = 1;
    while (true) {
      if (gameState.card.picks.every(x => x != null)) break;
      let nextP = null;
      if (pickPass === 1) {
        if (!passOneActed[winner]) nextP = winner;
        else if (!passOneActed[1 - winner]) nextP = 1 - winner;
        else pickPass = 2;
      }
      if (pickPass === 2 && nextP == null) {
        if (!wordPickedBy[winner]) nextP = winner;
        else if (!wordPickedBy[1 - winner]) nextP = 1 - winner;
      }
      if (nextP == null) break;
      const action = aiPickAction(nextP, pickPass === 1, gameState, s);
      if (action.kind === "bigram") {
        gameState.bigramPool = gameState.bigramPool.filter(b => b !== action.bg);
        players[nextP].claimedBigrams.push(action.bg);
      } else {
        gameState.card.picks[action.slot] = action.word;
        wordPickedBy[nextP] = true;
      }
      if (pickPass === 1) passOneActed[nextP] = true;
    }
    aiAssign(players[0], players[1], stationsLeft, gameState.card.picks, s, cards);
    aiAssign(players[1], players[0], stationsLeft, gameState.card.picks, s, cards);
    players[0].score += scoreRound(players[0], gameState.card.picks);
    players[1].score += scoreRound(players[1], gameState.card.picks);
  }
  return {
    specScore: players[0].score, genScore: players[1].score,
    specBigrams: players[0].claimedBigrams.slice(),
    genBigrams: players[1].claimedBigrams.slice(),
  };
}

function runTrials(N) {
  let sw = 0, gw = 0, t = 0, ss = 0, gs = 0;
  let specClaims = 0, genClaims = 0;
  const specHist = [0, 0, 0, 0, 0, 0];   // # of specs that claimed N bigrams
  const genHist = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < N; i++) {
    const r = simGame();
    ss += r.specScore; gs += r.genScore;
    if (r.specScore > r.genScore) sw++;
    else if (r.genScore > r.specScore) gw++;
    else t++;
    specClaims += r.specBigrams.length;
    genClaims += r.genBigrams.length;
    specHist[Math.min(r.specBigrams.length, 5)]++;
    genHist[Math.min(r.genBigrams.length, 5)]++;
  }
  return { N, sw, gw, t, ss, gs, specClaims, genClaims, specHist, genHist };
}

if (process.env.SWEEP) {
  const Ntrials = parseInt(process.env.N_TRIALS || "1500", 10);
  const bases = [1, 2, 3, 4, 5];
  const ramps = [3, 5, 7, 10];
  console.log(`Sweep: ${bases.length}×${ramps.length} configs × ${Ntrials} games each`);
  console.log(`base × ramp -> SPEC win% / claims-per-game (SPEC / GEN)`);
  for (const b of bases) {
    for (const r of ramps) {
      AI_BIGRAM_BASE_THRESHOLD = b;
      AI_BIGRAM_PER_CLAIM_PENALTY = r;
      const res = runTrials(Ntrials);
      const sw = (res.sw / res.N * 100).toFixed(1);
      const sc = (res.specClaims / res.N).toFixed(2);
      const gc = (res.genClaims / res.N).toFixed(2);
      console.log(`  base=${b} ramp=${r}: SPEC ${sw}%  claims ${sc}/${gc}`);
    }
  }
} else {
  const N = parseInt(process.env.N_TRIALS || "2000", 10);
  console.log(`SPEC vs GEN with bigrams + REPEAT, ${N} games`);
  console.log(`  base=${AI_BIGRAM_BASE_THRESHOLD}  ramp=${AI_BIGRAM_PER_CLAIM_PENALTY}`);
  const res = runTrials(N);
  const pct = x => (x / res.N * 100).toFixed(1);
  console.log(`  Win rate: SPEC ${pct(res.sw)}% / GEN ${pct(res.gw)}% / tie ${pct(res.t)}%`);
  console.log(`  Avg scores: SPEC ${(res.ss/res.N).toFixed(1)} / GEN ${(res.gs/res.N).toFixed(1)}`);
  console.log(`  Bigram+REPEAT claims/game: SPEC ${(res.specClaims/res.N).toFixed(2)} / GEN ${(res.genClaims/res.N).toFixed(2)}`);
  console.log(`  Distribution of claims (0..5+):`);
  console.log(`    SPEC: [${res.specHist.map(x => (x/res.N*100).toFixed(0)+"%").join(", ")}]`);
  console.log(`    GEN:  [${res.genHist.map(x => (x/res.N*100).toFixed(0)+"%").join(", ")}]`);
  const sample = simGame();
  console.log(`\nSample game:`);
  console.log(`  SPEC ${sample.specScore} (claimed: [${sample.specBigrams.join(", ")}])`);
  console.log(`  GEN  ${sample.genScore} (claimed: [${sample.genBigrams.join(", ")}])`);
}
