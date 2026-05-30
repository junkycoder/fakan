// Kompaktní markdown → HTML renderer pro náhled. Žádné závislosti.
// Pozn.: vstup je escapován, takže náhled nevykreslí surové HTML z AI odpovědi.

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Inline: code, obrázky, odkazy, bold, italic.
function inline(s) {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_, alt, url) => `<img alt="${alt}" src="${esc(url)}">`);
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_, txt, url) => `<a href="${esc(url)}" target="_blank" rel="noopener">${txt}</a>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/\b_([^_]+)_\b/g, '<em>$1</em>');
  return t;
}

function tableRow(line) {
  return line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
}

export function renderMarkdown(src) {
  const lines = (src || '').replace(/\r\n/g, '\n').split('\n');
  let html = '';
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // code fence
    if (/^```/.test(line)) {
      let buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++; // zavírací fence
      html += `<pre><code>${esc(buf.join('\n'))}</code></pre>`;
      continue;
    }

    // hr
    if (/^(\s*[-*_]){3,}\s*$/.test(line)) { html += '<hr>'; i++; continue; }

    // heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { const n = h[1].length; html += `<h${n}>${inline(h[2])}</h${n}>`; i++; continue; }

    // blockquote
    if (/^>\s?/.test(line)) {
      let buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      html += `<blockquote>${inline(buf.join(' '))}</blockquote>`;
      continue;
    }

    // table (header | --- | rows)
    if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && /-/.test(lines[i + 1])) {
      const head = tableRow(line);
      i += 2;
      let rows = '';
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) {
        rows += '<tr>' + tableRow(lines[i]).map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>';
        i++;
      }
      html += `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
      continue;
    }

    // unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      let buf = '';
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        buf += `<li>${inline(lines[i].replace(/^\s*[-*+]\s+/, ''))}</li>`;
        i++;
      }
      html += `<ul>${buf}</ul>`;
      continue;
    }

    // ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      let buf = '';
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        buf += `<li>${inline(lines[i].replace(/^\s*\d+\.\s+/, ''))}</li>`;
        i++;
      }
      html += `<ol>${buf}</ol>`;
      continue;
    }

    // blank
    if (!line.trim()) { i++; continue; }

    // paragraph (slepí po sobě jdoucí ne-blokové řádky)
    let buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|>|```|\s*[-*+]\s|\s*\d+\.\s|(\s*[-*_]){3,}\s*$)/.test(lines[i])) {
      buf.push(lines[i++]);
    }
    html += `<p>${inline(buf.join(' '))}</p>`;
  }

  return html;
}
