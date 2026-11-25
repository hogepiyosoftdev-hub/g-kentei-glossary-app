import json
import os
import re
import unicodedata

SOURCE_MD = r"C:\Users\Admin\.gemini\antigravity\brain\31d2dcd8-1827-4901-a29d-2edbb79f0307\g_kentei_glossary.md"
APP_ROOT = r"C:\Users\Admin\.gemini\antigravity\scratch\g-kentei-glossary-app"
DATA_DIR = os.path.join(APP_ROOT, "data")
os.makedirs(DATA_DIR, exist_ok=True)


def normalize_search_text(s: str) -> str:
    """Normalize text for case-insensitive, width-insensitive, kana-insensitive matching."""
    if not s:
        return ""
    # NFKC turns full-width alphanumerics & symbols into half-width, half-width katakana into full-width
    t = unicodedata.normalize("NFKC", s).lower()
    # Convert Katakana (U+30A1..U+30F6) to Hiragana (U+3041..U+3096) for seamless Japanese search
    out = []
    for ch in t:
        code = ord(ch)
        if 0x30A1 <= code <= 0x30F6:
            out.append(chr(code - 0x60))
        else:
            out.append(ch)
    return "".join(out)


def clean_heading_math(s: str) -> str:
    """Convert simple inline LaTeX math symbols in headings/aliases to crisp Unicode."""
    repl = [
        (r"$\varepsilon$", "ε"),
        (r"$\beta$", "β"),
        (r"$\alpha$", "α"),
        (r"$\gamma$", "γ"),
        (r"$\pi$", "π"),
        (r"$R^2$", "R²"),
        (r"$H_0$", "H₀"),
        (r"$H_1$", "H₁"),
        (r"$1 - \beta$", "1 − β"),
        (r"$\chi^2$", "χ²"),
    ]
    out = s
    for old, new in repl:
        out = out.replace(old, new)
    return out


def split_heading(heading: str):
    """Split '主見出し（別名1 / 別名2）' into main title and list of alias tokens."""
    h = clean_heading_math(heading.strip())
    m = re.match(r"^([^（]+)(?:（(.+)）)?$", h)
    if not m:
        return h, "", []
    title = m.group(1).strip()
    alias_raw = (m.group(2) or "").strip()
    aliases = []
    if alias_raw:
        for part in re.split(r"\s*[/／]\s*", alias_raw):
            p = part.strip()
            if p:
                aliases.append(p)
    return title, alias_raw, aliases


def chapter_short(chapter_title: str):
    m = re.match(r"^(第\d+章)：(.+)$", chapter_title)
    if m:
        num = int(re.search(r"\d+", m.group(1)).group(0))
        return num, m.group(1), m.group(2)
    return 11, "参考", "旧シラバス整理・削除ワード"


def parse_glossary(md_path: str):
    with open(md_path, "r", encoding="utf-8") as f:
        lines = f.read().splitlines()

    chapters_map = {}
    entries = []
    appendix = []

    cur_chapter = None
    cur_entry = None
    in_appendix = False

    def flush_entry():
        nonlocal cur_entry
        if not cur_entry:
            return
        raw_lines = cur_entry["raw_lines"]
        keywords = []
        sections = {
            "definition": [],
            "features": [],
            "related": [],
            "pitfalls": [],
        }
        cur_sec = None
        for ln in raw_lines:
            if ln.startswith("- **ポイントキーワード**:"):
                kw_part = ln.split(":", 1)[1].strip()
                keywords = [k.strip() for k in re.findall(r"`([^`]+)`", kw_part)]
                cur_sec = None
            elif ln.startswith("- **定義・意味・特徴**:") or ln.startswith("- **関連要素・補足**:"):
                cur_sec = None
            elif ln.startswith("  - **定義・意味**:"):
                cur_sec = "definition"
                sections[cur_sec].append(ln.split(":", 1)[1].strip())
            elif ln.startswith("  - **主な特徴**:"):
                cur_sec = "features"
                sections[cur_sec].append(ln.split(":", 1)[1].strip())
            elif ln.startswith("  - **関連ワード・試験ポイント**:"):
                cur_sec = "related"
                sections[cur_sec].append(ln.split(":", 1)[1].strip())
            elif re.match(r"^\s*-\s*\*\*よく間違いやすいポイント", ln):
                cur_sec = "pitfalls"
                sections[cur_sec].append(ln.split(":", 1)[1].strip())
            else:
                if cur_sec is not None:
                    sections[cur_sec].append(ln)

        title, alias_raw, aliases = split_heading(cur_entry["heading"])
        ch_num, ch_short, ch_sub = chapter_short(cur_entry["chapter"])
        if ch_num not in chapters_map:
            chapters_map[ch_num] = {
                "id": ch_num,
                "short": ch_short,
                "subtitle": ch_sub,
                "full": cur_entry["chapter"],
                "count": 0,
            }
        chapters_map[ch_num]["count"] += 1

        entry_obj = {
            "id": len(entries) + 1,
            "chapterId": ch_num,
            "chapterShort": ch_short,
            "chapterName": ch_sub,
            "heading": clean_heading_math(cur_entry["heading"]),
            "title": title,
            "aliasRaw": alias_raw,
            "aliases": aliases,
            "keywords": keywords,
            "definition": "\n".join(sections["definition"]).strip(),
            "features": "\n".join(sections["features"]).strip(),
            "related": "\n".join(sections["related"]).strip(),
            "pitfalls": "\n".join(sections["pitfalls"]).strip(),
        }
        entries.append(entry_obj)
        cur_entry = None

    for line in lines:
        if line.startswith("## （付録）"):
            flush_entry()
            in_appendix = True
            continue
        if in_appendix:
            if line.startswith("| **"):
                cols = [c.strip() for c in line.strip("|").split("|")]
                if len(cols) >= 4:
                    appendix.append(
                        {
                            "id": len(appendix) + 1,
                            "theme": re.sub(r"^\*\*|\*\*$", "", cols[0]).strip(),
                            "termA": cols[1],
                            "termB": cols[2],
                            "termC": "" if cols[3] in ("—", "-", "") else cols[3],
                        }
                    )
            continue

        if line.startswith("## "):
            flush_entry()
            cur_chapter = line[3:].strip()
        elif line.strip() == "---":
            flush_entry()
        elif line.startswith("#### "):
            flush_entry()
            cur_entry = {
                "chapter": cur_chapter,
                "heading": line[5:].strip(),
                "raw_lines": [],
            }
        elif cur_entry is not None:
            cur_entry["raw_lines"].append(line)

    flush_entry()
    chapters = [chapters_map[k] for k in sorted(chapters_map.keys())]
    return chapters, entries, appendix


def main():
    chapters, entries, appendix = parse_glossary(SOURCE_MD)
    assert len(entries) == 721, f"Expected 721 entries, got {len(entries)}"
    assert len(appendix) == 53, f"Expected 53 appendix rows, got {len(appendix)}"

    missing_fields = []
    for e in entries:
        for field in ("title", "definition", "features", "related", "pitfalls"):
            if not e[field]:
                missing_fields.append((e["id"], e["heading"], field))
        if not (4 <= len(e["keywords"]) <= 6):
            missing_fields.append((e["id"], e["heading"], f"keywords={len(e['keywords'])}"))

    if missing_fields:
        print("MISSING FIELDS:", missing_fields[:10])
        raise SystemExit(1)

    payload = {
        "meta": {
            "version": "第10版",
            "totalEntries": len(entries),
            "totalKeywords": sum(len(e["keywords"]) for e in entries),
            "totalAppendix": len(appendix),
            "source": "g_kentei_glossary.md",
        },
        "chapters": chapters,
        "entries": entries,
        "appendix": appendix,
    }

    json_path = os.path.join(DATA_DIR, "glossary-data.json")
    js_path = os.path.join(DATA_DIR, "glossary-data.js")

    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))

    with open(js_path, "w", encoding="utf-8") as f:
        f.write("window.GLOSSARY_DATA = ")
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")

    size_kb = os.path.getsize(js_path) / 1024
    print(f"SUCCESS: Parsed {len(entries)} entries, {payload['meta']['totalKeywords']} keywords, {len(appendix)} appendix rows")
    print(f"Chapters ({len(chapters)}): " + ", ".join(f"{c['short']}({c['count']})" for c in chapters))
    print(f"Wrote {js_path} ({size_kb:.1f} KB)")

    # Quick sanity test of CNN matching
    for q in ["C", "CN", "CNN"]:
        nq = normalize_search_text(q)
        title_hits = [
            e["title"]
            for e in entries
            if nq in normalize_search_text(e["heading"])
        ]
        all_hits = [
            e["title"]
            for e in entries
            if nq in normalize_search_text(
                e["heading"] + " " + " ".join(e["keywords"]) + " " + e["definition"] + " " + e["features"] + " " + e["related"] + " " + e["pitfalls"]
            )
        ]
        print(f"Query '{q}': heading hits={len(title_hits)} (top 5: {title_hits[:5]}), full hits={len(all_hits)}")


if __name__ == "__main__":
    main()
