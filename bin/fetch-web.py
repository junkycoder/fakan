#!/usr/bin/env python3
"""
fetch-web.py — stáhne web jako single-file HTML snapshot pro mindmapu fakan.cz.

Všechny CSS/JS/obrázky/fonty se zinlinují jako data: URIs.
3rd-party trackery (GA, GTM, FB pixel, Hotjar, segment, mixpanel, fullstory)
se vystřihnou. Service worker registrace odstraní.

Použití:
  python3 bin/fetch-web.py <URL> [target-dir]

Příklad:
  python3 bin/fetch-web.py https://imagineanything.cz projects/
"""
from __future__ import annotations

import argparse
import base64
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib import request
from urllib.parse import urljoin, urlparse

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 "
    "fakan-snapshot/1.0"
)
TIMEOUT = 20
MAX_ASSET = 10 * 1024 * 1024   # 10 MB / asset
MAX_HTML = 5 * 1024 * 1024     # 5 MB / HTML
MAX_CSS_DEPTH = 2

TRACKER_HOSTS = {
    "google-analytics.com",
    "googletagmanager.com",
    "facebook.net",
    "hotjar.com",
    "doubleclick.net",
    "googleadservices.com",
    "googlesyndication.com",
    "amazon-adsystem.com",
    "segment.com",
    "mxpnl.com",
    "mixpanel.com",
    "fullstory.com",
    "intercom.io",
    "intercomcdn.com",
}

REPO_ROOT = Path(__file__).resolve().parent.parent


def fetch(url: str, *, max_size: int = MAX_ASSET) -> tuple[bytes, str]:
    req = request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    with request.urlopen(req, timeout=TIMEOUT) as r:
        data = r.read(max_size + 1)
        if len(data) > max_size:
            raise ValueError(f"too large (>{max_size} B)")
        ct = r.headers.get_content_type() if hasattr(r.headers, "get_content_type") else "application/octet-stream"
        return data, ct


def to_data_uri(data: bytes, content_type: str) -> str:
    b64 = base64.b64encode(data).decode("ascii")
    return f"data:{content_type};base64,{b64}"


def host_of(url: str) -> str:
    h = (urlparse(url).hostname or "").lower()
    return h[4:] if h.startswith("www.") else h


def is_tracker(url: str) -> bool:
    host = host_of(url)
    if not host:
        return False
    for t in TRACKER_HOSTS:
        if host == t or host.endswith("." + t):
            return True
    return False


def remove_service_workers(js: str) -> str:
    return re.sub(
        r"navigator\s*\.\s*serviceWorker\s*\.\s*register\s*\([^)]*\)\s*;?",
        "/* fakan: serviceWorker.register removed */",
        js,
        flags=re.IGNORECASE,
    )


# Match jak `attr="x"` `attr='x'` tak `attr=x` (bez uvozovek, HTML 5 to dovoluje).
_ATTR_VALUE_RE_TMPL = r"\b{name}\s*=\s*(?:(['\"])([^'\"]*)\1|([^\s'\"<>`]+))"


def _replace_attr(attrs: str, name: str, new_value: str) -> str:
    safe = new_value.replace('"', "%22")

    def repl(m: re.Match[str]) -> str:
        return f'{name}="{safe}"'

    return re.sub(
        _ATTR_VALUE_RE_TMPL.format(name=name),
        repl,
        attrs,
        count=1,
        flags=re.IGNORECASE,
    )


def _find_attr(attrs: str, name: str) -> str | None:
    m = re.search(_ATTR_VALUE_RE_TMPL.format(name=name), attrs, re.IGNORECASE)
    if not m:
        return None
    return m.group(2) if m.group(2) is not None else m.group(3)


def _remove_attr(attrs: str, name: str) -> str:
    return re.sub(
        _ATTR_VALUE_RE_TMPL.format(name=name),
        "",
        attrs,
        flags=re.IGNORECASE,
    )


def inline_css(css: str, base_url: str, stats: dict, depth: int = 0) -> str:
    if depth > MAX_CSS_DEPTH:
        return css

    def repl_import(m: re.Match[str]) -> str:
        href = m.group(1) or m.group(2)
        if not href or href.startswith("data:"):
            return ""
        try:
            abs_u = urljoin(base_url, href)
            if is_tracker(abs_u):
                stats["skipped"] += 1
                return ""
            data, _ = fetch(abs_u)
            nested = data.decode("utf-8", errors="replace")
            stats["inlined"] += 1
            return inline_css(nested, abs_u, stats, depth + 1)
        except Exception as e:
            stats["failed"] += 1
            print(f"  skip @import {href}: {e}", file=sys.stderr)
            return ""

    css = re.sub(
        r"@import\s+(?:url\(\s*['\"]?([^'\")]+)['\"]?\s*\)|['\"]([^'\"]+)['\"])\s*[^;]*;",
        repl_import,
        css,
    )

    def repl_url(m: re.Match[str]) -> str:
        raw = m.group(1).strip().strip("'\"")
        if not raw or raw.startswith("data:") or raw.startswith("#"):
            return m.group(0)
        try:
            abs_u = urljoin(base_url, raw)
            if is_tracker(abs_u):
                stats["skipped"] += 1
                return m.group(0)
            data, ct = fetch(abs_u)
            stats["inlined"] += 1
            return f"url({to_data_uri(data, ct)})"
        except Exception as e:
            stats["failed"] += 1
            print(f"  skip url({raw}): {e}", file=sys.stderr)
            return m.group(0)

    return re.sub(r"url\(([^)]+)\)", repl_url, css)


def transform(html: str, base_url: str) -> tuple[str, dict]:
    stats = {"inlined": 0, "skipped": 0, "failed": 0}

    # <style> bloky — inline url() v jejich obsahu
    def style_repl(m: re.Match[str]) -> str:
        css = inline_css(m.group(2), base_url, stats)
        return f"<style{m.group(1)}>{css}</style>"

    html = re.sub(
        r"<style([^>]*)>(.*?)</style>",
        style_repl,
        html,
        flags=re.IGNORECASE | re.DOTALL,
    )

    # <script> — buď src= (inline JS), nebo s tělem (sanitize SW)
    def script_repl(m: re.Match[str]) -> str:
        attrs = m.group(1)
        body = m.group(2)
        src = _find_attr(attrs, "src")
        if src:
            try:
                abs_u = urljoin(base_url, src)
                if is_tracker(abs_u):
                    stats["skipped"] += 1
                    return ""
                data, _ = fetch(abs_u)
                js = data.decode("utf-8", errors="replace")
                js = remove_service_workers(js)
                js = js.replace("</script>", "<\\/script>")
                # Odstraň src=, zachovej zbytek atributů
                attrs2 = _remove_attr(attrs, "src")
                attrs2 = re.sub(r"\s+", " ", attrs2).rstrip()
                if attrs2 and not attrs2.startswith(" "):
                    attrs2 = " " + attrs2
                stats["inlined"] += 1
                return f"<script{attrs2}>{js}</script>"
            except Exception as e:
                stats["failed"] += 1
                print(f"  skip <script src={src}>: {e}", file=sys.stderr)
                return ""
        # inline JS bez src
        body2 = remove_service_workers(body)
        return f"<script{attrs}>{body2}</script>"

    html = re.sub(
        r"<script([^>]*)>(.*?)</script>",
        script_repl,
        html,
        flags=re.IGNORECASE | re.DOTALL,
    )

    # <link rel="...">
    def link_repl(m: re.Match[str]) -> str:
        attrs = m.group(1)
        rel = (_find_attr(attrs, "rel") or "").lower()
        href = _find_attr(attrs, "href")
        if not href:
            return m.group(0)
        if rel in {"preload", "prefetch", "dns-prefetch", "preconnect", "modulepreload", "manifest"}:
            stats["skipped"] += 1
            return ""
        try:
            abs_u = urljoin(base_url, href)
            if is_tracker(abs_u):
                stats["skipped"] += 1
                return ""
            data, ct = fetch(abs_u)
            if rel == "stylesheet" or rel.endswith(" stylesheet"):
                css = data.decode("utf-8", errors="replace")
                css = inline_css(css, abs_u, stats)
                stats["inlined"] += 1
                return f"<style>{css}</style>"
            if rel in {"icon", "shortcut icon", "apple-touch-icon", "apple-touch-icon-precomposed", "mask-icon"}:
                stats["inlined"] += 1
                return f"<link{_replace_attr(attrs, 'href', to_data_uri(data, ct))}>"
            return f"<link{_replace_attr(attrs, 'href', abs_u)}>"
        except Exception as e:
            stats["failed"] += 1
            print(f"  skip <link {href}>: {e}", file=sys.stderr)
            return ""

    html = re.sub(r"<link([^>]*?)/?>", link_repl, html, flags=re.IGNORECASE)

    # <img>, <source>, <video>, <audio>, <embed>, <track>, <object>
    def media_repl(m: re.Match[str]) -> str:
        tag = m.group(1)
        attrs = m.group(2)
        # vystřih srcset (multi-URL, příliš složitý pro MVP)
        attrs = _remove_attr(attrs, "srcset")
        for name in ("src", "data", "poster"):
            val = _find_attr(attrs, name)
            if not val or val.startswith("data:"):
                continue
            try:
                abs_u = urljoin(base_url, val)
                if is_tracker(abs_u):
                    stats["skipped"] += 1
                    continue
                data, ct = fetch(abs_u)
                attrs = _replace_attr(attrs, name, to_data_uri(data, ct))
                stats["inlined"] += 1
            except Exception as e:
                stats["failed"] += 1
                print(f"  skip <{tag} {name}={val}>: {e}", file=sys.stderr)
        return f"<{tag}{attrs}>"

    html = re.sub(
        r"<(img|source|video|audio|embed|object)([^>]*?)/?>",
        media_repl,
        html,
        flags=re.IGNORECASE,
    )

    # <iframe src> — neinlinuj, převeď na absolute (zachová cross-origin embed)
    def iframe_repl(m: re.Match[str]) -> str:
        attrs = m.group(1)
        src = _find_attr(attrs, "src")
        if src and not src.startswith(("data:", "javascript:", "about:")):
            attrs = _replace_attr(attrs, "src", urljoin(base_url, src))
        return f"<iframe{attrs}>"

    html = re.sub(r"<iframe([^>]*)>", iframe_repl, html, flags=re.IGNORECASE)

    # <a href> + <form action> + <area href> — převeď na absolute (kliky zachovají směr ven)
    def anchor_repl(m: re.Match[str]) -> str:
        tag = m.group(1)
        attrs = m.group(2)
        name = "action" if tag.lower() == "form" else "href"
        val = _find_attr(attrs, name)
        if val and not val.startswith(("#", "data:", "javascript:", "mailto:", "tel:", "sms:")):
            attrs = _replace_attr(attrs, name, urljoin(base_url, val))
        return f"<{tag}{attrs}>"

    html = re.sub(r"<(a|area|form)(\s[^>]*)>", anchor_repl, html, flags=re.IGNORECASE)

    # Injekce <base>, <meta name="fakan-snapshot-of">, <meta name="fakan-fetched-at"> do <head>
    fetched_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    inject = (
        f'\n<meta name="fakan-snapshot-of" content="{base_url}">\n'
        f'<meta name="fakan-fetched-at" content="{fetched_at}">\n'
        f'<base href="{base_url}">\n'
    )
    if re.search(r"<head[^>]*>", html, re.IGNORECASE):
        html = re.sub(
            r"(<head[^>]*>)",
            lambda mm: mm.group(1) + inject,
            html,
            count=1,
            flags=re.IGNORECASE,
        )
    else:
        html = inject + html

    return html, stats


def make_filename(url: str, target_dir: Path) -> Path:
    p = urlparse(url)
    host = (p.hostname or "page").lower()
    if host.startswith("www."):
        host = host[4:]
    path = p.path.strip("/")
    if path:
        slug = re.sub(r"[^a-z0-9._-]+", "-", path.lower()).strip("-")
        stem = f"{host}.{slug}" if slug else host
    else:
        stem = host
    candidate = target_dir / f"{stem}.html"
    n = 1
    while candidate.exists():
        candidate = target_dir / f"{stem}.{n}.html"
        n += 1
    return candidate


def decode_html(data: bytes) -> str:
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        m = re.search(rb"<meta[^>]+charset=['\"]?([\w-]+)", data, re.IGNORECASE)
        enc = m.group(1).decode("ascii", errors="replace") if m else "latin-1"
        try:
            return data.decode(enc, errors="replace")
        except LookupError:
            return data.decode("latin-1", errors="replace")


def main() -> int:
    ap = argparse.ArgumentParser(description="Stáhne web jako single-file HTML snapshot.")
    ap.add_argument("url", help="URL ke stažení (např. https://example.com)")
    ap.add_argument("target_dir", nargs="?", default=".", help="cílový adresář (default: aktuální)")
    args = ap.parse_args()

    url = args.url.strip()
    if not url.startswith(("http://", "https://")):
        url = "https://" + url

    target_dir = Path(args.target_dir).resolve()
    if not target_dir.is_dir():
        print(f"target dir nenalezen: {target_dir}", file=sys.stderr)
        return 2

    print(f"fetching {url} ...", file=sys.stderr)
    try:
        html_bytes, _ = fetch(url, max_size=MAX_HTML)
    except Exception as e:
        print(f"chyba: {e}", file=sys.stderr)
        return 1

    html = decode_html(html_bytes)
    html, stats = transform(html, url)

    out = make_filename(url, target_dir)
    out.write_text(html, encoding="utf-8")

    size_kb = out.stat().st_size / 1024
    try:
        rel = out.relative_to(REPO_ROOT)
    except ValueError:
        rel = out
    print(
        f"wrote {rel} ({size_kb:.0f} KB, "
        f"{stats['inlined']} inlined, {stats['skipped']} skipped, {stats['failed']} failed)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
