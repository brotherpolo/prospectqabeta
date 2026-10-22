// Question matching engine.
// Two modes, chosen automatically:
//  - "meaning": an AI model's sense of what each question and answer is about (semantic.js).
//    Catches paraphrases like "Is there a fee for the LMS?" vs "How much would access cost?".
//  - "words": shared-word scoring, used while the model loads, if it can't load, or if it's turned off.

// Two-letter words are kept (QR, AI, HR) unless they're common filler.
const STOP = new Set(`a an the and or but if of to in on at by is it as be do so we us me my no up go am he
are was were been being does did done can could will would should shall may might must have has had having
this that these those there here what which who whom whose when where why how any all each every some such
than then them they their theirs its our ours your yours you not yes also just only very more most other same
too show get use using used able need want like etc`.split(/\s+/));

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function stem(w) {
  if (w.length <= 4) return w;
  for (const suf of ['ing', 'ed', 'es', 's']) {
    if (w.endsWith(suf) && w.length - suf.length >= 4) return w.slice(0, -suf.length);
  }
  return w;
}

/** Turn a stemmed token back into a readable word from the text ("complet" -> "completed"). */
export function displayTerm(token, text, synonyms = []) {
  const syn = synonyms.find((s) => s.term.toLowerCase().replace(/[^\w]/g, '') === token);
  if (syn) return syn.term;
  const words = String(text || '').toLowerCase().replace(/[’']/g, '').replace(/[^\w\s]/g, ' ').split(/\s+/);
  return words.find((w) => stem(w) === token) || token;
}

/** Build a text normalizer from abbreviation rules like { term: "PTP", means: "pre-task plan" }. */
export function buildNormalizer(synonyms = []) {
  const rules = synonyms
    .filter((s) => s && s.term && s.means)
    .map((s) => ({
      re: new RegExp(`(^|[^\\w])${escapeRe(s.means.toLowerCase().trim())}s?(?=$|[^\\w])`, 'g'),
      token: s.term.toLowerCase().replace(/[^\w]/g, ''),
    }))
    .filter((r) => r.token);
  return (text) => {
    let t = ` ${String(text || '').toLowerCase()} `;
    for (const r of rules) t = t.replace(r.re, `$1 ${r.token} `);
    return t;
  };
}

export function tokenize(text, normalize = (t) => t.toLowerCase()) {
  const words = normalize(text).replace(/[’']/g, '').replace(/[^\w\s]/g, ' ').split(/\s+/);
  const out = new Set();
  for (const w of words) {
    if (w.length >= 2 && !STOP.has(w) && !/^\d+$/.test(w)) out.add(stem(w));
  }
  return out;
}

/** Word-based score, 0–100, plus the parts used for the "How this is scored" view. */
export function scoreSets(A, B, cfg) {
  const shared = [];
  for (const w of A) if (B.has(w)) shared.push(w);
  const i = shared.length;
  if (!A.size || !B.size || i === 0) return { score: 0, overlap: 0, jaccard: 0, shared };
  const overlap = i / Math.min(A.size, B.size);
  const jaccard = i / (A.size + B.size - i);
  const wo = Number(cfg.overlapRatio ?? 70);
  const wj = Number(cfg.jaccardRatio ?? 30);
  const total = wo + wj || 1;
  let score = Math.round(((wo * overlap + wj * jaccard) / total) * 100);
  if (i < (cfg.minShared ?? 2)) score = 0;
  return { score, overlap: Math.round(overlap * 100), jaccard: Math.round(jaccard * 100), shared };
}

export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * Cached index over the dataset. `vectors` (Map id -> Float32Array) switches on meaning-based matching.
 * Pair scores and groups are computed lazily on first use.
 */
export function createIndex(items, cfg, vectors = null) {
  const normalize = buildNormalizer(cfg.synonyms);
  const tokens = new Map(items.map((it) => [it.id, tokenize(it.question, normalize)]));
  const byId = new Map(items.map((it) => [it.id, it]));
  const semantic = !!(vectors && vectors.size);
  const mode = semantic ? 'meaning' : 'words';
  const threshold = semantic ? (cfg.semanticThreshold ?? 42) : (cfg.matchThreshold ?? 35);
  // "Same question" is a higher bar than "same topic": it drives duplicate warnings and conflict flags.
  const sameThreshold = semantic ? (cfg.sameThreshold ?? 70) : (cfg.sameWordThreshold ?? 60);
  // Fitting a question to an existing theme blends its closest member with the theme's average.
  // On your data that found every held-out member at a bar ~6 points above the grouping threshold.
  const themeThreshold = semantic ? threshold + 6 : threshold;
  const pairCache = new Map();
  let pairs = null;
  let groups = null;

  const key = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);

  function compare(a, b) {
    const k = key(a, b);
    if (!pairCache.has(k)) {
      const A = tokens.get(a), B = tokens.get(b);
      const words = A && B ? scoreSets(A, B, cfg) : { score: 0, overlap: 0, jaccard: 0, shared: [] };
      const va = semantic && vectors.get(a), vb = semantic && vectors.get(b);
      pairCache.set(k, va && vb
        ? { ...words, wordScore: words.score, score: Math.max(0, Math.round(dot(va, vb) * 100)), mode: 'meaning' }
        : { ...words, wordScore: words.score, mode: 'words' });
    }
    return pairCache.get(k);
  }

  function allPairs() {
    if (pairs) return pairs;
    pairs = [];
    const ids = items.map((i) => i.id);
    for (let x = 0; x < ids.length; x++) {
      for (let y = x + 1; y < ids.length; y++) {
        const r = compare(ids[x], ids[y]);
        if (r.score >= threshold) pairs.push({ a: ids[x], b: ids[y], score: r.score });
      }
    }
    pairs.sort((p, q) => q.score - p.score);
    return pairs;
  }

  /** Greedy grouping: a question joins a group only if it matches the group's members on average. */
  function getGroups() {
    if (groups) return groups;
    const maxSize = semantic ? 6 : 4;
    const slack = semantic ? 3 : 0;
    const owner = new Map();
    const list = [];
    function tryJoin(g, id) {
      const avg = g.ids.reduce((s, m) => s + compare(m, id).score, 0) / g.ids.length;
      if (avg >= threshold - slack) { g.ids.push(id); owner.set(id, g); }
    }
    for (const p of allPairs()) {
      const ga = owner.get(p.a), gb = owner.get(p.b);
      if (!ga && !gb) {
        const g = { ids: [p.a, p.b], score: p.score };
        list.push(g);
        owner.set(p.a, g); owner.set(p.b, g);
      } else if (ga && !gb && ga.ids.length < maxSize) tryJoin(ga, p.b);
      else if (gb && !ga && gb.ids.length < maxSize) tryJoin(gb, p.a);
    }
    groups = list.map((g) => {
      const ids = [...g.ids].sort((a, b) => a - b);
      const members = ids.map((id) => byId.get(id));
      // Name the group after its most representative question (highest average match to the others).
      const avg = (m) => ids.reduce((s, o) => s + (o === m.id ? 0 : compare(m.id, o).score), 0);
      const companies = members.map((m) => m.company).filter(Boolean);
      const named = (m) => (companies.some((c) => m.question.includes(c)) ? 1 : 0);
      const shortest = [...members].sort((a, b) => named(a) - named(b) || avg(b) - avg(a) || a.question.length - b.question.length)[0];
      const askers = [...new Set(members.map((m) => m.company || m.askedBy))];
      const topics = [...new Set(members.map((m) => m.topic))];
      return { key: ids.join('-'), ids, score: g.score, title: shortest.question, askers, topics };
    });
    return groups;
  }

  function similarTo(id, n = 3, min = 1) {
    const out = [];
    for (const it of items) {
      if (it.id === id) continue;
      const r = compare(id, it.id);
      if (r.score >= min) out.push({ item: it, ...r });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, n);
  }

  /** Word-based best match for free text. For meaning-based, use bestMatchByVector. */
  function bestMatch(text) {
    const T = tokenize(text, normalize);
    let best = null;
    for (const it of items) {
      const r = scoreSets(T, tokens.get(it.id), cfg);
      if (!best || r.score > best.score) best = { item: it, ...r, mode: 'words' };
    }
    return best;
  }

  function bestMatchByVector(vec, filter = () => true) {
    let best = null;
    if (!semantic) return null;
    for (const it of items) {
      const v = vectors.get(it.id);
      if (!v || !filter(it)) continue;
      const score = Math.max(0, Math.round(dot(vec, v) * 100));
      if (!best || score > best.score) best = { item: it, score, mode: 'meaning' };
    }
    return best;
  }

  // ---------- Theme fit ----------
  const membersOf = (themeId, exclude) => items.filter((i) => i.themeId === themeId && i.id !== exclude);

  /** How well a question (by id) or a vector fits a theme, 0–100. */
  function themeFit(idOrVec, themeId) {
    const isId = typeof idOrVec === 'number';
    const members = membersOf(themeId, isId ? idOrVec : null);
    if (!members.length) return 0;
    if (semantic) {
      const v = isId ? vectors.get(idOrVec) : idOrVec;
      if (!v) return 0;
      const vs = members.map((m) => vectors.get(m.id)).filter(Boolean);
      if (!vs.length) return 0;
      const near = Math.max(...vs.map((m) => dot(v, m)));
      const c = new Float32Array(v.length);
      vs.forEach((m) => { for (let i = 0; i < m.length; i++) c[i] += m[i]; });
      const norm = Math.hypot(...c) || 1;
      const cen = dot(v, c) / norm;
      return Math.max(0, Math.round(((near + cen) / 2) * 100));
    }
    if (!isId) return 0;
    return Math.max(...members.map((m) => compare(idOrVec, m.id).score));
  }

  /** Best-fitting existing theme for a question or vector: { themeId, score } or null. */
  function bestTheme(idOrVec, themeIds) {
    let best = null;
    for (const t of themeIds) {
      const score = themeFit(idOrVec, t);
      if (!best || score > best.score) best = { themeId: t, score };
    }
    return best;
  }

  return {
    compare, allPairs, groups: getGroups, similarTo, bestMatch, bestMatchByVector, tokens,
    mode, threshold, sameThreshold, themeThreshold, themeFit, bestTheme,
  };
}
