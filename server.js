const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Pool } = require('pg');

// ---------- Налаштування ----------
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const DATABASE_URL = process.env.DATABASE_URL;

// Фіксований список запитів (порядок = порядок у формі та звіті)
const QUERIES = [
  'SEO продвижение',
  'Просування сайту',
  'Контекстна реклама',
  'Розкрутка сайту',
  'SMM просування',
];
const DEVICES = ['mobile', 'desktop'];
const MAX_POSITION = 30; // перевіряємо перші 3 сторінки видачі

// Обласні центри (без Луганська, Донецька, Сімферополя)
const CITIES = ['Вінниця', 'Дніпро', 'Житомир', 'Запоріжжя', 'Івано-Франківськ', 'Київ', 'Кропивницький', 'Луцьк', 'Львів', 'Миколаїв', 'Одеса', 'Полтава', 'Рівне', 'Суми', 'Тернопіль', 'Ужгород', 'Харків', 'Херсон', 'Хмельницький', 'Черкаси', 'Чернівці', 'Чернігів'];

if (!DATABASE_URL) {
  console.error('DATABASE_URL не задано. Додайте PostgreSQL у Railway і змінну DATABASE_URL.');
  process.exit(1);
}
if (!ADMIN_PASSWORD) {
  console.warn('УВАГА: ADMIN_PASSWORD не задано — сторінка статистики буде недоступна.');
}

const isLocal = /localhost|127\.0\.0\.1|\/var\/run/.test(DATABASE_URL);
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: isLocal || process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
});

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS submissions (
      id          SERIAL PRIMARY KEY,
      employee    TEXT NOT NULL,
      city        TEXT NOT NULL,
      comment     TEXT,
      user_agent  TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS results (
      id             SERIAL PRIMARY KEY,
      submission_id  INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
      device         TEXT NOT NULL CHECK (device IN ('mobile','desktop')),
      query          TEXT NOT NULL,
      position       INTEGER CHECK (position IS NULL OR position >= 1),
      url            TEXT
    );
    CREATE INDEX IF NOT EXISTS results_submission_idx ON results(submission_id);
    CREATE INDEX IF NOT EXISTS submissions_city_idx ON submissions(city, created_at DESC);
  `);
}

// ---------- App ----------
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '50kb' }));

// Basic Auth для статистики
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

app.get('/healthz', (_req, res) => res.send('ok'));

app.get('/api/config', (_req, res) => {
  res.json({ queries: QUERIES, cities: CITIES, maxPosition: MAX_POSITION });
});

// Прийом форми
app.post('/api/submit', async (req, res) => {
  const body = req.body || {};
  const employee = String(body.employee || '').trim().slice(0, 120);
  let city = String(body.city || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  const comment = String(body.comment || '').trim().slice(0, 1000) || null;

  if (!employee) return res.status(400).json({ error: 'Вкажіть ім’я' });
  // місто зі списку або вписане вручну («Інше місто»)
  const known = CITIES.find((c) => c.toLowerCase() === city.toLowerCase());
  if (known) city = known;
  else if (body.otherCity && /^[\p{L}][\p{L}\s'’ʼ.-]{1,59}$/u.test(city)) city = city.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (m, sep, ch) => sep + ch.toUpperCase()); // «кривий ріг» → «Кривий Ріг»
  else return res.status(400).json({ error: body.otherCity ? 'Вкажіть назву міста літерами' : 'Оберіть місто зі списку' });

  const rows = [];
  for (const device of DEVICES) {
    const block = (body.results || {})[device] || {};
    for (const q of QUERIES) {
      const item = block[q];
      if (!item) return res.status(400).json({ error: `Не заповнено: «${q}» (${device === 'mobile' ? 'мобільна' : 'ПК'})` });
      let position = null;
      if (!item.notFound) {
        const n = Number(item.position);
        if (!Number.isInteger(n) || n < 1 || n > MAX_POSITION) {
          return res.status(400).json({ error: `Невірна позиція для «${q}» (${device === 'mobile' ? 'мобільна' : 'ПК'})` });
        }
        position = n;
      }
      rows.push({ device, query: q, position });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [s] } = await client.query(
      'INSERT INTO submissions (employee, city, comment, user_agent) VALUES ($1,$2,$3,$4) RETURNING id',
      [employee, city, comment, String(req.headers['user-agent'] || '').slice(0, 300)]
    );
    for (const r of rows) {
      await client.query(
        'INSERT INTO results (submission_id, device, query, position) VALUES ($1,$2,$3,$4)',
        [s.id, r.device, r.query, r.position]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, id: s.id });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'Помилка збереження, спробуйте ще раз' });
  } finally {
    client.release();
  }
});

// ---------- Статистика ----------
async function loadAll() {
  const { rows } = await pool.query(`
    SELECT s.id, s.employee, s.city, s.comment, s.created_at,
           r.device, r.query, r.position
    FROM submissions s
    JOIN results r ON r.submission_id = s.id
    ORDER BY s.created_at DESC, r.id ASC
  `);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.id)) {
      map.set(r.id, {
        id: r.id, employee: r.employee, city: r.city, comment: r.comment,
        created_at: r.created_at, results: { mobile: {}, desktop: {} },
      });
    }
    map.get(r.id).results[r.device][r.query] = { position: r.position };
  }
  return [...map.values()];
}

app.get('/api/stats', requireAdmin, async (_req, res) => {
  try {
    res.json({ queries: QUERIES, maxPosition: MAX_POSITION, submissions: await loadAll() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'DB error' });
  }
});

app.delete('/api/submissions/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM submissions WHERE id = $1', [Number(req.params.id)]);
  res.json({ ok: true });
});

app.get('/api/export.csv', requireAdmin, async (_req, res) => {
  const subs = await loadAll();
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [['ID', 'Дата', 'Місто', 'Співробітник', 'Пристрій', 'Запит', 'Позиція', 'Коментар'].join(';')];
  for (const s of subs) {
    const date = new Date(s.created_at).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });
    for (const d of DEVICES) {
      for (const q of QUERIES) {
        const r = s.results[d][q] || {};
        lines.push([s.id, date, s.city, s.employee, d === 'mobile' ? 'Мобільна' : 'ПК', q,
          r.position == null ? `немає в ТОП-${MAX_POSITION}` : r.position, s.comment].map(esc).join(';'));
      }
    }
  }
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="elit-web-positions-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('﻿' + lines.join('\r\n'));
});

app.get('/stats', requireAdmin, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'stats.html')));
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

migrate()
  .then(() => app.listen(PORT, () => console.log(`Server on :${PORT}`)))
  .catch((e) => { console.error('Migration failed', e); process.exit(1); });
