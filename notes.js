// Split pasted call notes into question/answer pairs. No AI involved: it reads markers
// (Q:/A:), question marks, bullets and line breaks, so the result is predictable.

const Q_MARK = /^(q(uestion)?\s*\d*\s*[:.)\-–]|\?\s)/i;
const A_MARK = /^(a(nswer)?|r(esponse)?|reply)\s*\d*\s*[:.)\-–]\s*/i;
const BULLET = /^\s*(?:[-*•▪◦·–]|\d{1,3}[.)]|\(?[a-z]\))\s+/i;
// "Kash:" or "Dita (Novara):" at the start of a line: a speaker label, not part of the text.
const SPEAKER = /^([A-Z][\w'’.-]*(?:\s+[A-Z][\w'’.-]*){0,2}(?:\s*\([^)]{1,40}\))?)\s*:\s+(?=\S)/;

const FILLER = /^(?:(?:ok(?:ay)?|so|and|also|um+|uh+|well|right)[,\s]+)+/i;

function clean(line) {
  let t = line.replace(BULLET, '').trim();
  const sp = SPEAKER.exec(t);
  if (sp && !/^(q|a|question|answer|response|reply|note|notes)$/i.test(sp[1])) t = t.slice(sp[0].length);
  t = t.replace(FILLER, '');
  return t.charAt(0).toUpperCase() + t.slice(1).trim();
}

/** @returns {{ pairs: {question: string, answer: string}[], skipped: number }} */
export function parseNotes(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
  const pairs = [];
  let cur = null;
  let skipped = 0;
  const startQ = (q) => { cur = { question: q, answer: [] }; pairs.push(cur); };

  for (const raw of lines) {
    let line = raw.replace(BULLET, '').trim();
    if (Q_MARK.test(line)) {
      startQ(clean(line.replace(Q_MARK, '').trim()));
      continue;
    }
    if (A_MARK.test(line)) {
      const a = clean(line.replace(A_MARK, ''));
      if (cur) cur.answer.push(a); else skipped++;
      continue;
    }
    line = clean(line);
    const qm = line.indexOf('?');
    if (qm >= 0) {
      const q = line.slice(0, qm + 1).trim();
      const rest = line.slice(qm + 1).replace(/^[\s\-–—:]+/, '').trim();
      // A line that is mostly a question starts a new pair; anything after the "?" is its answer.
      if (q.split(/\s+/).length >= 3) {
        startQ(q);
        if (rest.length > 2) cur.answer.push(rest);
        continue;
      }
    }
    if (cur) cur.answer.push(line); else skipped++;
  }
  return {
    pairs: pairs.filter((p) => p.question.length > 3).map((p) => ({ question: p.question, answer: p.answer.join(' ').replace(/\s+/g, ' ').trim() })),
    skipped,
  };
}
