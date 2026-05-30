// GitHub data fetch. V produkci jde přes Worker proxy (drží token serverside),
// lokálně/dev jde přímo proti veřejnému GitHub API (bez tokenu, nižší rate limit).

const META = document.querySelector('meta[name="ghcv-api-base"]');
const API_BASE = (META && META.content || '').replace(/\/$/, '');

// Když je nastavený Worker, voláme /api/github/...; jinak přímo api.github.com.
function ghUrl(path) {
  return API_BASE ? `${API_BASE}/api/github/${path}` : `https://api.github.com/${path}`;
}

async function ghJson(path) {
  const res = await fetch(ghUrl(path), { headers: { Accept: 'application/vnd.github+json' } });
  if (res.status === 404) throw new Error('Uživatel nenalezen.');
  if (res.status === 403) throw new Error('GitHub rate limit. Zkuste to za chvíli.');
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  return res.json();
}

// Agreguje jazyky z repozitářů (hrubě podle primary language + velikosti).
function aggregateLanguages(repos) {
  const tally = {};
  for (const r of repos) {
    if (r.language) tally[r.language] = (tally[r.language] || 0) + Math.max(1, r.stargazers_count) + 1;
  }
  return Object.entries(tally)
    .sort((a, b) => b[1] - a[1])
    .map(([lang]) => lang);
}

// Načte profil + veřejná repa. Filtruje forky, řadí podle hvězd a aktivity.
export async function fetchProfile(username) {
  const user = username.trim().replace(/^@/, '');
  if (!user) throw new Error('Zadejte username.');

  const [profile, reposRaw] = await Promise.all([
    ghJson(`users/${encodeURIComponent(user)}`),
    ghJson(`users/${encodeURIComponent(user)}/repos?per_page=100&sort=updated`),
  ]);

  const repos = reposRaw
    .filter((r) => !r.fork && !r.archived)
    .sort((a, b) => {
      const byStars = b.stargazers_count - a.stargazers_count;
      if (byStars) return byStars;
      return new Date(b.pushed_at) - new Date(a.pushed_at);
    })
    .slice(0, 8)
    .map((r) => ({
      name: r.name,
      description: r.description || '',
      stars: r.stargazers_count,
      forks: r.forks_count,
      language: r.language || '',
      topics: r.topics || [],
      url: r.html_url,
      pushed_at: r.pushed_at,
      homepage: r.homepage || '',
    }));

  return {
    login: profile.login,
    name: profile.name || profile.login,
    bio: profile.bio || '',
    company: profile.company || '',
    location: profile.location || '',
    blog: profile.blog || '',
    followers: profile.followers,
    following: profile.following,
    public_repos: profile.public_repos,
    avatar_url: profile.avatar_url,
    html_url: profile.html_url,
    languages: aggregateLanguages(repos),
    repos,
  };
}
