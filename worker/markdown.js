// Minimální Markdown → HTML parser pro server-side rendering.
//
// Žádné externí závislosti — Cloudflare Worker bundle musí být kompaktní.
// Podporuje to, co potřebujeme pro renderování README.md / CHANGELOG.md
// z blendid repa: headings, paragrafy, bold/italic/code inline, code bloky,
// seznamy, blockquoty, odkazy, obrázky, HR, frontmatter stripping.
//
// Není to plně CommonMark — záměrně. Pokud později začne vadit, vyměnit za
// `marked` nebo `markdown-it` (oba jsou worker-friendly).

const HTML_ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPE[c]);
}

// Strip YAML frontmatter (--- ... ---) ze začátku, vrátí { meta, body }.
function stripFrontmatter(src) {
  const m = src.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: src };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
    if (k) meta[k] = v;
  }
  return { meta, body: src.slice(m[0].length) };
}

// Inline render: bold, italic, code, links, images. Vstup už je escaped HTML.
function renderInline(text) {
  // Code spans nejdřív — uvnitř už se nic dalšího nerenderuje.
  // Placeholder substituce, ať bold/italic v `code` nematchují.
  const codes = [];
  text = text.replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(c);
    return `\x00CODE${codes.length - 1}\x00`;
  });

  // Images ![alt](url)
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_, alt, url, title) => {
    const t = title ? ` title="${esc(title)}"` : '';
    return `<img src="${esc(url)}" alt="${esc(alt)}"${t} loading="lazy">`;
  });

  // Links [text](url)
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_, label, url, title) => {
    const t = title ? ` title="${esc(title)}"` : '';
    const safe = /^(https?:|mailto:|#|\/)/i.test(url) ? url : '#';
    return `<a href="${esc(safe)}"${t}>${label}</a>`;
  });

  // Bare URLs <http://...>
  text = text.replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, (_, url) => `<a href="${esc(url)}">${esc(url)}</a>`);

  // Bold ** **
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  // Italic * * (nesmí kolidovat s **; ** už pryč)
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  // Underscore italic _foo_
  text = text.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');

  // Strikethrough ~~ ~~
  text = text.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

  // Vrátit code spans zpět
  text = text.replace(/\x00CODE(\d+)\x00/g, (_, i) => `<code>${esc(codes[+i])}</code>`);

  return text;
}

// Slug z heading textu pro #anchor. Z markdown raw textu vytáhne jen
// "viditelné" — alt text z obrázků, label z odkazů, code obsah.
function slug(s) {
  return String(s)
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')   // image → alt
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')    // link → label
    .replace(/`([^`]+)`/g, '$1')                // strip backticks
    .replace(/[*_~]/g, '')                       // strip emphasis
    .replace(/<[^>]+>/g, '')                     // strip HTML
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80);
}

// Block-level parser. Vstup = celý dokument, výstup = HTML string.
function renderBlocks(src) {
  const lines = src.split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank line — přeskočit
    if (!line.trim()) { i++; continue; }

    // Fenced code block ```lang
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      const lang = fence[1];
      i++;
      const code = [];
      while (i < lines.length && !lines[i].startsWith('```')) {
        code.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      const cls = lang ? ` class="lang-${esc(lang)}"` : '';
      out.push(`<pre><code${cls}>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }

    // ATX heading # Foo
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) {
      const level = h[1].length;
      const text = renderInline(esc(h[2]));
      const id = slug(h[2]);
      out.push(`<h${level} id="${id}">${text}</h${level}>`);
      i++;
      continue;
    }

    // Setext heading — Foo\n===
    if (i + 1 < lines.length && /^=+\s*$/.test(lines[i + 1])) {
      out.push(`<h1 id="${slug(line)}">${renderInline(esc(line.trim()))}</h1>`);
      i += 2;
      continue;
    }
    if (i + 1 < lines.length && /^-+\s*$/.test(lines[i + 1]) && line.trim()) {
      out.push(`<h2 id="${slug(line)}">${renderInline(esc(line.trim()))}</h2>`);
      i += 2;
      continue;
    }

    // Horizontal rule
    if (/^(\s*[-*_]){3,}\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith('>')) {
      const quote = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        quote.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${renderBlocks(quote.join('\n'))}</blockquote>`);
      continue;
    }

    // List (- * +, nebo 1.)
    const listMatch = line.match(/^(\s*)([-*+]|\d+\.)\s+(.+)/);
    if (listMatch) {
      const ordered = /^\d/.test(listMatch[2]);
      const tag = ordered ? 'ol' : 'ul';
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+\.)\s+(.+)/);
        if (!m) {
          // Continuation lines (indented) přilepit k poslednímu itemu.
          if (items.length && lines[i].match(/^\s{2,}\S/)) {
            items[items.length - 1] += '\n' + lines[i].replace(/^\s+/, '');
            i++;
            continue;
          }
          if (!lines[i].trim()) { i++; continue; }
          break;
        }
        items.push(m[3]);
        i++;
      }
      const html = items.map((it) => `<li>${renderInline(esc(it))}</li>`).join('');
      out.push(`<${tag}>${html}</${tag}>`);
      continue;
    }

    // Tabulka | a | b |
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[i + 1])) {
      const header = splitRow(line);
      i += 2; // skip separator
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      const th = header.map((c) => `<th>${renderInline(esc(c))}</th>`).join('');
      const trs = rows.map((r) => `<tr>${r.map((c) => `<td>${renderInline(esc(c))}</td>`).join('')}</tr>`).join('');
      out.push(`<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`);
      continue;
    }

    // Paragraph — sebrat dokud nepřijde blank line nebo blokový element.
    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i], lines[i + 1])) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p>${renderInline(esc(para.join('\n')))}</p>`);
  }

  return out.join('\n');
}

function splitRow(line) {
  const t = line.trim().replace(/^\||\|$/g, '');
  return t.split('|').map((c) => c.trim());
}

function isBlockStart(line, next) {
  if (!line) return false;
  if (/^#{1,6}\s/.test(line)) return true;
  if (/^```/.test(line)) return true;
  if (/^(\s*[-*_]){3,}\s*$/.test(line)) return true;
  if (/^>/.test(line)) return true;
  if (/^(\s*)([-*+]|\d+\.)\s+/.test(line)) return true;
  if (next && /^=+\s*$/.test(next)) return true;
  if (next && /^-+\s*$/.test(next)) return true;
  return false;
}

// Veřejné API.
export function renderMarkdown(src) {
  const { meta, body } = stripFrontmatter(src);
  const html = renderBlocks(body);
  return { meta, html };
}
