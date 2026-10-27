# Перевірка позицій elit-web.ua по містах

Форма для співробітників у різних містах + закрита сторінка статистики. Усі відповіді пишуться в одну базу PostgreSQL.

- `/` — форма (посилання для співробітників)
- `/stats` — статистика (логін будь-який, пароль = `ADMIN_PASSWORD`)
- `/api/export.csv` — вивантаження всіх відповідей для Excel

Запити зашиті в `server.js` (масив `QUERIES`), список міст — масив `CITIES`.

## Деплой на Railway

1. Створіть репозиторій на GitHub і запуште туди цю папку:
   ```bash
   git init && git add . && git commit -m "init"
   git branch -M main
   git remote add origin git@github.com:<you>/elit-positions.git
   git push -u origin main
   ```
2. Railway → **New Project → Deploy from GitHub repo** → оберіть репозиторій.
3. У проєкті натисніть **+ Create → Database → PostgreSQL**.
4. Відкрийте сервіс застосунку → **Variables** і додайте:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (посилання на змінну бази)
   - `ADMIN_PASSWORD` = ваш пароль для статистики
5. **Settings → Networking → Generate Domain** — отримаєте адресу на кшталт `elit-positions.up.railway.app`.

Таблиці створюються автоматично при першому запуску.

## Локальний запуск

```bash
npm install
DATABASE_URL=postgres://user:pass@localhost:5432/elit ADMIN_PASSWORD=secret npm start
```

## Як рахується статистика

- **Останній запис по місту** (за замовчуванням) — якщо з міста надіслали кілька разів, береться найсвіжіший.
- **Середнє** — середня позиція по всіх записах міста за обраний період.
- «Немає в ТОП‑30» (перевіряються перші 3 сторінки) не входить у середню позицію, але враховується в частці ТОП‑10.
