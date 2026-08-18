(function () {
    'use strict';

    // Do not rebuild the day card while the manager is typing.
    // The previous save flow fetched the row again and called refreshDayCard(),
    // which replaced the active input DOM after the debounce timer fired.
    const INPUT_SAVE_DEBOUNCE_MS = 1400;
    const timers = {};

    function showState(state) {
        if (typeof showSaveIndicator === 'function') showSaveIndicator(state);
    }

    function readSegments(dateStr) {
        const wrap = document.querySelector(`[data-day-segments="${dateStr}"]`);
        if (!wrap || typeof currentEmpId === 'undefined' || !currentEmpId) return null;
        const rows = Array.from(wrap.querySelectorAll('[data-segment-row]'));
        const segments = [];

        rows.forEach(row => {
            const q = field => row.querySelector(`[data-field="${field}"]`);
            const domain = q('domain_id');
            const entry = q('entry')?.value?.trim() || '';
            const exit = q('exit')?.value?.trim() || '';
            const notes = q('notes')?.value?.trim() || '';
            const totalInput = q('total_hours');
            let total = totalInput?.value?.trim() || '';

            if (entry && exit) {
                const toMinutes = value => {
                    const parts = value.split(':').map(Number);
                    if (parts.length !== 2 || parts.some(Number.isNaN)) return null;
                    return parts[0] * 60 + parts[1];
                };
                const a = toMinutes(entry), b = toMinutes(exit);
                if (a !== null && b !== null) {
                    let diff = b - a;
                    if (diff < 0) diff += 1440;
                    total = (diff / 60).toFixed(2);
                    if (totalInput && document.activeElement !== totalInput) totalInput.value = total;
                }
            }

            if (!entry && !exit && !total && !notes) return;

            segments.push({
                id: row.getAttribute('data-id') || '',
                domain_id: domain?.value || null,
                entry,
                exit,
                source: row.dataset.source || 'manual',
                total_hours: total || 0,
                notes
            });
        });
        return segments;
    }

    async function saveWithoutRerender(dateStr) {
        const segments = readSegments(dateStr);
        if (!segments || !currentEmpId) return;
        showState('saving');
        try {
            const response = await fetch('/api/shifts/upsert', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify({ employee_id: currentEmpId, date: dateStr, segments })
            });
            const raw = await response.text();
            let result = null;
            try { result = raw ? JSON.parse(raw) : null; } catch (_) {}
            if (!response.ok || !result?.success) {
                throw new Error(result?.error || `HTTP ${response.status}`);
            }

            // Keep the current DOM intact so the input the manager is typing into
            // never loses focus/value. Refresh the data map only in the background.
            if (typeof fetchDayFresh === 'function') {
                try { await fetchDayFresh(dateStr); } catch (_) {}
            }
            showState('saved');
        } catch (error) {
            console.error('[admin-input-fix] save failed:', error);
            showState('error');
        }
    }

    window.onSegmentFieldChange = function (el, dateStr) {
        const row = el?.closest?.('[data-segment-row]');
        if (row && typeof checkRowDirty === 'function') checkRowDirty(row);
        if (row && typeof renderRowValidation === 'function') renderRowValidation(row, dateStr);
        clearTimeout(timers[dateStr]);
        showState('saving');
        timers[dateStr] = setTimeout(() => saveWithoutRerender(dateStr), INPUT_SAVE_DEBOUNCE_MS);
    };

    window.flushAutoSave = function (dateStr) {
        clearTimeout(timers[dateStr]);
        delete timers[dateStr];
        return saveWithoutRerender(dateStr);
    };
})();
