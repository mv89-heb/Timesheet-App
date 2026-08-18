(function () {
    'use strict';

    async function loadLatestHours(empId, name) {
        const nameEl = document.getElementById('current-emp-name');
        const details = document.getElementById('emp-details-bar');
        const daysContainer = document.getElementById('month-grid-days');
        const tableWrap = document.getElementById('month-grid-table-wrap');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);

        if (typeof currentEmpId !== 'undefined') currentEmpId = empId;
        if (typeof currentEmpName !== 'undefined') currentEmpName = name || '';
        if (nameEl) nameEl.textContent = name || 'עובד';
        if (details) details.classList.remove('hidden');

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

            // Calendar decorations must never block the actual hours report.
            if (typeof loadHebrewCalendarForMonth === 'function') {
                Promise.resolve(loadHebrewCalendarForMonth(month)).catch(err => console.warn('[admin-latest] Hebrew calendar skipped:', err));
            }

            if (typeof renderHoursView !== 'function') throw new Error('רכיב תצוגת השעות לא נטען.');
            renderHoursView();

            const emp = (typeof empDataMap !== 'undefined') ? empDataMap[empId] : null;
            const pin = document.getElementById('meta-pin');
            if (pin) pin.textContent = emp?.pin_code || '';

            if (!payload.shifts.length && daysContainer) {
                daysContainer.innerHTML = '<div class="text-center py-12 text-slate-400">אין דיווחי שעות לעובד זה.</div>';
                if (tableWrap) tableWrap.classList.add('hidden');
            }
        } catch (error) {
            if (daysContainer) {
                daysContainer.innerHTML = `<div class="text-center py-10 px-4 text-rose-600"><i class="fa-solid fa-triangle-exclamation text-3xl mb-3 block"></i><div class="font-bold mb-2">לא ניתן לטעון את הדיווחים</div><div class="text-sm text-slate-500">${String(error.message || 'שגיאה').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}</div></div>`;
            }
            if (tableWrap) tableWrap.classList.add('hidden');
            console.error('[admin-latest] latest hours load failed', error);
        } finally {
            clearTimeout(timer);
        }
    }

    // Employee selection always opens the most recently reported month.
    window.loadShiftsForGrid = loadLatestHours;
})();
