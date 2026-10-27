(function () {
  const DEV = ['mobile', 'desktop'];
  const ICON = { mobile: '📱', desktop: '💻' };
  const $ = (id) => document.getElementById(id);
  let data = null;
  const openRows = new Set();

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (d) => new Date(d).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const dayKey = (d) => new Date(d).toLocaleDateString('sv-SE', { timeZone: 'Europe/Kyiv' });
  const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  const fmtPos = (v) => (v == null ? '—' : Number.isInteger(v) ? String(v) : v.toFixed(1));

  function bucket(v) {
    if (v == null) return 'b5';
    if (v <= 3) return 'b1';
    if (v <= 10) return 'b2';
    if (v <= 20) return 'b3';
    return 'b4';
  }
  const chip = (v, title, diff) => `<span class="pos-chip ${bucket(v)}${diff ? ' diff' : ''}"${diff ? ' title="Розбіжність між співробітниками цього міста"' : ''}${title ? ` title="${esc(title)}"` : ''}>${v == null ? '×' : fmtPos(v)}</span>`;

  async function load() {
    const res = await fetch('/api/stats', { credentials: 'same-origin' });
    if (!res.ok) { $('subtitle').textContent = 'Немає доступу або помилка сервера.'; return; }
    data = await res.json();
    render();
  }

  function filtered() {
    const from = $('from').value, to = $('to').value;
    return data.submissions.filter((s) => {
      const k = dayKey(s.created_at);
      return (!from || k >= from) && (!to || k <= to);
    });
  }

  const normName = (n) => String(n || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const DIFF = 5; // розбіжність між співробітниками одного міста, позицій

  // співробітник у місті -> позиції (останній запис або середнє по його записах)
  function perPerson(subs) {
    const mode = $('mode').value;
    const groups = new Map();
    for (const s of subs) {
      const key = s.city + '|' + normName(s.employee);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s); // subs уже відсортовані: новіші першими
    }
    const out = [];
    for (const list of groups.values()) {
      const row = { city: list[0].city, employee: list[0].employee, count: list.length, last: list[0], mobile: {}, desktop: {} };
      for (const d of DEV) {
        for (const q of data.queries) {
          if (mode === 'latest') row[d][q] = list[0].results[d][q]?.position ?? null;
          else row[d][q] = mean(list.map((s) => s.results[d][q]?.position).filter((v) => v != null));
        }
      }
      out.push(row);
    }
    return out.sort((a, b) => a.city.localeCompare(b.city, 'uk') || a.employee.localeCompare(b.employee, 'uk'));
  }

  // місто -> середнє по співробітниках міста (для KPI і зведення по запитах)
  function perCity(people) {
    const groups = new Map();
    for (const p of people) {
      if (!groups.has(p.city)) groups.set(p.city, []);
      groups.get(p.city).push(p);
    }
    return [...groups].map(([city, list]) => {
      const row = { city, people: list, mobile: {}, desktop: {} };
      for (const d of DEV) for (const q of data.queries) row[d][q] = mean(list.map((p) => p[d][q]).filter((v) => v != null));
      return row;
    });
  }

  // чи розходяться співробітники одного міста по цій клітинці
  function isDiff(list, d, q) {
    if (list.length < 2) return false;
    const vals = list.map((p) => p[d][q]);
    const found = vals.filter((v) => v != null);
    if (found.length && found.length < vals.length) return true;
    return found.length > 1 && Math.max(...found) - Math.min(...found) >= DIFF;
  }

  function render() {
    const subs = filtered();
    const people = perPerson(subs);
    const cities = perCity(people);
    const Q = data.queries;

    $('subtitle').textContent = data.submissions.length
      ? `Останнє оновлення: ${fmtDate(data.submissions[0].created_at)} · запитів: ${Q.length} · мобільна та ПК видача (Google)`
      : 'Поки немає жодної відповіді. Надішліть посилання на форму співробітникам.';

    // KPI
    const cells = { mobile: [], desktop: [] };
    let top10 = 0, total = 0;
    for (const c of cities) for (const d of DEV) for (const q of Q) {
      total++;
      const v = c[d][q];
      if (v != null) { cells[d].push(v); if (v <= 10) top10++; }
    }
    const k = (label, value, sub) => `<div class="kpi"><div class="label">${label}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
    $('kpis').innerHTML =
      k('Міст охоплено', cities.length, `${people.length} співробітн. · ${subs.length} відповідей`) +
      k('📱 Сер. позиція', fmtPos(mean(cells.mobile)), `знайдено ${cells.mobile.length} з ${cities.length * Q.length}`) +
      k('💻 Сер. позиція', fmtPos(mean(cells.desktop)), `знайдено ${cells.desktop.length} з ${cities.length * Q.length}`) +
      k('У ТОП‑10', total ? Math.round((top10 / total) * 100) + '%' : '—', `${top10} з ${total} перевірок`);

    // По запитах
    if (!cities.length) {
      $('byQuery').innerHTML = $('matrix').innerHTML = `<tr><td class="empty">Немає даних за обраний період</td></tr>`;
    } else {
      let h = `<thead><tr><th class="left">Запит</th><th>📱 сер.</th><th>💻 сер.</th><th>📱 ТОП‑10</th><th>💻 ТОП‑10</th><th class="left">Найкраще місто</th><th class="left">Найгірше місто</th></tr></thead><tbody>`;
      for (const q of Q) {
        const st = {};
        for (const d of DEV) {
          const vals = cities.map((c) => c[d][q]).filter((v) => v != null);
          st[d] = { avg: mean(vals), top: vals.filter((v) => v <= 10).length };
        }
        const both = cities.map((c) => ({ city: c.city, v: mean(DEV.map((d) => c[d][q]).filter((v) => v != null)) }));
        const found = both.filter((x) => x.v != null).sort((a, b) => a.v - b.v);
        const notFound = both.filter((x) => x.v == null);
        const best = found[0];
        const worst = notFound.length ? { city: notFound.map((x) => x.city).join(', '), v: null } : found[found.length - 1];
        h += `<tr><td class="left"><b>${esc(q)}</b></td>
          <td>${chip(st.mobile.avg)}</td><td>${chip(st.desktop.avg)}</td>
          <td>${st.mobile.top}/${cities.length}</td><td>${st.desktop.top}/${cities.length}</td>
          <td class="left">${best ? `${esc(best.city)} ${chip(best.v)}` : '—'}</td>
          <td class="left">${worst && worst !== best ? `${esc(worst.city)} ${chip(worst.v)}` : '—'}</td></tr>`;
      }
      $('byQuery').innerHTML = h + '</tbody>';

      // Матриця: окремий рядок на кожного співробітника, згруповано по містах
      let m = `<thead><tr><th class="left" rowspan="2">Місто · співробітник</th>${Q.map((q) => `<th class="qh" colspan="2">${esc(q)}</th>`).join('')}</tr>
        <tr>${Q.map(() => `<th class="qh">📱</th><th>💻</th>`).join('')}</tr></thead><tbody>`;
      for (const c of cities.sort((a, b) => a.city.localeCompare(b.city, 'uk'))) {
        c.people.forEach((p, i) => {
          m += `<tr class="${i === 0 ? 'grp-start' : ''}"><td class="city left">${esc(c.city)}${c.people.length > 1 ? ` <span class="meta">· ${i + 1}/${c.people.length}</span>` : ''}
            <div class="meta">${esc(p.employee)} · ${fmtDate(p.last.created_at)}${p.count > 1 ? ` · ${p.count} зап.` : ''}</div></td>`;
          for (const q of Q) {
            m += `<td class="m">${chip(p.mobile[q], null, isDiff(c.people, 'mobile', q))}</td><td>${chip(p.desktop[q], null, isDiff(c.people, 'desktop', q))}</td>`;
          }
          m += '</tr>';
        });
      }
      $('matrix').innerHTML = m + '</tbody>';
    }

    // Журнал
    $('logCount').textContent = `${subs.length} шт.`;
    if (!subs.length) { $('log').innerHTML = '<tr><td class="empty">Порожньо</td></tr>'; return; }
    let l = `<thead><tr><th class="left">Дата</th><th class="left">Місто</th><th class="left">Співробітник</th>
      ${Q.map((q) => `<th title="${esc(q)}">${esc(q.split(' ')[0])}<br>📱 / 💻</th>`).join('')}<th></th></tr></thead><tbody>`;
    for (const s of subs) {
      l += `<tr><td class="left">${fmtDate(s.created_at)}</td><td class="left">${esc(s.city)}</td><td class="left">${esc(s.employee)}</td>
        ${Q.map((q) => `<td>${chip(s.results.mobile[q]?.position ?? null)} ${chip(s.results.desktop[q]?.position ?? null)}</td>`).join('')}
        <td><button class="link-btn" data-toggle="${s.id}">${openRows.has(s.id) ? 'Сховати' : 'Деталі'}</button></td></tr>`;
      if (openRows.has(s.id)) {
        l += `<tr class="log-details"><td colspan="${Q.length + 4}">
          <p>${s.comment ? `<b>Коментар:</b> ${esc(s.comment)}` : '<span class="muted">Без коментаря.</span>'}</p>
          <button class="link-btn danger" data-del="${s.id}">Видалити цю відповідь</button></td></tr>`;
      }
    }
    $('log').innerHTML = l + '</tbody>';
  }

  $('log').addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.toggle) {
      const id = Number(t.dataset.toggle);
      openRows.has(id) ? openRows.delete(id) : openRows.add(id);
      render();
    } else if (t.dataset.del) {
      if (!confirm('Видалити цю відповідь назавжди?')) return;
      await fetch(`/api/submissions/${t.dataset.del}`, { method: 'DELETE', credentials: 'same-origin' });
      await load();
    }
  });
  ['from', 'to', 'mode'].forEach((id) => $(id).addEventListener('change', render));

  load();
  setInterval(load, 60000);
})();
