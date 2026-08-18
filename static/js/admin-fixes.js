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
            const response = await fetch(url, {
                cache: 'no-store',
                ...options,
                signal: controller.signal
            });
            let payload = null;
            try { payload = await response.json(); } catch (_) {}
            if (!response.ok) {
                const message = payload && (payload.error || payload.message) || `HTTP ${response.status}`;
                throw new Error(message);
            }
            return payload;
        } catch (error) {
            if (error && error.name === 'AbortError') {
                throw new Error('השרת לא החזיר תשובה בזמן. ייתכן שהחיבור למסד הנתונים איטי או מנותק.');
            }
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    function showLoadError(container, message) {
        if (!container) return;
        const cell = container.tagName === 'TBODY';
        const body = `
            <div class="text-center py-10 px-4 text-rose-600 dark:text-rose-400">
                <i class="fa-solid fa-triangle-exclamation text-3xl mb-3 block"></i>
                <div class="font-bold mb-2">לא ניתן לטעון את הנתונים</div>
                <div class="text-sm text-slate-500 dark:text-slate-400 mb-4">${escape(message)}</div>
                <button onclick="location.reload()" class="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-bold">נסה שוב</button>
            </div>`;
        container.innerHTML = cell ? `<tr><td colspan="5">${body}</td></tr>` : body;
    }

    async function loadHours(empId, name) {
        const nameEl = document.getElementById('current-emp-name');
        const details = document.getElementById('emp-details-bar');
        const monthVal = document.getElementById('month-picker')?.value || '';
        const daysContainer = document.getElementById('month-grid-days');
        const tableWrap = document.getElementById('month-grid-table-wrap');

        // These are top-level lexical variables created by admin.js, so they
        // must be assigned directly rather than through window.*.
        if (typeof currentEmpId !== 'undefined') currentEmpId = empId;
        if (typeof currentEmpName !== 'undefined') currentEmpName = name || '';

        if (nameEl) nameEl.textContent = name || 'עובד';
        if (details) details.classList.remove('hidden');

        try {
            if (typeof renderHoursSkeleton === 'function') renderHoursSkeleton();
            if (typeof activeHoursDomainFilter !== 'undefined') activeHoursDomainFilter = null;
            if (typeof pendingCopySegments !== 'undefined') pendingCopySegments = {};

            const data = await fetchJson(`/api/shifts/${encodeURIComponent(empId)}?month=${encodeURIComponent(monthVal)}`);
            if (!Array.isArray(data)) throw new Error('מבנה נתונים לא תקין מהשרת.');

            if (typeof currentShiftsMap !== 'undefined') {
                Object.keys(currentShiftsMap).filter(d => d.startsWith(monthVal)).forEach(d => delete currentShiftsMap[d]);
                data.forEach(row => { currentShiftsMap[row.date] = row; });
            }

            if (typeof loadHebrewCalendarForMonth === 'function') await loadHebrewCalendarForMonth(monthVal);
            if (typeof renderHoursView !== 'function') throw new Error('רכיב תצוגת השעות לא נטען.');
            renderHoursView();

            const emp = (typeof empDataMap !== 'undefined') ? empDataMap[empId] : null;
            const pin = document.getElementById('meta-pin');
            if (pin) pin.textContent = emp?.pin_code || '';
        } catch (error) {
            if (daysContainer) showLoadError(daysContainer, error.message || 'שגיאה לא ידועה');
            if (tableWrap) tableWrap.classList.add('hidden');
            console.error('[admin-fixes] hours load failed', error);
        }
    }

    window.loadShiftsForGrid = loadHours;

    window.fetchMonthShifts = async function (empId, monthVal) {
        const data = await fetchJson(`/api/shifts/${encodeURIComponent(empId)}?month=${encodeURIComponent(monthVal)}`);
        if (!Array.isArray(data)) throw new Error('מבנה נתונים לא תקין מהשרת.');
        if (typeof currentShiftsMap !== 'undefined') {
            Object.keys(currentShiftsMap).filter(d => d.startsWith(monthVal)).forEach(d => delete currentShiftsMap[d]);
            data.forEach(row => { currentShiftsMap[row.date] = row; });
        }
        return data;
    };

    window.renderPinsTable = async function () {
        const tbody = document.getElementById('pins-table-tbody');
        if (!tbody) return;

        tbody.innerHTML = '<tr><td colspan="5" class="text-center py-10 text-slate-400"><i class="fa-solid fa-spinner fa-spin text-2xl mb-2 block"></i>טוען עובדים...</td></tr>';

        try {
            // allEmployees is a top-level lexical variable in admin.js.
            let employees = (typeof allEmployees !== 'undefined' && Array.isArray(allEmployees)) ? allEmployees : [];
            if (!employees.length) {
                const data = await fetchJson('/api/employees');
                employees = Array.isArray(data) ? data : [];
                if (typeof allEmployees !== 'undefined') allEmployees = employees;
            }

            if (!employees.length) {
                tbody.innerHTML = '<tr><td colspan="5" class="text-center py-12 text-slate-400">אין עובדים במערכת.</td></tr>';
                return;
            }

            tbody.innerHTML = employees.map(emp => `
                <tr class="hover:bg-slate-50 dark:hover:bg-slate-700/40">
                    <td class="p-3 font-bold" data-label="שם העובד">${escape(emp.name || '')}${emp.is_active === false ? ' <span class="text-xs text-slate-400">(לא פעיל)</span>' : ''}</td>
                    <td class="p-3" data-label="מחלקה">${escape(emp.department || '-')}</td>
                    <td class="p-3" data-label="תפקיד">${escape(emp.role || '-')}</td>
                    <td class="p-3 font-mono" data-label="טלפון">${escape(emp.phone || '-')}</td>
                    <td class="p-3 font-mono font-black text-emerald-600 text-base" data-label="PIN">${escape(emp.pin_code || '-')}</td>
                </tr>`).join('');
        } catch (error) {
            showLoadError(tbody, error.message || 'לא ניתן לטעון את העובדים');
        }
    };
})();
