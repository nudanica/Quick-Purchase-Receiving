/**
 * SURU Quick Purchase List — server
 *
 * ทำสองหน้าที่ในตัวเดียว
 *   POST /ai         ส่งต่อคำขออ่านฉลากไปยัง Anthropic โดยเก็บ API key ไว้ฝั่งนี้
 *   POST /sync       รับและส่งคืนรายการที่เปลี่ยนแปลง ให้ทุกเครื่องเห็นตรงกัน
 *   POST /photo/put  เก็บรูปสินค้า
 *   POST /photo/get  ดึงรูปสินค้าตามรายการ id
 *
 * การซิงก์ใช้หลัก last-write-wins ต่อหนึ่งรายการ เทียบจากเวลา updated
 * การลบไม่ได้ลบแถวจริง แต่ทำเครื่องหมาย deleted ไว้ เพื่อให้เครื่องอื่นรู้ว่าถูกลบแล้ว
 *
 * ต้องผูก D1 database ชื่อ DB และตั้งค่าตัวแปรเหล่านี้
 *   ANTHROPIC_API_KEY  (secret)  คีย์จาก console.anthropic.com — ไม่ใส่ก็ได้ถ้าไม่ใช้ AI
 *   APP_TOKEN          (secret)  รหัสผ่านที่ตั้งเอง ต้องตรงกับในหน้าตั้งค่าของแอป
 *   ALLOWED_ORIGIN     (variable) เช่น https://nudanica.github.io
 */

const ANTHROPIC = 'https://api.anthropic.com/v1/messages';
const ALLOWED_MODELS = ['claude-sonnet-5', 'claude-haiku-4-5'];
const MAX_BODY = 8 * 1024 * 1024;

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-App-Token',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    };
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json({ error: 'ใช้ได้เฉพาะ POST' }, 405);

    if (env.ALLOWED_ORIGIN) {
      const from = request.headers.get('Origin');
      if (from && from !== env.ALLOWED_ORIGIN) return json({ error: 'ต้นทางไม่ได้รับอนุญาต' }, 403);
    }
    if (env.APP_TOKEN && request.headers.get('X-App-Token') !== env.APP_TOKEN) {
      return json({ error: 'รหัสผ่านไม่ถูกต้อง' }, 401);
    }

    const raw = await request.text();
    if (raw.length > MAX_BODY) return json({ error: 'คำขอใหญ่เกินไป' }, 413);
    let body;
    try { body = JSON.parse(raw); } catch { return json({ error: 'อ่าน JSON ไม่ได้' }, 400); }

    const path = new URL(request.url).pathname.replace(/\/+$/, '');
    try {
      await ensureSchema(env);
      if (path === '/ai') return json(...(await handleAI(body, env)));
      if (path === '/sync') return json(await handleSync(body, env));
      if (path === '/photo/put') return json(await handlePhotoPut(body, env));
      if (path === '/photo/get') return json(await handlePhotoGet(body, env));
      return json({ error: 'ไม่พบปลายทางนี้' }, 404);
    } catch (err) {
      return json({ error: String(err && err.message || err) }, 500);
    }
  }
};

/* ---------- schema ---------- */
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS records (' +
      'id TEXT PRIMARY KEY, kind TEXT NOT NULL, trip TEXT NOT NULL, ' +
      'updated INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_trip_updated ON records(trip, updated)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS photos (' +
      'id TEXT PRIMARY KEY, trip TEXT NOT NULL, updated INTEGER NOT NULL, data TEXT NOT NULL)')
  ]);
  schemaReady = true;
}

/* ---------- sync ---------- */
async function handleSync(body, env) {
  const trip = String(body.trip || '').slice(0, 40);
  if (!trip) throw new Error('ไม่ได้ระบุทริป');
  const since = Number(body.since) || 0;
  const changes = Array.isArray(body.changes) ? body.changes.slice(0, 400) : [];

  if (changes.length) {
    const stmt = env.DB.prepare(
      'INSERT INTO records (id, kind, trip, updated, deleted, data) VALUES (?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET ' +
      'kind = excluded.kind, trip = excluded.trip, updated = excluded.updated, ' +
      'deleted = excluded.deleted, data = excluded.data ' +
      'WHERE excluded.updated > records.updated'
    );
    await env.DB.batch(changes.map(c => stmt.bind(
      String(c.id).slice(0, 60),
      ['trip', 'group', 'entry'].includes(c.kind) ? c.kind : 'entry',
      trip, Number(c.updated) || Date.now(), c.deleted ? 1 : 0,
      String(c.data || '{}').slice(0, 200000)
    )));
  }

  // เผื่อเวลาเครื่องแต่ละตัวไม่ตรงกัน ถอยหลังไปหนึ่งนาที
  const cursor = Math.max(0, since - 60000);
  const { results } = await env.DB
    .prepare('SELECT id, kind, updated, deleted, data FROM records ' +
             'WHERE trip = ? AND updated > ? ORDER BY updated LIMIT 800')
    .bind(trip, cursor).all();

  return { now: Date.now(), records: results || [] };
}

/* ---------- photos ---------- */
async function handlePhotoPut(body, env) {
  const id = String(body.id || '').slice(0, 60);
  const trip = String(body.trip || '').slice(0, 40);
  const data = String(body.data || '');
  if (!id || !trip || !data.startsWith('data:image/')) throw new Error('ข้อมูลรูปไม่ถูกต้อง');
  if (data.length > 900000) throw new Error('รูปใหญ่เกินไป');
  await env.DB.prepare(
    'INSERT INTO photos (id, trip, updated, data) VALUES (?, ?, ?, ?) ' +
    'ON CONFLICT(id) DO NOTHING'
  ).bind(id, trip, Date.now(), data).run();
  return { ok: true };
}

async function handlePhotoGet(body, env) {
  const ids = (Array.isArray(body.ids) ? body.ids : []).slice(0, 4).map(x => String(x).slice(0, 60));
  if (!ids.length) return { photos: {} };
  const marks = ids.map(() => '?').join(',');
  const { results } = await env.DB
    .prepare('SELECT id, data FROM photos WHERE id IN (' + marks + ')').bind(...ids).all();
  const photos = {};
  for (const row of results || []) photos[row.id] = row.data;
  return { photos };
}

/* ---------- AI ---------- */
async function handleAI(body, env) {
  if (!env.ANTHROPIC_API_KEY) return [{ error: 'ยังไม่ได้ตั้ง ANTHROPIC_API_KEY' }, 503];
  const payload = {
    model: ALLOWED_MODELS.includes(body.model) ? body.model : ALLOWED_MODELS[0],
    max_tokens: Math.min(Number(body.max_tokens) || 1000, 1000),
    messages: Array.isArray(body.messages) ? body.messages.slice(-1) : []
  };
  if (!payload.messages.length) return [{ error: 'ไม่มีข้อความให้ประมวลผล' }, 400];
  const r = await fetch(ANTHROPIC, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(payload)
  });
  return [await r.json(), r.status];
}
