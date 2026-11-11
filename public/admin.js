(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDay = (d) => (d ? new Date(d).toLocaleDateString('uk-UA', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', year: 'numeric' }) : '');
  const STATUS = { active: 'Відкритий', draft: 'Чернетка', closed: 'Закритий' };
  const plural = (n, one, few, many) => {
    const m10 = n % 10, m100 = n % 100;
    return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  };

  let runs = [];
  let editing = null;        // id прогону, що редагується
  let confirmDelete = null;  // id прогону, для якого показано підтвердження
  let firstLoad = true;

  async function api(method, url, body) {
    const res = await fetch(url, {
      method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || 'Помилка сервера');
    return json;
  }

  async function load() {
    const data = await api('GET', '/api/runs');
    runs = data.runs;
    if (firstLoad) {
      $('newName').value = data.defaultName;
      $('newQueries').value = runs.length ? runs[0].queries.join('\n') : '';
      firstLoad = false;
    }
    render();
  }

  function period(r) {
    if (!r.opened_at) return 'ще не відкривався';
    return `${fmtDay(r.opened_at)} – ${r.status === 'active' ? 'зараз' : fmtDay(r.closed_at)}`;
  }

  function render() {
    const active = runs.find((r) => r.status === 'active');
    $('now').innerHTML = active
      ? `<div class="grow"><span class="pill active">Відкритий</span>
           <h2 style="margin-top:6px">${esc(active.name)}</h2>
           <p class="muted">З ${fmtDay(active.opened_at)} · ${active.submissions} ${plural(active.submissions, 'відповідь', 'відповіді', 'відповідей')} з ${active.cities} ${plural(active.cities, 'міста', 'міст', 'міст')} · ${active.queries.length} ${plural(active.queries.length, 'запит', 'запити', 'запитів')}</p></div>
         <a class="btn ghost small" href="/stats?run=${active.id}">Статистика прогону</a>
         <button class="btn ghost small danger" data-close="${active.id}" type="button">Закрити прогін</button>`
      : `<div class="grow"><span class="pill closed">Нічого не відкрито</span>
           <h2 style="margin-top:6px">Форма зараз не приймає відповіді</h2>
           <p class="muted">Співробітники бачать «Зараз перевірка не проводиться». Створіть новий прогін або відкрийте один із наявних.</p></div>`;

    if (!runs.length) { $('runs').innerHTML = '<tr><td class="empty">Прогонів ще немає</td></tr>'; return; }
    let h = `<thead><tr><th class="left">Прогін</th><th class="left">Статус</th><th class="left">Період</th><th>Запитів</th><th>Відповідей</th><th>Міст</th><th></th></tr></thead><tbody>`;
    for (const r of runs) {
      h += `<tr>
        <td class="left"><b>${esc(r.name)}</b></td>
        <td class="left"><span class="pill ${r.status}">${STATUS[r.status]}</span></td>
        <td class="left">${period(r)}</td>
        <td>${r.queries.length}</td><td>${r.submissions}</td><td>${r.cities}</td>
        <td class="actions">
          ${r.submissions ? `<a href="/stats?run=${r.id}">Статистика</a>` : ''}
          ${r.status === 'active'
            ? `<button class="link-btn" data-close="${r.id}" type="button">Закрити</button>`
            : `<button class="link-btn" data-open="${r.id}" type="button">${r.status === 'closed' ? 'Відкрити знову' : 'Відкрити'}</button>`}
          <button class="link-btn" data-edit="${r.id}" type="button">${editing === r.id ? 'Скасувати' : 'Редагувати'}</button>
          <button class="link-btn danger" data-askdel="${r.id}" type="button">Видалити</button>
        </td></tr>`;
      if (confirmDelete === r.id) {
        h += `<tr class="editor"><td colspan="7">
          <p><b>Видалити «${esc(r.name)}»${r.submissions ? ` разом із ${r.submissions} ${plural(r.submissions, 'відповіддю', 'відповідями', 'відповідями')}` : ''}?</b> Відновити не вийде.</p>
          <div class="form-actions"><button class="btn small danger" data-del="${r.id}" type="button">Так, видалити</button>
          <button class="btn small ghost" data-cancel="1" type="button">Скасувати</button></div></td></tr>`;
      }
      if (editing === r.id) {
        const locked = r.submissions > 0;
        h += `<tr class="editor"><td colspan="7"><div class="form-stack" style="margin-top:0">
          <div class="grid2"><label class="field"><span>Назва</span><input id="editName" maxlength="100" value="${esc(r.name)}"></label></div>
          <label class="field"><span>Запити, по одному в рядку</span>
            <textarea id="editQueries" rows="6" ${locked ? 'disabled' : ''}>${esc(r.queries.join('\n'))}</textarea>
            ${locked ? '<p class="hint">У прогоні вже є відповіді, тому запити змінювати не можна, інакше зламається статистика. Для нового набору запитів створіть новий прогін.</p>' : ''}
          </label>
          <div class="form-actions"><button class="btn small" data-save="${r.id}" type="button">Зберегти</button>
            <button class="btn small ghost" data-cancel="1" type="button">Скасувати</button>
            <p class="error" id="editError" role="alert"></p></div>
        </div></td></tr>`;
      }
    }
    $('runs').innerHTML = h + '</tbody>';
  }

  async function act(fn) {
    try { await fn(); await load(); } catch (e) { alertInline(e.message); }
  }
  function alertInline(msg) {
    const el = $('editError') || $('createError');
    if (el) el.textContent = msg;
  }

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    if (d.open) act(() => api('POST', `/api/runs/${d.open}/open`));
    else if (d.close) act(() => api('POST', `/api/runs/${d.close}/close`));
    else if (d.edit) { editing = editing === +d.edit ? null : +d.edit; confirmDelete = null; render(); }
    else if (d.askdel) { confirmDelete = +d.askdel; editing = null; render(); }
    else if (d.cancel) { editing = null; confirmDelete = null; render(); }
    else if (d.del) { confirmDelete = null; act(() => api('DELETE', `/api/runs/${d.del}`)); }
    else if (d.save) {
      const r = runs.find((x) => x.id === +d.save);
      const body = { name: $('editName').value };
      if (!r.submissions) body.queries = $('editQueries').value.split('\n');
      try { await api('PATCH', `/api/runs/${d.save}`, body); editing = null; await load(); }
      catch (err) { $('editError').textContent = err.message; }
    }
  });

  $('createForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('createError').textContent = '';
    $('createBtn').disabled = true;
    try {
      await api('POST', '/api/runs', { name: $('newName').value, queries: $('newQueries').value.split('\n'), open: $('newOpen').checked });
      firstLoad = true;
      await load();
      $('createError').innerHTML = '<span class="ok-msg">Прогін створено.</span>';
    } catch (err) {
      $('createError').textContent = err.message;
    } finally {
      $('createBtn').disabled = false;
    }
  });

  load().catch((e) => { $('now').innerHTML = `<p class="error">${esc(e.message)}</p>`; });
})();
