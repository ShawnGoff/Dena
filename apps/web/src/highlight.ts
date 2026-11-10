/**
 * Marking the word being read. The page's own text is never changed: a word is marked with the
 * browser's CSS Custom Highlight API (a Range painted by `::highlight(dena-word)`), where the
 * browser has it. Elsewhere only the whole part being read is marked, as before.
 */

export interface Word {
  /** Where the word starts and ends in the spoken text. */
  start: number;
  end: number;
}

export function wordsOf(text: string): Word[] {
  return [...text.matchAll(/\S+/g)].map((m) => ({ start: m.index!, end: m.index! + m[0].length }));
}

const core = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);

/**
 * For each spoken word, the matching word in `el` (or null where the spoken text says something
 * the page does not, such as "Dena infers that"). Words are matched in order, looking only a short
 * way ahead, so one miss does not send the rest off to a later part of the page.
 */
export function mapWords(el: Element, text: string): (Range | null)[] {
  const nodes: { node: Text; start: number }[] = [];
  let all = "";
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: n as Text, start: all.length });
    all += (n as Text).data;
  }
  const lower = all.toLowerCase();
  const at = (offset: number): { node: Text; offset: number } | null => {
    for (let i = nodes.length - 1; i >= 0; i--) if (offset >= nodes[i]!.start) return { node: nodes[i]!.node, offset: offset - nodes[i]!.start };
    return null;
  };
  let cursor = 0;
  return wordsOf(text).map((w) => {
    const word = core(text.slice(w.start, w.end));
    if (!word) return null;
    for (let from = cursor; from < Math.min(lower.length, cursor + 160); ) {
      const idx = lower.indexOf(word, from);
      if (idx < 0 || idx > cursor + 160) return null;
      if (!isWordChar(lower[idx - 1]) && !isWordChar(lower[idx + word.length])) {
        const a = at(idx);
        const b = at(idx + word.length - 1);
        if (!a || !b) return null;
        const r = document.createRange();
        r.setStart(a.node, a.offset);
        r.setEnd(b.node, Math.min(b.node.length, b.offset + 1));
        cursor = idx + word.length;
        return r;
      }
      from = idx + 1;
    }
    return null;
  });
}

/** How long each word takes to say, relative to the others, where the voice gives no timings. */
export function weights(text: string): number[] {
  return wordsOf(text).map((w) => {
    const t = text.slice(w.start, w.end);
    return core(t).length + 1 + (/[,;:]$/.test(t) ? 2 : /[.!?]$/.test(t) ? 4 : 0);
  });
}

/** The word being said `progress` (0-1) of the way through, given each word's weight. */
export function wordAt(w: number[], progress: number): number {
  const total = w.reduce((a, b) => a + b, 0);
  let acc = 0;
  for (let i = 0; i < w.length; i++) {
    acc += w[i]!;
    if (progress * total < acc) return i;
  }
  return Math.max(0, w.length - 1);
}

/** The word that contains character `charIndex` of the spoken text (for the browser's boundary events). */
export function wordAtChar(words: Word[], charIndex: number): number {
  const i = words.findIndex((w) => charIndex < w.end);
  return i < 0 ? Math.max(0, words.length - 1) : i;
}

const registry = () => (typeof CSS !== "undefined" ? (CSS as unknown as { highlights?: Map<string, unknown> }).highlights : undefined);

export function markWord(range: Range | null) {
  const reg = registry();
  const H = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  if (!reg || !H || !range) return;
  reg.set("dena-word", new H(range));
}

export function clearWord() {
  registry()?.delete("dena-word");
}
