"""Structure heuristics over ingested blocks: sections, references, sentences.

Deliberately dependency-light (no ML) so it works offline and fast. Good-enough
for navigation, reference parsing and auto-highlight anchoring.
"""
from __future__ import annotations

import re
import statistics
from typing import Any

_SECTION_NUM = re.compile(r"^(\d+(?:\.\d+)*)\.?\s+[A-Z]")
_HEADINGS = re.compile(
    r"^(abstract|introduction|related work|background|method(?:s|ology)?|approach|"
    r"experiments?|results?|evaluation|discussion|conclusions?|references|"
    r"bibliography|appendix|acknowledge?ments?)\b",
    re.IGNORECASE,
)
_REF_HEAD = re.compile(r"^(references|bibliography)\s*$", re.IGNORECASE)
_NUM_ONLY = re.compile(r"^(\d+(?:\.\d+)*)\.?$")            # "1", "2.1"
_NUM_PREFIX = re.compile(r"^(\d+(?:\.\d+)*)\.?\s+\S")      # "1 Introduction"
# pseudocode / caption lines that should NOT be treated as section headings
_HEADING_NOISE = re.compile(
    r"^(algorithm|figure|fig\.|table|for\b|if\b|while\b|return\b|end\b|input\b|"
    r"output\b|repeat\b|[–—•])",
    re.IGNORECASE,
)


def body_font_size(pages: list[dict]) -> float:
    """Median block font size — the paper's body text size."""
    sizes = [b["size"] for p in pages for b in p["blocks"] if b.get("text")]
    if not sizes:
        return 10.0
    try:
        return statistics.median(sizes)
    except statistics.StatisticsError:
        return 10.0


def detect_sections(parsed: dict) -> list[dict]:
    """Return a flat list of {title, page, block_id, level} section headers."""
    pages = parsed["pages"]
    body = body_font_size(pages)
    sections: list[dict] = []

    # Prefer the embedded TOC if the PDF has one.
    toc = parsed.get("toc") or []
    if toc:
        for level, title, page in toc:
            sections.append({
                "title": title.strip(),
                "page": max(0, int(page) - 1),
                "block_id": None,
                "level": int(level),
            })
        return sections

    for p in pages:
        for b in p["blocks"]:
            lines = [ln.strip() for ln in b["text"].splitlines() if ln.strip()]
            if not lines:
                continue
            first = lines[0]
            if len(first) > 120 or _HEADING_NOISE.match(first):
                continue

            # figure out numbering + a full title (headings often split the
            # number and the title text across two lines: "1" / "Introduction")
            num = None
            title = first
            m_only = _NUM_ONLY.match(first)
            if m_only:
                num = m_only.group(1)
                title = f"{num} {lines[1]}" if len(lines) > 1 else num
            elif _NUM_PREFIX.match(first):
                num = _NUM_PREFIX.match(first).group(1)
                title = first

            is_big = b["size"] >= body * 1.12
            looks_numbered = num is not None
            looks_named = bool(_HEADINGS.match(first)) and len(first) < 60
            short_bold = bool(b.get("bold")) and is_big and len(first) < 40

            if not ((is_big and (looks_numbered or looks_named)) or looks_named or short_bold):
                continue
            # drop entries that are still just a bare number (no title text)
            if _NUM_ONLY.match(title):
                continue
            # real sections don't start at 0 (those are equation/axis fragments)
            if num and num.split(".")[0] == "0":
                continue
            # a numbered heading must carry real words, not equation symbols
            if looks_numbered and not re.search(r"[A-Za-z]{2,}", title):
                continue

            level = num.count(".") + 1 if num else 1
            sections.append({
                "title": title.strip()[:90],
                "page": p["index"],
                "block_id": b["id"],
                "level": level,
            })
    return sections


def find_references_text(parsed: dict) -> str:
    """Return the raw text of the References/Bibliography section, if present."""
    pages = parsed["pages"]
    started = False
    parts: list[str] = []
    for p in pages:
        for b in p["blocks"]:
            first = b["text"].strip().splitlines()[0] if b["text"].strip() else ""
            if not started and _REF_HEAD.match(first):
                started = True
                continue
            if started:
                # stop at an Appendix heading
                if re.match(r"^appendix\b", first, re.IGNORECASE):
                    return "\n\n".join(parts)
                parts.append(b["text"])
    # blocks joined with blank lines so per-block splitting works for
    # author-year reference lists that lack [n] markers.
    return "\n\n".join(parts)


# Numbered reference markers are only "[n]" or a line-initial "n." (1-3 digits).
# NOTE: we deliberately do NOT treat "(n)" as a marker — that matches centred
# equation numbers in appendices and shreds them into fake references.
_REF_MARK = re.compile(r"(?m)^\s*(?:\[(\d{1,3})\]|(\d{1,3})\.)\s+")
_YEAR = re.compile(r"\b(?:18|19|20)\d{2}[a-z]?\b")
_VENUE = re.compile(
    r"\bet al\b|arxiv|\bin proc|\bproceedings\b|\bconference\b|\bjournal\b|"
    r"\bpp\.\b|\bvol\.\b|\bpreprint\b|\bworkshop\b",
    re.IGNORECASE,
)
_MAX_ENTRY = 700  # references are rarely longer; caps runaway appendix tails


def _looks_like_reference(t: str) -> bool:
    if not (18 <= len(t) <= 900):
        return False
    # must contain real words (drops appendix axis-tick / numeric rows)
    letters = len(re.findall(r"[A-Za-z]", t))
    if letters < 10 or letters < len(t) * 0.25:
        return False
    # result-table rows are dense with decimal numbers; references are not
    if len(re.findall(r"\d+\.\d+", t)) >= 4:
        return False
    return bool(_YEAR.search(t) or _VENUE.search(t))


def split_reference_entries(ref_text: str) -> list[str]:
    """Split a references blob into individual entries (best-effort)."""
    if not ref_text.strip():
        return []
    # 1) numbered / bracketed style
    marks = list(_REF_MARK.finditer(ref_text))
    if len(marks) >= 3:
        entries = []
        for i, m in enumerate(marks):
            start = m.start()
            end = marks[i + 1].start() if i + 1 < len(marks) else len(ref_text)
            entry = " ".join(ref_text[start:end].split())[:_MAX_ENTRY]
            if len(entry) > 12:
                entries.append(entry)
        return entries
    # 2) author-year style: split by block, keep only reference-looking chunks
    chunks = re.split(r"\n\s*\n", ref_text)
    out = []
    for c in chunks:
        c = " ".join(c.split())[:_MAX_ENTRY]
        if _looks_like_reference(c):
            out.append(c)
    return out


_SENT_SPLIT = re.compile(r"(?<=[.!?])\s+(?=[A-Z(])")


def split_sentences(text: str) -> list[str]:
    text = " ".join(text.split())
    if not text:
        return []
    sents = _SENT_SPLIT.split(text)
    return [s.strip() for s in sents if len(s.strip()) > 3]
