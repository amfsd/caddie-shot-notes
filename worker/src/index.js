// Caddie Shot Notes relay: receives tips from the page and writes them to Notion.
// Secrets/vars (set in Cloudflare, never in this repo):
//   NOTION_TOKEN        Notion internal integration secret (wrangler secret put NOTION_TOKEN)
//   NOTION_DATA_SOURCE  data source id of the "Caddie Shot Notes" database (wrangler.toml)
//   ALLOWED_ORIGINS     comma-separated origins allowed to post (wrangler.toml)

const NOTION = 'https://api.notion.com/v1';
const NOTION_VERSION = '2025-09-03';
const MAX_IMAGES = 10;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const RATING = { 5: '5 Great', 4: '4 Good', 3: '3 OK with issues', 2: '2 Poor decision', 1: '1 Makes score worse' };

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const okOrigin = allowed.includes(origin);
    const cors = okOrigin ? {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    } : {};
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors } });

    if (req.method === 'OPTIONS') return new Response(null, { status: okOrigin ? 204 : 403, headers: cors });
    const path = new URL(req.url).pathname;
    if (req.method === 'GET' && path === '/') return new Response('Caddie Shot Notes relay is running.', { status: 200 });
    if (!okOrigin) return reply(403, { error: 'origin_not_allowed' });
    if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
    if (!env.NOTION_TOKEN || !env.NOTION_DATA_SOURCE) return reply(500, { error: 'relay_not_configured' });

    let body;
    try { body = await req.json(); } catch { return reply(400, { error: 'bad_json' }); }
    const roundId = clip(body.roundId, 64);
    if (!/^[a-zA-Z0-9-]{8,64}$/.test(roundId)) return reply(400, { error: 'bad_round_id' });

    const notion = (method, url, json) => notionCall(env, method, url, json);

    try {
      if (path === '/tip') {
        const tipNo = Number(body.tip);
        if (!Number.isInteger(tipNo) || tipNo < 1 || tipNo > 500) return reply(400, { error: 'bad_tip_number' });
        const m = body.meta || {}, r = body.row || {};
        const images = Array.isArray(body.images) ? body.images.slice(0, MAX_IMAGES) : [];

        const files = [];
        for (let k = 0; k < images.length; k++) {
          const f = await uploadImage(env, images[k], `${roundId}-tip${tipNo}-${k + 1}.jpg`);
          if (f) files.push(f);
        }

        const stars = Math.max(0, Math.min(5, parseInt(r.stars, 10) || 0));
        const hole = parseInt(r.hole, 10);
        const title = [r.hole ? `Hole ${clip(r.hole, 10)}` : '', r.shot ? `Shot ${clip(r.shot, 20)}` : ''].filter(Boolean).join(' · ') || `Tip ${tipNo}`;
        const date = /^\d{4}-\d{2}-\d{2}$/.test(m.date || '') ? { start: m.date } : null;
        const props = {
          'Tip': { title: text(title) },
          'Tester': { rich_text: text(clip(m.tester, 200)) },
          'Course': { rich_text: text(clip(m.course, 200)) },
          'Round date': { date },
          'Tees': { rich_text: text(clip(m.tees, 100)) },
          'App build': { rich_text: text(clip(m.build, 100)) },
          'Hole': { number: Number.isFinite(hole) ? hole : null },
          'Shot': { rich_text: text(clip(r.shot, 100)) },
          'Stars': { number: stars || null },
          'Rating': { select: { name: RATING[stars] || 'Not rated' } },
          'Notes': { rich_text: text(clip(r.notes, 1900)) },
          'Screenshots': { files },
          'Round ID': { rich_text: text(roundId) },
          'Tip #': { number: tipNo },
        };

        const existing = await findTips(notion, env, roundId, tipNo);
        let page;
        if (existing.length) {
          page = await notion('PATCH', `/pages/${existing[0].id}`, { properties: props });
          for (const extra of existing.slice(1)) await notion('PATCH', `/pages/${extra.id}`, { in_trash: true });
        } else {
          page = await notion('POST', '/pages', { parent: { type: 'data_source_id', data_source_id: env.NOTION_DATA_SOURCE }, properties: props });
        }
        return reply(200, { ok: true, url: page.url, screenshots: files.length, screenshotsDropped: images.length - files.length });
      }

      if (path === '/prune') {
        const keep = new Set((Array.isArray(body.keep) ? body.keep : []).map(Number));
        const all = await findTips(notion, env, roundId, null);
        let removed = 0;
        for (const p of all) {
          const n = p.properties?.['Tip #']?.number;
          if (!keep.has(n)) { await notion('PATCH', `/pages/${p.id}`, { in_trash: true }); removed++; }
        }
        return reply(200, { ok: true, removed });
      }

      return reply(404, { error: 'not_found' });
    } catch (e) {
      return reply(502, { error: 'notion_error', detail: String(e.message || e).slice(0, 300) });
    }
  },
};

function clip(v, n) { return String(v ?? '').slice(0, n); }
function text(s) { return s ? [{ type: 'text', text: { content: s } }] : []; }

async function notionCall(env, method, url, json) {
  const res = await fetch(NOTION + url, {
    method,
    headers: { 'Authorization': `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
    body: json ? JSON.stringify(json) : undefined,
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${out.code || ''} ${out.message || ''}`);
  return out;
}

async function findTips(notion, env, roundId, tipNo) {
  const and = [{ property: 'Round ID', rich_text: { equals: roundId } }];
  if (tipNo != null) and.push({ property: 'Tip #', number: { equals: tipNo } });
  const out = await notion('POST', `/data_sources/${env.NOTION_DATA_SOURCE}/query`, { filter: { and }, page_size: 100 });
  return out.results || [];
}

// dataUrl (image/jpeg or png) -> Notion file upload, returns a files-property entry or null
async function uploadImage(env, dataUrl, filename) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
  if (bytes.length > MAX_IMAGE_BYTES) return null;
  const created = await notionCall(env, 'POST', '/file_uploads', { mode: 'single_part', filename, content_type: m[1] });
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: m[1] }), filename);
  const res = await fetch(`${NOTION}/file_uploads/${created.id}/send`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': NOTION_VERSION },
    body: form,
  });
  if (!res.ok) return null;
  return { type: 'file_upload', file_upload: { id: created.id }, name: filename };
}
