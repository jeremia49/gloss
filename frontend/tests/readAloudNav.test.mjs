import assert from "node:assert/strict";
import test from "node:test";

import {
  adjacentSection,
  nextReadable,
  readableIndices,
  startIndex,
} from "../src/readAloudNav.mjs";

// sections: 0 front matter, 1 Abstract, 2 Intro, 3 References, 4 Appendix
const seg = (page, section, skip = null) => ({ page, section, skip, rects: [], text: "x", heading: false });
const segments = [
  seg(0, 0), seg(0, 0, "authors"), seg(0, 0, "contact"), // 0-2
  seg(0, 1), seg(0, 1),                                   // 3-4
  seg(1, 2), seg(1, 2, "caption"), seg(1, 2),             // 5-7
  seg(2, 3, "references"), seg(2, 3, "references"),       // 8-9
  seg(3, 4),                                              // 10
];
const sections = [0, 3, 5, 8, 10].map((start, i) => ({ title: `s${i}`, level: 1, start }));
const skip = { skipEnabled: true, forceSection: null };
const all = { skipEnabled: false, forceSection: null };

test("paragraph stepping passes over skip-tagged blocks only while skipping is on", () => {
  assert.equal(nextReadable(segments, 0, 1, skip), 3);
  assert.equal(nextReadable(segments, 5, 1, skip), 7);
  assert.equal(nextReadable(segments, 7, 1, skip), 10);
  assert.equal(nextReadable(segments, 0, 1, all), 1);
  assert.equal(nextReadable(segments, 3, -1, skip), 0);
  assert.equal(nextReadable(segments, 10, 1, skip), -1);
});

test("an explicitly chosen section is read even though it is skip-tagged", () => {
  const forced = { skipEnabled: true, forceSection: 3 };
  assert.equal(nextReadable(segments, 7, 1, forced), 8);
  assert.equal(nextReadable(segments, 8, 1, forced), 9);
});

test("next section reaches a fully skipped section, which is then read anyway", () => {
  assert.deepEqual(adjacentSection(segments, sections, 5, 1, skip), { index: 8, forceSection: 3 });
  assert.deepEqual(adjacentSection(segments, sections, 3, 1, skip), { index: 5, forceSection: null });
  assert.deepEqual(adjacentSection(segments, sections, 5, 1, all), { index: 8, forceSection: null });
  assert.equal(adjacentSection(segments, sections, 10, 1, skip), null);
});

test("next section from the front matter lands on its first readable block", () => {
  // section 0 starts with readable 0; section 1 head is 3
  assert.deepEqual(adjacentSection(segments, sections, 0, 1, skip), { index: 3, forceSection: null });
});

test("previous section rewinds to the current section start first", () => {
  assert.deepEqual(adjacentSection(segments, sections, 7, -1, skip), { index: 5, forceSection: null });
  assert.deepEqual(adjacentSection(segments, sections, 5, -1, skip), { index: 3, forceSection: null });
  assert.deepEqual(adjacentSection(segments, sections, 9, -1, { skipEnabled: true, forceSection: 3 }), { index: 8, forceSection: 3 });
  assert.deepEqual(adjacentSection(segments, sections, 10, -1, skip), { index: 8, forceSection: 3 });
  assert.equal(adjacentSection(segments, sections, 0, -1, skip), null);
});

test("reading starts at the first readable block of the visible page", () => {
  assert.equal(startIndex(segments, 1, skip), 5);
  assert.equal(startIndex(segments, 2, skip), 10);
  assert.equal(startIndex(segments, 2, all), 8);
  assert.equal(startIndex(segments, 9, skip), 10); // past the end → last readable
});

test("progress counts only readable blocks", () => {
  assert.deepEqual(readableIndices(segments, skip), [0, 3, 4, 5, 7, 10]);
  assert.equal(readableIndices(segments, all).length, segments.length);
});
