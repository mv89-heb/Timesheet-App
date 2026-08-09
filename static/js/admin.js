let myChart = null, allEmployees = [], empDataMap = {}, currentShiftsMap = {}, currentEmpId = null, currentEmpName = "";
const dayNames = ['א\'', 'ב\'', 'ג\'', 'ד\'', 'ה\'', 'ו\'', 'שבת'];

const _origFetch = window.fetch;
window.fetch = function(url, opts) {
    return _origFetch(url, opts).then(res => {
        if (res.status === 401 && typeof url === 'string' && url.startsWith('/api/') && !url.includes('/api/login') && !url.includes('/api/check_auth')) {
            document.getElementById('main-app').classList.add('hidden'); document.getElementById('main-app').classList.remove('flex');
            document.getElementById('login-screen').classList.remove('hidden');
        }
        return res;
    });
};

function toggleDarkMode() { document.documentElement.classList.toggle('dark'); localStorage.setItem('theme', document.documentElement.classList.contains('dark') ? 'dark' : 'light'); if(myChart) myChart.update(); }
if (localStorage.getItem('theme') === 'dark') document.documentElement.classList.add('dark');

function safeTippy(selector, opts) {
    if (typeof tippy === 'undefined') { console.warn('tippy.js לא נטען'); return; }
    try { tippy(selector, opts); } catch(e) {}
}

function showSuccessToast(title, html, durationMs) {
    Swal.fire({
        toast: true, position: 'top', icon: 'success', title: title,
        html: html || undefined, showConfirmButton: false, timer: durationMs || 3000,
        timerProgressBar: true,
        didOpen: (toastEl) => { toastEl.addEventListener('mouseenter', Swal.stopTimer); toastEl.addEventListener('mouseleave', Swal.resumeTimer); }
    });
}

document.addEventListener('DOMContentLoaded', () => {
    const now = new Date(); 
    const currentMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    document.getElementById('month-picker').value = currentMonthStr;
    document.getElementById('schedule-month-picker').value = currentMonthStr;
    document.getElementById('requests-month-picker').value = currentMonthStr;
    document.getElementById('corrections-month-picker').value = currentMonthStr;
    
    fetch('/api/check_auth', { cache: 'no-store' }).then(r=>r.json()).then(d => {
        if(d.logged_in) {
            document.getElementById('login-screen').classList.add('hidden');
            document.getElementById('main-app').classList.remove('hidden'); document.getElementById('main-app').classList.add('flex');
            switchTab('dashboard'); loadDomains(); loadEmployees(); refreshRequestsBadge(); loadTimeCorrections(); safeTippy('[data-tippy-content]');
        }
    });
});

function performLogin() { 
    const payload = {
        password: document.getElementById('login-password').value,
        phone: document.getElementById('login-password').value,
        pin: document.getElementById('login-password').value
    };
    fetch('/api/login', {
        method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)
    }).then(r => r.json()).then(res => {
        if(res.success) {
            document.getElementById('login-screen').classList.add('hidden');
            document.getElementById('main-app').classList.remove('hidden'); document.getElementById('main-app').classList.add('flex');
            switchTab('dashboard'); loadDomains(); loadEmployees(); refreshRequestsBadge(); loadTimeCorrections();
        } else {
            Swal.fire('שגיאה', 'פרטי התחברות שגויים', 'error');
        }
    }).catch(() => Swal.fire('שגיאה', 'בעיית תקשורת. בדוק חיבור לשרת.', 'error')); 
}

function performLogout() { fetch('/api/logout', {method:'POST'}).then(() => { window.location.href = '/?refresh=' + new Date().getTime(); }); }

function switchTab(tabId) {
    ['dashboard', 'hours', 'schedule', 'requests', 'corrections', 'pins', 'settings'].forEach(t => { 
        document.getElementById(`content-${t}`).classList.add('hidden'); document.getElementById(`content-${t}`).classList.remove('flex'); 
        document.getElementById(`tab-${t}`).classList.remove('text-blue-600', 'border-blue-600'); document.getElementById(`tab-${t}`).classList.add('text-slate-500', 'border-transparent'); 
    });
    const targetEl = document.getElementById(`content-${tabId}`); targetEl.classList.remove('hidden');
    if(tabId === 'hours' || tabId === 'schedule') targetEl.classList.add('flex');
    document.getElementById(`tab-${tabId}`).classList.remove('text-slate-500', 'border-transparent'); document.getElementById(`tab-${tabId}`).classList.add('text-blue-600', 'border-blue-600');
    
    if(tabId === 'dashboard') { renderDashboardSkeleton(); loadDashboard(); loadDashboardTrend(); }
    if(tabId === 'schedule') loadSchedule();
    if(tabId === 'requests') loadShiftRequests();
    if(tabId === 'corrections') loadTimeCorrections();
    if(tabId === 'pins') renderPinsTable();
    if(tabId === 'settings') loadSettingsTab();
}

// ----------------- DASHBOARD -----------------

const LIVE_SHIFT_WARNING_HOURS = 10;
let mainPollInterval = null;
let liveTimerInterval = null;

function skeletonBlocks(count, heightClass) {
    return Array.from({ length: count }).map(() => `<div class="animate-pulse bg-slate-100 dark:bg-slate-700/50 rounded-xl ${heightClass}"></div>`).join('');
}

function renderDashboardSkeleton() {
    const health = document.getElementById('dash-health-strip'); if (health && !health.dataset.loaded) health.innerHTML = skeletonBlocks(4, 'h-16');
    const action = document.getElementById('action-center-cards'); if (action && !action.dataset.loaded) action.innerHTML = skeletonBlocks(3, 'h-24');
    const cards = document.getElementById('dash-domain-cards'); if (cards && !cards.dataset.loaded) cards.innerHTML = skeletonBlocks(4, 'h-28');
    const live = document.getElementById('live-employees-list'); if (live && !live.dataset.loaded) live.innerHTML = skeletonBlocks(3, 'h-16');
}

function elapsedSinceEntry(entryTime) {
    if (!entryTime) return null;
    const [h, mnt] = entryTime.split(':').map(Number);
    if (isNaN(h) || isNaN(mnt)) return null;
    const now = new Date();
    let diffMinutes = (now.getHours() * 60 + now.getMinutes()) - (h * 60 + mnt);
    if (diffMinutes < 0) diffMinutes += 24 * 60;
    return { text: `${String(Math.floor(diffMinutes / 60)).padStart(2, '0')}:${String(diffMinutes % 60).padStart(2, '0')}`, hours: diffMinutes / 60 };
}

function updateLiveTimers() {
    document.querySelectorAll('[data-live-entry]').forEach(el => {
        const elapsed = elapsedSinceEntry(el.dataset.liveEntry);
        if (!elapsed) return;
        el.textContent = elapsed.text;
        const warn = elapsed.hours >= LIVE_SHIFT_WARNING_HOURS;
        el.classList.toggle('text-rose-600', warn); el.classList.toggle('dark:text-rose-400', warn);
        el.classList.toggle('text-emerald-600', !warn); el.classList.toggle('dark:text-emerald-400', !warn);
    });
}

function loadDashboard() {
    fetch('/api/dashboard', { cache: 'no-store' }).then(r=>r.json()).then(d => {
        const healthContainer = document.getElementById('dash-health-strip');
        if (healthContainer) {
            healthContainer.dataset.loaded = '1';
            const totalOpenShifts = (d.live_employees ? d.live_employees.length : 0) + d.action_center.past_open_shifts;
            healthContainer.innerHTML = `
                <div class="bg-white dark:bg-slate-800 border dark:border-slate-700 rounded-xl p-3 flex items-center gap-3">
                    <i class="fa-solid fa-tower-broadcast text-emerald-500 text-xl"></i>
                    <div><div class="text-2xl font-black">${d.live_employees ? d.live_employees.length : 0}</div><div class="text-[11px] text-slate-400 font-bold">עובדים פעילים כרגע</div></div>
                </div>
                <div class="bg-white dark:bg-slate-800 border dark:border-slate-700 rounded-xl p-3 flex items-center gap-3">
                    <i class="fa-solid fa-hourglass-half text-rose-500 text-xl"></i>
                    <div><div class="text-2xl font-black">${totalOpenShifts}</div><div class="text-[11px] text-slate-400 font-bold">משמרות פתוחות</div></div>
                </div>
                <div class="bg-white dark:bg-slate-800 border dark:border-slate-700 rounded-xl p-3 flex items-center gap-3">
                    <i class="fa-solid fa-inbox text-blue-500 text-xl"></i>
                    <div><div class="text-2xl font-black">${d.action_center.pending_requests}</div><div class="text-[11px] text-slate-400 font-bold">בקשות שיבוץ ממתינות</div></div>
                </div>
                <div class="bg-white dark:bg-slate-800 border dark:border-slate-700 rounded-xl p-3 flex items-center gap-3">
                    <i class="fa-solid fa-clock-rotate-left text-amber-500 text-xl"></i>
                    <div><div class="text-2xl font-black">${d.action_center.pending_corrections}</div><div class="text-[11px] text-slate-400 font-bold">תיקוני שעות ממתינים</div></div>
                </div>
            `;
        }

        const actionContainer = document.getElementById('action-center-cards');
        if(actionContainer) {
            actionContainer.dataset.loaded = '1';
            actionContainer.innerHTML = `
                <div class="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 p-5 rounded-xl flex items-center justify-between shadow-sm cursor-pointer hover:bg-amber-100 transition" onclick="switchTab('corrections')">
                    <div><h3 class="font-bold text-amber-800 dark:text-amber-400">תיקוני שעות</h3><p class="text-sm text-amber-600">ממתינים לאישור</p></div>
                    <div class="text-4xl font-black text-amber-500">${d.action_center.pending_corrections}</div>
                </div>
                <div class="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700 p-5 rounded-xl flex items-center justify-between shadow-sm cursor-pointer hover:bg-blue-100 transition" onclick="switchTab('requests')">
                    <div><h3 class="font-bold text-blue-800 dark:text-blue-400">בקשות שיבוץ</h3><p class="text-sm text-blue-600">ממתינות לטיפול</p></div>
                    <div class="text-4xl font-black text-blue-500">${d.action_center.pending_requests}</div>
                </div>
                <div class="bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-700 p-5 rounded-xl flex items-center justify-between shadow-sm cursor-pointer hover:bg-rose-100 transition" onclick="switchTab('hours')">
                    <div><h3 class="font-bold text-rose-800 dark:text-rose-400">משמרות פתוחות</h3><p class="text-sm text-rose-600">מאתמול אחורה</p></div>
                    <div class="text-4xl font-black text-rose-500">${d.action_center.past_open_shifts}</div>
                </div>
            `;
        }

        const liveContainer = document.getElementById('live-employees-list');
        if (liveContainer) {
            liveContainer.dataset.loaded = '1';
            if (!d.live_employees || d.live_employees.length === 0) {
                liveContainer.innerHTML = '<div class="text-center py-8 text-slate-400 text-sm"><i class="fa-solid fa-mug-hot text-2xl mb-2 block"></i>אין עובדים מחוברים כרגע.</div>';
            } else {
                liveContainer.innerHTML = d.live_employees.map(emp => {
                    const elapsed = elapsedSinceEntry(emp.entry_time);
                    return `
                    <div class="flex justify-between items-center bg-slate-50 dark:bg-slate-700/50 border border-slate-100 dark:border-slate-600 p-3 rounded-lg hover:border-blue-300 transition-colors">
                        <div>
                            <div class="font-bold text-slate-800 dark:text-white">${emp.first_name} ${emp.last_name}</div>
                            <div class="text-[10px] font-bold px-2 py-0.5 rounded-full inline-block mt-1" style="background-color:${emp.domain_color}22; color:${emp.domain_color}">${emp.domain_name || 'ללא תחום'}</div>
                        </div>
                        <div class="text-left bg-white dark:bg-slate-800 px-3 py-1.5 rounded shadow-sm border border-slate-100 dark:border-slate-700">
                            <div class="text-[10px] text-slate-400 font-bold mb-0.5">במשמרת כבר</div>
                            <div class="font-mono font-black text-sm text-emerald-600 dark:text-emerald-400" data-live-entry="${emp.entry_time}" title="החל מ-${emp.entry_time}">${elapsed ? elapsed.text : emp.entry_time}</div>
                        </div>
                    </div>
                `;}).join('');
                updateLiveTimers();
            }
        }

        const cardsContainer = document.getElementById('dash-domain-cards');
        const icons = ['fa-regular fa-clock', 'fa-solid fa-wrench', 'fa-solid fa-broom', 'fa-solid fa-utensils', 'fa-solid fa-briefcase'];
        if(cardsContainer) {
            cardsContainer.dataset.loaded = '1';
            cardsContainer.innerHTML = (d.domains_summary || []).map((dom, i) => `
                <div class="bg-white dark:bg-slate-800 p-4 rounded-2xl shadow-sm border dark:border-slate-700 border-t-4 flex flex-col justify-between h-full" style="border-top-color:${dom.color}">
                    <div class="flex justify-between items-start"><span class="text-slate-500 font-bold text-sm">שעות ${dom.name}</span><i class="${icons[i % icons.length]}" style="color:${dom.color}"></i></div>
                    <div class="text-3xl font-black mt-2" style="color:${dom.color}">${dom.hours}</div>
                    <div class="text-[10px] text-slate-400 mt-2 space-y-0.5 border-t dark:border-slate-700 pt-2">
                        <div><i class="fa-solid fa-user-check"></i> ${dom.active_employees_count} עבדו בפועל החודש (מתוך ${dom.employees_count} משויכים)</div>
                        <div><i class="fa-solid fa-calculator"></i> ממוצע ${dom.avg_hours_per_employee} שעות/עובד</div>
                    </div>
                </div>
            `).join('') || '<div class="text-slate-400 text-sm col-span-4 text-center py-4">אין תחומי עבודה.</div>';
        }

        const forecastNote = document.getElementById('dash-forecast-note');
        if (forecastNote) {
            if (d.forecast) {
                forecastNote.classList.remove('hidden');
                forecastNote.innerHTML = `<i class="fa-solid fa-chart-line"></i> <b>תחזית לסוף החודש (הערכה):</b> כ-${d.forecast.hours} שעות וכ-${d.forecast.shifts} משמרות סה"כ
                    <span class="cursor-help text-slate-400" data-tippy-content="חושב לפי הקצב היומי הממוצע עד כה: ${d.total_hours} שעות ב-${d.forecast.days_elapsed} ימים שחלפו, מוקרן על ${d.forecast.days_in_month} ימים בחודש. זו הערכה בלבד ולא מספר סופי.">
                        <i class="fa-solid fa-circle-info"></i>
                    </span>`;
                safeTippy('[data-tippy-content]', { allowHTML: false, theme: 'light-border' });
            } else {
                forecastNote.classList.add('hidden');
            }
        }

        const skelH = document.getElementById('hoursChart-skeleton'); if (skelH) skelH.classList.add('hidden');
        document.getElementById('hoursChart').classList.remove('hidden');
        const ctx = document.getElementById('hoursChart').getContext('2d');
        if(myChart) {
            myChart.data.labels = d.chart_data.map(i => i.name); myChart.data.datasets[0].data = d.chart_data.map(i => i.hours);
            myChart.data.datasets[0].backgroundColor = d.chart_data.map(i => i.color || '#6366f1'); myChart.update();
        } else {
            myChart = new Chart(ctx, { type: 'bar', data: { labels: d.chart_data.map(i => i.name), datasets: [{ label: 'סה"כ שעות (החודש)', data: d.chart_data.map(i => i.hours), backgroundColor: d.chart_data.map(i => i.color || '#6366f1'), borderRadius: 6 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } } });
        }
        
        const correctionsBadge = document.getElementById('corrections-badge');
        if(correctionsBadge) { if(d.action_center.pending_corrections > 0) { correctionsBadge.classList.remove('hidden'); correctionsBadge.textContent = d.action_center.pending_corrections; } else { correctionsBadge.classList.add('hidden'); } }
    });
}

let trendChart = null;
function loadDashboardTrend() {
    fetch('/api/dashboard/trend?months=6', { cache: 'no-store' }).then(r => r.json()).then(d => {
        const skelT = document.getElementById('trendChart-skeleton'); if (skelT) skelT.classList.add('hidden');
        document.getElementById('trendChart').classList.remove('hidden');
        const ctx = document.getElementById('trendChart').getContext('2d');
        const opts = {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: { rtl: true, callbacks: { label: (item) => `${item.parsed.y} שעות` } } },
            scales: { y: { beginAtZero: true } }
        };
        if (trendChart) {
            trendChart.data.labels = d.months; trendChart.data.datasets[0].data = d.total_hours; trendChart.update();
        } else {
            trendChart = new Chart(ctx, { type: 'line', data: { labels: d.months, datasets: [{ label: 'שעות עבודה', data: d.total_hours, borderColor: '#6366f1', backgroundColor: '#6366f122', fill: true, tension: 0.3, pointRadius: 4, pointBackgroundColor: '#6366f1' }] }, options: opts });
        }
    });
}

function openOrgSummaryModal() {
    const monthVal = document.getElementById('month-picker').value || document.getElementById('schedule-month-picker').value;
    fetch(`/api/shifts/summary?month=${monthVal}`, { cache: 'no-store' }).then(r => r.json()).then(d => {
        const domainRows = (d.domains_summary || []).map(dom => `<div class="flex items-center justify-between border-b py-2"><span class="font-bold flex items-center gap-2"><span class="w-2.5 h-2.5 rounded-full inline-block" style="background-color:${dom.color}"></span>${dom.name}</span><span class="font-bold text-indigo-600">${dom.hours} שעות</span></div>`).join('') || '<div class="text-slate-400 text-sm">אין תחומים מוגדרים.</div>';
        const empRows = (d.chart_data || []).sort((a, b) => b.hours - a.hours).map(emp => `<div class="flex items-center justify-between text-sm py-1.5 border-b border-dashed"><span>${emp.name} <span class="text-xs text-slate-400">(${emp.domain || '-'})</span></span><span class="font-bold">${emp.hours}</span></div>`).join('') || '<div class="text-slate-400 text-sm">אין נתונים.</div>';
        Swal.fire({ title: `סיכום ארגוני - ${monthVal}`, html: `<div class="text-right"><p class="text-lg mb-2">📌 סה"כ שעות בכל הארגון: <span class="font-bold text-blue-600">${d.total_hours}</span></p><h4 class="font-bold mt-4 mb-1">לפי תחום:</h4>${domainRows}<h4 class="font-bold mt-4 mb-1">לפי עובד:</h4><div class="max-h-52 overflow-y-auto">${empRows}</div></div>`, width: 600, confirmButtonText: 'סגור' });
    });
}

// ----------------- EMPLOYEES & DOMAINS -----------------
let allDomains = [];

function loadDomains() {
    return fetch('/api/domains', { cache: 'no-store' }).then(r => r.json()).then(domains => {
        allDomains = Array.isArray(domains) ? domains : [];
        populateEmpDeptDropdown(); renderEmployees(allEmployees);
        if (!document.getElementById('content-settings').classList.contains('hidden')) renderDomainsAdmin();
        return allDomains;
    });
}

function loadEmployees() {
    fetch('/api/employees', { cache: 'no-store' }).then(r=>r.json()).then(emps => { 
        allEmployees = emps; empDataMap = {}; 
        const datalist = document.getElementById('employee-names-list'); datalist.innerHTML = '';
        emps.forEach(e => { empDataMap[e.id] = e; datalist.innerHTML += `<option value="${e.name}">`; });
        renderEmployees(emps);
        if (!document.getElementById('content-pins').classList.contains('hidden')) renderPinsTable();
    });
}

function populateEmpDeptDropdown() {
    const select = document.getElementById('emp-dept'); const current = select.value;
    select.innerHTML = allDomains.filter(d => d.active || d.name === current).map(d => `<option value="${d.name}">${d.name}${!d.active ? ' (מבוטל)' : ''}</option>`).join('');
    if (current) select.value = current;
}

function domainColor(name) { const d = allDomains.find(x => x.name === name); return d ? d.color : '#94a3b8'; }
function filterEmployees() { renderEmployees(allEmployees.filter(e => e.name.toLowerCase().includes(document.getElementById('emp-search').value.toLowerCase()))); }

function renderEmployees(emps) {
    const container = document.getElementById('employees-list-container'); if (!container) return;
    const groups = {}; const groupOrder = [];
    (allDomains.length ? allDomains.map(d => d.name) : []).forEach(name => { groups[name] = []; groupOrder.push(name); });
    emps.forEach(emp => { const key = emp.department || 'ללא תחום'; if (!(key in groups)) { groups[key] = []; groupOrder.push(key); } groups[key].push(emp); });

    container.innerHTML = groupOrder.filter(name => groups[name].length > 0).map(name => `
        <div>
            <h3 class="font-bold text-xs mb-2" style="color:${domainColor(name)}">${name}</h3>
            <div class="space-y-2">
                ${groups[name].map(emp => `
                    <div class="flex justify-between items-center bg-slate-50 dark:bg-slate-700/50 border rounded-lg p-1 hover:border-blue-300">
                        <button onclick="loadShiftsForGrid(${emp.id}, '${emp.name}')" class="flex-grow text-right py-2 px-2 text-sm focus:text-blue-600 font-medium ${!emp.is_active ? 'text-slate-400 line-through' : ''}">${emp.name} ${!emp.is_active ? '<span class="text-[10px] bg-slate-200 text-slate-500 px-1 rounded ml-1">לא פעיל</span>' : ''}</button>
                        <button onclick="openEmpModal(${emp.id})" class="text-blue-400 hover:text-blue-600 p-2"><i class="fa-solid fa-pen"></i></button>
                        <button onclick="deleteEmp(${emp.id}, '${emp.name}')" class="text-red-400 hover:text-red-600 p-2"><i class="fa-solid fa-trash-can"></i></button>
                    </div>
                `).join('')}
            </div>
        </div>
    `).join('') || '<div class="text-slate-400 text-sm text-center py-6">לא נמצאו עובדים.</div>';
}

function openEmpModal(id) {
    const form = document.getElementById('emp-form'); form.reset(); populateEmpDeptDropdown();
    document.getElementById('emp-permission').value = 'worker'; document.getElementById('emp-active').checked = true;

    if(id){
        const emp = empDataMap[id]; if(!emp) return;
        document.getElementById('emp-edit-id').value = emp.id;
        document.getElementById('emp-modal-title').innerHTML = '<i class="fa-solid fa-user-pen"></i> עריכת פרטי עובד';
        document.getElementById('emp-submit-btn').textContent = 'עדכן פרטים';
        const nameParts = (emp.name || '').trim().split(' ');
        document.getElementById('emp-fname').value = nameParts[0] || ''; document.getElementById('emp-lname').value = nameParts.slice(1).join(' ') || '';
        document.getElementById('emp-phone').value = emp.phone && emp.phone !== '-' ? emp.phone : '';
        document.getElementById('emp-dept').value = emp.department || (allDomains[0] ? allDomains[0].name : '');
        document.getElementById('emp-role').value = emp.role && emp.role !== '-' ? emp.role : '';
        document.getElementById('emp-permission').value = emp.permission_level || 'worker';
        document.getElementById('emp-active').checked = emp.is_active !== false;
    } else {
        document.getElementById('emp-edit-id').value = '';
        document.getElementById('emp-modal-title').innerHTML = '<i class="fa-solid fa-user-plus"></i> הוספת עובד חדש';
        document.getElementById('emp-submit-btn').textContent = 'שמור';
    }
    document.getElementById('emp-modal').classList.remove('hidden');
}

document.getElementById('emp-form').onsubmit = e => {
    e.preventDefault();
    const editId = document.getElementById('emp-edit-id').value;
    const payload = { 
        first_name: document.getElementById('emp-fname').value, last_name: document.getElementById('emp-lname').value, 
        phone: document.getElementById('emp-phone').value, department: document.getElementById('emp-dept').value, 
        role: document.getElementById('emp-role').value, permission_level: document.getElementById('emp-permission').value,
        is_active: document.getElementById('emp-active').checked
    };
    fetch(editId ? `/api/employees/${editId}` : '/api/employees', { method: editId ? 'PUT' : 'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) })
    .then(r => r.json()).then(res => {
        if(res.success) {
            document.getElementById('emp-modal').classList.add('hidden'); loadEmployees();
            if(editId){ showSuccessToast('הפרטים עודכנו'); if(currentEmpId == editId) loadShiftsForGrid(parseInt(editId), payload.first_name + ' ' + payload.last_name); } 
            else { showSuccessToast('עובד נוסף בהצלחה', `קוד גישה KIOSK: <b class="text-2xl text-blue-600 block mt-1">${res.pin}</b>`, 6000); }
        } else { Swal.fire('שגיאה', res.error || 'הפעולה נכשלה', 'error'); }
    }).catch(() => Swal.fire('שגיאה', 'בעיית תקשורת', 'error'));
};

function deleteEmp(id, name) {
    Swal.fire({ title: `למחוק את ${name}?`, html: '<div class="text-right text-rose-600 text-sm">שימו לב: מחיקת העובד תמחק לצמיתות גם את כל שעות העבודה שנרשמו עבורו.</div>', icon: 'warning', showCancelButton: true, confirmButtonText: 'מחק לצמיתות', cancelButtonText: 'ביטול', confirmButtonColor: '#e11d48'
    }).then(res => { if(res.isConfirmed) fetch(`/api/employees/${id}`, {method:'DELETE'}).then(()=>{loadEmployees(); loadDashboard(); if(currentEmpId === id){ document.getElementById('month-grid-days').innerHTML = '<div class="text-center py-12 text-slate-400">יש לבחור עובד.</div>'; document.getElementById('month-grid-table-wrap').innerHTML = '<div class="text-center py-12 text-slate-400">יש לבחור עובד.</div>'; document.getElementById('hours-domain-tabs').innerHTML = ''; document.getElementById('emp-details-bar').classList.add('hidden'); currentEmpId = null; } }); }); 
}

// ----------------- SHIFTS & HOURS -----------------
let currentHebrewCalendar = {};
let activeHoursDomainFilter = null;
let currentHoursView = 'month';
let pendingCopySegments = {};   
let saveDebounceTimers = {};    
let deletedSegmentUndo = null;  
const AUTO_SAVE_DEBOUNCE_MS = 700;
const UNDO_WINDOW_MS = 6000;

function loadShiftsForGrid(id, name) {
    currentEmpId = id; currentEmpName = name;
    document.getElementById('current-emp-name').innerHTML = name; document.getElementById('meta-pin').textContent = empDataMap[id].pin_code;
    document.getElementById('emp-details-bar').classList.remove('hidden'); activeHoursDomainFilter = null; pendingCopySegments = {};
    renderHoursSkeleton();
    const monthVal = document.getElementById('month-picker').value;
    Promise.all([fetchMonthShifts(id, monthVal), loadHebrewCalendarForMonth(monthVal)]).then(renderHoursView);
}

function fetchMonthShifts(empId, monthVal) {
    return fetch(`/api/shifts/${empId}?month=${monthVal}`, { cache: 'no-store' }).then(r => r.json()).then(shifts => {
        Object.keys(currentShiftsMap).filter(d => d.startsWith(monthVal)).forEach(d => delete currentShiftsMap[d]);
        shifts.forEach(s => { currentShiftsMap[s.date] = s; });
    });
}

function fetchDayIfMissing(dateStr) {
    if (currentShiftsMap[dateStr]) return Promise.resolve(currentShiftsMap[dateStr]);
    const monthOfDate = dateStr.slice(0, 7);
    return fetch(`/api/shifts/${currentEmpId}?month=${monthOfDate}`, { cache: 'no-store' }).then(r => r.json()).then(shifts => {
        shifts.forEach(s => { currentShiftsMap[s.date] = s; });
        return currentShiftsMap[dateStr] || null;
    });
}

function fetchDayFresh(dateStr) {
    const monthOfDate = dateStr.slice(0, 7);
    return fetch(`/api/shifts/${currentEmpId}?month=${monthOfDate}`, { cache: 'no-store' }).then(r => r.json()).then(shifts => {
        Object.keys(currentShiftsMap).filter(d => d.startsWith(monthOfDate)).forEach(d => delete currentShiftsMap[d]);
        shifts.forEach(s => { currentShiftsMap[s.date] = s; });
    });
}

function loadHebrewCalendarForMonth(monthVal) {
    if (!monthVal) return Promise.resolve();
    return fetch(`/api/hebrew_calendar?month=${monthVal}`, { cache: 'no-store' }).then(r => r.json()).then(d => { currentHebrewCalendar = d.days || {}; }).catch(() => { currentHebrewCalendar = {}; });
}

function onMonthPickerChange() {
    if (!currentEmpId) return;
    pendingCopySegments = {}; renderHoursSkeleton();
    const monthVal = document.getElementById('month-picker').value;
    Promise.all([fetchMonthShifts(currentEmpId, monthVal), loadHebrewCalendarForMonth(monthVal)]).then(renderHoursView);
}
function shiftHoursMonth(delta) { const picker = document.getElementById('month-picker'); if (!picker.value) return; const [y, m] = picker.value.split('-').map(Number); const d = new Date(y, m - 1 + delta, 1); picker.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; onMonthPickerChange(); }
function jumpToCurrentHoursMonth() { const now = new Date(); document.getElementById('month-picker').value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`; onMonthPickerChange(); }

function renderHoursSkeleton() {
    const days = document.getElementById('month-grid-days'); if (days) days.innerHTML = skeletonBlocks(5, 'h-24');
    const tbl = document.getElementById('month-grid-table-wrap'); if (tbl) tbl.innerHTML = skeletonBlocks(6, 'h-10');
}

function switchHoursView(view) {
    currentHoursView = view;
    document.getElementById('hours-view-month-btn').className = `text-xs px-3 py-1.5 rounded-md font-bold ${view === 'month' ? 'bg-blue-600 text-white' : 'text-slate-500'}`;
    document.getElementById('hours-view-day-btn').className = `text-xs px-3 py-1.5 rounded-md font-bold ${view === 'day' ? 'bg-blue-600 text-white' : 'text-slate-500'}`;
    document.getElementById('month-grid-table-wrap').classList.toggle('hidden', view !== 'month'); document.getElementById('month-grid-days').classList.toggle('hidden', view !== 'day'); renderHoursView();
}

function renderHoursView() {
    if (!currentEmpId) return;
    renderHoursDomainTabs(); renderHoursSummaryBar(); renderPendingCopyBanner();
    if (currentHoursView === 'day') renderMonthGrid(); else renderMonthTable();
}

function jumpToDayCard(dateStr) { switchHoursView('day'); setTimeout(() => { const el = document.getElementById(`day-card-${dateStr}`); if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('ring-2', 'ring-blue-400'); setTimeout(() => el.classList.remove('ring-2', 'ring-blue-400'), 1500); } }, 50); }
function emptySegment() { return { domain_id: (allDomains[0] ? allDomains[0].id : null), entry: '', exit: '', total_hours: '', notes: '', source: 'manual' }; }

const HOLIDAY_CATEGORY_STYLE = { chag: { bg: '#fef3c7', color: '#92400e', label: '' }, erev_chag: { bg: '#fef9c3', color: '#854d0e', label: '' }, chol_hamoed: { bg: '#e0f2fe', color: '#075985', label: 'חוה"מ ' }, fast: { bg: '#e2e8f0', color: '#334155', label: 'צום: ' } };
const SOURCE_BADGE = { kiosk: { icon: 'fa-solid fa-desktop', label: 'קיוסק', color: '#0ea5e9' }, manual: { icon: 'fa-solid fa-pen', label: 'הזנה ידנית', color: '#8b5cf6' }, legacy: { icon: 'fa-solid fa-clock-rotate-left', label: 'היסטורי', color: '#94a3b8' }, correction: { icon: 'fa-solid fa-user-check', label: 'אישור תיקון עובד', color: '#f59e0b' } };
function sourceBadgeHtml(source) { const s = SOURCE_BADGE[source] || SOURCE_BADGE.manual; return `<span class="text-xs" style="color:${s.color}" title="מקור: ${s.label}"><i class="${s.icon}"></i></span>`; }

function renderHoursDomainTabs() {
    const monthVal = document.getElementById('month-picker').value; if (!monthVal) return;
    const [year, month] = monthVal.split('-'); const daysInMonth = new Date(year, month, 0).getDate();
    const domainMonthTotals = {};
    for (let d = 1; d <= daysInMonth; d++) {
        const s = currentShiftsMap[`${year}-${month}-${String(d).padStart(2, '0')}`];
        if (s) (s.segments || []).forEach(seg => { const dname = seg.domain_name || 'ללא תחום'; domainMonthTotals[dname] = (domainMonthTotals[dname] || 0) + parseFloat(seg.total_hours || 0); });
    }
    const tabsContainer = document.getElementById('hours-domain-tabs'); const tabNames = Object.keys(domainMonthTotals);
    if (!tabNames.length) { tabsContainer.innerHTML = ''; return; }
    const allTab = `<button onclick="activeHoursDomainFilter=null; renderHoursView();" class="px-3 py-1.5 rounded-full text-xs font-bold border ${activeHoursDomainFilter === null ? 'bg-blue-600 text-white border-blue-600' : 'bg-slate-50 dark:bg-slate-700 border-slate-200 dark:border-slate-600'}">הכל</button>`;
    const domainTabs = tabNames.map(name => { const c = domainColor(name); const active = activeHoursDomainFilter === name; return `<button onclick="activeHoursDomainFilter='${name.replace(/'/g, "\\'")}'; renderHoursView();" class="px-3 py-1.5 rounded-full text-xs font-bold border" style="${active ? `background-color:${c};color:white;border-color:${c}` : `background-color:${c}15;color:${c};border-color:${c}55`}">${name} (${domainMonthTotals[name].toFixed(1)})</button>`; }).join('');
    tabsContainer.innerHTML = allTab + domainTabs;
}

function renderHoursSummaryBar() {
    const bar = document.getElementById('hours-summary-bar'); if (!bar) return;
    const monthVal = document.getElementById('month-picker').value; if (!monthVal) { bar.innerHTML = ''; return; }
    let workDays = 0, shiftCount = 0, totalHours = 0;
    Object.keys(currentShiftsMap).filter(d => d.startsWith(monthVal)).forEach(d => {
        const s = currentShiftsMap[d];
        const segs = activeHoursDomainFilter ? (s.segments || []).filter(x => x.domain_name === activeHoursDomainFilter) : (s.segments || []);
        if (segs.length) { workDays++; shiftCount += segs.length; totalHours += segs.reduce((sum, x) => sum + parseFloat(x.total_hours || 0), 0); }
    });
    bar.innerHTML = `<div class="flex flex-wrap gap-3 text-sm mb-3">
        <div class="bg-indigo-50 dark:bg-indigo-900/30 px-3 py-1.5 rounded-lg border border-indigo-100"><span class="text-indigo-500">סה"כ שעות:</span> <b class="text-indigo-700">${totalHours.toFixed(2)}</b></div>
        <div class="bg-slate-50 dark:bg-slate-700 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-600"><span class="text-slate-500">ימי עבודה:</span> <b>${workDays}</b></div>
        <div class="bg-slate-50 dark:bg-slate-700 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-600"><span class="text-slate-500">משמרות:</span> <b>${shiftCount}</b></div>
    </div>`;
}

function renderPendingCopyBanner() {
    const el = document.getElementById('hours-pending-banner'); if (!el) return;
    const dates = Object.keys(pendingCopySegments);
    if (!dates.length || currentHoursView !== 'day') { el.classList.add('hidden'); el.innerHTML = ''; return; }
    el.classList.remove('hidden');
    el.innerHTML = `<div class="flex items-center justify-between bg-amber-50 dark:bg-amber-900/20 border border-amber-300 rounded-lg px-4 py-2 mb-3">
        <span class="text-amber-800 dark:text-amber-300 font-bold text-sm"><i class="fa-solid fa-clone"></i> ${dates.length} ${dates.length === 1 ? 'יום ממתין' : 'ימים ממתינים'} לאישור העתקה</span>
        <div class="flex gap-2"><button onclick="commitAllPendingCopies()" class="bg-emerald-600 text-white text-xs px-3 py-1.5 rounded-lg font-bold">💾 שמור הכל</button><button onclick="cancelAllPendingCopies()" class="bg-white dark:bg-slate-700 border text-xs px-3 py-1.5 rounded-lg font-bold">✖ בטל הכל</button></div>
    </div>`;
}
function commitAllPendingCopies() { Object.keys(pendingCopySegments).forEach(d => commitPendingCopy(d)); }
function cancelAllPendingCopies() { Object.keys(pendingCopySegments).forEach(d => cancelPendingCopy(d)); }

function renderMonthTable() {
    if (!currentEmpId) return; const monthVal = document.getElementById('month-picker').value; if (!monthVal) return;
    const [year, month] = monthVal.split('-'); const daysInMonth = new Date(year, month, 0).getDate();
    const wrap = document.getElementById('month-grid-table-wrap'); let totalMonthHoursLocal = 0; let rowsHtml = '';
    for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${year}-${month}-${String(d).padStart(2, '0')}`; const dayOfWeek = new Date(year, parseInt(month) - 1, d).getDay(); const isWeekend = dayOfWeek === 5 || dayOfWeek === 6;
        const s = currentShiftsMap[dateStr] || { segments: [], warnings: [] };
        const segments = activeHoursDomainFilter ? (s.segments || []).filter(seg => seg.domain_name === activeHoursDomainFilter) : (s.segments || []);
        if (activeHoursDomainFilter && segments.length === 0) continue;
        totalMonthHoursLocal += segments.reduce((sum, seg) => sum + parseFloat(seg.total_hours || 0), 0);
        const dayTotal = segments.reduce((sum, seg) => sum + parseFloat(seg.total_hours || 0), 0);
        const isAnomaly = (s.warnings || []).length > 0;
        const heInfo = currentHebrewCalendar[String(d)];
        let heCell = '<span class="text-slate-300">-</span>';
        if (heInfo) { const style = HOLIDAY_CATEGORY_STYLE[heInfo.category] || { bg: 'transparent', color: '#94a3b8', label: '' }; heCell = `<span class="text-xs text-slate-400">${heInfo.hebrew_date}</span>` + (heInfo.holiday ? `<br><span class="text-xs font-bold px-1.5 py-0.5 rounded" style="background-color:${style.bg};color:${style.color}">${style.label}${heInfo.holiday}</span>` : ''); }
        const rowClass = isAnomaly ? 'bg-rose-50/60 dark:bg-rose-900/10' : (isWeekend ? 'bg-orange-50/40 dark:bg-orange-900/5' : '');
        const shiftsCell = segments.length ? segments.map(seg => `<div class="flex items-center gap-1.5 whitespace-nowrap"><span class="w-2 h-2 rounded-full inline-block" style="background-color:${seg.domain_color}"></span><span class="font-bold">${seg.domain_name}</span><span class="text-slate-500">${seg.entry || '--:--'}–${seg.exit || '--:--'}</span><span class="text-indigo-600 font-bold">(${parseFloat(seg.total_hours || 0).toFixed(2)})</span>${sourceBadgeHtml(seg.source)}</div>`).join('') : '<span class="text-slate-300 text-xs">אין משמרות</span>';
        const warningIcon = isAnomaly ? `<span class="cursor-pointer text-red-500 hover:text-red-700 mr-1" data-tippy-content="<div class='text-right'><b>⚠️ חריגות:</b><br>${(s.warnings||[]).join('<br>')}</div>" data-tippy-allowHTML="true"><i class="fa-solid fa-circle-exclamation"></i></span>` : '';
        rowsHtml += `<tr class="border-b dark:border-slate-700 cursor-pointer hover:bg-blue-50 dark:hover:bg-slate-700/60 ${rowClass}" onclick="jumpToDayCard('${dateStr}')"><td class="p-2 font-bold whitespace-nowrap ${isWeekend ? 'text-orange-500' : 'text-slate-500'}">${dayNames[dayOfWeek]}</td><td class="p-2 font-medium whitespace-nowrap">${warningIcon}${dateStr}</td><td class="p-2 whitespace-nowrap">${heCell}</td><td class="p-2">${shiftsCell}</td><td class="p-2 font-bold text-indigo-600 whitespace-nowrap">${dayTotal.toFixed(2)}</td><td class="p-2 text-left"><button onclick="event.stopPropagation(); jumpToDayCard('${dateStr}')" class="text-xs bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300 px-2 py-1 rounded-lg font-bold hover:bg-blue-100"><i class="fa-solid fa-plus"></i> משמרת</button></td></tr>`;
    }
    wrap.innerHTML = `<table class="w-full text-right border-collapse text-sm"><thead class="bg-slate-50 dark:bg-slate-700/50 border-b sticky top-0 z-10"><tr><th class="p-2 w-14">יום</th><th class="p-2 w-28">תאריך</th><th class="p-2 w-32">לוח עברי</th><th class="p-2">משמרות</th><th class="p-2 w-20 text-indigo-600">סה"כ</th><th class="p-2 w-24"></th></tr></thead><tbody>${rowsHtml || `<tr><td colspan="6" class="text-center py-10 text-slate-400">אין נתונים.</td></tr>`}</tbody></table>`;
    document.getElementById('meta-hours').textContent = totalMonthHoursLocal.toFixed(2);
    safeTippy('[data-tippy-content]', { allowHTML: true, theme: 'light-border' });
}

function renderMonthGrid() {
    if (!currentEmpId) return; const monthVal = document.getElementById('month-picker').value; if (!monthVal) return;
    const [year, month] = monthVal.split('-'); const daysInMonth = new Date(year, month, 0).getDate();
    const container = document.getElementById('month-grid-days'); container.innerHTML = ''; let totalMonthHoursLocal = 0; let anyRendered = false;
    for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${year}-${month}-${String(d).padStart(2, '0')}`;
        const isPending = !!pendingCopySegments[dateStr];
        const s = currentShiftsMap[dateStr];
        const segments = isPending ? pendingCopySegments[dateStr] : (s && s.segments ? s.segments : []);
        const filteredSegments = (!isPending && activeHoursDomainFilter) ? segments.filter(seg => seg.domain_name === activeHoursDomainFilter) : segments;
        if (!isPending && activeHoursDomainFilter && filteredSegments.length === 0) continue;
        totalMonthHoursLocal += filteredSegments.reduce((sum, seg) => sum + parseFloat(seg.total_hours || 0), 0);
        container.appendChild(buildDayCardElement(dateStr));
        anyRendered = true;
    }
    if (!anyRendered) container.innerHTML = '<div class="text-center py-12 text-slate-400">אין נתונים להצגה.</div>';
    document.getElementById('meta-hours').textContent = totalMonthHoursLocal.toFixed(2);
    safeTippy('[data-tippy-content]', { allowHTML: true, theme: 'light-border' });
}

function buildDayCardElement(dateStr) {
    const [year, month, dayStr] = dateStr.split('-'); const d = parseInt(dayStr);
    const dayOfWeek = new Date(year, parseInt(month) - 1, d).getDay(); const isWeekend = dayOfWeek === 5 || dayOfWeek === 6;
    const isPending = !!pendingCopySegments[dateStr];
    const s = currentShiftsMap[dateStr] || { segments: [], warnings: [] };
    const segments = isPending ? pendingCopySegments[dateStr] : (s.segments && s.segments.length ? s.segments : []);
    const filteredSegments = (!isPending && activeHoursDomainFilter) ? segments.filter(seg => seg.domain_name === activeHoursDomainFilter) : segments;
    const warningsArray = isPending ? [] : (s.warnings || []); const isAnomaly = warningsArray.length > 0;
    const dayTotal = filteredSegments.reduce((sum, seg) => sum + parseFloat(seg.total_hours || 0), 0);
    const heInfo = currentHebrewCalendar[String(d)]; let heBadge = '';
    if (heInfo) { const style = HOLIDAY_CATEGORY_STYLE[heInfo.category] || { bg: '#f1f5f9', color: '#475569', label: '' }; const holidayPart = heInfo.holiday ? `<span class="px-1.5 py-0.5 rounded font-bold" style="background-color:${style.bg};color:${style.color}">${style.label}${heInfo.holiday}</span>` : ''; heBadge = `<span class="text-xs text-slate-400">${heInfo.hebrew_date}</span> ${holidayPart}`; }
    const cardClass = isPending ? "border-amber-300 bg-amber-50/60 dark:bg-amber-900/10" : (isAnomaly ? "border-rose-300 bg-rose-50/60 dark:bg-rose-900/10" : (isWeekend ? "border-orange-200 bg-orange-50/40 dark:bg-orange-900/5" : "border-slate-200 dark:border-slate-700"));
    const warningIcon = isAnomaly ? `<span class="cursor-pointer text-red-500 hover:text-red-700" data-tippy-content="<div class='text-right'><b>⚠️ חריגות שזוהו:</b><br>${warningsArray.join('<br>')}</div>" data-tippy-allowHTML="true"><i class="fa-solid fa-circle-exclamation animate-pulse"></i></span>` : '';
    const pendingBadge = isPending ? `<span class="text-[10px] font-bold bg-amber-200 text-amber-800 px-2 py-0.5 rounded-full">ממתין לאישור</span>` : '';
    const segRows = (filteredSegments.length ? filteredSegments : [emptySegment()]).map(seg => renderSegmentRow(dateStr, seg)).join('');

    const card = document.createElement('div'); card.id = `day-card-${dateStr}`; card.className = `border rounded-xl p-3 transition-shadow ${cardClass}`;
    card.innerHTML = `<div class="flex items-center justify-between flex-wrap gap-2 mb-2">
        <div class="flex items-center gap-2 flex-wrap"><span class="font-bold ${isWeekend && !isAnomaly ? 'text-orange-500' : (isAnomaly ? 'text-red-500' : 'text-slate-500')}">${dayNames[dayOfWeek]}</span><span class="font-medium">${dateStr}</span>${heBadge}${warningIcon}${pendingBadge}</div>
        <div class="flex items-center gap-2 flex-wrap">
            <span class="text-xs text-slate-400">סה"כ יום:</span><span class="font-bold text-indigo-600">${dayTotal.toFixed(2)}</span>
            ${isPending ? `
                <button onclick="commitPendingCopy('${dateStr}')" class="text-xs bg-emerald-600 text-white px-2 py-1 rounded-lg font-bold hover:bg-emerald-700">💾 שמור</button>
                <button onclick="cancelPendingCopy('${dateStr}')" class="text-xs bg-slate-200 dark:bg-slate-600 px-2 py-1 rounded-lg font-bold">✖ בטל</button>
            ` : `
                <div class="relative" data-day-menu>
                    <button onclick="toggleDayMenu(this)" class="text-xs bg-slate-100 dark:bg-slate-700 px-2 py-1 rounded-lg font-bold hover:bg-slate-200" title="פעולות העתקה"><i class="fa-solid fa-copy"></i></button>
                    <div class="hidden absolute left-0 mt-1 bg-white dark:bg-slate-800 border dark:border-slate-600 rounded-lg shadow-lg z-20 w-48 text-xs" data-day-menu-list>
                        <button onclick="copyFromYesterday('${dateStr}'); closeDayMenus();" class="w-full text-right px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-700">העתק מאתמול</button>
                        <button onclick="duplicateFromDatePrompt('${dateStr}'); closeDayMenus();" class="w-full text-right px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-700 border-t dark:border-slate-700">העתק מיום אחר</button>
                        <button onclick="smartCopyPrompt('${dateStr}'); closeDayMenus();" class="w-full text-right px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-700 border-t dark:border-slate-700">העתק לימים נוספים</button>
                    </div>
                </div>
                <button onclick="addSegmentRow('${dateStr}')" class="text-xs bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300 px-2 py-1 rounded-lg font-bold hover:bg-blue-100"><i class="fa-solid fa-plus"></i> משמרת</button>
            `}
        </div>
    </div><div class="space-y-1.5" data-day-segments="${dateStr}">${segRows}</div>`;
    return card;
}

function toggleDayMenu(btn) { document.querySelectorAll('[data-day-menu-list]').forEach(el => { if (el !== btn.nextElementSibling) el.classList.add('hidden'); }); btn.nextElementSibling.classList.toggle('hidden'); }
function closeDayMenus() { document.querySelectorAll('[data-day-menu-list]').forEach(el => el.classList.add('hidden')); }
document.addEventListener('click', (e) => { if (!e.target.closest('[data-day-menu]')) closeDayMenus(); });

function renderSegmentRow(dateStr, seg) {
    const domainOptions = allDomains.map(d => `<option value="${d.id}" ${String(seg.domain_id) === String(d.id) ? 'selected' : ''}>${d.name}${!d.active ? ' (מבוטל)' : ''}</option>`).join('');
    const originalRaw = JSON.stringify({ domain_id: seg.domain_id != null ? String(seg.domain_id) : '', entry: seg.entry || '', exit: seg.exit || '', total_hours: seg.total_hours || '', notes: seg.notes || '' });
    const original = originalRaw.replace(/'/g, '&#39;');
    return `<div class="flex flex-wrap items-start gap-2 bg-slate-50 dark:bg-slate-700/40 rounded-lg p-2 transition-shadow" data-segment-row data-source="${seg.source || 'manual'}" data-original='${original}'>
        ${sourceBadgeHtml(seg.source || 'manual')}
        <select class="grid-input w-32" data-field="domain_id" onchange="onSegmentFieldChange(this, '${dateStr}')" onkeydown="onSegmentFieldKeydown(event, '${dateStr}')">${domainOptions}</select>
        <input type="time" class="grid-input w-28" data-field="entry" value="${seg.entry || ''}" oninput="onSegmentFieldChange(this, '${dateStr}')" onkeydown="onSegmentFieldKeydown(event, '${dateStr}')">
        <span class="text-slate-400 text-xs pt-2">עד</span>
        <input type="time" class="grid-input w-28" data-field="exit" value="${seg.exit || ''}" oninput="onSegmentFieldChange(this, '${dateStr}')" onkeydown="onSegmentFieldKeydown(event, '${dateStr}')">
        <input type="number" step="0.01" class="grid-input w-20 font-bold text-indigo-600" data-field="total_hours" value="${seg.total_hours || ''}" placeholder="שעות" oninput="onSegmentFieldChange(this, '${dateStr}')" onkeydown="onSegmentFieldKeydown(event, '${dateStr}')">
        <input type="text" class="grid-input flex-grow min-w-[8rem]" data-field="notes" value="${seg.notes || ''}" placeholder="הערות" oninput="onSegmentFieldChange(this, '${dateStr}')" onkeydown="onSegmentFieldKeydown(event, '${dateStr}')">
        <button type="button" onclick="removeSegmentRow(this, '${dateStr}')" class="text-red-400 hover:text-red-600 p-1"><i class="fa-solid fa-trash-can"></i></button>
        <div data-row-hint class="w-full text-[11px] text-amber-600 dark:text-amber-400 font-bold"></div>
    </div>`;
}

function checkRowDirty(row) {
    let original = {}; try { original = JSON.parse(row.dataset.original || '{}'); } catch (e) {}
    const current = { domain_id: row.querySelector('[data-field="domain_id"]').value, entry: row.querySelector('[data-field="entry"]').value, exit: row.querySelector('[data-field="exit"]').value, total_hours: row.querySelector('[data-field="total_hours"]').value, notes: row.querySelector('[data-field="notes"]').value };
    const dirty = JSON.stringify(original) !== JSON.stringify(current);
    row.classList.toggle('ring-2', dirty); row.classList.toggle('ring-amber-300', dirty);
    return dirty;
}

function renderRowValidation(row, dateStr) {
    const wrap = row.closest('[data-day-segments]'); const allRows = wrap ? Array.from(wrap.querySelectorAll('[data-segment-row]')) : [row];
    const entry = row.querySelector('[data-field="entry"]').value, exit = row.querySelector('[data-field="exit"]').value, domainId = row.querySelector('[data-field="domain_id"]').value;
    const warnings = [];
    const t2d = (t) => { const [h, m] = t.split(':').map(Number); return h + m / 60; };
    if (entry && exit) {
        let diff = t2d(exit) - t2d(entry); const crossesMidnight = diff < 0; if (crossesMidnight) diff += 24;
        if (diff === 0) warnings.push('משך משמרת אפס');
        if (diff > 16) warnings.push('משמרת ארוכה במיוחד (מעל 16 שעות)');
        if (crossesMidnight && diff > 12) warnings.push('יציאה לפני כניסה - ודאו שזו משמרת שחוצה חצות');
    }
    if (!domainId) warnings.push('לא נבחר תחום עבודה');
    if (entry && exit) {
        let s1 = t2d(entry), e1 = t2d(exit); if (e1 < s1) e1 += 24;
        for (const other of allRows) {
            if (other === row) continue;
            const oe = other.querySelector('[data-field="entry"]').value, ox = other.querySelector('[data-field="exit"]').value;
            if (!oe || !ox) continue;
            let s2 = t2d(oe), e2 = t2d(ox); if (e2 < s2) e2 += 24;
            if (s1 < e2 && s2 < e1) { warnings.push('חפיפת זמנים עם משמרת אחרת באותו יום'); break; }
        }
    }
    const hint = row.querySelector('[data-row-hint]');
    if (hint) hint.innerHTML = warnings.length ? `<i class="fa-solid fa-triangle-exclamation"></i> ${warnings.join(' · ')}` : '';
}

function onSegmentFieldChange(el, dateStr) {
    const row = el.closest('[data-segment-row]');
    checkRowDirty(row); renderRowValidation(row, dateStr); scheduleAutoSave(dateStr);
}

function onSegmentFieldKeydown(e, dateStr) {
    if (e.key !== 'Escape') return;
    const row = e.target.closest('[data-segment-row]');
    let original = {}; try { original = JSON.parse(row.dataset.original || '{}'); } catch (err) {}
    row.querySelector('[data-field="domain_id"]').value = original.domain_id || '';
    row.querySelector('[data-field="entry"]').value = original.entry || '';
    row.querySelector('[data-field="exit"]').value = original.exit || '';
    row.querySelector('[data-field="total_hours"]').value = original.total_hours || '';
    row.querySelector('[data-field="notes"]').value = original.notes || '';
    checkRowDirty(row); renderRowValidation(row, dateStr); e.target.blur();
}

function scheduleAutoSave(dateStr) {
    clearTimeout(saveDebounceTimers[dateStr]);
    showSaveIndicator('saving');
    saveDebounceTimers[dateStr] = setTimeout(() => { saveDaySegments(dateStr); }, AUTO_SAVE_DEBOUNCE_MS);
}
function flushAutoSave(dateStr) { clearTimeout(saveDebounceTimers[dateStr]); delete saveDebounceTimers[dateStr]; saveDaySegments(dateStr); }

document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        const row = document.activeElement ? document.activeElement.closest('[data-segment-row]') : null;
        if (row) { e.preventDefault(); const wrap = row.closest('[data-day-segments]'); if (wrap) flushAutoSave(wrap.getAttribute('data-day-segments')); }
    }
});

function showSaveIndicator(state) {
    const ind = document.getElementById('save-indicator'); if (!ind) return;
    ind.classList.remove('opacity-0', 'text-emerald-500', 'text-red-500', 'text-slate-400');
    if (state === 'saving') { ind.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> שומר...'; ind.classList.add('text-slate-400'); }
    else if (state === 'saved') { ind.innerHTML = '<i class="fa-solid fa-check-circle"></i> נשמר בהצלחה'; ind.classList.add('text-emerald-500'); setTimeout(() => ind.classList.add('opacity-0'), 2000); }
    else if (state === 'error') { ind.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> שגיאה בשמירה'; ind.classList.add('text-red-500'); setTimeout(() => ind.classList.add('opacity-0'), 4000); }
}

function addSegmentRow(dateStr) { const wrap = document.querySelector(`[data-day-segments="${dateStr}"]`); if (wrap) wrap.insertAdjacentHTML('beforeend', renderSegmentRow(dateStr, emptySegment())); }

function removeSegmentRow(btn, dateStr) {
    const row = btn.closest('[data-segment-row]'); const wrap = document.querySelector(`[data-day-segments="${dateStr}"]`);
    const rowData = { domain_id: row.querySelector('[data-field="domain_id"]').value, entry: row.querySelector('[data-field="entry"]').value, exit: row.querySelector('[data-field="exit"]').value, total_hours: row.querySelector('[data-field="total_hours"]').value, notes: row.querySelector('[data-field="notes"]').value, source: row.dataset.source || 'manual' };
    const isEmpty = !rowData.entry && !rowData.exit;
    if (isEmpty) { row.remove(); if (wrap && wrap.children.length === 0) wrap.insertAdjacentHTML('beforeend', renderSegmentRow(dateStr, emptySegment())); return; }

    Swal.fire({ title: 'למחוק את המשמרת?', text: `${rowData.entry || '--:--'} - ${rowData.exit || '--:--'}`, icon: 'warning', showCancelButton: true, confirmButtonText: 'מחק', cancelButtonText: 'ביטול', confirmButtonColor: '#dc2626' }).then(res => {
        if (!res.isConfirmed) return;
        row.remove();
        if (wrap && wrap.children.length === 0) wrap.insertAdjacentHTML('beforeend', renderSegmentRow(dateStr, emptySegment()));
        flushAutoSave(dateStr);
        deletedSegmentUndo = { dateStr, rowData };
        showUndoToast();
    });
}

function showUndoToast() {
    let el = document.getElementById('undo-toast');
    if (!el) { el = document.createElement('div'); el.id = 'undo-toast'; el.className = 'fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-800 text-white px-4 py-2.5 rounded-xl shadow-lg flex items-center gap-3 z-50'; document.body.appendChild(el); }
    el.innerHTML = `<span class="text-sm">המשמרת נמחקה</span><button onclick="undoDeleteSegment()" class="text-blue-300 font-bold text-sm hover:text-blue-200">↩ בטל</button>`;
    el.classList.remove('hidden');
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => { el.classList.add('hidden'); deletedSegmentUndo = null; }, UNDO_WINDOW_MS);
}

function undoDeleteSegment() {
    if (!deletedSegmentUndo) return;
    const { dateStr, rowData } = deletedSegmentUndo; deletedSegmentUndo = null;
    const el = document.getElementById('undo-toast'); if (el) el.classList.add('hidden');
    const wrap = document.querySelector(`[data-day-segments="${dateStr}"]`);
    if (wrap) {
        const rows = wrap.querySelectorAll('[data-segment-row]');
        if (rows.length === 1) { const only = rows[0]; const isEmpty = !only.querySelector('[data-field="entry"]').value && !only.querySelector('[data-field="exit"]').value; if (isEmpty) only.remove(); }
        wrap.insertAdjacentHTML('beforeend', renderSegmentRow(dateStr, rowData));
    }
    flushAutoSave(dateStr);
}

function saveDaySegments(dateStr) {
    const wrap = document.querySelector(`[data-day-segments="${dateStr}"]`); if (!wrap || !currentEmpId) return;
    const rows = wrap.querySelectorAll('[data-segment-row]'); const segments = [];
    rows.forEach(row => {
        const getVal = (f) => row.querySelector(`[data-field="${f}"]`).value;
        const entry = getVal('entry'), exit = getVal('exit'); const domainSelect = row.querySelector('[data-field="domain_id"]');
        const t2d = (t) => { if (!t) return null; let [h, m] = t.split(':').map(Number); return h + (m / 60); };
        let autoTotal = 0; if (entry && exit) { let diff = t2d(exit) - t2d(entry); if (diff < 0) diff += 24; autoTotal = diff; }
        const totalInput = row.querySelector('[data-field="total_hours"]'); if (autoTotal > 0) totalInput.value = autoTotal.toFixed(2);
        
        // תיקון סך שעות ידני: מדלג רק אם הכל ריק!
        if (!entry && !exit && !totalInput.value && !getVal('notes')) return;
        
        segments.push({ domain_id: domainSelect ? domainSelect.value : null, entry: entry, exit: exit, source: row.dataset.source || 'manual', total_hours: totalInput.value || 0, notes: getVal('notes') });
    });

    showSaveIndicator('saving');
    fetch('/api/shifts/upsert', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ employee_id: currentEmpId, date: dateStr, segments }) })
    .then(r => r.json()).then(res => {
        if (res.success) {
            showSaveIndicator('saved');
            fetchDayFresh(dateStr).then(() => { refreshDayCard(dateStr); renderHoursDomainTabs(); renderHoursSummaryBar(); });
        } else { showSaveIndicator('error'); }
    }).catch(() => showSaveIndicator('error'));
}

function refreshDayCard(dateStr) {
    const existing = document.getElementById(`day-card-${dateStr}`); if (!existing) return;
    existing.replaceWith(buildDayCardElement(dateStr));
}

function applyPendingCopy(dateStr, sourceSegments) {
    pendingCopySegments[dateStr] = sourceSegments.map(s => ({ domain_id: s.domain_id, entry: s.entry, exit: s.exit, total_hours: s.total_hours, notes: s.notes, source: 'manual' }));
    refreshDayCard(dateStr); renderPendingCopyBanner();
}
function commitPendingCopy(dateStr) {
    const segs = pendingCopySegments[dateStr]; if (!segs) return;
    delete pendingCopySegments[dateStr];
    fetch('/api/shifts/upsert', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ employee_id: currentEmpId, date: dateStr, segments: segs }) })
    .then(r => r.json()).then(res => { if (res.success) fetchDayFresh(dateStr).then(() => { refreshDayCard(dateStr); renderHoursDomainTabs(); renderHoursSummaryBar(); renderPendingCopyBanner(); }); });
}
function cancelPendingCopy(dateStr) { delete pendingCopySegments[dateStr]; refreshDayCard(dateStr); renderPendingCopyBanner(); }

function copyFromYesterday(dateStr) {
    const d = new Date(dateStr); d.setDate(d.getDate() - 1);
    const yStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    fetchDayIfMissing(yStr).then(source => {
        if (!source || !source.segments || !source.segments.length) { Swal.fire('אין נתונים', 'לא נמצאו משמרות אתמול להעתקה.', 'info'); return; }
        applyPendingCopy(dateStr, source.segments);
    });
}

function duplicateFromDatePrompt(dateStr) {
    Swal.fire({ title: 'העתק מיום אחר', input: 'date', inputLabel: 'בחר תאריך מקור', showCancelButton: true, confirmButtonText: 'המשך', cancelButtonText: 'ביטול' }).then(res => {
        if (!res.isConfirmed || !res.value) return;
        fetchDayIfMissing(res.value).then(source => {
            if (!source || !source.segments || !source.segments.length) { Swal.fire('אין נתונים', `לא נמצאו משמרות בתאריך ${res.value}.`, 'info'); return; }
            applyPendingCopy(dateStr, source.segments);
        });
    });
}

function smartCopyPrompt(dateStr) {
    const sourceSegs = pendingCopySegments[dateStr] || (currentShiftsMap[dateStr] && currentShiftsMap[dateStr].segments) || [];
    if (!sourceSegs.length) { Swal.fire('אין מה להעתיק', 'ליום הזה אין עדיין משמרות.', 'info'); return; }
    Swal.fire({
        title: 'העתק לימים נוספים',
        html: `<div class="text-right text-sm space-y-3">
            <div><label class="font-bold block mb-1">עד תאריך:</label><input type="date" id="smart-copy-end" class="swal2-input" style="margin:0;"></div>
            <div><label class="font-bold block mb-1">רק בימים אלו:</label><div class="flex flex-wrap gap-2 justify-end" id="smart-copy-days">${dayNames.map((n, i) => `<label class="flex items-center gap-1"><input type="checkbox" value="${i}" checked> ${n}</label>`).join('')}</div></div>
        </div>`,
        showCancelButton: true, confirmButtonText: 'תצוגה מקדימה', cancelButtonText: 'ביטול',
        preConfirm: () => {
            const endVal = document.getElementById('smart-copy-end').value;
            if (!endVal) { Swal.showValidationMessage('יש לבחור תאריך סיום'); return false; }
            return { end: endVal, days: Array.from(document.querySelectorAll('#smart-copy-days input:checked')).map(c => parseInt(c.value)) };
        }
    }).then(res => {
        if (!res.isConfirmed) return;
        const { end, days } = res.value;
        const startD = new Date(dateStr), endD = new Date(end);
        if (endD < startD) { Swal.fire('שגיאה', 'תאריך הסיום לפני תאריך ההתחלה.', 'error'); return; }
        const targets = [];
        for (let d = new Date(startD); d <= endD; d.setDate(d.getDate() + 1)) {
            const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            if (ds !== dateStr && days.includes(d.getDay())) targets.push(ds);
        }
        if (!targets.length) { Swal.fire('אין ימים מתאימים', 'לא נמצאו ימים בטווח שנבחר.', 'info'); return; }
        Swal.fire({ title: `להעתיק ל-${targets.length} ימים?`, html: `<div class="text-right text-sm max-h-40 overflow-y-auto">${targets.join('<br>')}</div>`, icon: 'question', showCancelButton: true, confirmButtonText: `העתק`, cancelButtonText: 'ביטול' }).then(confirmRes => {
            if (!confirmRes.isConfirmed) return;
            targets.forEach(t => { pendingCopySegments[t] = sourceSegs.map(s => ({ domain_id: s.domain_id, entry: s.entry, exit: s.exit, total_hours: s.total_hours, notes: s.notes, source: 'manual' })); });
            renderHoursView();
        });
    });
}

function showValidationReport() {
    if (!currentEmpId) return Swal.fire('שגיאה', 'יש לבחור עובד', 'error');
    const monthFilter = document.getElementById('month-picker').value; let totalH = 0, totalShifts = 0, allWarnings = [];
    Object.values(currentShiftsMap).filter(s => s.date.startsWith(monthFilter)).forEach(s => {
        const th = parseFloat(s.total_hours || 0);
        if (th > 0 || (s.segments && s.segments.length > 0)) { totalH += th; totalShifts += (s.segments ? s.segments.length : 0); }
        if (s.warnings && s.warnings.length > 0) allWarnings.push(`<b>${s.date}:</b> ${s.warnings.join(' | ')}`);
    });
    let warningsHtml = allWarnings.length > 0 ? `<div class="bg-rose-50 text-rose-700 p-3 rounded text-sm text-right mt-3"><b>⚠️ אזהרות שנמצאו:</b><br><ul class="list-disc list-inside mt-1">${allWarnings.map(w => `<li>${w}</li>`).join('')}</ul></div>` : `<div class="bg-emerald-50 text-emerald-700 p-3 rounded text-sm text-right mt-3"><i class="fa-solid fa-check"></i> לא נמצאו חריגות.</div>`;
    Swal.fire({ title: `דוח אימות: ${currentEmpName}`, html: `<div class="text-right"><p class="text-lg">📌 סה"כ שעות: <span class="font-bold text-blue-600">${totalH.toFixed(2)}</span></p><p class="text-sm mt-1">🕒 משמרות בחודש: ${totalShifts}</p>${warningsHtml}</div>`, icon: 'info', width: 600, confirmButtonText: 'סגור' });
}

function exportAllEmployeesToCSV() {
    const monthFilter = document.getElementById('month-picker').value;
    if (!monthFilter) return Swal.fire('שגיאה', 'נא לבחור חודש לייצוא', 'error');
    window.location.href = `/api/exports/all_employees?month=${monthFilter}`;
}

// ----------------- CORRECTIONS (שלב 2) -----------------
function loadTimeCorrections() {
    const picker = document.getElementById('corrections-month-picker');
    const monthVal = picker ? picker.value : '';
    const tbody = document.getElementById('corrections-table-tbody');
    if(tbody) tbody.innerHTML = '<tr><td colspan="7" class="text-center py-8 text-slate-400">טוען...</td></tr>';

    fetch(`/api/time_corrections${monthVal ? '?month=' + monthVal : ''}`, { cache: 'no-store' })
        .then(r => r.json()).then(list => {
            if(!tbody) return;
            if (!Array.isArray(list) || !list.length) {
                tbody.innerHTML = '<tr><td colspan="7" class="text-center py-12 text-slate-400">אין בקשות תיקון שעות לחודש זה.</td></tr>';
                refreshCorrectionsBadge(0); return;
            }
            const statusLabels = { pending: 'ממתין', approved: 'אושר', rejected: 'נדחה' };
            const statusColors = { pending: 'bg-amber-100 text-amber-800', approved: 'bg-emerald-100 text-emerald-800', rejected: 'bg-slate-200 text-slate-600' };
            
            tbody.innerHTML = list.map(req => `
                <tr class="hover:bg-slate-50 dark:hover:bg-slate-700/40 border-b dark:border-slate-700">
                    <td class="p-3 font-bold">${req.first_name} ${req.last_name}</td>
                    <td class="p-3">${req.date}</td>
                    <td class="p-3 font-medium">${req.domain_name || '-'}</td>
                    <td class="p-3 font-bold text-indigo-600" dir="ltr">${req.entry_time} - ${req.exit_time}</td>
                    <td class="p-3 text-slate-500 max-w-xs truncate" title="${req.reason || ''}">${req.reason || '-'}</td>
                    <td class="p-3"><span class="px-2 py-1 rounded-full text-xs font-bold ${statusColors[req.status] || ''}">${statusLabels[req.status] || req.status}</span></td>
                    <td class="p-3">
                        <div class="flex gap-1">
                            ${req.status === 'pending' ? `
                                <button onclick="handleCorrection(${req.id}, 'approved')" title="אשר וצור משמרת" class="bg-emerald-100 hover:bg-emerald-200 text-emerald-700 px-3 py-1.5 rounded text-xs font-bold"><i class="fa-solid fa-check"></i> אשר</button>
                                <button onclick="handleCorrection(${req.id}, 'rejected')" title="דחה בקשה" class="bg-rose-100 hover:bg-rose-200 text-rose-700 px-3 py-1.5 rounded text-xs font-bold"><i class="fa-solid fa-xmark"></i> דחה</button>
                            ` : '-'}
                        </div>
                    </td>
                </tr>
            `).join('');
            refreshCorrectionsBadge(list.filter(r => r.status === 'pending').length);
        });
}

function handleCorrection(id, status) {
    fetch(`/api/time_corrections/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) })
    .then(r => r.json()).then(res => {
        if (res.success) { showSuccessToast('הבקשה עודכנה בהצלחה'); loadTimeCorrections(); loadDashboard(); }
        else Swal.fire('שגיאה', res.error || 'הפעולה נכשלה', 'error');
    });
}

function refreshCorrectionsBadge(count) {
    const badge = document.getElementById('corrections-badge'); if (!badge) return;
    if (count > 0) { badge.classList.remove('hidden'); badge.textContent = count; } else badge.classList.add('hidden');
}

// ----------------- SCHEDULE & REQUESTS -----------------
const EXTRA_ROLE_MEAL_PREFIX = '§meal:';
function encodeExtraRoleField(mealKey, roleText) { return `${EXTRA_ROLE_MEAL_PREFIX}${mealKey}§${roleText || ''}`; }
function decodeExtraRoleField(raw) { if (typeof raw === 'string' && raw.startsWith(EXTRA_ROLE_MEAL_PREFIX)) { const rest = raw.slice(EXTRA_ROLE_MEAL_PREFIX.length); const sepIdx = rest.indexOf('§'); if (sepIdx !== -1) { return { meal: rest.slice(0, sepIdx), role: rest.slice(sepIdx + 1) }; } } return { meal: null, role: raw || '' }; }

let scheduleTimeout, currentScheduleHebrewCalendar = {}, currentScheduleWeekIndex = null, currentScheduleWeeks = [];

let scheduleAvailabilityMap = {}; 
const MEAL_KEY_LABEL = { breakfast: 'בוקר', lunch: 'צהריים', dinner: 'ערב' };
const AVAILABILITY_BADGE = { available: { icon: '🟢', title: 'העובד ביקש זמינות למועד זה (מאושר)' }, pending_available: { icon: '🟡', title: 'קיימת בקשת זמינות למועד זה (ממתינה לאישור)' }, unavailable: { icon: '🔴', title: 'העובד ביקש אי-זמינות למועד זה' } };

function buildAvailabilityKey(name, dateStr, meal) { return `${name.trim()}|${dateStr}|${meal}`; }

function loadScheduleAvailabilityMap(monthVal) {
    return fetch(`/api/shift_requests?month=${monthVal}`, { cache: 'no-store' }).then(r => r.json()).then(list => {
        scheduleAvailabilityMap = {};
        const priority = { unavailable: 3, pending_available: 2, available: 1 };
        (Array.isArray(list) ? list : []).forEach(r => {
            const meals = r.meal === 'all' ? ['breakfast', 'lunch', 'dinner'] : [r.meal];
            const candidate = r.request_type === 'unavailable' ? 'unavailable' : (r.status === 'approved' ? 'available' : 'pending_available');
            meals.forEach(mk => {
                const key = buildAvailabilityKey(r.employee_name || '', r.date || '', mk);
                const existing = scheduleAvailabilityMap[key];
                if (!existing || priority[candidate] > priority[existing]) scheduleAvailabilityMap[key] = candidate;
            });
        });
    }).catch(() => { scheduleAvailabilityMap = {}; });
}

function refreshCellAvailabilityBadge(inputEl, meal) {
    const td = inputEl.closest('td'); if (!td || !meal) return;
    const monthVal = document.getElementById('schedule-month-picker').value;
    const day = td.getAttribute('data-day'); const name = inputEl.value.trim();
    let badge = td.querySelector('.availability-badge');
    td.classList.remove('cell-conflict');
    if (!name || !day) { if (badge) badge.remove(); return; }
    const dateStr = `${monthVal}-${String(day).padStart(2, '0')}`;
    const status = scheduleAvailabilityMap[buildAvailabilityKey(name, dateStr, meal)];
    if (!status) { if (badge) badge.remove(); return; }
    const info = AVAILABILITY_BADGE[status];
    if (!badge) { badge = document.createElement('span'); badge.className = 'availability-badge'; td.appendChild(badge); }
    badge.textContent = info.icon; badge.title = info.title;
    if (status === 'unavailable') { td.classList.add('cell-conflict'); td.setAttribute('data-tippy-content', `⚠️ ${info.title}`); safeTippy(`[data-day="${day}"].cell-conflict`, { theme: 'light-border' }); }
}

function applyAvailabilityBadges() {
    document.querySelectorAll('#schedule-table tbody tr[data-meal] td.employee-cell').forEach(td => {
        const input = td.querySelector('input'); const tr = td.closest('tr');
        if (input && tr) refreshCellAvailabilityBadge(input, tr.getAttribute('data-meal'));
    });
}

function findScheduleAvailabilityConflicts() {
    const monthVal = document.getElementById('schedule-month-picker').value; const conflicts = [];
    document.querySelectorAll('#schedule-table tbody tr[data-meal] td.employee-cell').forEach(td => {
        const input = td.querySelector('input'); const tr = td.closest('tr'); if (!input || !tr) return;
        const meal = tr.getAttribute('data-meal'); const day = td.getAttribute('data-day'); const name = input.value.trim();
        if (!meal || !day || !name) return;
        const dateStr = `${monthVal}-${String(day).padStart(2, '0')}`;
        if (scheduleAvailabilityMap[buildAvailabilityKey(name, dateStr, meal)] === 'unavailable') conflicts.push({ name, dateStr, meal: MEAL_KEY_LABEL[meal] || meal });
    });
    return conflicts;
}

function triggerAutoSave() {
    const badge = document.getElementById('unsaved-badge'); if(badge) badge.classList.remove('hidden');
    clearTimeout(scheduleTimeout); scheduleTimeout = setTimeout(() => { try { localStorage.setItem('schedule_draft', JSON.stringify({ month: document.getElementById('schedule-month-picker').value, matrix: getMatrixFromTable(), mealTimes: getMealTimesFromTable() })); } catch(e) {} }, 800);
}

function loadSchedule() { 
    const monthVal = document.getElementById('schedule-month-picker').value; currentScheduleWeekIndex = null;
    Promise.all([ fetch(`/api/schedule?month=${monthVal}`, { cache: 'no-store' }).then(r=>r.json()), fetch(`/api/hebrew_calendar?month=${monthVal}`, { cache: 'no-store' }).then(r=>r.json()).catch(() => ({ days: {} })), loadScheduleAvailabilityMap(monthVal) ])
    .then(([d, heb]) => { currentScheduleHebrewCalendar = heb.days || {}; renderScheduleTable(d.matrix, d.mealTimes || {}); applyAvailabilityBadges(); document.getElementById('unsaved-badge').classList.add('hidden'); }); 
}

function computeScheduleWeeks(year, month) {
    const daysInMonth = new Date(year, month, 0).getDate(); const weeks = []; let currentWeek = [];
    for (let d = 1; d <= daysInMonth; d++) { currentWeek.push(d); if (new Date(year, month - 1, d).getDay() === 6 || d === daysInMonth) { weeks.push(currentWeek); currentWeek = []; } }
    return weeks;
}

function getDefaultScheduleWeekIndex(year, month, weeks) { const today = new Date(); if (today.getFullYear() !== Number(year) || (today.getMonth() + 1) !== Number(month)) return 0; const idx = weeks.findIndex(w => w.includes(today.getDate())); return idx >= 0 ? idx : 0; }
function updateScheduleWeekLabel(year, month) { const week = currentScheduleWeeks[currentScheduleWeekIndex] || []; const label = document.getElementById('schedule-week-label'); if (!label || !week.length) { if(label) label.innerText = ''; return; } label.innerText = week[0] === week[week.length - 1] ? `${week[0]}/${parseInt(month)}` : `${week[0]}-${week[week.length - 1]}/${parseInt(month)}`; }

function applyScheduleWeekFilter() {
    const monthVal = document.getElementById('schedule-month-picker').value; if (!monthVal) return; const [year, month] = monthVal.split('-');
    currentScheduleWeeks = computeScheduleWeeks(year, month);
    if (currentScheduleWeekIndex === null || currentScheduleWeekIndex >= currentScheduleWeeks.length) currentScheduleWeekIndex = getDefaultScheduleWeekIndex(year, month, currentScheduleWeeks);
    const visibleDays = new Set(currentScheduleWeeks[currentScheduleWeekIndex] || []);
    const table = document.getElementById('schedule-table'); if (!table) return;
    table.querySelectorAll('th[data-day], td[data-day]').forEach(cell => { cell.style.display = visibleDays.has(parseInt(cell.getAttribute('data-day'), 10)) ? '' : 'none'; });
    updateScheduleWeekLabel(year, month);
}
function changeScheduleWeek(delta) { if (!currentScheduleWeeks.length) return; const newIndex = currentScheduleWeekIndex + delta; if (newIndex < 0 || newIndex >= currentScheduleWeeks.length) return; currentScheduleWeekIndex = newIndex; applyScheduleWeekFilter(); }

function copyPreviousSchedule() {
    const currentMonth = document.getElementById('schedule-month-picker').value;
    if (!currentMonth) return;
    
    Swal.fire({
        title: 'שכפול שיבוץ לחודש זה',
        text: 'פעולה זו תעתיק את כל השיבוצים מהחודש הקודם (כולל תפקידים ושעות) אל החודש הנוכחי. שימו לב: הפעולה תדרוס את השיבוץ הקיים בחודש זה.',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#4f46e5',
        cancelButtonColor: '#d33',
        confirmButtonText: 'כן, שכפל עכשיו',
        cancelButtonText: 'ביטול'
    }).then(res => {
        if(res.isConfirmed) {
            fetch('/api/schedule/copy', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ target_month: currentMonth })
            }).then(r => r.json()).then(data => {
                if(data.success) {
                    Swal.fire('בוצע!', data.message, 'success');
                    loadSchedule(); 
                } else {
                    Swal.fire('שגיאה', data.error, 'error');
                }
            }).catch(() => Swal.fire('שגיאה', 'בעיית תקשורת בביצוע הפעולה', 'error'));
        }
    });
}

// ------ הלשוניות של בקשות השיבוץ ------
let currentRequestStatusFilter = 'pending';

function filterShiftRequestsByStatus(status) {
    currentRequestStatusFilter = status;
    
    const tabs = {
        pending: { el: 'req-status-tab-pending', activeCls: 'bg-amber-500 text-white shadow-sm' },
        approved: { el: 'req-status-tab-approved', activeCls: 'bg-emerald-600 text-white shadow-sm' },
        rejected: { el: 'req-status-tab-rejected', activeCls: 'bg-rose-600 text-white shadow-sm' },
        all: { el: 'req-status-tab-all', activeCls: 'bg-blue-600 text-white shadow-sm' }
    };

    const inactiveCls = 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200';

    Object.keys(tabs).forEach(key => {
        const tabEl = document.getElementById(tabs[key].el);
        if (!tabEl) return;
        if (key === status) {
            tabEl.className = `px-4 py-2 rounded-lg font-bold text-sm flex items-center gap-2 transition-all ${tabs[key].activeCls}`;
        } else {
            tabEl.className = `px-4 py-2 rounded-lg font-bold text-sm flex items-center gap-2 transition-all ${inactiveCls}`;
        }
    });

    renderShiftRequestsTable();
}

function updateRequestsCounts() {
    const counts = { pending: 0, approved: 0, rejected: 0, all: allShiftRequests.length };
    allShiftRequests.forEach(r => {
        if (counts[r.status] !== undefined) counts[r.status]++;
    });

    const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setVal('req-count-pending', counts.pending);
    setVal('req-count-approved', counts.approved);
    setVal('req-count-rejected', counts.rejected);
    setVal('req-count-all', counts.all);
}

let allShiftRequests = [];
function refreshRequestsBadge() { 
    fetch('/api/shift_requests', { cache: 'no-store' })
    .then(r => r.json())
    .then(list => { 
        const badge = document.getElementById('requests-badge'); 
        if (!badge) return; 
        const pendingCount = Array.isArray(list) ? list.filter(r => r.status === 'pending').length : 0; 
        if (pendingCount > 0) { 
            badge.classList.remove('hidden'); 
            badge.textContent = pendingCount; 
        } else badge.classList.add('hidden'); 
    }).catch(() => {}); 
}

function loadShiftRequests() {
    const monthVal = document.getElementById('requests-month-picker').value; 
    const tbody = document.getElementById('requests-table-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="8" class="text-center py-8 text-slate-400">טוען...</td></tr>';
    
    fetch(`/api/shift_requests?month=${monthVal}`, { cache: 'no-store' })
    .then(r => r.json())
    .then(list => { 
        allShiftRequests = Array.isArray(list) ? list : []; 
        renderShiftRequestsTable(); 
        refreshRequestsBadge(); 
    }).catch(() => { 
        tbody.innerHTML = '<tr><td colspan="8" class="text-center py-8 text-red-400">שגיאה בטעינת נתונים</td></tr>'; 
    });
}

function renderShiftRequestsTable() {
    const tbody = document.getElementById('requests-table-tbody'); 
    if (!tbody) return;
    tbody.innerHTML = '';

    updateRequestsCounts();

    const filteredRequests = allShiftRequests.filter(req => {
        if (currentRequestStatusFilter === 'all') return true;
        return req.status === currentRequestStatusFilter;
    });

    if (!filteredRequests.length) { 
        tbody.innerHTML = '<tr><td colspan="8" class="text-center py-12 text-slate-400">אין בקשות בסטטוס זה.</td></tr>'; 
        return; 
    }

    const statusLabels = { pending: 'ממתין', approved: 'אושר', rejected: 'נדחה' }, 
          statusColors = { pending: 'bg-amber-100 text-amber-800', approved: 'bg-emerald-100 text-emerald-800', rejected: 'bg-slate-200 text-slate-600' }, 
          typeColors = { available: 'bg-emerald-50 text-emerald-700 border border-emerald-300', unavailable: 'bg-rose-50 text-rose-700 border border-rose-300' };

    [...filteredRequests].sort((a, b) => (a.date || '').localeCompare(b.date || '')).forEach(req => {
        const tr = document.createElement('tr'); 
        tr.className = req.has_conflict ? 'request-row-conflict' : 'hover:bg-slate-50 dark:hover:bg-slate-700/40';
        tr.innerHTML = `
            <td class="p-3 font-bold">${req.employee_name}</td>
            <td class="p-3">${req.date}</td>
            <td class="p-3">${req.meal_label}</td>
            <td class="p-3"><span class="px-2 py-1 rounded-full text-xs font-bold ${typeColors[req.request_type] || ''}">${req.request_type_label}</span></td>
            <td class="p-3 text-slate-500 max-w-xs truncate" title="${req.note || ''}">${req.note || '-'}</td>
            <td class="p-3"><span class="px-2 py-1 rounded-full text-xs font-bold ${statusColors[req.status] || ''}">${statusLabels[req.status] || req.status}</span></td>
            <td class="p-3">${req.has_conflict ? `<span class="request-conflict-badge inline-flex items-center gap-1 bg-red-600 text-white text-xs font-bold px-2 py-1 rounded-full" title="${(req.conflict_reasons || []).join(' | ')}"><i class="fa-solid fa-triangle-exclamation"></i> התנגשות</span>` : '<span class="text-slate-300">-</span>'}</td>
            <td class="p-3"><div class="flex gap-1 flex-wrap">
                <button onclick="jumpToScheduleFromRequest('${req.date}')" title="עבור לשיבוץ" class="bg-blue-100 hover:bg-blue-200 text-blue-700 px-2 py-1 rounded text-xs font-bold"><i class="fa-solid fa-calendar-days"></i></button>
                ${req.status !== 'approved' ? `<button onclick="setShiftRequestStatus(${req.id}, 'approved')" title="אשר" class="bg-emerald-100 hover:bg-emerald-200 text-emerald-700 px-2 py-1 rounded text-xs font-bold"><i class="fa-solid fa-check"></i></button>` : ''}
                ${req.status !== 'rejected' ? `<button onclick="setShiftRequestStatus(${req.id}, 'rejected')" title="דחה" class="bg-slate-200 hover:bg-slate-300 text-slate-700 px-2 py-1 rounded text-xs font-bold"><i class="fa-solid fa-xmark"></i></button>` : ''}
                <button onclick="deleteShiftRequest(${req.id})" title="מחק" class="bg-red-100 hover:bg-red-200 text-red-700 px-2 py-1 rounded text-xs font-bold"><i class="fa-solid fa-trash"></i></button>
            </div></td>
        `;
        tbody.appendChild(tr);
    });
}

function setShiftRequestStatus(id, status) {
    fetch(`/api/shift_requests/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) })
    .then(r => r.json()).then(res => {
        if (res.success) {
            loadShiftRequests(); loadDashboard();
            if (status === 'approved' && res.assigned) { showSuccessToast('העובד שובץ בהצלחה', res.message); const req = allShiftRequests.find(r => r.id === id); const reqMonth = req && req.date ? req.date.slice(0, 7) : null; const schedEl = document.getElementById('schedule-month-picker'); if (reqMonth && schedEl && schedEl.value === reqMonth) { fetch(`/api/schedule?month=${reqMonth}`, { cache: 'no-store' }).then(r => r.json()).then(d => renderScheduleTable(d.matrix, d.mealTimes || {})); } } else if (status === 'approved') showSuccessToast(res.message || 'הבקשה אושרה');
        } else if (res.conflict) {
            Swal.fire({ icon: 'warning', title: 'לא שובץ עקב התנגשות', html: `<div class="text-right text-sm">${res.message || 'קיימת התנגשות.'}<br><br><b>הבקשה נשארה ממתינה</b> (לא סומנה כמאושרת) עד שהתנגשות תיפתר.</div>`, confirmButtonText: 'הבנתי', confirmButtonColor: '#d97706' });
        } else Swal.fire('שגיאה', res.error || 'הפעולה נכשלה', 'error');
    });
}

function deleteShiftRequest(id) { Swal.fire({ title: 'למחוק?', icon: 'warning', showCancelButton: true, confirmButtonText: 'מחק', confirmButtonColor: '#dc2626' }).then(res => { if (res.isConfirmed) fetch(`/api/shift_requests/${id}`, { method: 'DELETE' }).then(r => r.json()).then(result => { if (result.success) loadShiftRequests(); }); }); }

function jumpToScheduleFromRequest(dateStr) {
    if (!dateStr) return; const [y, m] = dateStr.split('-'); const monthVal = `${y}-${m}`;
    document.getElementById('schedule-month-picker').value = monthVal; currentScheduleWeekIndex = null; switchTab('schedule');
    fetch(`/api/schedule?month=${monthVal}`, { cache: 'no-store' }).then(r => r.json()).then(d => { renderScheduleTable(d.matrix, d.mealTimes || {}); document.getElementById('unsaved-badge').classList.add('hidden'); const day = parseInt(dateStr.split('-')[2], 10); const weeks = computeScheduleWeeks(y, m); const idx = weeks.findIndex(w => w.includes(day)); currentScheduleWeekIndex = idx >= 0 ? idx : 0; applyScheduleWeekFilter(); });
}

function renderScheduleTable(matrix = [], mealTimes = {}) {
    const table = document.getElementById("schedule-table"); table.innerHTML = "";
    const monthVal = document.getElementById("schedule-month-picker").value; const [year, month] = monthVal.split("-"); const daysInMonth = new Date(year, month, 0).getDate();
    const scheduleDayNames = ["א׳","ב׳","ג׳","ד׳","ה׳","ו׳","שבת"]; const meals = [ { name:"בוקר", time:"08:30", key:"breakfast" }, { name:"צהריים", time:"11:30", key:"lunch" }, { name:"ערב", time:"18:30", key:"dinner" } ]; const roles = [ "אחראי", "מלצר 1", "מלצר 2", "מלצר 3", "מלצר 4", "מלצר 5" ];
    let matrixIndex = 0; const extraRowsByMeal = {}; meals.forEach(m => { extraRowsByMeal[m.key] = []; }); const genericExtraRows = [];
    for(let i = meals.length * roles.length; i < matrix.length; i++){ const savedRow = matrix[i] || []; const decoded = decodeExtraRoleField(savedRow[0]); if(decoded.meal && extraRowsByMeal[decoded.meal]) extraRowsByMeal[decoded.meal].push({ role: decoded.role, cells: savedRow }); else genericExtraRows.push(savedRow); }
    const thead = document.createElement("thead"); let headHtml = `<tr><th class="sticky-col">יום / שעה</th>`;
    for(let d=1; d<=daysInMonth; d++){
        const dow = new Date(year, month - 1, d).getDay(); const heInfo = currentScheduleHebrewCalendar[String(d)]; let heHtml = '';
        if (heInfo) { const style = HOLIDAY_CATEGORY_STYLE[heInfo.category] || { bg: 'transparent', color: '#94a3b8', label: '' }; heHtml = `<div class="day-col-hebrew" title="${heInfo.hebrew_date}${heInfo.holiday ? ' - ' + style.label + heInfo.holiday : ''}">${heInfo.holiday ? `<span class="day-col-holiday-dot" style="background-color:${style.color}"></span>` : ''}</div>`; }
        headHtml += `<th data-day="${d}" class="${dow === 5 || dow === 6 ? 'day-col-weekend' : ''}" onclick="toggleMuteDay(${d})"><div>${d}</div><div class="day-col-name">${scheduleDayNames[dow]}</div>${heHtml}</th>`;
    }
    thead.innerHTML = headHtml + "</tr>"; table.appendChild(thead); const tbody = document.createElement("tbody");
    meals.forEach(meal => {
        let timeHtml = `<td class="sticky-col bg-gray-200 font-bold" data-meal-label="${meal.key}">${meal.name} / שעה</td>`;
        for(let d=1; d<=daysInMonth; d++){ timeHtml += `<td class="bg-gray-100 meal-time-cell" data-day="${d}"><div class="meal-time-wrap"><input type="text" class="meal-time-input" data-meal="${meal.key}" data-day="${d}" value="${mealTimes[`${meal.key}_${d}`] || meal.time}" oninput="triggerAutoSave()"><button type="button" class="meal-mute-btn" onclick="toggleMuteMealDay('${meal.key}', ${d})"><i class="fa-solid fa-eye-slash"></i></button></div></td>`; }
        const timeRow = document.createElement("tr"); timeRow.innerHTML = timeHtml; timeRow.setAttribute("data-meal", meal.key); tbody.appendChild(timeRow);
        roles.forEach(role => {
            const savedRow = matrix[matrixIndex] || []; let rowHtml = `<td class="sticky-col font-bold">${role}</td>`;
            for(let d=1; d<=daysInMonth; d++) rowHtml += `<td class="employee-cell" data-day="${d}"><input type="text" list="employee-names-list" value="${savedRow[d] || ""}" oninput="triggerAutoSave(); refreshCellAvailabilityBadge(this, '${meal.key}')"></td>`;
            const row = document.createElement("tr"); row.innerHTML = rowHtml; row.setAttribute("data-meal", meal.key); tbody.appendChild(row); matrixIndex++;
        });
        extraRowsByMeal[meal.key].forEach(entry => {
            const extraTr = document.createElement("tr"); extraTr.className = "border-b dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800/80"; extraTr.setAttribute("data-meal", meal.key); extraTr.setAttribute("data-extra-role", "1");
            const tdRole = document.createElement("td"); tdRole.className = "p-2 border-x dark:border-slate-700 sticky-col bg-white dark:bg-slate-800 z-10 shadow-sm"; tdRole.innerHTML = `<div class="flex items-center gap-1"><input type="text" placeholder="מלצר נוסף" value="${entry.role}" oninput="triggerAutoSave()" class="role-input flex-grow bg-slate-50 dark:bg-slate-700 text-xs rounded border p-1 font-bold outline-none"><button type="button" onclick="this.closest('tr').remove(); triggerAutoSave();" class="text-red-400 hover:text-red-600 shrink-0"><i class="fa-solid fa-xmark"></i></button></div>`; extraTr.appendChild(tdRole);
            for(let d=1; d<=daysInMonth; d++){ const td = document.createElement("td"); td.className = "employee-cell"; td.setAttribute("data-day", d); td.innerHTML = `<input type="text" list="employee-names-list" value="${entry.cells[d] || ""}" oninput="triggerAutoSave(); refreshCellAvailabilityBadge(this, '${meal.key}')">`; extraTr.appendChild(td); }
            tbody.appendChild(extraTr);
        });
        const addRowBtnTr = document.createElement("tr"); addRowBtnTr.className = "schedule-add-row"; addRowBtnTr.setAttribute("data-meal", meal.key); addRowBtnTr.innerHTML = `<td colspan="${daysInMonth + 1}"><button type="button" class="add-meal-row-btn" onclick="addMealRow('${meal.key}')"><i class="fa-solid fa-plus"></i> הוסף מלצר לארוחת ${meal.name}</button></td>`; tbody.appendChild(addRowBtnTr);
        const divider = document.createElement("tr"); divider.className = "section-divider"; divider.innerHTML = `<td colspan="${daysInMonth+1}"></td>`; tbody.appendChild(divider);
    });
    genericExtraRows.forEach(savedRow => {
        const tr = document.createElement("tr"); tr.className = "border-b dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800/80";
        const tdRole = document.createElement("td"); tdRole.className = "p-2 border-x dark:border-slate-700 sticky-col bg-white dark:bg-slate-800 z-10 shadow-sm"; tdRole.innerHTML = `<div class="flex items-center gap-1"><input type="text" placeholder="שם תפקיד" value="${savedRow[0] || ""}" oninput="triggerAutoSave()" class="role-input flex-grow bg-slate-50 dark:bg-slate-700 text-xs rounded border p-1 font-bold outline-none"><button type="button" onclick="this.closest('tr').remove(); triggerAutoSave();" class="text-red-400 hover:text-red-600 shrink-0"><i class="fa-solid fa-xmark"></i></button></div>`; tr.appendChild(tdRole);
        for(let d = 1; d <= daysInMonth; d++){ const td = document.createElement("td"); td.className = "p-2 border-x dark:border-slate-700 text-center"; td.setAttribute("data-day", d); td.innerHTML = `<input type="text" list="employee-names-list" value="${savedRow[d] || ""}" oninput="triggerAutoSave()" class="w-full bg-transparent outline-none p-1 text-center">`; tr.appendChild(td); }
        tbody.appendChild(tr);
    });
    table.appendChild(tbody); applyMutedDaysStyling(); applyScheduleWeekFilter();
}

function getMutedDaysKey() { return `muted_schedule_days_${document.getElementById('schedule-month-picker').value}`; }
function getMutedDaysSet() { try { const raw = localStorage.getItem(getMutedDaysKey()); return new Set(raw ? JSON.parse(raw) : []); } catch(e) { return new Set(); } }
function saveMutedDaysSet(set) { localStorage.setItem(getMutedDaysKey(), JSON.stringify(Array.from(set))); }
function toggleMuteDay(day) { const muted = getMutedDaysSet(); muted.has(day) ? muted.delete(day) : muted.add(day); saveMutedDaysSet(muted); applyMutedDaysStyling(); }

function getMutedMealDaysKey() { return `muted_schedule_mealdays_${document.getElementById('schedule-month-picker').value}`; }
function getMutedMealDaysSet() { try { const raw = localStorage.getItem(getMutedMealDaysKey()); return new Set(raw ? JSON.parse(raw) : []); } catch(e) { return new Set(); } }
function saveMutedMealDaysSet(set) { localStorage.setItem(getMutedMealDaysKey(), JSON.stringify(Array.from(set))); }
function toggleMuteMealDay(mealKey, day) { const muted = getMutedMealDaysSet(); const key = `${mealKey}_${day}`; muted.has(key) ? muted.delete(key) : muted.add(key); saveMutedMealDaysSet(muted); applyMutedDaysStyling(); }

function applyMutedDaysStyling() {
    const table = document.getElementById('schedule-table'); if (!table) return;
    const mutedDays = getMutedDaysSet(), mutedMealDays = getMutedMealDaysSet();
    table.querySelectorAll('th[data-day]').forEach(th => th.classList.toggle('day-col-muted', mutedDays.has(parseInt(th.getAttribute('data-day'), 10))));
    table.querySelectorAll('td[data-day]').forEach(td => {
        const d = parseInt(td.getAttribute('data-day'), 10), mealKey = td.closest('tr') ? td.closest('tr').getAttribute('data-meal') : null;
        const isMuted = mutedDays.has(d) || (mealKey && mutedMealDays.has(`${mealKey}_${d}`));
        td.classList.toggle('day-cell-muted', isMuted);
        const input = td.querySelector('input'); if (input) { input.disabled = isMuted; input.tabIndex = isMuted ? -1 : 0; }
    });
}
function clearMutedDays() { saveMutedDaysSet(new Set()); saveMutedMealDaysSet(new Set()); applyMutedDaysStyling(); }
        
function getMatrixFromTable() {
    const table = document.getElementById("schedule-table"); const fixedRows = [], extraRows = [];
    table.querySelectorAll("tbody tr").forEach(row => {
        if(row.classList.contains("schedule-add-row")) return;
        const firstCell = row.cells[0]; if(!firstCell) return;
        const roleField = firstCell.querySelector("input, select"); const rawRole = roleField ? roleField.value.trim() : firstCell.innerText.trim();
        if(rawRole === "" || rawRole.includes("/ שעה")) return;
        const role = (roleField && row.hasAttribute("data-extra-role") && row.hasAttribute("data-meal")) ? encodeExtraRoleField(row.getAttribute("data-meal"), rawRole) : rawRole;
        const rowData = [role];
        for(let i=1; i<row.cells.length; i++){ const input = row.cells[i].querySelector("input"); rowData.push(input ? input.value.trim() : ""); }
        (roleField ? extraRows : fixedRows).push(rowData);
    });
    return fixedRows.concat(extraRows);
}
function getMealTimesFromTable() { const times = {}; document.querySelectorAll("input.meal-time-input").forEach(input => { const val = input.value.trim(); if(val) times[`${input.getAttribute("data-meal")}_${input.getAttribute("data-day")}`] = val; }); return times; }

function addRow() { 
    const tbody = document.getElementById('schedule-table').querySelector('tbody'); if(!tbody) return;
    const daysInMonth = new Date(document.getElementById('schedule-month-picker').value.split('-')[0], document.getElementById('schedule-month-picker').value.split('-')[1], 0).getDate();
    const tr = document.createElement('tr'); tr.className="border-b dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800/80"; 
    tr.innerHTML = `<td class="p-2 border-x dark:border-slate-700 sticky-col bg-white dark:bg-slate-800 z-10 shadow-sm"><div class="flex items-center gap-1"><input type="text" placeholder="שם תפקיד" oninput="triggerAutoSave()" class="role-input flex-grow bg-slate-50 dark:bg-slate-700 text-xs rounded border p-1 font-bold outline-none"><button type="button" onclick="this.closest('tr').remove(); triggerAutoSave();" class="text-red-400 hover:text-red-600 shrink-0"><i class="fa-solid fa-xmark"></i></button></div></td>`;
    for(let d=1; d<=daysInMonth; d++) tr.innerHTML += `<td class="p-2 border-x dark:border-slate-700 text-center"><input type="text" list="employee-names-list" oninput="triggerAutoSave()" class="w-full bg-transparent outline-none p-1 text-center"></td>`; 
    tbody.appendChild(tr); triggerAutoSave(); applyScheduleWeekFilter();
}

function addMealRow(mealKey) {
    const tbody = document.getElementById('schedule-table').querySelector('tbody'); if(!tbody) return;
    const daysInMonth = new Date(document.getElementById('schedule-month-picker').value.split('-')[0], document.getElementById('schedule-month-picker').value.split('-')[1], 0).getDate();
    const tr = document.createElement('tr'); tr.className = "border-b dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800/80"; tr.setAttribute('data-meal', mealKey); tr.setAttribute('data-extra-role', '1');
    tr.innerHTML = `<td class="p-2 border-x dark:border-slate-700 sticky-col bg-white dark:bg-slate-800 z-10 shadow-sm"><div class="flex items-center gap-1"><input type="text" placeholder="מלצר נוסף" oninput="triggerAutoSave()" class="role-input flex-grow bg-slate-50 dark:bg-slate-700 text-xs rounded border p-1 font-bold outline-none"><button type="button" onclick="this.closest('tr').remove(); triggerAutoSave();" class="text-red-400 hover:text-red-600 shrink-0"><i class="fa-solid fa-xmark"></i></button></div></td>`;
    for(let d=1; d<=daysInMonth; d++) tr.innerHTML += `<td class="employee-cell" data-day="${d}"><input type="text" list="employee-names-list" oninput="triggerAutoSave(); refreshCellAvailabilityBadge(this, '${mealKey}')"></td>`;
    const addBtnRow = tbody.querySelector(`tr.schedule-add-row[data-meal="${mealKey}"]`); if(addBtnRow) tbody.insertBefore(tr, addBtnRow); else tbody.appendChild(tr);
    triggerAutoSave(); applyMutedDaysStyling(); applyScheduleWeekFilter(); const firstInput = tr.querySelector('.role-input'); if(firstInput) firstInput.focus();
}

function saveScheduleToDB() {
    const conflicts = findScheduleAvailabilityConflicts();
    if (conflicts.length) {
        const list = conflicts.slice(0, 10).map(c => `${c.name} — ${c.dateStr} (${c.meal})`).join('<br>');
        const more = conflicts.length > 10 ? `<br>ועוד ${conflicts.length - 10}...` : '';
        Swal.fire({
            title: 'נמצאו התנגשויות זמינות', icon: 'warning',
            html: `<div class="text-right text-sm">העובדים הבאים ביקשו אי-זמינות למועדים שבהם הם משובצים כרגע:<br><br>${list}${more}<br><br>לשמור בכל זאת?</div>`,
            showCancelButton: true, confirmButtonText: 'שמור בכל זאת', cancelButtonText: 'בטל, אני אתקן', confirmButtonColor: '#d97706'
        }).then(res => { if (res.isConfirmed) doSaveScheduleToDB(); });
        return;
    }
    doSaveScheduleToDB();
}

function doSaveScheduleToDB() {
    fetch("/api/schedule", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ month:document.getElementById("schedule-month-picker").value, matrix:getMatrixFromTable(), mealTimes:getMealTimesFromTable() }) })
    .then(async r => { const data = await r.json(); if(!r.ok) throw new Error(data.error || "Server Error"); return data; })
    .then(() => { localStorage.removeItem("schedule_draft"); const badge = document.getElementById("unsaved-badge"); if(badge) badge.classList.add("hidden"); Swal.fire({ icon:"success", title:"השיבוץ נשמר", toast: true, position: 'top', showConfirmButton: false, timer: 2000 }); })
    .catch(err => { Swal.fire({ icon:"error", title:"השמירה נכשלה", text:err.message }); });
}

function printSchedule() {
    const table = document.getElementById("schedule-table").outerHTML; const printWindow = window.open("", "_blank");
    printWindow.document.write(`<html dir="rtl"><head><title>שיבוץ עובדים</title><style>body{font-family:Arial,sans-serif;padding:20px;} h2{text-align:center;margin-bottom:20px;} table{width:100%;border-collapse:collapse;} td,th{border:1px solid #000;padding:6px;text-align:center;}</style></head><body><h2>שיבוץ עובדים</h2>${table}</body></html>`);
    printWindow.document.close(); setTimeout(() => { printWindow.print(); }, 500);
}

function buildWeekScheduleCanvas() {
    const monthVal = document.getElementById("schedule-month-picker").value; if(!monthVal) return null; const [year, monthNum] = monthVal.split('-');
    const weekDays = (currentScheduleWeeks && currentScheduleWeeks[currentScheduleWeekIndex]) || []; if(!weekDays.length) return null;
    const matrix = getMatrixFromTable(), mealTimes = getMealTimesFromTable(); const scheduleDayNames = ["א׳","ב׳","ג׳","ד׳","ה׳","ו׳","שבת"];
    const meals = [ { name: "בוקר", time: "08:30", key: "breakfast" }, { name: "צהריים", time: "11:30", key: "lunch" }, { name: "ערב", time: "18:30", key: "dinner" } ]; const rolesPerMeal = 6;
    const orderedDays = [...weekDays].reverse(); const numDayCols = orderedDays.length;
    const roleColWidth = 112, dayColWidth = 92, rowHeight = 34, headerHeight = 46, titleHeight = 40, padding = 16;
    const fixedRowsTotal = meals.length * rolesPerMeal; const extraByMeal = {}; meals.forEach(m => { extraByMeal[m.key] = []; }); const genericExtraRows = [];
    for(let i = fixedRowsTotal; i < matrix.length; i++){ const savedRow = matrix[i] || []; const decoded = decodeExtraRoleField(savedRow[0]); if(decoded.role && decoded.meal && extraByMeal[decoded.meal]) extraByMeal[decoded.meal].push({ role: decoded.role, cells: savedRow }); else if(decoded.role && !decoded.meal) genericExtraRows.push(savedRow); }
    const extraRowsCount = meals.reduce((sum, m) => sum + extraByMeal[m.key].length, 0) + genericExtraRows.length;
    const totalDataRows = meals.length * (1 + rolesPerMeal) + extraRowsCount;
    const canvasWidth = padding * 2 + roleColWidth + dayColWidth * numDayCols; const canvasHeight = padding * 2 + titleHeight + headerHeight + totalDataRows * rowHeight;
    const scale = 2; const canvas = document.createElement('canvas'); canvas.width = canvasWidth * scale; canvas.height = canvasHeight * scale;
    const ctx = canvas.getContext('2d'); ctx.scale(scale, scale); ctx.textBaseline = 'middle'; ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvasWidth, canvasHeight);
    function drawCell(x, yTop, w, h, text, opts) {
        opts = opts || {}; ctx.fillStyle = opts.bg || '#ffffff'; ctx.fillRect(x, yTop, w, h); ctx.strokeStyle = '#475569'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, yTop + 0.5, w - 1, h - 1);
        if(text){ ctx.fillStyle = opts.color || '#111827'; ctx.font = (opts.bold ? 'bold ' : '') + (opts.fontSize || 13) + 'px Arial, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(text, x + w / 2, opts.subtext ? yTop + h / 2 - 7 : yTop + h / 2, w - 8); if(opts.subtext){ ctx.font = '10px Arial, sans-serif'; ctx.fillStyle = opts.color || '#111827'; ctx.globalAlpha = 0.75; ctx.fillText(opts.subtext, x + w / 2, yTop + h / 2 + 9, w - 8); ctx.globalAlpha = 1; } }
    }
    const weekRangeLabel = weekDays.length > 1 ? `${weekDays[0]}-${weekDays[weekDays.length - 1]}/${parseInt(monthNum)}` : `${weekDays[0]}/${parseInt(monthNum)}`;
    ctx.fillStyle = '#111827'; ctx.font = 'bold 20px Arial, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(`שיבוץ עובדים – שבוע ${weekRangeLabel}`, canvasWidth / 2, padding + titleHeight / 2);
    let y = padding + titleHeight; const roleColX = padding + dayColWidth * numDayCols;
    drawCell(roleColX, y, roleColWidth, headerHeight, 'יום / שעה', { bg: '#f3f4f6', bold: true });
    orderedDays.forEach((d, idx) => { const dow = new Date(year, monthNum - 1, d).getDay(); drawCell(padding + idx * dayColWidth, y, dayColWidth, headerHeight, String(d), { bg: dow === 5 || dow === 6 ? '#fff7ed' : '#f3f4f6', bold: true, fontSize: 14, subtext: scheduleDayNames[dow] }); });
    y += headerHeight; let matrixIndex = 0;
    meals.forEach(meal => {
        drawCell(roleColX, y, roleColWidth, rowHeight, `${meal.name} / שעה`, { bg: '#e5e7eb', bold: true, fontSize: 12 });
        orderedDays.forEach((d, idx) => drawCell(padding + idx * dayColWidth, y, dayColWidth, rowHeight, mealTimes[`${meal.key}_${d}`] || meal.time, { bg: '#d1d5db', bold: true }));
        y += rowHeight;
        for(let i = 0; i < rolesPerMeal; i++){
            const row = matrix[matrixIndex] || []; drawCell(roleColX, y, roleColWidth, rowHeight, row[0] || '', { bg: '#e5e7eb', bold: true, fontSize: 12 });
            orderedDays.forEach((d, idx) => { const val = row[d] || ''; drawCell(padding + idx * dayColWidth, y, dayColWidth, rowHeight, val || '-', { bg: val ? '#7ba7d9' : '#eef2f7', color: val ? '#0f172a' : '#94a3b8', bold: !!val }); });
            y += rowHeight; matrixIndex++;
        }
        extraByMeal[meal.key].forEach(entry => {
            drawCell(roleColX, y, roleColWidth, rowHeight, entry.role || '', { bg: '#e5e7eb', bold: true, fontSize: 12 });
            orderedDays.forEach((d, idx) => { const val = entry.cells[d] || ''; drawCell(padding + idx * dayColWidth, y, dayColWidth, rowHeight, val || '-', { bg: val ? '#7ba7d9' : '#eef2f7', color: val ? '#0f172a' : '#94a3b8', bold: !!val }); });
            y += rowHeight;
        });
    });
    genericExtraRows.forEach(row => {
        drawCell(roleColX, y, roleColWidth, rowHeight, row[0] || '', { bg: '#e5e7eb', bold: true, fontSize: 12 });
        orderedDays.forEach((d, idx) => { const val = row[d] || ''; drawCell(padding + idx * dayColWidth, y, dayColWidth, rowHeight, val || '-', { bg: val ? '#7ba7d9' : '#eef2f7', color: val ? '#0f172a' : '#94a3b8', bold: !!val }); });
        y += rowHeight;
    });
    return canvas;
}

function sendScheduleWhatsapp() {
    const monthVal = document.getElementById("schedule-month-picker").value; if(!monthVal) return Swal.fire('שגיאה', 'נא לבחור חודש', 'error');
    if(!currentScheduleWeeks || !currentScheduleWeeks.length) return Swal.fire('שגיאה', 'לא נמצא שבוע לשליחה', 'error');
    let canvas; try { canvas = buildWeekScheduleCanvas(); } catch(err) { return Swal.fire('שגיאה', 'יצירת התמונה נכשלה', 'error'); }
    if(!canvas) return Swal.fire('שגיאה', 'לא ניתן להפיק תמונה', 'error');
    canvas.toBlob(blob => {
        if(!blob) return Swal.fire('שגיאה', 'יצירת התמונה נכשלה', 'error');
        const [year, monthNum] = monthVal.split('-'); const weekDays = currentScheduleWeeks[currentScheduleWeekIndex] || [];
        const weekTag = weekDays.length > 1 ? `${weekDays[0]}-${weekDays[weekDays.length - 1]}_${parseInt(monthNum)}` : `${weekDays[0]}_${parseInt(monthNum)}`;
        const file = new File([blob], `שיבוץ_שבועי_${weekTag}.png`, { type: 'image/png' });
        if(navigator.canShare && navigator.canShare({ files: [file] })){ navigator.share({ files: [file], title: 'שיבוץ עובדים', text: `שיבוץ עובדים לשבוע ${weekTag.replace('_', '/')}` }).catch(() => {}); } 
        else { const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `שיבוץ_שבועי_${weekTag}.png`; document.body.appendChild(link); link.click(); document.body.removeChild(link); Swal.fire({ title: 'התמונה הורדה', html: 'פתחו את WhatsApp Web וצרפו אותה ידנית לשיחה.', icon: 'info' }); }
    }, 'image/png');
}

// ----------------- SETTINGS & PINS -----------------
function saveGapAlertSetting() {
    const val = document.getElementById('setting-gap-alert').value;
    fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shift_gap_alert_hours: val }) })
    .then(r => r.json()).then(result => { if (result.success) showSuccessToast('ההגדרה נשמרה'); else Swal.fire('שגיאה', 'שמירת ההגדרה נכשלה', 'error'); });
}

function renderPinsTable() {
    const tbody = document.getElementById('pins-table-tbody'); tbody.innerHTML = '';
    const sortedEmployees = [...allEmployees].sort((a,b) => a.name.localeCompare(b.name));
    if (sortedEmployees.length === 0) { tbody.innerHTML = `<tr><td colspan="5" class="text-center py-8 text-slate-400">אין עובדים רשומים.</td></tr>`; return; }
    sortedEmployees.forEach(emp => {
        const tr = document.createElement('tr'); tr.className = "hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors"; const c = domainColor(emp.department);
        tr.innerHTML = `<td class="p-3 font-bold text-slate-900 dark:text-white ${!emp.is_active ? 'line-through text-slate-400' : ''}">${emp.name} ${!emp.is_active ? '<span class="text-[10px] bg-slate-200 text-slate-500 px-1 rounded ml-1">לא פעיל</span>' : ''}</td><td class="p-3"><span class="px-2.5 py-1 rounded-full text-xs font-semibold" style="background-color:${c}22;color:${c}">${emp.department || '-'}</span></td><td class="p-3 text-slate-600 dark:text-slate-400">${emp.role || '-'}</td><td class="p-3 font-mono text-slate-600 dark:text-slate-400">${emp.phone || '-'}</td><td class="p-3 font-black text-xl text-emerald-600 dark:text-emerald-400 tracking-widest">${emp.pin_code}</td>`;
        tbody.appendChild(tr);
    });
}

function addDomainPrompt() { Swal.fire({ title: 'תחום חדש', input: 'text', showCancelButton: true, confirmButtonText: 'הוסף', cancelButtonText: 'ביטול' }).then(res => { if (!res.isConfirmed || !res.value.trim()) return; fetch('/api/domains', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: res.value.trim() }) }).then(r => r.json()).then(result => { if (result.success) loadDomains(); }); }); }
function renameDomainPrompt(id, currentName) { Swal.fire({ title: 'שינוי שם', input: 'text', inputValue: currentName, showCancelButton: true, confirmButtonText: 'שמור', cancelButtonText: 'ביטול' }).then(res => { if (!res.isConfirmed || !res.value.trim()) return; fetch(`/api/domains/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: res.value.trim() }) }).then(r => r.json()).then(result => { if (result.success) { loadDomains(); loadEmployees(); } }); }); }
function updateDomainColor(id, color) { fetch(`/api/domains/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ color }) }).then(r => r.json()).then(result => { if (result.success) loadDomains(); }); }
function toggleDomainActive(id, newActive) { fetch(`/api/domains/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: newActive }) }).then(r => r.json()).then(result => { if (result.success) loadDomains(); }); }

function pollTick() {
    if (!document.getElementById('content-dashboard').classList.contains('hidden')) loadDashboard();
    if (!document.getElementById('content-hours').classList.contains('hidden') && currentEmpId) {
        if (document.activeElement && document.activeElement.tagName !== 'INPUT') {
            fetch(`/api/shifts/${currentEmpId}`, { cache: 'no-store' }).then(r=>r.json()).then(shifts => { currentShiftsMap = {}; shifts.forEach(s => { currentShiftsMap[s.date] = s; }); renderMonthGrid(); });
        }
    }
}

function startPolling() {
    if (mainPollInterval) return; 
    mainPollInterval = setInterval(pollTick, 10000);
    if (!liveTimerInterval) liveTimerInterval = setInterval(updateLiveTimers, 60000);
}

function stopPolling() {
    if (mainPollInterval) { clearInterval(mainPollInterval); mainPollInterval = null; }
    if (liveTimerInterval) { clearInterval(liveTimerInterval); liveTimerInterval = null; }
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        stopPolling();
    } else {
        startPolling();
        pollTick(); 
        updateLiveTimers();
    }
});

startPolling();
