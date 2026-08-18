(function () {
    'use strict';

    const REQUEST_TIMEOUT_MS = 15000;

    function escape(value) {
        if (value == null) return '';
        return String(value).replace(/[&<>'\"]/g, ch => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '\"': '&quot;'
        }[ch]));
    }

    async function fetchJson(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(url, { cache: 'no-store', ...options, signal: controller.signal });
            const raw = await response.text();
            let payload = null;
            try { payload = raw ? JSON.parse(raw) : null; } catch (_) {}
            if (!response.ok) {
                const message = payload && (payload.error || payload.message) || (raw && raw.length < 500 ? raw : '') || `HTTP ${response.status}`;
                throw new Error(message);
            }
            if (payload === null && raw) throw new Error('השרת החזיר תשובה שאינה JSON.');
            return payload;
        } catch (error) {
            if (error && error.name === 'AbortError') throw new Error('השרת לא החזיר תשובה בזמן.');
            throw error;
        } finally { clearTimeout(timer); }
    }

    function showLoadError(container, message) {
        if (!container) return;
        const cell = container.tagName === 'TBODY';
        const body = `<div class="text-center py-10 px-4 text-rose-600 dark:text-rose-400"><i class="fa-solid fa-triangle-exclamation text-3xl mb-3 block"></i><div class="font-bold mb-2">לא ניתן לטעון את הנתונים</div><div class="text-sm text-slate-500 dark:text-slate-400 mb-4">${escape(message)}</div><button onclick="location.reload()" class="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-bold">נסה שוב</button></div>`;
        container.innerHTML = cell ? `<tr><td colspan="5">${body}</td></tr>` : body;
    }

    function forceCardsView() {
        currentHoursView = 'day';
        const dayBtn = document.getElementById('hours-view-day-btn');
        const monthBtn = document.getElementById('hours-view-month-btn');
        const days = document.getElementById('month-grid-days');
        const table = document.getElementById('month-grid-table-wrap');
        dayBtn?.classList.add('bg-blue-600', 'text-white');
        monthBtn?.classList.remove('bg-blue-600', 'text-white');
        days?.classList.remove('hidden');
        table?.classList.add('hidden');
    }

    async function renderCardsImmediately() {
        forceCardsView();
        if (typeof renderHoursView === 'function') renderHoursView();
        forceCardsView();
        // The legacy renderer can change the view while finishing its own render.
        // Re-assert the requested default view on the next paint as well.
        requestAnimationFrame(() => {
            forceCardsView();
            requestAnimationFrame(forceCardsView);
        });
    }

    window.performLogin = async function () {
        const input = document.getElementById('login-password'), btn = document.getElementById('login-btn');
        const password = input ? input.value : '';
        if (!password) { Swal.fire('שגיאה', 'הזן סיסמה.', 'warning'); return; }
        const originalHtml = btn ? btn.innerHTML : '';
        try {
            if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> מתחבר...'; }
            const res = await fetchJson('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify({ password, phone: password, pin: password }) });
            if (!res || !res.success) throw new Error(res?.error || 'פרטי התחברות שגויים');
            document.getElementById('login-screen')?.classList.add('hidden');
            const main = document.getElementById('main-app'); main?.classList.remove('hidden'); main?.classList.add('flex');
            if (typeof startPolling === 'function') startPolling();
            if (typeof switchTab === 'function') switchTab('dashboard');
            if (typeof loadDomains === 'function') loadDomains();
            if (typeof loadEmployees === 'function') loadEmployees();
            if (typeof refreshRequestsBadge === 'function') refreshRequestsBadge();
            if (typeof loadTimeCorrections === 'function') loadTimeCorrections();
        } catch (error) {
            console.error('[admin-fixes] login failed:', error);
            Swal.fire({ icon: 'error', title: 'ההתחברות נכשלה', html: `<div class="text-right text-sm">${escape(error.message || 'שגיאה לא ידועה')}</div>`, confirmButtonText: 'הבנתי' });
        } finally { if (btn) { btn.disabled = false; btn.innerHTML = originalHtml; } }
    };

    function putRowsIntoMap(data, monthVal) {
        if (!Array.isArray(data) || typeof currentShiftsMap === 'undefined') return;
        Object.keys(currentShiftsMap).filter(d => !monthVal || d.startsWith(monthVal)).forEach(d => delete currentShiftsMap[d]);
        data.forEach(row => { if (row && row.date) currentShiftsMap[row.date] = row; });
    }

    function latestMonthFromRows(rows) {
        if (!Array.isArray(rows) || !rows.length) return '';
        let latest = '';
        rows.forEach(row => { if (row?.date && row.date > latest) latest = row.date; });
        return latest.slice(0, 7);
    }

    async function loadHours(empId, name) {
        const nameEl = document.getElementById('current-emp-name');
        const details = document.getElementById('emp-details-bar');
        const picker = document.getElementById('month-picker');
        const daysContainer = document.getElementById('month-grid-days');
        const tableWrap = document.getElementById('month-grid-table-wrap');

        currentEmpId = empId;
        currentEmpName = name || '';
        if (nameEl) nameEl.textContent = name || 'עובד';
        if (details) details.classList.remove('hidden');
        activeHoursDomainFilter = null;
        pendingCopySegments = {};

        try {
            if (typeof renderHoursSkeleton === 'function') renderHoursSkeleton();
            forceCardsView();

            // Do not require the manager to choose a month. Always find the most
            // recent month containing an actual report and open that month directly.
            const allData = await fetchJson(`/api/shifts/${encodeURIComponent(empId)}`);
            if (!Array.isArray(allData)) throw new Error('מבנה נתונים לא תקין מהשרת.');

            const latestMonth = latestMonthFromRows(allData);
            let monthVal = latestMonth;
            if (!monthVal) {
                monthVal = picker?.value || '';
                if (!monthVal) {
                    const now = new Date();
                    monthVal = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
                }
            }
            if (picker) picker.value = monthVal;

            const data = latestMonth ? allData.filter(row => row?.date?.startsWith(monthVal)) : allData;
            putRowsIntoMap(data, monthVal);

            await renderCardsImmediately();

            const emp = (typeof empDataMap !== 'undefined') ? empDataMap[empId] : null;
            const pin = document.getElementById('meta-pin');
            if (pin) pin.textContent = emp?.pin_code || '';

            // Hebrew calendar is optional and can update decorations later.
            if (typeof loadHebrewCalendarForMonth === 'function' && monthVal) {
                fetchJson(`/api/hebrew_calendar?month=${encodeURIComponent(monthVal)}`, {}, 5000)
                    .then(calendar => {
                        if (calendar && typeof calendar.days === 'object') {
                            currentHebrewCalendar = calendar.days || {};
                            renderHoursView();
                            forceCardsView();
                            requestAnimationFrame(forceCardsView);
                        }
                    })
                    .catch(error => console.warn('[admin-fixes] Hebrew calendar skipped:', error.message));
            }
        } catch (error) {
            showLoadError(daysContainer, error.message || 'שגיאה לא ידועה');
            tableWrap?.classList.add('hidden');
            console.error('[admin-fixes] hours load failed', error);
        }
    }

    window.loadShiftsForGrid = loadHours;

    window.fetchMonthShifts = async function (empId, monthVal) {
        const data = await fetchJson(`/api/shifts/${encodeURIComponent(empId)}?month=${encodeURIComponent(monthVal)}`);
        if (!Array.isArray(data)) throw new Error('מבנה נתונים לא תקין מהשרת.');
        putRowsIntoMap(data, monthVal);
        return data;
    };

    window.renderPinsTable = async function () {
        const tbody = document.getElementById('pins-table-tbody');
        if (!tbody) return;
        tbody.innerHTML = '<tr><td colspan="5" class="text-center py-10 text-slate-400"><i class="fa-solid fa-spinner fa-spin text-2xl mb-2 block"></i>טוען עובדים...</td></tr>';
        try {
            let employees = (typeof allEmployees !== 'undefined' && Array.isArray(allEmployees)) ? allEmployees : [];
            if (!employees.length) {
                const data = await fetchJson('/api/employees');
                employees = Array.isArray(data) ? data : [];
                if (typeof allEmployees !== 'undefined') allEmployees = employees;
            }
            if (!employees.length) { tbody.innerHTML = '<tr><td colspan="5" class="text-center py-12 text-slate-400">אין עובדים במערכת.</td></tr>'; return; }
            tbody.innerHTML = employees.map(emp => `<tr class="hover:bg-slate-50 dark:hover:bg-slate-700/40"><td class="p-3 font-bold">${escape(emp.name || '')}${emp.is_active === false ? ' <span class="text-xs text-slate-400">(לא פעיל)</span>' : ''}</td><td class="p-3">${escape(emp.department || '-')}</td><td class="p-3">${escape(emp.role || '-')}</td><td class="p-3 font-mono">${escape(emp.phone || '-')}</td><td class="p-3 font-mono font-black text-emerald-600 text-base">${escape(emp.pin_code || '-')}</td></tr>`).join('');
        } catch (error) { showLoadError(tbody, error.message || 'לא ניתן לטעון את העובדים'); }
    };
})();
