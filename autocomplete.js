// ===========================
// TicketScout — Shared search autocomplete
// Works on any page that has:
//   - An input with id="search-input"
//   - A div with id="search-suggestions"
//   - A handleSearch() function defined
// ===========================

// Works when loaded normally (DOMContentLoaded) AND when re-appended by page stubs
// Using IIFE so it runs immediately regardless of document ready state
(function initAutocomplete() {
  const input       = document.getElementById('search-input');
  const suggestions = document.getElementById('search-suggestions');
  if (!input || !suggestions) return;

  let debounceTimer = null;
  let lastQuery     = '';

  input.addEventListener('input', function() {
    const query = this.value.trim();
    clearTimeout(debounceTimer);
    if (query.length < 3) { hideSuggestions(); return; }
    if (query === lastQuery) return;
    lastQuery = query;
    debounceTimer = setTimeout(() => fetchSuggestions(query), 300);
  });

  input.addEventListener('keydown', function(e) {
    const items  = suggestions.querySelectorAll('.suggestion-item');
    const active = suggestions.querySelector('.suggestion-item.active');

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!active) { items[0]?.classList.add('active'); }
      else { active.classList.remove('active'); (active.nextElementSibling || items[0])?.classList.add('active'); }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!active) { items[items.length-1]?.classList.add('active'); }
      else { active.classList.remove('active'); (active.previousElementSibling || items[items.length-1])?.classList.add('active'); }
    } else if (e.key === 'Escape') {
      hideSuggestions();
    } else if (e.key === 'Enter' && active) {
      e.preventDefault();
      e.stopPropagation();
      input.value = active.dataset.name;
      hideSuggestions();
      setTimeout(() => { if (typeof handleSearch === 'function') handleSearch(); }, 0);
    }
  });

  document.addEventListener('click', function(e) {
    if (!input.contains(e.target) && !suggestions.contains(e.target)) hideSuggestions();
  });

  async function fetchSuggestions(query) {
    try {
      const resp = await fetch(`/api/attractions?keyword=${encodeURIComponent(query)}&size=6`);
      if (!resp.ok) return;
      const data        = await resp.json();
      const attractions = (data._embedded?.attractions || [])
        .filter(a => !isTribute(a.name))
        .slice(0, 6);

      if (attractions.length === 0) { hideSuggestions(); return; }

      suggestions.innerHTML = attractions.map(a => {
        const img     = getSmallImage(a.images);
        const genre   = a.classifications?.[0]?.segment?.name || '';
        const segment = a.classifications?.[0]?.segment?.name || '';
        const tmId    = a.id || '';
        return `<div class="suggestion-item" data-name="${esc(a.name)}" data-segment="${esc(segment)}" data-tmid="${esc(tmId)}">
          ${img
            ? `<img src="${img}" alt="" style="width:36px;height:36px;object-fit:cover;border-radius:4px;flex-shrink:0;" />`
            : `<div style="width:36px;height:36px;background:#e8f2fc;border-radius:4px;flex-shrink:0;display:flex;align-items:center;justify-content:center;"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#1a6fc4" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div>`
          }
          <div style="flex:1;min-width:0;">
            <div style="font-size:13px;font-weight:600;color:#1a1a1a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(a.name)}</div>
            ${genre ? `<div style="font-size:11px;color:#888;">${escHtml(genre)}</div>` : ''}
          </div>
        </div>`;
      }).join('');

      suggestions.querySelectorAll('.suggestion-item').forEach(item => {
        item.addEventListener('mouseenter', function() {
          suggestions.querySelectorAll('.suggestion-item').forEach(i => i.classList.remove('active'));
          this.classList.add('active');
        });
        item.addEventListener('click', function() {
          const name    = this.dataset.name;
          const segment = (this.dataset.segment || '').toLowerCase();
          hideSuggestions();

          // Normalise name to slug — handle umlauts and special chars
          const slug = normaliseToSlug(name);

          // Route sports directly to football page, bypass handleSearch slug issues
          if (segment === 'sports') {
            // Check alias map first, then fall back to normalised slug
            const footballSlug = FOOTBALL_SLUG_ALIASES[slug] || slug;
            window.location.href = '/football/' + footballSlug;
            return;
          }

          input.value = name;
          setTimeout(() => { if (typeof handleSearch === 'function') handleSearch(); }, 0);
        });
      });

      suggestions.style.display = 'block';
    } catch(err) {
      console.warn('Autocomplete error:', err);
      hideSuggestions();
    }
  }

  function hideSuggestions() {
    suggestions.style.display = 'none';
    suggestions.innerHTML    = '';
    lastQuery = '';
  }

  function getSmallImage(images) {
    if (!images?.length) return null;
    const small = images.find(img => img.ratio === '1_1' && img.width <= 100);
    if (small) return small.url;
    return images.sort((a, b) => (a.width || 999) - (b.width || 999))[0]?.url || null;
  }

  function isTribute(name) {
    return ['tribute', 'ultimate', 'salute', 'legacy', 'experience']
      .some(kw => (name || '').toLowerCase().includes(kw));
  }

  function esc(str)     { return (str||'').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
  function escHtml(str) { return (str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
})()

// Normalise a TM attraction name to a URL slug — handles umlauts, CF/FC suffixes
function normaliseToSlug(name) {
  return (name || '')
    .replace(/\s*\([^)]*\)\s*/g, '')
    .replace(/[äÄ]/g, 'a').replace(/[öÖ]/g, 'o').replace(/[üÜ]/g, 'u')
    .replace(/[éèêë]/g, 'e').replace(/[àâ]/g, 'a').replace(/[îï]/g, 'i')
    .replace(/[ùûú]/g, 'u').replace(/[ñ]/g, 'n').replace(/[ç]/g, 'c')
    .replace(/\s+(CF|FC)$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
}

// Map TM attraction names (normalised) to our actual football page slugs
// Handles cases where TM name differs from our slug
const FOOTBALL_SLUG_ALIASES = {
  'fc-bayern-munchen': 'bayern-munich',
  'fc-barcelona': 'fc-barcelona',
  'real-madrid': 'real-madrid',
  'atletico-de-madrid': 'atletico-madrid',
  'paris-saint-germain': 'paris-saint-germain',
  'fc-internazionale-milano': 'inter-milan',
  'inter-milan': 'inter-milan',
  'ac-milan': 'ac-milan',
  'juventus-fc': 'juventus',
  'ssc-napoli': 'napoli',
  'as-roma': 'as-roma',
  'ss-lazio': 'lazio',
  'atalanta-bc': 'atalanta',
  'acf-fiorentina': 'fiorentina',
  'afc-ajax': 'ajax',
  'psv-eindhoven': 'psv-eindhoven',
  'sl-benfica': 'benfica',
  'sporting-cp': 'sporting-cp',
  'fc-porto': 'porto',
  'olympique-de-marseille': 'olympique-marseille',
  'olympique-lyonnais': 'olympique-lyonnais',
  'bayer-04-leverkusen': 'bayer-leverkusen',
  'rb-leipzig': 'rb-leipzig',
  'eintracht-frankfurt': 'eintracht-frankfurt',
  'vfb-stuttgart': 'vfb-stuttgart',
  'borussia-monchengladbach': 'borussia-monchengladbach',
  '1-fc-union-berlin': 'union-berlin',
  'fsv-mainz-05': 'fsv-mainz-05',
  'rcd-espanyol': 'espanyol',
  'rcd-mallorca': 'mallorca',
  'ud-las-palmas': 'las-palmas',
  'ca-osasuna': 'osasuna',
  'real-valladolid': 'real-valladolid',
  'real-betis': 'real-betis',
  'villarreal-cf': 'villarreal',
  'athletic-club': 'athletic-bilbao',
  'celta-de-vigo': 'celta-vigo',
  'getafe-cf': 'getafe',
  'deportivo-alaves': 'alaves',
  'stade-rennais-fc': 'stade-rennais',
  'losc-lille': 'lille-osc',
  'rc-strasbourg-alsace': 'rc-strasbourg',
  'stade-brestois-29': 'stade-brestois',
};
