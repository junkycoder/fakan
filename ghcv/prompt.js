// Sestaví prompt na míru z GitHub dat + uživatelských nastavení.
// Jádro celého nástroje: kreativní psaní necháváme na AI uživatele,
// my dodáme bohatý, strukturovaný kontext a jasné instrukce.

function repoLine(r) {
  const meta = [];
  if (r.language) meta.push(r.language);
  if (r.stars) meta.push(`★ ${r.stars}`);
  if (r.topics && r.topics.length) meta.push(r.topics.slice(0, 4).join(', '));
  const tail = meta.length ? ` — ${meta.join(' · ')}` : '';
  const desc = r.description ? `: ${r.description}` : '';
  return `- ${r.name}${desc}${tail} (${r.url})`;
}

export function buildPrompt(profile, opts) {
  const o = opts || {};
  const lang = o.lang || 'čeština';
  const tone = o.tone || 'profesionální, ale lidský';
  const tagline = (o.tagline || '').trim();
  const website = (o.website || profile.blog || '').trim();
  const stack = (o.stack || profile.languages.slice(0, 6).join(', ')).trim();
  const wantBadges = o.badges !== false;
  const allowEmoji = !!o.emoji;

  const topRepos = profile.repos.map(repoLine).join('\n') || '- (žádná veřejná repa)';

  const facts = [
    `- Jméno: ${profile.name}`,
    `- GitHub: @${profile.login} (${profile.html_url})`,
    profile.bio && `- Bio na GitHubu: ${profile.bio}`,
    profile.company && `- Firma: ${profile.company}`,
    profile.location && `- Lokace: ${profile.location}`,
    `- Veřejných repozitářů: ${profile.public_repos}, sledujících: ${profile.followers}`,
    profile.languages.length && `- Hlavní jazyky/technologie (dle repozitářů): ${profile.languages.join(', ')}`,
    website && `- Web/portfolio: ${website}`,
    tagline && `- Vlastní tagline: ${tagline}`,
    stack && `- Preferovaný stack k vyzdvižení: ${stack}`,
  ].filter(Boolean).join('\n');

  return `Jsi zkušený technický copywriter. Napiš mi GitHub profile README (soubor README.md do repozitáře "${profile.login}/${profile.login}", který se zobrazuje nahoře na profilu).

JAZYK: ${lang}.
TÓN: ${tone}.
DÉLKA: stručné, k věci, dobře skenovatelné. Žádná marketingová klišé ani vata.
EMOJI: ${allowEmoji ? 'použij střídmě, kde dávají smysl' : 'nepoužívej žádné emoji'}.

O MNĚ (zdrojová data z GitHubu — fakta neměň, nevymýšlej si):
${facts}

MÉ NEJLEPŠÍ PROJEKTY:
${topRepos}

POŽADAVKY NA STRUKTURU README:
1. Výrazný nadpis se jménem a jednou silnou větou (taglinem), kdo jsem a co dělám.
2. Krátký odstavec „o mně" — čím se zabývám, na čem mi záleží, případně lokace.
3. Sekce "Tech stack" — přehledně klíčové technologie${wantBadges ? ' jako odznaky přes https://img.shields.io/ (styl flat-square, konzistentní barvy)' : ''}.
4. Sekce "Vybrané projekty" — 3 až 5 nejlepších repozitářů z dat výše, u každého výstižný jednořádkový popis a odkaz. Vybírej podle relevance, ne jen podle hvězd.
${wantBadges ? '5. GitHub statistiky přes https://github-readme-stats.vercel.app/api?username=' + profile.login + ' a jazykovou kartu (top-langs). Použij oficiální URL parametry.\n6.' : '5.'} Kontakt / odkazy${website ? ` — včetně ${website}` : ''} a profil ${profile.html_url}.

PRAVIDLA:
- Vrať POUZE obsah README.md jako čistý Markdown, nic navíc (žádný komentář před ani za).
- Žádné vymyšlené projekty, čísla ani zkušenosti — drž se dodaných dat.
- Odkazy musí být funkční (použij URL z dat výše).
- Markdown musí být validní a vykreslitelný na GitHubu.`;
}
