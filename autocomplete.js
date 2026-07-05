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
        const img   = getSmallImage(a.images);
        const genre = a.classifications?.[0]?.segment?.name || '';
        return `<div class="suggestion-item" data-name="${esc(a.name)}">
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
          input.value = this.dataset.name;
          hideSuggestions();
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
