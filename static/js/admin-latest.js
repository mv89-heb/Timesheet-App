(function () {
    'use strict';

    async function loadLatestHours(empId, name) {
        const nameEl = document.getElementById('current-emp-name');
        const details = document.getElementById('emp-details-bar');
        const daysContainer = document.getElementById('month-grid-days');
        const tableWrap = document.getElementById('month-grid-table-wrap');
        const dayBtn = document.getElementById('hours-view-day-btn');
        const monthBtn = document.getElementById('hours-view-month-btn');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);

        currentEmpId = empId;
        currentEmpName = name || '';
        if (nameEl) nameEl.textContent = name || 'עובד';
        if (details) details.classList.remove('hidden');
        activeHoursDomainFilter = null;
        pendingCopySegments = {};

        // Cards are the default when an employee is selected.
        currentHoursView = 'day';
        dayBtn?.classList.add('bg-blue-600', 'text-white');
        dayBtn?.classList.remove('text-slate-500');
        monthBtn?.classList.remove('bg-blue-600', 'text-white');
        monthBtn?.classList.add('text-slate-500');
        tableWrap?.classList.add('hidden');
        daysContainer?.classList.remove('hidden');
        if (typeof renderHoursSkeleton === 'function') renderHoursSkeleton();

        try {
            const response = await fetch(`/api/shifts/${encodeURIComponent(empId)}/latest`, {
                cache: 'no-store',
                headers: { 'Accept': 'application/json' },
                signal: controller.signal
            });
            const raw = await response.text();
            let payload = null;
            try { payload = raw ? JSON.parse(raw) : null; } catch (_) {}
            if (!response.ok) throw new Error(payload?.error || payload?.message || `HTTP ${response.status}`);
            if (!payload || !Array.isArray(payload.shifts)) throw new Error('מבנה נתונים לא תקין מהשרת.');

            const month = payload.month || document.getElementById('month-picker')?.value || '';
            const picker = document.getElementById('month-picker');
            if (picker && month) picker.value = month;

            if (typeof currentShiftsMap !== 'undefined') {
                Object.keys(currentShiftsMap).forEach(d => { if (d.startsWith(month)) delete currentShiftsMap[d]; });
                const grouped = {};
                payload.shifts.forEach(row => {
                    if (!grouped[row.date]) grouped[row.date] = [];
                    grouped[row.date].push(row);
                });
                Object.entries(grouped).forEach(([date, rows]) => {
                    const segments = rows.map(row => ({
                        id: row.id,
                        domain_id: row.domain_id,
                        domain_name: row.domain_name || 'ללא תחום',
                        domain_color: row.domain_color || '#94a3b8',
                        entry: row.entry_time || '',
                        exit: row.exit_time || '',
                        total_hours: row.total_hours || 0,
                        notes: row.notes || '',
                        source: row.source || 'manual'
                    }));
                    currentShiftsMap[date] = {
                        date,
                        segments,
                        total_hours: segments.reduce((sum, s) => sum + Number(s.total_hours || 0), 0),
                        warnings: [],
                        is_anomaly: false
                    };
                });
            }

            // Re-assert card view immediately before every render.
            currentHoursView = 'day';
            tableWrap?.classList.add('hidden');
            daysContainer?.classList.remove('hidden');
            dayBtn?.classList.add('bg-blue-600', 'text-white');
            monthBtn?.classList.remove('bg-blue-600', 'text-white');
            renderHoursView();

            const emp = (typeof empDataMap !== 'undefined') ? empDataMap[empId] : null;
            const pin = document.getElementById('meta-pin');
            if (pin) pin.textContent = emp?.pin_code || '';

            if (typeof loadHebrewCalendarForMonth === 'function' && month) {
                Promise.resolve(loadHebrewCalendarForMonth(month))
                    .then(() => {
                        currentHoursView = 'day';
                        tableWrap?.classList.add('hidden');
                        daysContainer?.classList.remove('hidden');
                        renderHoursView();
                    })
                    .catch(err => console.warn('[admin-latest] Hebrew calendar skipped:', err));
            }

            if (!payload.shifts.length && daysContainer) {
                daysContainer.innerHTML = '<div class="text-center py-12 text-slate-400">אין דיווחי שעות לעובד זה.</div>';
            }
        } catch (error) {
            if (error?.name === 'AbortError') error = new Error('טעינת הדיווחים ארכה יותר מדי זמן.');
            if (daysContainer) {
                daysContainer.innerHTML = `<div class="text-center py-10 px-4 text-rose-600"><i class="fa-solid fa-triangle-exclamation text-3xl mb-3 block"></i><div class="font-bold mb-2">לא ניתן לטעון את הדיווחים</div><div class="text-sm text-slate-500">${String(error.message || 'שגיאה').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}</div></div>`;
            }
            tableWrap?.classList.add('hidden');
            console.error('[admin-latest] latest hours load failed', error);
        } finally {
            clearTimeout(timer);
        }
    }

    window.loadShiftsForGrid = loadLatestHours;
})();
