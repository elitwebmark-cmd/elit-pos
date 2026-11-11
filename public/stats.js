(function () {
  const DEV = ['mobile', 'desktop'];
  const $ = (id) => document.getElementById(id);
  const STATUS = { active: 'відкритий', draft: 'чернетка', closed: 'закритий' };
  const DIFF = 5; // розбіжність між співробітниками одного міста, позицій

  let data = null;
  let runsById = new Map();
  let runsWithData = [];      // прогони з відповідями, від старого до нового
  const openRows = new Set();
  let pendingDel = null;
  let cmpTouched = false;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (d) => new Date(d).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const fmtDay = (d) => (d ? new Date(d).toLocaleDateString('uk-UA', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', year: 'numeric' }) : '');
  const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  const fmtNum = (v) => (v == null ? '—' : Number.isInteger(v) ? String(v) : v.toFixed(1));
  const normName = (n) => String(n || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const plural = (n, one, few, many) => {
    const m10 = n % 10, m100 = n % 100;
    return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  };

  function bucket(v) {
    if (v == null) return 'b5';
    if (v <= 3) return 'b1';
    if (v <= 10) return 'b2';
    if (v <= 20) return 'b3';
    return 'b4';
  }
  const chip = (v, diff) => `<span class="pos-chip ${bucket(v)}${diff ? ' diff' : ''}"${diff ? ' title="Розбіжність між співробітниками цього міста"' : ''}>${v == null ? '×' : fmtNum(v)}</span>`;

  // зміна позиції: додатне число = покращення (позиція стала ближчою до 1)
  function deltaPos(cur, prev) {
    if (cur === undefined || prev === undefined) return '';
    if (cur == null && prev == null) return '';
    if (prev == null) return '<span class="delta up" title="Минулого разу не було в ТОП‑30">нове</span>';
    if (cur == null) return '<span class="delta down" title="Минулого разу був у ТОП‑30">випав</span>';
    const d = Math.round((prev - cur) * 10) / 10;
    if (d === 0) return '<span class="delta same">=</span>';
    return d > 0 ? `<span class="delta up">↑${fmtNum(d)}</span>` : `<span class="delta down">↓${fmtNum(-d)}</span>`;
  }
  function deltaPp(cur, prev) {
    if (cur == null || prev == null) return '';
    const d = Math.round(cur - prev);
    if (d === 0) return '<span class="delta same">= без змін</span>';
    return d > 0 ? `<span class="delta up">↑${d} п.п.</span>` : `<span class="delta down">↓${-d} п.п.</span>`;
  }

  // ---------- Обчислення ----------
  // співробітник у місті -> позиції (останній запис або середнє по його записах)
  function perPerson(subs, Q, mode) {
    const groups = new Map();
    for (const s of subs) {
      const key = s.city + '|' + normName(s.employee);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s); // відсортовано: новіші першими
    }
    const out = [];
    for (const list of groups.values()) {
      const row = { city: list[0].city, employee: list[0].employee, count: list.length, last: list[0], mobile: {}, desktop: {} };
      for (const d of DEV) {
        for (const q of Q) {
          if (mode === 'latest') row[d][q] = list[0].results[d][q]?.position ?? null;
          else row[d][q] = mean(list.map((s) => s.results[d][q]?.position).filter((v) => v != null));
        }
      }
      out.push(row);
    }
    return out.sort((a, b) => a.city.localeCompare(b.city, 'uk') || a.employee.localeCompare(b.employee, 'uk'));
  }

  // місто -> середнє по співробітниках міста (кожне місто важить однаково)
  function perCity(people, Q) {
    const groups = new Map();
    for (const p of people) {
      if (!groups.has(p.city)) groups.set(p.city, []);
      groups.get(p.city).push(p);
    }
    return [...groups].map(([city, list]) => {
      const row = { city, people: list, mobile: {}, desktop: {} };
      for (const d of DEV) for (const q of Q) row[d][q] = mean(list.map((p) => p[d][q]).filter((v) => v != null));
      return row;
    }).sort((a, b) => a.city.localeCompare(b.city, 'uk'));
  }

  const cache = new Map();
  function compute(runId) {
    const mode = $('mode').value;
    const key = runId + '|' + mode;
    if (cache.has(key)) return cache.get(key);
    const run = runsById.get(runId);
    const Q = run.queries;
    const subs = data.submissions.filter((s) => s.run_id === runId);
    const people = perPerson(subs, Q, mode);
    const cities = perCity(people, Q);
    const res = { run, Q, subs, people, cities, cityMap: new Map(cities.map((c) => [c.city, c])) };
    cache.set(key, res);
    return res;
  }

  // зведені показники по набору міст і запитів
  function summarize(cities, Q) {
    const out = {};
    for (const d of DEV) {
      const vals = [];
      let top10 = 0, found = 0, cells = 0;
      for (const c of cities) for (const q of Q) {
        cells++;
        const v = c[d][q];
        if (v != null) { vals.push(v); found++; if (v <= 10) top10++; }
      }
      out[d] = { avg: mean(vals), top10: cells ? (top10 / cells) * 100 : null, found: cells ? (found / cells) * 100 : null, foundN: found, top10N: top10, cells };
    }
    const cells = out.mobile.cells + out.desktop.cells;
    out.top10All = cells ? ((out.mobile.top10N + out.desktop.top10N) / cells) * 100 : null;
    return out;
  }

  function isDiff(list, d, q) {
    if (list.length < 2) return false;
    const vals = list.map((p) => p[d][q]);
    const found = vals.filter((v) => v != null);
    if (found.length && found.length < vals.length) return true;
    return found.length > 1 && Math.max(...found) - Math.min(...found) >= DIFF;
  }

  // ---------- Завантаження ----------
  async function load() {
    const res = await fetch('/api/stats', { credentials: 'same-origin' });
    if (!res.ok) { $('subtitle').textContent = 'Немає доступу або помилка сервера.'; return; }
    data = await res.json();
    cache.clear();
    runsById = new Map(data.runs.map((r) => [r.id, r]));
    const withData = new Set(data.submissions.map((s) => s.run_id));
    runsWithData = data.runs.filter((r) => withData.has(r.id)).sort((a, b) => a.id - b.id);
    fillSelects();
    render();
  }

  function fillSelects() {
    const runSel = $('run');
    const wanted = Number(runSel.value) || Number(new URLSearchParams(location.search).get('run'));
    const counts = new Map();
    data.submissions.forEach((s) => counts.set(s.run_id, (counts.get(s.run_id) || 0) + 1));
    runSel.innerHTML = data.runs.map((r) => `<option value="${r.id}">${esc(r.name)}${r.status === 'active' ? ' · відкритий' : ''} (${counts.get(r.id) || 0})</option>`).join('');
    const active = data.runs.find((r) => r.status === 'active');
    const fallback = (active && counts.get(active.id) ? active : runsWithData[runsWithData.length - 1]) || active || data.runs[0];
    if (wanted && runsById.has(wanted)) runSel.value = wanted;
    else if (fallback) runSel.value = fallback.id;
    fillCompare();

    const qs = [];
    runsWithData.forEach((r) => r.queries.forEach((q) => { if (!qs.includes(q)) qs.push(q); }));
    const cq = $('chartQuery').value;
    $('chartQuery').innerHTML = '<option value="__all">Усі запити</option>' + qs.map((q) => `<option>${esc(q)}</option>`).join('');
    if (cq && (cq === '__all' || qs.includes(cq))) $('chartQuery').value = cq;
  }

  function fillCompare() {
    const runId = Number($('run').value);
    const prevVal = Number($('cmp').value);
    const options = runsWithData.filter((r) => r.id !== runId).slice().reverse();
    $('cmp').innerHTML = '<option value="">Без порівняння</option>' + options.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('');
    const prevRun = runsWithData.filter((r) => r.id < runId).pop();
    if (cmpTouched && (prevVal === 0 || options.some((r) => r.id === prevVal))) $('cmp').value = prevVal || '';
    else $('cmp').value = prevRun ? prevRun.id : '';
  }

  // ---------- Рендер ----------
  function render() {
    if (!data || !data.runs.length) { $('subtitle').textContent = 'Прогонів ще немає. Створіть перший у розділі «Прогони».'; return; }
    const runId = Number($('run').value);
    const cmpId = Number($('cmp').value) || null;
    const cur = compute(runId);
    const prev = cmpId ? compute(cmpId) : null;
    const Q = cur.Q;
    const url = new URL(location.href);
    url.searchParams.set('run', runId);
    history.replaceState(null, '', url);
    $('csvRun').href = `/api/export.csv?run=${runId}`;

    const r = cur.run;
    const period = r.opened_at ? `${fmtDay(r.opened_at)} – ${r.status === 'active' ? 'зараз' : fmtDay(r.closed_at)}` : 'ще не відкривався';
    $('subtitle').textContent = `${r.name} · ${STATUS[r.status]} · ${period} · ${Q.length} ${plural(Q.length, 'запит', 'запити', 'запитів')}` +
      (prev ? ` · порівняння з «${prev.run.name}»` : '');
    $('deltaKey').hidden = !prev;

    // спільні міста й запити — щоб зміна не залежала від того, які міста перевірили
    const Qc = prev ? Q.filter((q) => prev.Q.includes(q)) : [];
    const Cc = prev ? cur.cities.filter((c) => prev.cityMap.has(c.city)).map((c) => c.city) : [];
    const sCur = summarize(cur.cities, Q);
    const dCur = prev ? summarize(cur.cities.filter((c) => Cc.includes(c.city)), Qc) : null;
    const dPrev = prev ? summarize(prev.cities.filter((c) => Cc.includes(c.city)), Qc) : null;
    const cmpNote = prev ? ` title="Зміна по ${Cc.length} спільних містах і ${Qc.length} спільних запитах"` : '';

    const k = (label, value, sub, delta) => `<div class="kpi"${delta ? cmpNote : ''}><div class="label">${label}</div><div class="value">${value}${delta || ''}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
    const cityDelta = prev ? cur.cities.length - prev.cities.length : 0;
    const r1 = (v) => (v == null ? null : +v.toFixed(1));
    $('kpis').innerHTML =
      k('Міст охоплено', cur.cities.length,
        `${cur.people.length} співробітн. · ${cur.subs.length} ${plural(cur.subs.length, 'відповідь', 'відповіді', 'відповідей')}${prev && cityDelta ? ` · ${cityDelta > 0 ? '+' : ''}${cityDelta} до порівняння` : ''}`) +
      k('📱 Сер. позиція', fmtNum(r1(sCur.mobile.avg)), `знайдено ${sCur.mobile.foundN} з ${sCur.mobile.cells}`, prev ? deltaPos(r1(dCur.mobile.avg), r1(dPrev.mobile.avg)) : '') +
      k('💻 Сер. позиція', fmtNum(r1(sCur.desktop.avg)), `знайдено ${sCur.desktop.foundN} з ${sCur.desktop.cells}`, prev ? deltaPos(r1(dCur.desktop.avg), r1(dPrev.desktop.avg)) : '') +
      k('У ТОП‑10', sCur.top10All == null ? '—' : Math.round(sCur.top10All) + '%', 'мобільна та ПК разом', prev ? deltaPp(dCur.top10All, dPrev.top10All) : '');

    renderChart(runId);

    if (!cur.cities.length) {
      const empty = `<tr><td class="empty">У цьому прогоні ще немає відповідей</td></tr>`;
      $('byQuery').innerHTML = $('matrix').innerHTML = $('log').innerHTML = empty;
      $('logCount').textContent = '0';
      return;
    }

    // По запитах
    let h = `<thead><tr><th class="left">Запит</th><th>📱 сер.</th><th>💻 сер.</th><th>📱 ТОП‑10</th><th>💻 ТОП‑10</th><th class="left">Найкраще місто</th><th class="left">Найслабше місто</th></tr></thead><tbody>`;
    for (const q of Q) {
      const st = summarize(cur.cities, [q]);
      let dm = '', dd = '';
      if (prev && prev.Q.includes(q)) {
        const a = summarize(cur.cities.filter((c) => Cc.includes(c.city)), [q]);
        const b = summarize(prev.cities.filter((c) => Cc.includes(c.city)), [q]);
        dm = deltaPos(r1(a.mobile.avg), r1(b.mobile.avg)); dd = deltaPos(r1(a.desktop.avg), r1(b.desktop.avg));
      }
      const both = cur.cities.map((c) => ({ city: c.city, v: mean(DEV.map((d) => c[d][q]).filter((v) => v != null)) }));
      const found = both.filter((x) => x.v != null).sort((a, b) => a.v - b.v);
      const notFound = both.filter((x) => x.v == null);
      const best = found[0];
      const worst = notFound.length ? { city: notFound.map((x) => x.city).join(', '), v: null } : found[found.length - 1];
      const n = cur.cities.length;
      h += `<tr><td class="left"><b>${esc(q)}</b></td>
        <td>${chip(r1(st.mobile.avg))}${dm}</td><td>${chip(r1(st.desktop.avg))}${dd}</td>
        <td>${st.mobile.top10N}/${n}</td><td>${st.desktop.top10N}/${n}</td>
        <td class="left">${best ? `${esc(best.city)} ${chip(r1(best.v))}` : '—'}</td>
        <td class="left">${worst && worst !== best ? `${esc(worst.city)} ${chip(r1(worst.v))}` : '—'}</td></tr>`;
    }
    $('byQuery').innerHTML = h + '</tbody>';

    // Матриця
    let m = `<thead><tr><th class="left" rowspan="2">Місто · співробітник</th>${Q.map((q) => `<th class="qh" colspan="2">${esc(q)}</th>`).join('')}</tr>
      <tr>${Q.map(() => `<th class="qh">📱</th><th>💻</th>`).join('')}</tr></thead><tbody>`;
    for (const c of cur.cities) {
      const pc = prev ? prev.cityMap.get(c.city) : null;
      c.people.forEach((p, i) => {
        m += `<tr class="${i === 0 ? 'grp-start' : ''}"><td class="city left">${esc(c.city)}${c.people.length > 1 ? ` <span class="meta">· ${i + 1}/${c.people.length}</span>` : ''}${prev && !pc && i === 0 ? ' <span class="meta">· нове місто</span>' : ''}
          <div class="meta">${esc(p.employee)} · ${fmtDate(p.last.created_at)}${p.count > 1 ? ` · ${p.count} зап.` : ''}</div></td>`;
        for (const q of Q) {
          for (const d of DEV) {
            const dl = pc && prev.Q.includes(q) ? deltaPos(r1(p[d][q]), r1(pc[d][q])) : '';
            m += `<td class="${d === 'mobile' ? 'm' : ''}">${chip(r1(p[d][q]), isDiff(c.people, d, q))}${dl}</td>`;
          }
        }
        m += '</tr>';
      });
    }
    $('matrix').innerHTML = m + '</tbody>';

    // Відповіді
    $('logCount').textContent = `${cur.subs.length} шт.`;
    let l = `<thead><tr><th class="left">Дата</th><th class="left">Місто</th><th class="left">Співробітник</th>
      ${Q.map((q) => `<th title="${esc(q)}">${esc(q.split(' ')[0])}<br>📱 / 💻</th>`).join('')}<th></th></tr></thead><tbody>`;
    for (const s of cur.subs) {
      l += `<tr><td class="left">${fmtDate(s.created_at)}</td><td class="left">${esc(s.city)}</td><td class="left">${esc(s.employee)}</td>
        ${Q.map((q) => `<td>${chip(s.results.mobile[q]?.position ?? null)} ${chip(s.results.desktop[q]?.position ?? null)}</td>`).join('')}
        <td><button class="link-btn" data-toggle="${s.id}" type="button">${openRows.has(s.id) ? 'Сховати' : 'Деталі'}</button></td></tr>`;
      if (openRows.has(s.id)) {
        l += `<tr class="log-details"><td colspan="${Q.length + 4}">
          <p>${s.comment ? `<b>Коментар:</b> ${esc(s.comment)}` : '<span class="muted">Без коментаря.</span>'}</p>
          <div class="edit-sub">
            <label class="field"><span>Співробітник</span><input id="emp-${s.id}" value="${esc(s.employee)}"></label>
            <label class="field"><span>Місто</span><input id="city-${s.id}" value="${esc(s.city)}"></label>
            <button class="btn small" data-save="${s.id}" type="button">Зберегти</button>
            <span class="error" id="err-${s.id}"></span>
          </div>
          ${pendingDel === s.id
            ? `<p><b>Видалити цю відповідь?</b> <button class="link-btn danger" data-del="${s.id}" type="button">Так, видалити</button> · <button class="link-btn" data-canceldel="1" type="button">Скасувати</button></p>`
            : `<button class="link-btn danger" data-askdel="${s.id}" type="button">Видалити відповідь</button>`}
        </td></tr>`;
      }
    }
    $('log').innerHTML = l + '</tbody>';
  }

  // ---------- Графік динаміки ----------
  function renderChart(selectedId) {
    const metric = $('chartMetric').value;
    const qSel = $('chartQuery').value;
    const pts = runsWithData.map((run) => {
      const c = compute(run.id);
      const Q = qSel === '__all' ? c.Q : (c.Q.includes(qSel) ? [qSel] : []);
      if (!Q.length || !c.cities.length) return { run, mobile: null, desktop: null };
      const s = summarize(c.cities, Q);
      return { run, mobile: s.mobile[metric], desktop: s.desktop[metric] };
    });
    const box = $('chart');
    if (!pts.length) { box.innerHTML = '<p class="empty">Ще немає даних</p>'; $('chartHint').textContent = ''; return; }

    const isPct = metric !== 'avg';
    const vals = pts.flatMap((p) => [p.mobile, p.desktop]).filter((v) => v != null);
    const yMax = isPct ? 100 : Math.min(30, Math.max(10, Math.ceil(Math.max(...vals, 1) / 5) * 5));
    const W = Math.max($('chart').clientWidth || 640, 150 * pts.length + 80), H = 280;
    const P = { l: 48, r: 28, t: 28, b: 58 };
    const x = (i) => (pts.length === 1 ? (P.l + W - P.r) / 2 : P.l + 50 + i * ((W - P.l - P.r - 100) / (pts.length - 1)));
    // позиція 1 і 100% — угорі
    const y = (v) => (isPct ? P.t + (1 - v / 100) * (H - P.t - P.b) : P.t + ((v - 1) / (yMax - 1)) * (H - P.t - P.b));
    const ticks = isPct ? [0, 25, 50, 75, 100] : [1, ...Array.from({ length: yMax / 5 }, (_, i) => (i + 1) * 5)];
    const fmtV = (v) => (isPct ? Math.round(v) + '%' : v.toFixed(1));

    let svg = `<svg class="chart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Динаміка по прогонах">`;
    const sel = pts.findIndex((p) => p.run.id === selectedId);
    if (sel >= 0) svg += `<rect class="cur" x="${x(sel) - 55}" y="${P.t - 22}" width="110" height="${H - P.t - P.b + 30}" rx="8"/>`;
    for (const t of ticks) {
      svg += `<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${y(t)}" y2="${y(t)}"/>`;
      svg += `<text x="${P.l - 8}" y="${y(t) + 4}" text-anchor="end">${isPct ? t + '%' : t}</text>`;
    }
    pts.forEach((p, i) => {
      const [a, b] = p.run.name.split('·').map((s) => s.trim());
      svg += `<text x="${x(i)}" y="${H - P.b + 22}" text-anchor="middle"${i === sel ? ' class="val"' : ''}>${esc(a)}</text>`;
      if (b) svg += `<text x="${x(i)}" y="${H - P.b + 38}" text-anchor="middle">${esc(b)}</text>`;
    });
    for (const d of DEV) {
      let path = '', pen = false;
      pts.forEach((p, i) => {
        const v = p[d];
        if (v == null) { pen = false; return; }
        path += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
        pen = true;
      });
      if (path) svg += `<path class="l-${d}" d="${path}" fill="none" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
    }
    for (const d of DEV) {
      pts.forEach((p, i) => {
        const v = p[d];
        if (v == null) return;
        const other = p[d === 'mobile' ? 'desktop' : 'mobile'];
        // підпис ставимо з того боку, де немає другої лінії
        const above = other == null ? true : (isPct ? v >= other : v <= other);
        svg += `<circle class="d-${d}" cx="${x(i)}" cy="${y(v)}" r="4.5"/>`;
        svg += `<text class="val" x="${x(i)}" y="${y(v) + (above ? -10 : 18)}" text-anchor="middle">${fmtV(v)}</text>`;
      });
    }
    svg += '</svg>';
    box.innerHTML = svg;

    const hints = [];
    if (pts.length === 1) hints.push('Лінія з’явиться, коли буде другий прогін з відповідями.');
    if (metric === 'avg') hints.push('«Немає в ТОП‑30» у середню позицію не входить, тому дивіться також «Знайдено в ТОП‑30».');
    if (qSel !== '__all' && pts.some((p) => p.mobile == null && p.desktop == null)) hints.push('У деяких прогонах цього запиту не було.');
    $('chartHint').textContent = hints.join(' ');
  }

  // ---------- Події ----------
  $('log').addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    const d = t.dataset;
    if (d.toggle) {
      const id = Number(d.toggle);
      openRows.has(id) ? openRows.delete(id) : openRows.add(id);
      pendingDel = null;
      render();
    } else if (d.askdel) { pendingDel = Number(d.askdel); render(); }
    else if (d.canceldel) { pendingDel = null; render(); }
    else if (d.del) {
      pendingDel = null;
      await fetch(`/api/submissions/${d.del}`, { method: 'DELETE', credentials: 'same-origin' });
      await load();
    } else if (d.save) {
      const id = d.save;
      const res = await fetch(`/api/submissions/${id}`, {
        method: 'PATCH', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employee: $('emp-' + id).value, city: $('city-' + id).value }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { $('err-' + id).textContent = json.error || 'Помилка'; return; }
      await load();
    }
  });
  $('run').addEventListener('change', () => { cmpTouched = false; fillCompare(); render(); });
  $('cmp').addEventListener('change', () => { cmpTouched = true; render(); });
  $('mode').addEventListener('change', () => { cache.clear(); render(); });
  ['chartQuery', 'chartMetric'].forEach((id) => $(id).addEventListener('change', () => renderChart(Number($('run').value))));

  load();
  // автооновлення раз на хвилину, але не посеред редагування відповіді
  setInterval(() => { if (!document.querySelector('.log-details input:focus')) load(); }, 60000);
})();
