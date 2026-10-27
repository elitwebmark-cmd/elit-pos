(async function () {
  const DRAFT_KEY = 'elit-positions-draft-v1';
  const form = document.getElementById('form');
  const errorEl = document.getElementById('formError');
  const btn = document.getElementById('submitBtn');
  const tpl = document.getElementById('rowTpl');
  const citySelect = form.citySelect;

  const cfg = await fetch('/api/config').then((r) => r.json());
  const { queries, cities, maxPosition } = cfg;

  // Міста
  citySelect.innerHTML = '<option value="">— оберіть місто —</option>' +
    cities.map((c) => `<option>${c}</option>`).join('');
  citySelect.addEventListener('change', saveDraft);

  // Рядки запитів
  const rowsByDevice = { mobile: [], desktop: [] };
  for (const device of ['mobile', 'desktop']) {
    const box = document.querySelector(`[data-rows="${device}"]`);
    queries.forEach((q) => {
      const node = tpl.content.firstElementChild.cloneNode(true);
      node.querySelector('.q').textContent = q;
      const pos = node.querySelector('.pos input');
      const nf = node.querySelector('.nf input');
      pos.max = maxPosition;
      pos.addEventListener('input', () => { if (pos.value) nf.checked = false; sync(); });
      nf.addEventListener('change', () => { if (nf.checked) pos.value = ''; sync(); });
      box.appendChild(node);
      rowsByDevice[device].push({ q, node, pos, nf });
    });
  }

  function rowFilled(r) {
    const n = Number(r.pos.value);
    return r.nf.checked || (Number.isInteger(n) && n >= 1 && n <= maxPosition);
  }

  function sync() {
    for (const d of ['mobile', 'desktop']) {
      const rows = rowsByDevice[d];
      const filled = rows.filter(rowFilled).length;
      const c = document.querySelector(`[data-counter="${d}"]`);
      c.textContent = `${filled}/${rows.length}`;
      c.classList.toggle('ok', filled === rows.length);
      rows.forEach((r) => {
        r.node.classList.toggle('filled', rowFilled(r));
      });
    }
    saveDraft();
  }

  function collect() {
    const results = { mobile: {}, desktop: {} };
    for (const d of ['mobile', 'desktop']) {
      for (const r of rowsByDevice[d]) {
        results[d][r.q] = { position: r.pos.value ? Number(r.pos.value) : null, notFound: r.nf.checked };
      }
    }
    return {
      employee: form.employee.value.trim(),
      citySelect: citySelect.value,
      comment: form.comment.value.trim(),
      results,
    };
  }

  function saveDraft() {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(collect())); } catch (_) {}
  }

  function loadDraft() {
    let d;
    try { d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch (_) {}
    if (!d) return;
    form.employee.value = d.employee || '';
    if (cities.includes(d.citySelect)) citySelect.value = d.citySelect;
    form.comment.value = d.comment || '';
    for (const dev of ['mobile', 'desktop']) {
      for (const r of rowsByDevice[dev]) {
        const v = d.results && d.results[dev] && d.results[dev][r.q];
        if (!v) continue;
        r.pos.value = v.position || '';
        r.nf.checked = !!v.notFound;
      }
    }
  }

  function clearDraftFields() {
    // ім'я та місто залишаємо, позиції очищуємо
    for (const dev of ['mobile', 'desktop']) {
      for (const r of rowsByDevice[dev]) { r.pos.value = ''; r.nf.checked = false; }
    }
    form.comment.value = '';
    sync();
  }

  form.employee.addEventListener('input', saveDraft);
  form.comment.addEventListener('input', saveDraft);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';
    document.querySelectorAll('.invalid').forEach((el) => el.classList.remove('invalid'));

    const data = collect();
    const city = data.citySelect;
    let firstBad = null;
    const mark = (el) => { el.classList.add('invalid'); firstBad = firstBad || el; };

    if (!data.employee) mark(form.employee);
    if (!city) mark(citySelect);
    for (const d of ['mobile', 'desktop']) {
      for (const r of rowsByDevice[d]) if (!rowFilled(r)) mark(r.node);
    }
    if (firstBad) {
      errorEl.textContent = 'Заповніть усі позначені поля: для кожного запиту — позицію від 1 до 30 або «Немає в ТОП‑30».';
      firstBad.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Надсилаємо…';
    try {
      const res = await fetch('/api/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employee: data.employee, city, comment: data.comment, results: data.results }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Помилка сервера');
      clearDraftFields();
      form.classList.add('hidden');
      document.getElementById('done').classList.remove('hidden');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      errorEl.textContent = err.message || 'Не вдалося надіслати. Перевірте інтернет і спробуйте ще раз.';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Надіслати результати';
    }
  });

  document.getElementById('again').addEventListener('click', () => {
    document.getElementById('done').classList.add('hidden');
    form.classList.remove('hidden');
  });

  loadDraft();
  sync();
})();
