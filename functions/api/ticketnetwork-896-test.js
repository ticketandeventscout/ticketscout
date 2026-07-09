// Temporary test endpoint to inspect catalog 896 CSV columns and sample rows
// GET /api/ticketnetwork-896-test
// REMOVE after diagnosis

export async function onRequestGet({ request, env }) {
  const owner = env.GITHUB_OWNER;
  const repo  = env.GITHUB_REPO;
  const feedUrl = `https://raw.githubusercontent.com/${owner}/${repo}/main/public/ticketnetwork-feed-896.csv.gz`;

  try {
    const resp = await fetch(feedUrl);
    if (!resp.ok) return json({ error: `HTTP ${resp.status}`, hint: 'Commit public/ticketnetwork-feed-896.csv.gz first' }, 200);

    const ds      = new DecompressionStream('gzip');
    const body    = resp.body.pipeThrough(ds);
    const reader  = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let   text    = '';

    // Read just enough to get headers + 3 rows
    while (text.length < 50000) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
      if (text.split('\n').length > 5) break;
    }
    await reader.cancel().catch(() => {});

    const lines   = text.split('\n').filter(l => l.trim());
    const header  = parseCSV(lines[0]);
    const row1    = lines[1] ? parseCSV(lines[1]) : [];
    const row2    = lines[2] ? parseCSV(lines[2]) : [];

    // Map first 3 rows as objects
    const sample = [row1, row2].map(row =>
      Object.fromEntries(header.map((h, i) => [h, row[i] || '']))
    );

    return json({ columns: header, columnCount: header.length, sample }, 200);
  } catch(e) {
    return json({ error: String(e) }, 500);
  }
}

function parseCSV(line) {
  const result = [];
  let current = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i+1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current); current = '';
    } else { current += ch; }
  }
  result.push(current);
  return result;
}

function json(body, status) {
  return new Response(JSON.stringify(body, null, 2), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}