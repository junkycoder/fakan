#!/usr/bin/env python3
# Projde aktuální adresář a vyrobí tree.json pro mindmapu fakan.cz.
# .md soubory: parsuje YAML frontmatter (title, slug) + tělo jako content.
# Ostatní soubory: jen filename, bez obsahu.
# Použití: python3 bin/gen-tree.py
# Spouštět z rootu repa.

from __future__ import annotations

import fnmatch
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Patterny pro skrývání čte z `.fokrc` v rootu (glob na jméno entry, "!" = výjimka).
# Bez `.fokrc` použij minimální fallback — dot files + Python cache.
FOKRC = ROOT / ".fokrc"
FALLBACK_PATTERNS = [(".*", False), ("__pycache__", False)]


def load_patterns() -> list[tuple[str, bool]]:
    if not FOKRC.exists():
        return FALLBACK_PATTERNS
    out: list[tuple[str, bool]] = []
    for line in FOKRC.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        neg = line.startswith("!")
        if neg:
            line = line[1:].strip()
        out.append((line, neg))
    return out


def is_hidden(name: str, patterns: list[tuple[str, bool]]) -> bool:
    hidden = False
    for pat, neg in patterns:
        if fnmatch.fnmatch(name, pat):
            hidden = not neg
    return hidden

FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n(.*)$", re.DOTALL)


def parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    """Vrátí (frontmatter_dict, body). Bez závislosti na pyyaml — jen `key: value`."""
    m = FRONTMATTER_RE.match(text)
    if not m:
        return {}, text
    fm_text, body = m.group(1), m.group(2)
    fm: dict[str, str] = {}
    for line in fm_text.split("\n"):
        line = line.strip()
        if not line or ":" not in line:
            continue
        key, _, val = line.partition(":")
        val = val.strip()
        if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
            val = val[1:-1]
        fm[key.strip()] = val
    return fm, body.lstrip("\n")


TEXT_EXTENSIONS = {
    ".md", ".html", ".css", ".js", ".json", ".txt", ".sh", ".py",
    ".ts", ".tsx", ".yaml", ".yml", ".toml",
}


def make_file_node(entry: Path) -> dict:
    name = entry.name
    ext = entry.suffix.lower()
    is_md = ext == ".md"
    is_text = ext in TEXT_EXTENSIONS or name.startswith(".")

    node = {
        "name": name,
        "type": "file",
        "kind": "md" if is_md else ("text" if is_text else "other"),
        "filename": name,
    }

    if is_text:
        try:
            text = entry.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            text = ""
        if is_md:
            fm, body = parse_frontmatter(text)
            node["slug"] = fm.get("slug") or entry.stem
            node["title"] = fm.get("title") or ""
            node["content"] = body  # markdown body (po frontmatteru)
            node["raw"] = text       # surový text souboru včetně frontmatteru
        else:
            node["content"] = text
            node["raw"] = text

    return node


def walk(path: Path, patterns: list[tuple[str, bool]], depth: int = 0, max_depth: int = 4) -> dict:
    node: dict = {"name": path.name or "fakan.cz", "type": "dir"}
    if depth >= max_depth:
        node["children"] = []
        return node

    try:
        entries = sorted(path.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
    except PermissionError:
        entries = []

    children = []
    for entry in entries:
        if is_hidden(entry.name, patterns):
            continue
        if entry.is_dir():
            children.append(walk(entry, patterns, depth + 1, max_depth))
        else:
            children.append(make_file_node(entry))

    node["children"] = children
    return node


def main() -> int:
    patterns = load_patterns()
    tree = walk(ROOT, patterns)
    tree["name"] = "fakan.cz"
    out = ROOT / "tree.json"
    out.write_text(json.dumps(tree, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {out.relative_to(ROOT)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
