function safeTippy(selector, opts) {
    if (typeof tippy === 'undefined') { console.warn('tippy.js לא נטען'); return; }
    try { tippy(selector, opts); } catch(e) {}
}
safeTippy('[data-tippy-content]', { animation: 'scale', theme: 'light-border', placement: 'bottom' });

let currentPin = '', selectedActionType = '', isProcessing = false, idleTimer;
let requestEmployeePin = '', requestEmployeeName = '';

// שעון חי
setInterval(() => {
    document.getElementById('clock').innerText = new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}, 1000);

function resetIdleTimer() {
    clearTimeout(idleTimer);
    const pinVisible = !document.getElementById('screen-pin').classList.contains('hidden');
    const domainVisible = !document.getElementById('screen-domain').classList.contains('hidden');
    const scopeVisible = !document.getElementById('screen-request-scope').classList.contains('hidden');
    const reqVisible = !document.getElementById('screen-request').classList.contains('hidden');
    const corrVisible = document.getElementById('screen-correction') && !document.getElementById('screen-correction').classList.contains('hidden');
    
    if (pinVisible || corrVisible) {
        idleTimer = setTimeout(() => { goBack(); }, 15000);
    } else if (domainVisible) {
        idleTimer = setTimeout(() => { goBackFromDomain(); }, 20000);
    } else if (scopeVisible || reqVisible) {
        idleTimer = setTimeout(() => { goBackFromRequest(); }, 60000);
    }
}

// ניהול ניווט בין מסכים
function selectAction(type) {
    if(isProcessing) return;
    selectedActionType = type;
    document.getElementById('screen-action').classList.add('hidden');
    document.getElementById('screen-pin').classList.remove('hidden');
    const titleEl = document.getElementById('action-title');
    
    if (type === 'entry') {
        titleEl.innerHTML = '<i class="fa-solid fa-arrow-right-to-bracket"></i> כניסה';
        titleEl.className = "text-lg font-bold px-4 py-1.5 rounded-full shadow-sm bg-emerald-100 text-emerald-800 border border-emerald-200";
    } else if (type === 'exit') {
        titleEl.innerHTML = '<i class="fa-solid fa-arrow-right-from-bracket"></i> יציאה';
        titleEl.className = "text-lg font-bold px-4 py-1.5 rounded-full shadow-sm bg-rose-100 text-rose-800 border border-rose-200";
    } else if (type === 'correction') {
        titleEl.innerHTML = '<i class="fa-solid fa-clock-rotate-left"></i> תיקון שעות';
        titleEl.className = "text-lg font-bold px-4 py-1.5 rounded-full shadow-sm bg-amber-100 text-amber-800 border border-amber-200";
    } else {
        titleEl.innerHTML = '<i class="fa-solid fa-calendar-plus"></i> בקשת שיבוץ';
        titleEl.className = "text-lg font-bold px-4 py-1.5 rounded-full shadow-sm bg-blue-100 text-blue-800 border border-blue-200";
    }
    clearPin();
    resetIdleTimer();
}

function goBack() {
    if (isProcessing) return;
    document.getElementById('screen-pin').classList.add('hidden');
    if(document.getElementById('screen-correction')) document.getElementById('screen-correction').classList.add('hidden');
    document.getElementById('screen-action').classList.remove('hidden');
    clearPin();
    clearTimeout(idleTimer);
}

function goBackFromRequest() {
    if (isProcessing) return;
    document.getElementById('screen-request-scope').classList.add('hidden');
    document.getElementById('screen-request').classList.add('hidden');
    document.getElementById('screen-action').classList.remove('hidden');
    requestEmployeePin = ''; requestEmployeeName = ''; selectedRequestDays = {}; requestScope = null;
    requestWeekOffset = 0; requestMonthOffset = 0;
    clearTimeout(idleTimer);
}

function goToRequestScopeScreen() {
    document.getElementById('screen-request').classList.add('hidden');
    document.getElementById('screen-request-scope').classList.remove('hidden');
    document.getElementById('request-scope-greeting').innerText = `שלום ${requestEmployeeName}, בחר טווח לבקשה:`;
    resetIdleTimer();
}

// =======================================================
// בקשות שיבוץ
// =======================================================
let requestScope = null, requestWeekOffset = 0, requestMonthOffset = 0, selectedRequestDays = {};
const requestDayNames = ["ראשון","שני","שלישי","רביעי","חמישי","שישי","שבת"];
const REQUEST_MEALS = [
    { key: 'breakfast', label: 'בוקר' },
    { key: 'lunch', label: 'צהריים' },
    { key: 'dinner', label: 'ערב' }
];

// התיקון: מבטיחים שהתאריך נבנה לפי זמן מקומי כדי למנוע קפיצות זמן
function toDateStr(d) {
    const y = d.getFullYear(); 
    const m = String(d.getMonth() + 1).padStart(2, '0'); 
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function parseLocalDate(dateStr) {
    const [y, m, d] = dateStr.split('-');
    return new Date(y, m - 1, d);
}

function chooseRequestScope(scope) {
    requestScope = scope; requestWeekOffset = 0; requestMonthOffset = 0; selectedRequestDays = {};
    document.getElementById('screen-request-scope').classList.add('hidden');
    document.getElementById('screen-request').classList.remove('hidden');
    document.getElementById('request-greeting').innerText = `שלום ${requestEmployeeName}, מלא את פרטי הבקשה:`;
    renderRequestDayPicker(); renderDayCards(); resetIdleTimer();
}

function changeRequestRange(delta) {
    if (requestScope === 'week') {
        const next = requestWeekOffset + delta; if (next < 0 || next > 8) return; requestWeekOffset = next;
    } else {
        const next = requestMonthOffset + delta; if (next < 0 || next > 2) return; requestMonthOffset = next;
    }
    renderRequestDayPicker();
}

function renderRequestDayPicker() {
    const prevBtn = document.getElementById('req-range-prev'), nextBtn = document.getElementById('req-range-next');
    if (requestScope === 'week') { prevBtn.disabled = requestWeekOffset <= 0; nextBtn.disabled = requestWeekOffset >= 8; renderRequestWeekDays(); } 
    else { prevBtn.disabled = requestMonthOffset <= 0; nextBtn.disabled = requestMonthOffset >= 2; renderRequestMonthDays(); }
    [prevBtn, nextBtn].forEach(btn => { btn.classList.toggle('opacity-30', btn.disabled); btn.classList.toggle('cursor-not-allowed', btn.disabled); });
}

function dayButtonClass(dateStr, isPast, isMonthView) {
    const shape = isMonthView ? "rounded-lg py-2 text-sm" : "rounded-xl py-2";
    if (isPast) return `req-day-btn border ${isMonthView ? '' : 'border-2'} border-slate-100 bg-slate-50 text-slate-300 ${shape} font-bold cursor-not-allowed`;
    if (selectedRequestDays[dateStr]) return `req-day-btn border-2 border-blue-600 bg-blue-50 text-blue-700 ${shape} font-bold`;
    return `req-day-btn border ${isMonthView ? '' : 'border-2'} border-slate-200 bg-white text-slate-600 ${shape} font-bold`;
}

function renderRequestWeekDays() {
    const today = new Date(); const sunday = new Date(today); sunday.setDate(today.getDate() - today.getDay() + (requestWeekOffset * 7));
    const container = document.getElementById('req-days-container'); container.innerHTML = '<div class="grid grid-cols-4 gap-2" id="req-week-days"></div>';
    const grid = document.getElementById('req-week-days'); const lastDay = new Date(sunday); lastDay.setDate(sunday.getDate() + 6);
    document.getElementById('req-range-label').innerText = `${sunday.getDate()}/${sunday.getMonth() + 1} - ${lastDay.getDate()}/${lastDay.getMonth() + 1}`;
    for (let i = 0; i < 7; i++) {
        const d = new Date(sunday); d.setDate(sunday.getDate() + i); const dateStr = toDateStr(d); const isPast = dateStr < toDateStr(today);
        const btn = document.createElement('button'); btn.type = 'button'; btn.id = `req-day-${dateStr}`; btn.disabled = isPast; btn.className = dayButtonClass(dateStr, isPast, false);
        btn.innerHTML = `<div class="text-sm">${requestDayNames[d.getDay()]}</div><div class="text-lg">${d.getDate()}/${d.getMonth() + 1}</div>`;
        if (!isPast) btn.onclick = () => toggleRequestDay(dateStr, d);
        grid.appendChild(btn);
    }
}

function renderRequestMonthDays() {
    const today = new Date(); const targetMonth = new Date(today.getFullYear(), today.getMonth() + requestMonthOffset, 1);
    const year = targetMonth.getFullYear(); const month = targetMonth.getMonth(); const daysInMonth = new Date(year, month + 1, 0).getDate(); const firstDow = targetMonth.getDay();
    const monthNames = ["ינואר","פברואר","מרץ","אפריל","מאי","יוני","יולי","אוגוסט","ספטמבר","אוקטובר","נובמבר","דצמבר"];
    document.getElementById('req-range-label').innerText = `${monthNames[month]} ${year}`;
    const container = document.getElementById('req-days-container');
    container.innerHTML = `<div class="grid grid-cols-7 gap-1 text-center text-xs font-bold text-slate-400 mb-1">${requestDayNames.map(n => `<div>${n[0]}</div>`).join('')}</div><div class="grid grid-cols-7 gap-1" id="req-month-days"></div>`;
    const grid = document.getElementById('req-month-days');
    for (let i = 0; i < firstDow; i++) grid.appendChild(document.createElement('div'));
    for (let day = 1; day <= daysInMonth; day++) {
        const d = new Date(year, month, day); const dateStr = toDateStr(d); const isPast = dateStr < toDateStr(today);
        const btn = document.createElement('button'); btn.type = 'button'; btn.id = `req-day-${dateStr}`; btn.disabled = isPast; btn.className = dayButtonClass(dateStr, isPast, true); btn.innerText = day;
        if (!isPast) btn.onclick = () => toggleRequestDay(dateStr, d);
        grid.appendChild(btn);
    }
}

function toggleRequestDay(dateStr, dateObj) {
    if (selectedRequestDays[dateStr]) delete selectedRequestDays[dateStr];
    else selectedRequestDays[dateStr] = { type: 'available', meals: { breakfast: true, lunch: true, dinner: true }, dow: dateObj.getDay() };
    const btn = document.getElementById(`req-day-${dateStr}`); if (btn) btn.className = dayButtonClass(dateStr, false, requestScope === 'month');
    renderDayCards();
}

function removeRequestDay(dateStr) { delete selectedRequestDays[dateStr]; const btn = document.getElementById(`req-day-${dateStr}`); if (btn) btn.className = dayButtonClass(dateStr, false, requestScope === 'month'); renderDayCards(); }
function setDayType(dateStr, type) { if (!selectedRequestDays[dateStr]) return; selectedRequestDays[dateStr].type = type; renderDayCards(); }
function toggleDayMeal(dateStr, mealKey) { const day = selectedRequestDays[dateStr]; if (!day) return; day.meals[mealKey] = !day.meals[mealKey]; renderDayCards(); }

function renderDayCards() {
    const container = document.getElementById('req-day-cards'); const dates = Object.keys(selectedRequestDays).sort();
    if (!dates.length) { container.innerHTML = ''; return; }
    container.innerHTML = dates.map(dateStr => {
        const day = selectedRequestDays[dateStr]; const d = parseLocalDate(dateStr); const dow = d.getDay(); const dateLabel = `${requestDayNames[dow]} ${d.getDate()}/${d.getMonth() + 1}`;
        const mealButtons = REQUEST_MEALS.map(m => {
            const on = day.meals[m.key]; const cls = on ? "flex-1 border-2 border-blue-500 bg-blue-50 text-blue-700 rounded-lg py-2 text-xs font-bold" : "flex-1 border border-slate-200 bg-white text-slate-400 rounded-lg py-2 text-xs font-bold";
            return `<button type="button" onclick="toggleDayMeal('${dateStr}','${m.key}')" class="${cls}">${m.label}</button>`;
        }).join('');
        const availCls = day.type === 'available' ? "flex-1 border-2 border-emerald-500 bg-emerald-50 text-emerald-700 rounded-lg py-1.5 text-xs font-bold" : "flex-1 border border-slate-200 bg-white text-slate-400 rounded-lg py-1.5 text-xs font-bold";
        const unavailCls = day.type === 'unavailable' ? "flex-1 border-2 border-rose-500 bg-rose-50 text-rose-700 rounded-lg py-1.5 text-xs font-bold" : "flex-1 border border-slate-200 bg-white text-slate-400 rounded-lg py-1.5 text-xs font-bold";
        return `
            <div class="border border-slate-200 rounded-xl p-3 bg-slate-50">
                <div class="flex justify-between items-center mb-2"><span class="font-bold text-slate-700">${dateLabel}</span><button type="button" onclick="removeRequestDay('${dateStr}')" class="text-rose-500 hover:text-rose-700 text-sm"><i class="fa-solid fa-circle-xmark"></i> הסר</button></div>
                <div class="flex gap-2 mb-2"><button type="button" onclick="setDayType('${dateStr}','available')" class="${availCls}">זמין</button><button type="button" onclick="setDayType('${dateStr}','unavailable')" class="${unavailCls}">לא זמין</button></div>
                <div class="flex gap-2">${mealButtons}</div>
            </div>
        `;
    }).join('');
}

function submitShiftRequest() {
    if (isProcessing) return;
    const dates = Object.keys(selectedRequestDays); if (!dates.length) return Swal.fire('שגיאה', 'נא לבחור לפחות יום אחד', 'error');
    const note = document.getElementById('req-note').value.trim(); const payloads = []; let hasEmptyDay = false;
    dates.forEach(dateStr => {
        const day = selectedRequestDays[dateStr]; const activeMeals = REQUEST_MEALS.filter(m => day.meals[m.key]).map(m => m.key);
        if (!activeMeals.length) { hasEmptyDay = true; return; }
        if (activeMeals.length === 3) payloads.push({ pin: requestEmployeePin, date: dateStr, meal: 'all', request_type: day.type, note });
        else activeMeals.forEach(mealKey => { payloads.push({ pin: requestEmployeePin, date: dateStr, meal: mealKey, request_type: day.type, note }); });
    });
    if (hasEmptyDay) return Swal.fire('שגיאה', 'יש יום שנבחר בלי אף ארוחה מסומנת', 'error');

    isProcessing = true; clearTimeout(idleTimer);
    Promise.all(payloads.map(payload => fetch('/api/kiosk/shift_request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then(r => r.json())))
    .then(results => {
        const failed = results.filter(r => !r.success); const successName = (results.find(r => r.success) || {}).name || requestEmployeeName;
        if (!failed.length) {
            Swal.fire({ title: `תודה, ${successName}`, text: `${payloads.length} בקשות שיבוץ נשלחו ויבדקו על ידי המנהל`, icon: 'success', timer: 3000, showConfirmButton: false }).then(() => {
                isProcessing = false; document.getElementById('req-note').value = ''; selectedRequestDays = {}; goBackFromRequest();
            });
        } else Swal.fire('שגיאה חלקית', 'חלק מהבקשות לא נשלחו.', 'warning').then(() => { isProcessing = false; });
    }).catch(() => { Swal.fire('תקלה', 'לא ניתן להתחבר לשרת.', 'error').then(() => { isProcessing = false; }); });
}

// =======================================================
// ניהול ה-Numpad וההתחברות
// =======================================================
function updateDots() { for (let i = 1; i <= 4; i++) { const dot = document.getElementById(`dot-${i}`); if (i <= currentPin.length) dot.classList.add('filled'); else dot.classList.remove('filled'); } }
function press(digit) { resetIdleTimer(); if (isProcessing || currentPin.length >= 4) return; currentPin += digit; updateDots(); if (currentPin.length === 4) submitPin(); }
function clearPin() { resetIdleTimer(); if (isProcessing) return; currentPin = ''; updateDots(); }
function backspace() { resetIdleTimer(); if (isProcessing || currentPin.length === 0) return; currentPin = currentPin.slice(0, -1); updateDots(); }

function submitPin() {
    if(isProcessing) return; isProcessing = true; clearTimeout(idleTimer);

    if (selectedActionType === 'request' || selectedActionType === 'correction') {
        fetch('/api/kiosk/validate_pin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: currentPin }) })
        .then(r => r.json()).then(data => {
            isProcessing = false;
            if (data.success) {
                requestEmployeePin = currentPin; requestEmployeeName = data.name;
                document.getElementById('screen-pin').classList.add('hidden');
                if (selectedActionType === 'request') {
                    document.getElementById('screen-request-scope').classList.remove('hidden');
                    document.getElementById('request-scope-greeting').innerText = `שלום ${data.name}, בחר טווח לבקשה:`;
                } else if (selectedActionType === 'correction') {
                    showCorrectionScreen(data.name);
                }
                clearPin(); resetIdleTimer();
            } else Swal.fire({ title: 'שגיאה', text: data.message, icon: 'error', timer: 3000, showConfirmButton: true, confirmButtonText: 'הבנתי' }).then(() => { goBack(); });
        }).catch(() => { Swal.fire('תקלה', 'לא ניתן להתחבר לשרת.', 'error').then(() => { isProcessing = false; goBack(); }); });
        return;
    }

    if (selectedActionType === 'entry') {
        fetch('/api/kiosk/validate_pin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: currentPin }) })
        .then(r => r.json()).then(data => {
            isProcessing = false;
            if (data.success) { punchEmployeePin = currentPin; showDomainScreen(data.name); } 
            else Swal.fire({ title: 'שגיאה', text: data.message, icon: 'error', timer: 3000, showConfirmButton: true, confirmButtonText: 'הבנתי' }).then(() => { goBack(); });
        }).catch(() => { Swal.fire('תקלה', 'לא ניתן להתחבר לשרת.', 'error').then(() => { isProcessing = false; goBack(); }); });
        return;
    }

    fetch('/api/kiosk/punch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: currentPin, action_type: selectedActionType }) })
    .then(r => r.json()).then(data => {
        if (data.success) {
            let iconType = data.action.includes('כניסה') ? 'success' : 'info';
            const domainLine = data.domain ? `<div class="text-sm mt-1 text-slate-500 font-bold">תחום: ${data.domain}</div>` : '';
            Swal.fire({ title: `שלום, ${data.name}`, html: `<div class="text-3xl mt-2 font-black ${selectedActionType === 'entry' ? 'text-emerald-600' : 'text-rose-600'}">${data.action} התקבלה</div><div class="text-lg mt-2 text-slate-500 font-bold">השעה: ${data.time}</div>${domainLine}`, icon: iconType, timer: 2500, showConfirmButton: false, backdrop: `rgba(0,0,0,0.4)` }).then(() => { isProcessing = false; goBack(); });
        } else Swal.fire({ title: 'שגיאה', text: data.message, icon: 'error', timer: 3500, showConfirmButton: true, confirmButtonText: 'הבנתי' }).then(() => { isProcessing = false; goBack(); });
    }).catch(err => { Swal.fire('תקלה', 'לא ניתן להתחבר לשרת.', 'error').then(() => { isProcessing = false; goBack(); }); });
}

let punchEmployeePin = '', punchEmployeeName = '';
function showDomainScreen(empName) {
    punchEmployeeName = empName;
    document.getElementById('screen-pin').classList.add('hidden'); document.getElementById('screen-domain').classList.remove('hidden');
    document.getElementById('domain-greeting').innerText = `שלום ${empName}, נא לבחור תחום עבודה:`;
    const container = document.getElementById('domain-buttons'); container.innerHTML = '<div class="text-center text-slate-400 py-4"><i class="fa-solid fa-spinner fa-spin"></i> טוען תחומים...</div>';

    fetch('/api/kiosk/domains', { cache: 'no-store' }).then(r => r.json()).then(domains => {
        if (!Array.isArray(domains) || domains.length === 0) { container.innerHTML = '<div class="text-center text-rose-500 font-bold py-4">לא הוגדרו תחומי עבודה במערכת. יש לפנות למנהל.</div>'; return; }
        container.innerHTML = domains.map(d => `<button type="button" onclick="confirmDomainAndPunch(${d.id})" class="action-btn py-5 rounded-2xl flex items-center justify-center gap-3 shadow-md border-2 font-black text-xl" style="background-color:${d.color}15; border-color:${d.color}; color:${d.color};"><i class="fa-solid fa-briefcase"></i> ${d.name}</button>`).join('');
    }).catch(() => { container.innerHTML = '<div class="text-center text-rose-500 font-bold py-4">שגיאה בטעינת תחומי עבודה.</div>'; });
    resetIdleTimer();
}

function goBackFromDomain() {
    if (isProcessing) return;
    document.getElementById('screen-domain').classList.add('hidden'); document.getElementById('screen-action').classList.remove('hidden');
    punchEmployeePin = ''; punchEmployeeName = ''; clearTimeout(idleTimer);
}

function confirmDomainAndPunch(domainId) {
    if (isProcessing) return; isProcessing = true;
    fetch('/api/kiosk/punch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: punchEmployeePin, action_type: 'entry', domain_id: domainId }) })
    .then(r => r.json()).then(data => {
        if (data.success) {
            const domainLine = data.domain ? `<div class="text-sm mt-1 text-slate-500 font-bold">תחום: ${data.domain}</div>` : '';
            Swal.fire({ title: `שלום, ${data.name}`, html: `<div class="text-3xl mt-2 font-black text-emerald-600">${data.action} התקבלה</div><div class="text-lg mt-2 text-slate-500 font-bold">השעה: ${data.time}</div>${domainLine}`, icon: 'success', timer: 2500, showConfirmButton: false, backdrop: `rgba(0,0,0,0.4)` }).then(() => { isProcessing = false; document.getElementById('screen-domain').classList.add('hidden'); document.getElementById('screen-action').classList.remove('hidden'); punchEmployeePin = ''; punchEmployeeName = ''; clearTimeout(idleTimer); });
        } else Swal.fire({ title: 'שגיאה', text: data.message, icon: 'error', timer: 3500, showConfirmButton: true, confirmButtonText: 'הבנתי' }).then(() => { isProcessing = false; goBackFromDomain(); });
    }).catch(() => { Swal.fire('תקלה', 'לא ניתן להתחבר לשרת.', 'error').then(() => { isProcessing = false; goBackFromDomain(); }); });
}

// התיקון: בדיקה שאכן הגיעו תחומי עבודה מהשרת (כדי למנוע תקיעה של מסך התיקון)
function showCorrectionScreen(empName) {
    document.getElementById('screen-correction').classList.remove('hidden');
    document.getElementById('correction-greeting').innerText = `שלום ${empName}, השלם את פרטי המשמרת החסרה:`;
    document.getElementById('corr-date').value = new Date().toISOString().split('T')[0];
    
    fetch('/api/kiosk/domains', { cache: 'no-store' }).then(r => r.json()).then(domains => {
        const select = document.getElementById('corr-domain');
        if (Array.isArray(domains) && domains.length > 0) {
            select.innerHTML = domains.map(d => `<option value="${d.id}">${d.name}</option>`).join('');
        } else {
            select.innerHTML = `<option value="">לא הוגדרו תחומים במערכת</option>`;
        }
    }).catch(() => {
        document.getElementById('corr-domain').innerHTML = `<option value="">שגיאה בטעינת תחומים</option>`;
    });
    resetIdleTimer();
}

function submitCorrectionRequest() {
    const date = document.getElementById('corr-date').value; const entry = document.getElementById('corr-entry').value; const exit = document.getElementById('corr-exit').value; const domain_id = document.getElementById('corr-domain').value; const reason = document.getElementById('corr-reason').value;
    if (!date || !entry || !exit || !domain_id) return Swal.fire('שגיאה', 'יש למלא את כל שדות החובה המסומנים בכוכבית (*)', 'error');
    
    isProcessing = true; clearTimeout(idleTimer);
    fetch('/api/kiosk/time_correction', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: requestEmployeePin, date, entry, exit, domain_id, reason }) }).then(r => r.json()).then(data => {
        isProcessing = false;
        if(data.success) { Swal.fire({ title: 'תודה', text: 'בקשתך הועברה לאישור מנהל', icon: 'success', timer: 3000, showConfirmButton: false }).then(() => { document.getElementById('corr-entry').value = ''; document.getElementById('corr-exit').value = ''; document.getElementById('corr-reason').value = ''; goBack(); }); } 
        else { Swal.fire('שגיאה', data.message, 'error').then(resetIdleTimer); }
    }).catch(() => { isProcessing = false; Swal.fire('תקלה', 'לא ניתן להתחבר לשרת', 'error').then(resetIdleTimer); });
}

document.addEventListener('keydown', (e) => {
    if (document.getElementById('screen-pin').classList.contains('hidden')) return;
    if (e.key >= '0' && e.key <= '9') press(e.key);
    if (e.key === 'Backspace') backspace();
    if (e.key === 'Escape' || e.key === 'Delete') clearPin();
});
