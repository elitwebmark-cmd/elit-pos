const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Pool } = require('pg');

// ---------- Налаштування ----------
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const DATABASE_URL = process.env.DATABASE_URL;

// Запити за замовчуванням для першого прогону. Далі запити кожного прогону
// зберігаються в базі й редагуються в адмінці (/admin).
const DEFAULT_QUERIES = [
  'SEO продвижение',
  'Просування сайту',
  'Контекстна реклама',
  'Розкрутка сайту',
  'SMM просування',
];
const DEVICES = ['mobile', 'desktop'];
const MAX_POSITION = 30; // перевіряємо перші 3 сторінки видачі
const MAX_QUERIES = 30;

// Обласні центри (без Луганська, Донецька, Сімферополя). Інші міста співробітник вписує вручну.
const CITIES = ['Вінниця', 'Дніпро', 'Житомир', 'Запоріжжя', 'Івано-Франківськ', 'Київ', 'Кропивницький', 'Луцьк', 'Львів', 'Миколаїв', 'Одеса', 'Полтава', 'Рівне', 'Суми', 'Тернопіль', 'Ужгород', 'Харків', 'Херсон', 'Хмельницький', 'Черкаси', 'Чернівці', 'Чернігів'];

const MONTHS = ['Січень', 'Лютий', 'Березень', 'Квітень', 'Травень', 'Червень', 'Липень', 'Серпень', 'Вересень', 'Жовтень', 'Листопад', 'Грудень'];
function monthLabel(date) {
  const d = new Date(new Date(date).toLocaleString('en-US', { timeZone: 'Europe/Kyiv' }));
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

if (!DATABASE_URL) {
  console.error('DATABASE_URL не задано. Додайте PostgreSQL у Railway і змінну DATABASE_URL.');
  process.exit(1);
}
if (!ADMIN_PASSWORD) {
  console.warn('УВАГА: ADMIN_PASSWORD не задано — статистика та адмінка будуть недоступні.');
}

const isLocal = /localhost|127\.0\.0\.1|\/var\/run/.test(DATABASE_URL);
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: isLocal || process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
});

// ---------- Міграція ----------
// Безпечна для наявних даних: відповіді, зібрані до появи прогонів, стають «Прогоном 1».
async function migrate() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(7311001)');
    await c.query(`
      CREATE TABLE IF NOT EXISTS runs (
        id          SERIAL PRIMARY KEY,
        name        TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','closed')),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        opened_at   TIMESTAMPTZ,
        closed_at   TIMESTAMPTZ
      );
      -- одночасно може бути відкритий лише один прогін
      CREATE UNIQUE INDEX IF NOT EXISTS runs_one_active ON runs ((status)) WHERE status = 'active';

      CREATE TABLE IF NOT EXISTS run_queries (
        id      SERIAL PRIMARY KEY,
        run_id  INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        query   TEXT NOT NULL,
        sort    INTEGER NOT NULL DEFAULT 0,
        UNIQUE (run_id, query)
      );

      CREATE TABLE IF NOT EXISTS submissions (
        id          SERIAL PRIMARY KEY,
        employee    TEXT NOT NULL,
        city        TEXT NOT NULL,
        comment     TEXT,
        user_agent  TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      ALTER TABLE submissions ADD COLUMN IF NOT EXISTS run_id INTEGER REFERENCES runs(id) ON DELETE CASCADE;

      CREATE TABLE IF NOT EXISTS results (
        id             SERIAL PRIMARY KEY,
        submission_id  INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
        device         TEXT NOT NULL CHECK (device IN ('mobile','desktop')),
        query          TEXT NOT NULL,
        position       INTEGER CHECK (position IS NULL OR position >= 1)
      );
      CREATE INDEX IF NOT EXISTS results_submission_idx ON results(submission_id);
      CREATE INDEX IF NOT EXISTS submissions_run_idx ON submissions(run_id, created_at DESC);
    `);

    const { rows: [orphans] } = await c.query(
      'SELECT count(*)::int AS n, min(created_at) AS first FROM submissions WHERE run_id IS NULL'
    );
    const { rows: [{ n: runCount }] } = await c.query('SELECT count(*)::int AS n FROM runs');

    if (runCount > 0 && orphans.n > 0) {
      // Відповіді без прогону, що прийшли під час оновлення від старої версії, — у поточний прогін
      await c.query(`UPDATE submissions SET run_id = (SELECT id FROM runs ORDER BY (status = 'active') DESC, id DESC LIMIT 1) WHERE run_id IS NULL`);
    } else if (runCount === 0) {
      // Перше коло (або чиста база): створюємо відкритий «Прогін 1» із поточними запитами,
      // щоб після оновлення форма працювала як раніше
      const startedAt = orphans.first || new Date();
      const { rows: [run] } = await c.query(
        `INSERT INTO runs (name, status, created_at, opened_at) VALUES ($1, 'active', $2, $2) RETURNING id`,
        [`Прогін 1 · ${monthLabel(startedAt)}`, startedAt]
      );
      let queries = DEFAULT_QUERIES;
      if (orphans.n > 0) {
        const { rows } = await c.query(
          `SELECT DISTINCT r.query FROM results r JOIN submissions s ON s.id = r.submission_id WHERE s.run_id IS NULL`
        );
        const used = rows.map((r) => r.query);
        queries = [...DEFAULT_QUERIES.filter((q) => used.includes(q)), ...used.filter((q) => !DEFAULT_QUERIES.includes(q))];
        await c.query('UPDATE submissions SET run_id = $1 WHERE run_id IS NULL', [run.id]);
        console.log(`Міграція: ${orphans.n} відповідей перенесено в прогін #${run.id}`);
      }
      await insertQueries(c, run.id, queries);
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

async function insertQueries(c, runId, queries) {
  await c.query('DELETE FROM run_queries WHERE run_id = $1', [runId]);
  for (let i = 0; i < queries.length; i++) {
    await c.query('INSERT INTO run_queries (run_id, query, sort) VALUES ($1,$2,$3)', [runId, queries[i], i]);
  }
}

async function getRunQueries(runId, c = pool) {
  const { rows } = await c.query('SELECT query FROM run_queries WHERE run_id = $1 ORDER BY sort, id', [runId]);
  return rows.map((r) => r.query);
}

async function getActiveRun(c = pool) {
  const { rows: [run] } = await c.query("SELECT id, name, opened_at FROM runs WHERE status = 'active'");
  return run || null;
}

// ---------- Допоміжне ----------
function cleanQueries(input) {
  const list = (Array.isArray(input) ? input : String(input || '').split('\n'))
    .map((q) => String(q).trim().replace(/\s+/g, ' ').slice(0, 150))
    .filter(Boolean);
  const seen = new Set();
  return list.filter((q) => { const k = q.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

// «кривий ріг» → «Кривий Ріг»; міста зі списку — у канонічному написанні
function normalizeCity(raw, allowOther) {
  const city = String(raw || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  const known = CITIES.find((c) => c.toLowerCase() === city.toLowerCase());
  if (known) return known;
  if (allowOther && /^[\p{L}][\p{L}\s'’ʼ.-]{1,59}$/u.test(city)) {
    return city.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (m, sep, ch) => sep + ch.toUpperCase());
  }
  return null;
}

// ---------- App ----------
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '50kb' }));

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) return res.status(503).send('ADMIN_PASSWORD не налаштовано');
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const pass = decoded.slice(decoded.indexOf(':') + 1);
    const a = Buffer.from(pass);
    const b = Buffer.from(ADMIN_PASSWORD);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="elit-web stats", charset="UTF-8"');
  res.status(401).send('Потрібна авторизація');
}

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(e);
  res.status(500).json({ error: 'Помилка сервера, спробуйте ще раз' });
});

app.get('/healthz', (_req, res) => res.send('ok'));

// ---------- Форма ----------
app.get('/api/config', wrap(async (_req, res) => {
  const run = await getActiveRun();
  res.json({
    run: run ? { id: run.id, name: run.name } : null,
    queries: run ? await getRunQueries(run.id) : [],
    cities: CITIES,
    maxPosition: MAX_POSITION,
  });
}));

app.post('/api/submit', wrap(async (req, res) => {
  const body = req.body || {};
  const run = await getActiveRun();
  if (!run) return res.status(409).json({ error: 'Зараз перевірка не проводиться. Дочекайтесь нового прогону.', code: 'no_run' });
  if (Number(body.runId) !== run.id) {
    return res.status(409).json({ error: `Відкрито новий прогін «${run.name}». Оновіть сторінку і заповніть форму ще раз.`, code: 'run_changed' });
  }
  const queries = await getRunQueries(run.id);

  const employee = String(body.employee || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  const comment = String(body.comment || '').trim().slice(0, 1000) || null;
  if (!employee) return res.status(400).json({ error: 'Вкажіть ім’я' });
  const city = normalizeCity(body.city, !!body.otherCity);
  if (!city) return res.status(400).json({ error: body.otherCity ? 'Вкажіть назву міста літерами' : 'Оберіть місто зі списку' });

  const rows = [];
  for (const device of DEVICES) {
    const block = (body.results || {})[device] || {};
    for (const q of queries) {
      const item = block[q];
      const label = device === 'mobile' ? 'мобільна' : 'ПК';
      if (!item) return res.status(400).json({ error: `Не заповнено: «${q}» (${label})` });
      let position = null;
      if (!item.notFound) {
        const n = Number(item.position);
        if (!Number.isInteger(n) || n < 1 || n > MAX_POSITION) return res.status(400).json({ error: `Невірна позиція для «${q}» (${label})` });
        position = n;
      }
      rows.push({ device, query: q, position });
    }
  }

  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows: [s] } = await c.query(
      'INSERT INTO submissions (run_id, employee, city, comment, user_agent) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [run.id, employee, city, comment, String(req.headers['user-agent'] || '').slice(0, 300)]
    );
    for (const r of rows) {
      await c.query('INSERT INTO results (submission_id, device, query, position) VALUES ($1,$2,$3,$4)', [s.id, r.device, r.query, r.position]);
    }
    await c.query('COMMIT');
    res.json({ ok: true, id: s.id });
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}));

// ---------- Прогони (адмінка) ----------
async function listRuns() {
  const { rows } = await pool.query(`
    SELECT r.id, r.name, r.status, r.created_at, r.opened_at, r.closed_at,
           COALESCE(json_agg(q.query ORDER BY q.sort, q.id) FILTER (WHERE q.id IS NOT NULL), '[]') AS queries,
           (SELECT count(*)::int FROM submissions s WHERE s.run_id = r.id) AS submissions,
           (SELECT count(DISTINCT s.city)::int FROM submissions s WHERE s.run_id = r.id) AS cities
    FROM runs r LEFT JOIN run_queries q ON q.run_id = r.id
    GROUP BY r.id
    ORDER BY r.id DESC
  `);
  return rows;
}

app.get('/api/runs', requireAdmin, wrap(async (_req, res) => {
  res.json({ runs: await listRuns(), defaultName: `Прогін ${(await pool.query('SELECT count(*)::int n FROM runs')).rows[0].n + 1} · ${monthLabel(new Date())}` });
}));

async function openRun(c, id) {
  await c.query("UPDATE runs SET status = 'closed', closed_at = now() WHERE status = 'active' AND id <> $1", [id]);
  await c.query("UPDATE runs SET status = 'active', opened_at = COALESCE(opened_at, now()), closed_at = NULL WHERE id = $1", [id]);
}

app.post('/api/runs', requireAdmin, wrap(async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 100);
  const queries = cleanQueries(req.body.queries);
  if (!name) return res.status(400).json({ error: 'Вкажіть назву прогону' });
  if (!queries.length) return res.status(400).json({ error: 'Додайте хоча б один запит' });
  if (queries.length > MAX_QUERIES) return res.status(400).json({ error: `Не більше ${MAX_QUERIES} запитів` });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows: [run] } = await c.query("INSERT INTO runs (name, status) VALUES ($1, 'draft') RETURNING id", [name]);
    await insertQueries(c, run.id, queries);
    if (req.body.open) await openRun(c, run.id);
    await c.query('COMMIT');
    res.json({ ok: true, id: run.id });
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}));

app.patch('/api/runs/:id', requireAdmin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { rows: [run] } = await pool.query('SELECT id FROM runs WHERE id = $1', [id]);
  if (!run) return res.status(404).json({ error: 'Прогін не знайдено' });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim().slice(0, 100);
      if (!name) { await c.query('ROLLBACK'); return res.status(400).json({ error: 'Назва не може бути порожньою' }); }
      await c.query('UPDATE runs SET name = $1 WHERE id = $2', [name, id]);
    }
    if (req.body.queries !== undefined) {
      const queries = cleanQueries(req.body.queries);
      const { rows: [{ n }] } = await c.query('SELECT count(*)::int n FROM submissions WHERE run_id = $1', [id]);
      if (n > 0) { await c.query('ROLLBACK'); return res.status(409).json({ error: 'У прогоні вже є відповіді, тому запити змінити не можна. Створіть новий прогін.' }); }
      if (!queries.length) { await c.query('ROLLBACK'); return res.status(400).json({ error: 'Додайте хоча б один запит' }); }
      if (queries.length > MAX_QUERIES) { await c.query('ROLLBACK'); return res.status(400).json({ error: `Не більше ${MAX_QUERIES} запитів` }); }
      await insertQueries(c, id, queries);
    }
    await c.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}));

app.post('/api/runs/:id/open', requireAdmin, wrap(async (req, res) => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await openRun(c, Number(req.params.id));
    await c.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}));

app.post('/api/runs/:id/close', requireAdmin, wrap(async (req, res) => {
  await pool.query("UPDATE runs SET status = 'closed', closed_at = now() WHERE id = $1 AND status = 'active'", [Number(req.params.id)]);
  res.json({ ok: true });
}));

app.delete('/api/runs/:id', requireAdmin, wrap(async (req, res) => {
  await pool.query('DELETE FROM runs WHERE id = $1', [Number(req.params.id)]);
  res.json({ ok: true });
}));

// ---------- Статистика ----------
async function loadSubmissions(runId) {
  const { rows } = await pool.query(`
    SELECT s.id, s.run_id, s.employee, s.city, s.comment, s.created_at,
           r.device, r.query, r.position
    FROM submissions s
    JOIN results r ON r.submission_id = s.id
    WHERE ($1::int IS NULL OR s.run_id = $1)
    ORDER BY s.created_at DESC, r.id ASC
  `, [runId || null]);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.id)) {
      map.set(r.id, {
        id: r.id, run_id: r.run_id, employee: r.employee, city: r.city, comment: r.comment,
        created_at: r.created_at, results: { mobile: {}, desktop: {} },
      });
    }
    map.get(r.id).results[r.device][r.query] = { position: r.position };
  }
  return [...map.values()];
}

app.get('/api/stats', requireAdmin, wrap(async (_req, res) => {
  const runs = (await listRuns()).map(({ id, name, status, opened_at, closed_at, created_at, queries }) => ({ id, name, status, opened_at, closed_at, created_at, queries }));
  res.json({ maxPosition: MAX_POSITION, runs, submissions: await loadSubmissions(null) });
}));

app.patch('/api/submissions/:id', requireAdmin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const employee = String(req.body.employee || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  const city = normalizeCity(req.body.city, true);
  if (!employee) return res.status(400).json({ error: 'Вкажіть ім’я' });
  if (!city) return res.status(400).json({ error: 'Вкажіть назву міста літерами' });
  await pool.query('UPDATE submissions SET employee = $1, city = $2 WHERE id = $3', [employee, city, id]);
  res.json({ ok: true, employee, city });
}));

app.delete('/api/submissions/:id', requireAdmin, wrap(async (req, res) => {
  await pool.query('DELETE FROM submissions WHERE id = $1', [Number(req.params.id)]);
  res.json({ ok: true });
}));

app.get('/api/export.csv', requireAdmin, wrap(async (req, res) => {
  const runId = req.query.run ? Number(req.query.run) : null;
  const runs = await listRuns();
  const runById = new Map(runs.map((r) => [r.id, r]));
  const subs = await loadSubmissions(runId);
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [['Прогін', 'ID', 'Дата', 'Місто', 'Співробітник', 'Пристрій', 'Запит', 'Позиція', 'Коментар'].join(';')];
  for (const s of subs) {
    const run = runById.get(s.run_id);
    const date = new Date(s.created_at).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });
    for (const d of DEVICES) {
      for (const q of run ? run.queries : Object.keys(s.results[d])) {
        const r = s.results[d][q];
        if (!r) continue;
        lines.push([run ? run.name : '', s.id, date, s.city, s.employee, d === 'mobile' ? 'Мобільна' : 'ПК', q,
          r.position == null ? `немає в ТОП-${MAX_POSITION}` : r.position, s.comment].map(esc).join(';'));
      }
    }
  }
  const suffix = runId && runById.get(runId) ? `run${runId}` : 'all';
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="elit-web-positions-${suffix}-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('﻿' + lines.join('\r\n'));
}));

// ---------- Сторінки ----------
app.get(['/stats', '/stats.html'], requireAdmin, (_req, res) => res.sendFile(path.join(__dirname, 'views', 'stats.html')));
app.get(['/admin', '/admin.html'], requireAdmin, (_req, res) => res.sendFile(path.join(__dirname, 'views', 'admin.html')));
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

migrate()
  .then(() => app.listen(PORT, () => console.log(`Server on :${PORT}`)))
  .catch((e) => { console.error('Migration failed', e); process.exit(1); });
