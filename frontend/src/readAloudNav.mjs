// Pure navigation over a read-aloud plan (segments + sections). Kept free of
// React/DOM so node:test can exercise it directly.
//
// segment: { page, rects, text, section, heading, skip: string | null }
// section: { title, level, start }
// opts:    { skipEnabled: boolean, forceSection: number | null }

/** A segment is spoken unless it is skip-tagged while skipping is on —
 * except inside a section the user explicitly jumped to. */
export function isReadable(seg, opts) {
  return !opts.skipEnabled || !seg.skip || seg.section === opts.forceSection;
}

/** Next readable index strictly after/before `from` (dir = +1 / -1), or -1. */
export function nextReadable(segments, from, dir, opts) {
  for (let i = from + dir; i >= 0 && i < segments.length; i += dir) {
    if (isReadable(segments[i], opts)) return i;
  }
  return -1;
}

function sectionEnd(segments, sections, secIdx) {
  return secIdx + 1 < sections.length ? sections[secIdx + 1].start : segments.length;
}

/** First readable segment inside a section, or -1 when all of it is skipped. */
export function sectionFirstReadable(segments, sections, secIdx, opts) {
  const sec = sections[secIdx];
  if (!sec) return -1;
  const end = sectionEnd(segments, sections, secIdx);
  for (let i = sec.start; i < end; i++) {
    if (isReadable(segments[i], opts)) return i;
  }
  return -1;
}

/** Where ⏭ / ⏮ from segment `index` lands: `{ index, forceSection }`, or null.
 * Explicit section jumps reach EVERY section — a section whose content is all
 * skip-tagged (References, Acknowledgments) is entered with `forceSection` so
 * it is read anyway. ⏮ first rewinds to the start of the current section (like
 * a media player's "previous") and only goes back further when already there. */
export function adjacentSection(segments, sections, index, dir, opts) {
  const cur = segments[index] ? segments[index].section : 0;
  if (dir < 0) {
    const head = sectionStart(segments, sections, cur, opts);
    if (head && head.index < index) return head;
  }
  for (let s = cur + dir; s >= 0 && s < sections.length; s += dir) {
    const hit = sectionStart(segments, sections, s, opts);
    if (hit) return hit;
  }
  return null;
}

/** First segment to read when the user picks section `secIdx`, or null if empty. */
export function sectionStart(segments, sections, secIdx, opts) {
  const sec = sections[secIdx];
  if (!sec || sec.start >= sectionEnd(segments, sections, secIdx)) return null;
  const free = { ...opts, forceSection: null };
  const i = sectionFirstReadable(segments, sections, secIdx, free);
  return i !== -1 ? { index: i, forceSection: null } : { index: sec.start, forceSection: secIdx };
}

/** Where "read from the visible page" starts: first readable segment on or
 * after `page`, falling back to the last readable one before it. */
export function startIndex(segments, page, opts) {
  let fallback = -1;
  for (let i = 0; i < segments.length; i++) {
    if (!isReadable(segments[i], opts)) continue;
    if (segments[i].page >= page) return i;
    fallback = i;
  }
  return fallback;
}

/** Indices of all readable segments, in order (drives the progress bar). */
export function readableIndices(segments, opts) {
  const out = [];
  for (let i = 0; i < segments.length; i++) if (isReadable(segments[i], opts)) out.push(i);
  return out;
}
