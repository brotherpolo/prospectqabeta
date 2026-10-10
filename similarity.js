// Question matching engine.
// Improvements over the original: light stemming, user-defined abbreviations,
// the overlap/Jaccard weights are actually applied, a minimum number of shared terms,
// and grouping that doesn't chain unrelated questions together.

const STOP = new Set(`a an the and or but if of to in on at by for with from into onto about as is are was were be been being
do does did done can could will would should shall may might must have has had having this that these those there here
what which who whom whose when where why how any all each every some such than then them they their theirs it its
our ours your yours you we us i me my he she his her not no yes also just only very more most other same so too
flex show get use using used able need want like etc`.split(/\s+/));

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function stem(w) {
  if (w.length <= 4) return w;
  for (const suf of ['ing', 'ed', 'es', 's']) {
    if (w.endsWith(suf) && w.length - suf.length >= 4) return w.slice(0, -suf.length);
  }
  return w;
}

/** Turn a stemmed token back into a readable word that appears in the text ("complet" -> "completed"). */
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
    if (w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w)) out.add(stem(w));
  }
  return out;
}

/** Score two token sets. Returns 0–100 plus the parts used, for the "How this is scored" view. */
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

/**
 * Build a cached index over the dataset. Token sets are computed once per data change;
 * pair scores and groups are computed lazily on first use.
 */
export function createIndex(items, cfg) {
  const normalize = buildNormalizer(cfg.synonyms);
  const tokens = new Map(items.map((it) => [it.id, tokenize(it.question, normalize)]));
  const byId = new Map(items.map((it) => [it.id, it]));
  const pairCache = new Map();
  let pairs = null;
  let groups = null;

  const key = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);

  function compare(a, b) {
    const k = key(a, b);
    if (!pairCache.has(k)) {
      const A = tokens.get(a), B = tokens.get(b);
      pairCache.set(k, A && B ? scoreSets(A, B, cfg) : { score: 0, overlap: 0, jaccard: 0, shared: [] });
    }
    return pairCache.get(k);
  }

  function allPairs() {
    if (pairs) return pairs;
    pairs = [];
    const ids = items.map((i) => i.id);
    const th = cfg.matchThreshold ?? 35;
    for (let x = 0; x < ids.length; x++) {
      for (let y = x + 1; y < ids.length; y++) {
        const r = compare(ids[x], ids[y]);
        if (r.score >= th) pairs.push({ a: ids[x], b: ids[y], score: r.score });
      }
    }
    pairs.sort((p, q) => q.score - p.score);
    return pairs;
  }

  /** Greedy grouping: a question joins a group only if it matches the group on average. Max 4 per group. */
  function getGroups() {
    if (groups) return groups;
    const th = cfg.matchThreshold ?? 35;
    const owner = new Map();
    const list = [];
    for (const p of allPairs()) {
      const ga = owner.get(p.a), gb = owner.get(p.b);
      if (!ga && !gb) {
        const g = { ids: [p.a, p.b], score: p.score };
        list.push(g);
        owner.set(p.a, g); owner.set(p.b, g);
      } else if (ga && !gb && ga.ids.length < 4) {
        tryJoin(ga, p.b);
      } else if (gb && !ga && gb.ids.length < 4) {
        tryJoin(gb, p.a);
      }
    }
    function tryJoin(g, id) {
      const avg = g.ids.reduce((s, m) => s + compare(m, id).score, 0) / g.ids.length;
      if (avg >= th) { g.ids.push(id); owner.set(id, g); }
    }
    groups = list.map((g) => {
      const ids = [...g.ids].sort((a, b) => a - b);
      const members = ids.map((id) => byId.get(id));
      const shortest = [...members].sort((a, b) => a.question.length - b.question.length)[0];
      const askers = [...new Set(members.map((m) => m.askedBy))];
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

  /** Score free text (e.g. an imported question) against every existing question. */
  function bestMatch(text) {
    const T = tokenize(text, normalize);
    let best = null;
    for (const it of items) {
      const r = scoreSets(T, tokens.get(it.id), cfg);
      if (!best || r.score > best.score) best = { item: it, ...r };
    }
    return best;
  }

  return { compare, allPairs, groups: getGroups, similarTo, bestMatch, tokens };
}
