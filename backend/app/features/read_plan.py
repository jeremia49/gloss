"""Read-aloud reading plan: a parsed paper as an ordered list of speakable paragraphs.

Each segment is one parsed text block (so the UI can highlight its bbox while it
is spoken), tagged with the section it belongs to and — when it is something a
listener usually doesn't want to hear — a ``skip`` reason (authors, e-mail,
footnotes, running headers, captions, math fragments, references, …). The UI
decides whether to honour ``skip``; nothing is dropped here except blocks that
have no speakable text at all.
"""
from __future__ import annotations

import re

from ..library import store
from ..pdf import structure
from .tts import clean_for_speech

_ABSTRACT = re.compile(r"^(?:abstract|summary|highlights|a b s t r a c t)\b", re.IGNORECASE)
_REF_HEAD = re.compile(r"^(references|bibliography)\s*$", re.IGNORECASE)
_ACK_HEAD = re.compile(r"^(?:\d+(?:\.\d+)*\.?\s+)?acknowledge?ments?\b", re.IGNORECASE)
_EMAIL = re.compile(r"@[\w-]+(?:\.[\w-]+)+")
_CAPTION = re.compile(r"^(?:fig(?:ure)?|table|tab|algorithm)\.?\s*[\dIVX]+[a-z]?\s*[.:|]", re.IGNORECASE)
_PAGE_NUM = re.compile(r"^(?:page\s+)?\d{1,4}(?:\s*(?:/|of)\s*\d{1,4})?$", re.IGNORECASE)
_NOTE = re.compile(
    r"^[*†‡§¶⇑✉]|corresponding author|equal contribution|contributed equally|work done (?:while|during)|"
    r"preprint|under review|copyright|©|licensed under|permission to make|arxiv:\s*\d|"
    r"proceedings of|accepted (?:at|to|for)|published (?:at|in|as|online)|article history|"
    r"^keywords?\b|^key ?words\b|^index terms\b|received:?\s*\d|^\(received\b|to cite this article|"
    r"to link to this article|please scroll down|downloaded (?:by|from)|this article was downloaded|"
    r"terms (?:and|&) conditions|contents lists available|journal homepage|open access article|"
    r"every effort to ensure the accuracy|may be used for research, teaching|publication details",
    re.IGNORECASE,
)
_DIGITS = re.compile(r"\d+")


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", s.lower())


def _first_line(text: str) -> str:
    for ln in text.splitlines():
        if ln.strip():
            return ln.strip()
    return ""


def reading_order(blocks: list[dict], width: float) -> list[dict]:
    """Order blocks for reading, column-aware.

    Blocks that straddle the page's vertical midline (titles, full-width
    paragraphs, wide figures) act as band separators; between them the left
    column is read top-to-bottom before the right column. Single-column pages
    degrade to plain top-to-bottom order.
    """
    mid = width / 2
    out: list[dict] = []
    left: list[dict] = []
    right: list[dict] = []

    def y(b: dict) -> tuple[float, float]:
        return (b["bbox"][1], b["bbox"][0])

    def flush() -> None:
        out.extend(sorted(left, key=y))
        out.extend(sorted(right, key=y))
        left.clear()
        right.clear()

    for b in sorted(blocks, key=y):
        x0, _, x1, _ = b["bbox"]
        if x0 < mid - 1 and x1 > mid + 1:
            flush()
            out.append(b)
        elif (x0 + x1) / 2 < mid:
            left.append(b)
        else:
            right.append(b)
    flush()
    return out


def _letters_ratio(text: str) -> tuple[int, float]:
    chars = [c for c in text if not c.isspace()]
    letters = sum(c.isalpha() for c in chars)
    return letters, (letters / len(chars) if chars else 0.0)


_SENTENCE_END = re.compile(r"[a-z]{2,}[.!?]\s+[A-Z]")


def _is_prose(text: str) -> bool:
    """Running sentences (an abstract, a paragraph) — not a list of names/places."""
    t = " ".join(text.split())
    return len(t) > 900 or len(_SENTENCE_END.findall(t)) >= 2


def _running_texts(pages: list[dict]) -> set[str]:
    """Short lines repeated on 3+ pages (journal running headers, banners).

    Digits are normalised away so "Page 3" / "Page 4" or "… 2516" / "… 2517"
    count as the same line.
    """
    seen: dict[str, set[int]] = {}
    for p in pages:
        for b in p.get("blocks", []):
            t = b.get("text", "").strip()
            if t and len(t) < 160:
                seen.setdefault(_DIGITS.sub("#", " ".join(t.split())).lower(), set()).add(p["index"])
    return {k for k, v in seen.items() if len(v) >= 3}


def _block_skip(b: dict, page: dict, body: float, running: set[str] = frozenset()) -> str | None:
    """Skip reason from the block's own text/geometry (section context aside)."""
    text = b.get("text", "").strip()
    first = _first_line(text)
    h = page.get("height") or 792.0
    x0, y0, x1, y1 = b["bbox"]
    if _EMAIL.search(text) and len(text) < 400:
        return "contact"
    if (
        _PAGE_NUM.match(text)
        or ((y1 < h * 0.07 or y0 > h * 0.93) and len(text) < 160)
        or _DIGITS.sub("#", " ".join(text.split())).lower() in running
    ):
        return "header_footer"
    if _CAPTION.match(first):
        return "caption"
    if _NOTE.search(first) and len(text) < 900:
        return "note"
    if b.get("size", body) <= body * 0.88 and y0 > h * 0.6 and len(text) < 600:
        return "footnote"
    letters, ratio = _letters_ratio(text)
    if letters < 4 or ratio < 0.45:
        return "math"
    return None


def build_plan(parsed: dict) -> dict:
    """Return ``{"segments": [...], "sections": [...]}`` for a parsed paper.

    segment: ``{page, rects: [[x0,y0,x1,y1]], text, section, heading, skip}``
    section: ``{title, level, start}`` — ``start`` is a segment index; a leading
    untitled section (``title == ""``) holds anything before the first heading.
    """
    pages = parsed.get("pages", [])
    body = structure.body_font_size(pages)
    detected = parsed.get("sections") or structure.detect_sections(parsed)
    running = _running_texts(pages)

    ordered: list[tuple[dict, dict]] = []  # (page, block)
    for p in pages:
        for b in reading_order([b for b in p.get("blocks", []) if b.get("text")], p.get("width") or 612.0):
            ordered.append((p, b))

    # --- resolve section headings to blocks --------------------------------
    by_id = {b["id"]: i for i, (_, b) in enumerate(ordered)}
    heading_at: dict[int, dict] = {}
    for s in detected:
        idx = by_id.get(s.get("block_id")) if s.get("block_id") is not None else None
        if idx is None:  # embedded-TOC entry: find the heading block on its page
            want = _norm(s.get("title", ""))[:40]
            on_page = [i for i, (p, _) in enumerate(ordered) if p["index"] == s.get("page")]
            # tolerate a section number the TOC omits ("1 Introduction" vs "Introduction")
            idx = next(
                (i for i in on_page if want and want in _norm(ordered[i][1]["text"])[: len(want) + 8]),
                None,
            )
            if idx is None:  # title not found verbatim: start at the page's first real block
                idx = next(
                    (i for i in on_page if _block_skip(ordered[i][1], ordered[i][0], body, running) != "header_footer"),
                    None,
                )
        if idx is not None and idx not in heading_at:
            heading_at[idx] = s

    # --- front matter: title is read, banners/authors/affiliations skip ----
    # Per page (the first, and the second when the first is a publisher cover
    # sheet): the title is the largest top-of-page text; everything after it
    # up to the first heading / abstract / prose paragraph is author matter,
    # and non-prose blocks above it are journal banners.
    front: dict[int, str] = {}
    for pno in (0, 1):
        if pno >= len(pages):
            break
        on_page = [(i, b) for i, (p, b) in enumerate(ordered) if p["index"] == pno]
        h = pages[pno].get("height") or 792.0
        top = [b for _, b in on_page if b["bbox"][1] < h * 0.4]
        title_size = max((b.get("size", 0) for b in top), default=0)
        if title_size < body * 1.15:
            break  # no title here: regular content page
        is_title = lambda b: b["bbox"][1] < h * 0.4 and b.get("size", 0) >= title_size * 0.9
        seen_title = False
        for i, b in on_page:
            if is_title(b):
                seen_title = True
                continue
            first = _first_line(b["text"])
            if (seen_title and i in heading_at) or _ABSTRACT.match(first) or _is_prose(b["text"]):
                if seen_title:
                    break
                continue
            front[i] = "authors" if seen_title else "note"
        # a cover sheet is all title + skippable text; then the article starts
        # on the next page with its own title block
        cover = all(
            is_title(b) or i in front or _block_skip(b, pages[pno], body, running)
            for i, b in on_page
        )
        if not cover:
            break

    # --- walk in order, tracking skipped sections --------------------------
    segments: list[dict] = []
    sections: list[dict] = []
    section_skip: str | None = None
    for i, (p, b) in enumerate(ordered):
        first = _first_line(b["text"])
        is_heading = i in heading_at or bool(_REF_HEAD.match(first))
        if is_heading:
            if _REF_HEAD.match(first):
                section_skip = "references"
            elif _ACK_HEAD.match(first):
                section_skip = "acknowledgments"
            else:
                section_skip = None
        text = clean_for_speech(b["text"])
        if not text:
            continue
        if section_skip:
            skip = section_skip
        elif is_heading:
            skip = None
        else:
            skip = _block_skip(b, p, body, running) or front.get(i)
        if is_heading or not sections:
            s = heading_at.get(i)
            sections.append({
                "title": (s["title"] if s else first)[:90] if is_heading else "",
                "level": int(s.get("level", 1)) if s else 1,
                "start": len(segments),
            })
        segments.append({
            "page": p["index"],
            "rects": [b["bbox"]],
            "text": text,
            "section": len(sections) - 1,
            "heading": is_heading,
            "skip": skip,
        })
    return {"segments": segments, "sections": sections}


def paper_plan(paper_id: str) -> dict:
    parsed = store.load_parsed(paper_id)
    if not parsed:
        raise ValueError("paper not parsed")
    return build_plan(parsed)
