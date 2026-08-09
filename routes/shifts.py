from flask import Blueprint, request, jsonify, session
from datetime import datetime, timedelta
from calendar import monthrange
from database import db_cursor, calc_hours, get_setting, SETTINGS_SCHEMA
from routes.auth import requires_role

shifts_bp = Blueprint('shifts', __name__)

def t_to_float(t):
    if not t or t == '-': return None
    try:
        h, m = map(int, str(t).split(':'))
        return h + m / 60.0
    except Exception:
        return None

def compute_month_summary(month):
    today_str = datetime.now().strftime('%Y-%m-%d')
    with db_cursor(dict_cursor=True) as (conn, cursor):
        cursor.execute("SELECT id, department, first_name, last_name FROM employees")
        emps = cursor.fetchall()
        cursor.execute("SELECT id, name, color FROM domains ORDER BY sort_order ASC, id ASC")
        domains = cursor.fetchall()
        cursor.execute("""SELECT s.employee_id, s.date, s.entry_time, s.exit_time, s.total_hours, d.name AS domain_name 
                          FROM shift_segments s LEFT JOIN domains d ON d.id = s.domain_id 
                          WHERE s.date LIKE %s""", (f"{month}%",))
        segments = cursor.fetchall()

    emp_name_map = {e['id']: f"{e['first_name']} {e['last_name']}" for e in emps}
    domain_hours = {d['name']: 0.0 for d in domains}
    domain_shift_count = {d['name']: 0 for d in domains}
    domain_active_employees = {d['name']: set() for d in domains}
    emp_hours_map = {e['id']: {'name': emp_name_map[e['id']], 'hours': 0.0, 'domain': None} for e in emps}
    anomalies_count, total_hours, shift_count = 0, 0.0, 0

    for s in segments:
        if s['date'] < today_str and s['entry_time'] and not s['exit_time']: anomalies_count += 1
        hours = float(s['total_hours'] or 0)
        total_hours += hours
        shift_count += 1
        dname = s['domain_name'] or 'ללא תחום'
        domain_hours[dname] = domain_hours.get(dname, 0.0) + hours
        domain_shift_count[dname] = domain_shift_count.get(dname, 0) + 1
        if dname in domain_active_employees:
            domain_active_employees[dname].add(s['employee_id'])
        if s['employee_id'] in emp_hours_map:
            emp_hours_map[s['employee_id']]['hours'] += hours
            emp_hours_map[s['employee_id']]['domain'] = dname

    employees_assigned_per_domain = {}
    for e in emps: employees_assigned_per_domain[e['department']] = employees_assigned_per_domain.get(e['department'], 0) + 1

    domain_colors = {d['name']: d['color'] for d in domains}
    chart_data = [{'name': v['name'], 'hours': round(v['hours'], 2), 'domain': v['domain'], 'color': domain_colors.get(v['domain'], '#6366f1')} for v in emp_hours_map.values() if v['hours'] > 0]

    domains_summary = []
    for d in domains:
        name = d['name']
        active_count = len(domain_active_employees.get(name, set()))
        hours = round(domain_hours.get(name, 0), 2)
        domains_summary.append({
            'name': name,
            'color': d['color'],
            'employees_count': employees_assigned_per_domain.get(name, 0),
            'active_employees_count': active_count,
            'hours': hours,
            'shift_count': domain_shift_count.get(name, 0),
            'avg_hours_per_employee': round(hours / active_count, 2) if active_count > 0 else 0
        })

    return {
        'month': month,
        'domains_summary': domains_summary,
        'anomalies_count': anomalies_count,
        'chart_data': chart_data,
        'total_hours': round(total_hours, 2),
        'shift_count': shift_count
    }

def compute_month_forecast(month, total_hours_so_far, shift_count_so_far):
    now = datetime.now()
    if month != now.strftime('%Y-%m'):
        return None
    days_in_month = monthrange(now.year, now.month)[1]
    days_elapsed = now.day
    if days_elapsed <= 0:
        return None
    return {
        'hours': round(total_hours_so_far / days_elapsed * days_in_month, 1),
        'shifts': round(shift_count_so_far / days_elapsed * days_in_month),
        'days_elapsed': days_elapsed,
        'days_in_month': days_in_month,
        'is_estimate': True
    }

@shifts_bp.route('/api/dashboard', methods=['GET'])
@requires_role(['admin', 'manager'])
def dashboard_stats():
    today_str = datetime.now().strftime('%Y-%m-%d')
    month_str = datetime.now().strftime('%Y-%m')
    
    payload = compute_month_summary(month_str)
    payload['forecast'] = compute_month_forecast(month_str, payload['total_hours'], payload['shift_count'])
    
    with db_cursor(dict_cursor=True) as (conn, cursor):
        cursor.execute("""
            SELECT e.id, e.first_name, e.last_name, d.name AS domain_name, d.color AS domain_color, s.entry_time
            FROM shift_segments s
            JOIN employees e ON s.employee_id = e.id
            LEFT JOIN domains d ON s.domain_id = d.id
            WHERE s.date = %s AND s.exit_time IS NULL
            ORDER BY s.entry_time DESC
        """, (today_str,))
        payload['live_employees'] = cursor.fetchall()
        
        cursor.execute("SELECT COUNT(*) AS c FROM time_corrections WHERE status = 'pending'")
        pending_corrections = cursor.fetchone()['c']
        
        cursor.execute("SELECT COUNT(*) AS c FROM shift_requests WHERE status = 'pending'")
        pending_requests = cursor.fetchone()['c']
        
        cursor.execute("SELECT COUNT(*) AS c FROM shift_segments WHERE exit_time IS NULL AND date < %s", (today_str,))
        past_open_shifts = cursor.fetchone()['c']
        
        payload['action_center'] = {
            'pending_corrections': pending_corrections,
            'pending_requests': pending_requests,
            'past_open_shifts': past_open_shifts
        }
        
    return jsonify(payload)

@shifts_bp.route('/api/dashboard/trend', methods=['GET'])
@requires_role(['admin', 'manager'])
def dashboard_trend():
    try:
        months_count = int(request.args.get('months', 6))
    except (TypeError, ValueError):
        months_count = 6
    months_count = max(1, min(months_count, 12))

    now = datetime.now()
    month_keys = []
    y, m = now.year, now.month
    for _ in range(months_count):
        month_keys.append(f"{y}-{str(m).zfill(2)}")
        m -= 1
        if m == 0:
            m, y = 12, y - 1
    month_keys.reverse() 

    earliest = month_keys[0]
    with db_cursor(dict_cursor=True) as (conn, cursor):
        cursor.execute("""SELECT LEFT(date, 7) AS month, COALESCE(SUM(total_hours), 0) AS hours, COUNT(*) AS shifts
                           FROM shift_segments
                           WHERE LEFT(date, 7) >= %s
                           GROUP BY LEFT(date, 7)""", (earliest,))
        rows = {r['month']: r for r in cursor.fetchall()}

    result = {
        'months': month_keys,
        'total_hours': [round(float(rows[mk]['hours']), 2) if mk in rows else 0 for mk in month_keys],
        'shift_counts': [int(rows[mk]['shifts']) if mk in rows else 0 for mk in month_keys]
    }
    return jsonify(result)

@shifts_bp.route('/api/shifts/summary', methods=['GET'])
@requires_role(['admin', 'manager'])
def shifts_summary():
    month = request.args.get('month', datetime.now().strftime('%Y-%m'))
    return jsonify(compute_month_summary(month))

@shifts_bp.route('/api/shifts/<int:emp_id>', methods=['GET'])
@requires_role(['admin', 'manager'])
def get_shifts(emp_id):
    gap_alert_hours = float(get_setting('shift_gap_alert_hours', '8') or 8)
    if gap_alert_hours <= 0: gap_alert_hours = None

    month_filter = request.args.get('month')

    with db_cursor(dict_cursor=True) as (conn, cursor):
        if month_filter:
            cursor.execute("""SELECT s.*, d.name AS domain_name, d.color AS domain_color 
                              FROM shift_segments s LEFT JOIN domains d ON d.id = s.domain_id 
                              WHERE s.employee_id = %s AND s.date LIKE %s ORDER BY s.date ASC, s.id ASC""", (emp_id, f"{month_filter}%"))
        else:
            cursor.execute("""SELECT s.*, d.name AS domain_name, d.color AS domain_color 
                              FROM shift_segments s LEFT JOIN domains d ON d.id = s.domain_id 
                              WHERE s.employee_id = %s ORDER BY s.date ASC, s.id ASC""", (emp_id,))
        rows = cursor.fetchall()
    today_str = datetime.now().strftime('%Y-%m-%d')
        
    by_date = {}
    for r in rows: by_date.setdefault(r['date'], []).append(r)
    result = []
    
    for date_str, segs in sorted(by_date.items()):
        segs_sorted = sorted(segs, key=lambda x: (t_to_float(x['entry_time']) if t_to_float(x['entry_time']) is not None else 999, x['id']))
        warnings, total_hours, seg_list, prev_exit = [], 0.0, [], None
        for seg in segs_sorted:
            entry_f, exit_f = t_to_float(seg['entry_time']), t_to_float(seg['exit_time'])
            if date_str < today_str and seg['entry_time'] and not seg['exit_time']: warnings.append(f"משמרת פתוחה מ-{seg['entry_time']}")
            if seg['total_hours'] and float(seg['total_hours']) > 16: warnings.append(f"משמרת חריגה ({seg['total_hours']} שעות)")
            if prev_exit is not None and entry_f is not None:
                if entry_f < prev_exit: warnings.append("חפיפת זמנים באותו יום")
                elif gap_alert_hours is not None:
                    gap = entry_f - prev_exit
                    if gap < 0: gap += 24
                    if gap > gap_alert_hours: warnings.append(f"פער של {round(gap, 1)} שעות")
            if exit_f is not None: prev_exit = exit_f
            total_hours += float(seg['total_hours'] or 0)
            seg_list.append({'id': seg['id'], 'domain_id': seg['domain_id'], 'domain_name': seg['domain_name'] or 'ללא תחום', 'domain_color': seg['domain_color'] or '#94a3b8', 'entry': seg['entry_time'] or '', 'exit': seg['exit_time'] or '', 'total_hours': seg['total_hours'] or 0, 'notes': seg['notes'] or '', 'source': seg['source'] or 'manual'})
        result.append({'date': date_str, 'segments': seg_list, 'total_hours': round(total_hours, 2), 'warnings': warnings, 'is_anomaly': len(warnings) > 0})
    return jsonify(result)

@shifts_bp.route('/api/shifts/upsert', methods=['POST'])
@requires_role(['admin', 'manager'])
def upsert_shift():
    data = request.json or {}
    emp_id, date, segments = data.get('employee_id'), data.get('date'), data.get('segments')
    if not emp_id or not date or segments is None: return jsonify({'success': False, 'error': 'חסרים שדות חובה'}), 400
    with db_cursor() as (conn, cursor):
        
        # תיקון (מניעת השמדת מזהי משמרות במחיקה מלאה ויצירה מחדש): 
        # משמרות שמגיעות עם ID יעודכנו, ורק כאלו שהוסרו יימחקו
        incoming_ids = [int(seg['id']) for seg in segments if str(seg.get('id')).isdigit()]
        if incoming_ids:
            format_strings = ','.join(['%s'] * len(incoming_ids))
            cursor.execute(f"DELETE FROM shift_segments WHERE employee_id = %s AND date = %s AND id NOT IN ({format_strings})", [emp_id, date] + incoming_ids)
        else:
            cursor.execute("DELETE FROM shift_segments WHERE employee_id = %s AND date = %s", (emp_id, date))

        for seg in segments:
            entry, exit_ = (seg.get('entry') or '').strip() or None, (seg.get('exit') or '').strip() or None
            total = seg.get('total_hours')
            try: total = float(total) if total not in (None, '') else 0
            except: total = 0
            
            if not entry and not exit_ and not total and not seg.get('notes'): continue
            if not total and entry and exit_: total = calc_hours(entry, exit_)
            
            seg_id = seg.get('id')
            if str(seg_id).isdigit():
                cursor.execute("""UPDATE shift_segments 
                                  SET domain_id=%s, entry_time=%s, exit_time=%s, total_hours=%s, notes=%s, source=%s 
                                  WHERE id=%s AND employee_id=%s""",
                               (seg.get('domain_id') or None, entry, exit_, round(total, 2), (seg.get('notes') or '').strip() or None, (seg.get('source') or 'manual').strip() or 'manual', int(seg_id), emp_id))
            else:
                cursor.execute("""INSERT INTO shift_segments (employee_id, date, domain_id, entry_time, exit_time, total_hours, notes, source) 
                                  VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""", 
                               (emp_id, date, seg.get('domain_id') or None, entry, exit_, round(total, 2), (seg.get('notes') or '').strip() or None, (seg.get('source') or 'manual').strip() or 'manual'))
        conn.commit()
    return jsonify({'success': True})

@shifts_bp.route('/api/kiosk/validate_pin', methods=['POST'])
def kiosk_validate_pin():
    pin = (request.json or {}).get('pin')
    with db_cursor(dict_cursor=True) as (conn, cursor):
        cursor.execute("SELECT * FROM employees WHERE pin_code = %s", (pin,))
        emp = cursor.fetchone()
    if not emp: return jsonify({'success': False, 'message': 'קוד PIN שגוי. אנא נסה שוב.'})
    if not emp.get('is_active', True): return jsonify({'success': False, 'message': 'העובד אינו פעיל במערכת.'})
    return jsonify({'success': True, 'employee_id': emp['id'], 'name': f"{emp['first_name']} {emp['last_name']}"})

@shifts_bp.route('/api/kiosk/punch', methods=['POST'])
def kiosk_punch():
    data = request.json or {}
    pin, action_type, domain_id = data.get('pin'), data.get('action_type'), data.get('domain_id')
    with db_cursor(dict_cursor=True) as (conn, cursor):
        cursor.execute("SELECT * FROM employees WHERE pin_code = %s", (pin,))
        emp = cursor.fetchone()
        if not emp: return jsonify({'success': False, 'message': 'קוד PIN שגוי.'})
        if not emp.get('is_active', True): return jsonify({'success': False, 'message': 'העובד אינו פעיל במערכת.'})
        today, time_now = datetime.now().strftime('%Y-%m-%d'), datetime.now().strftime('%H:%M')
        cursor.execute("""SELECT * FROM shift_segments WHERE employee_id = %s AND exit_time IS NULL ORDER BY date DESC, id DESC LIMIT 1""", (emp['id'],))
        open_segment = cursor.fetchone()
        action_name, domain_label = "", ""
        if action_type == 'entry':
            if open_segment: return jsonify({'success': False, 'message': 'אתה כבר במשמרת פעילה.'})
            if not domain_id: return jsonify({'success': False, 'message': 'יש לבחור תחום.'})
            cursor.execute("SELECT id, name FROM domains WHERE id = %s AND active = TRUE", (domain_id,))
            domain = cursor.fetchone()
            if not domain: return jsonify({'success': False, 'message': 'תחום אינו תקין.'})
            cursor.execute("""INSERT INTO shift_segments (employee_id, date, domain_id, entry_time, exit_time, total_hours, notes, source) 
                              VALUES (%s, %s, %s, %s, NULL, 0, NULL, 'kiosk')""", (emp['id'], today, domain_id, time_now))
            action_name, domain_label = "כניסה למשמרת", domain['name']
        elif action_type == 'exit':
            if not open_segment: return jsonify({'success': False, 'message': 'לא נמצאה משמרת פתוחה.'})
            
            # התיקון: חסימת משמרות "זומבי" של ימים קודמים
            if open_segment['date'] != today:
                return jsonify({'success': False, 'message': 'המשמרת הפתוחה שלך היא מיום קודם. אנא השתמש ב"תיקון שעות ידני" כדי לסגור אותה.'})

            total = calc_hours(open_segment['entry_time'], time_now)
            cursor.execute("UPDATE shift_segments SET exit_time = %s, total_hours = %s WHERE id = %s", (time_now, round(total, 2), open_segment['id']))
            cursor.execute("SELECT name FROM domains WHERE id = %s", (open_segment['domain_id'],))
            d = cursor.fetchone()
            action_name, domain_label = "יציאה ממשמרת", d['name'] if d else ''
        else: return jsonify({'success': False, 'message': 'סוג פעולה לא תקין.'})
        conn.commit()
        return jsonify({'success': True, 'name': f"{emp['first_name']} {emp['last_name']}", 'action': action_name, 'time': time_now, 'domain': domain_label})

@shifts_bp.route('/api/kiosk/time_correction', methods=['POST'])
def kiosk_time_correction():
    data = request.json or {}
    pin = data.get('pin')
    date, entry, exit_time = data.get('date'), data.get('entry'), data.get('exit')
    domain_id, reason = data.get('domain_id'), data.get('reason', '')
    with db_cursor(dict_cursor=True) as (conn, cursor):
        cursor.execute("SELECT id, first_name, last_name, is_active FROM employees WHERE pin_code = %s", (pin,))
        emp = cursor.fetchone()
        if not emp: return jsonify({'success': False, 'message': 'קוד PIN שגוי.'})
        if not emp.get('is_active', True): return jsonify({'success': False, 'message': 'העובד אינו פעיל.'})
        if not date or not entry or not exit_time or not domain_id:
            return jsonify({'success': False, 'message': 'נא למלא את כל שדות החובה.'})
        
        cursor.execute("""INSERT INTO time_corrections (employee_id, date, domain_id, entry_time, exit_time, reason)
                          VALUES (%s, %s, %s, %s, %s, %s)""", 
                       (emp['id'], date, domain_id, entry, exit_time, reason))
        conn.commit()
        return jsonify({'success': True, 'name': f"{emp['first_name']} {emp['last_name']}"})

@shifts_bp.route('/api/time_corrections', methods=['GET'])
@requires_role(['admin', 'manager'])
def get_time_corrections():
    month_filter = request.args.get('month')
    with db_cursor(dict_cursor=True) as (conn, cursor):
        query = """SELECT c.*, e.first_name, e.last_name, d.name as domain_name 
                   FROM time_corrections c JOIN employees e ON c.employee_id = e.id 
                   LEFT JOIN domains d ON c.domain_id = d.id"""
        if month_filter:
            cursor.execute(query + " WHERE c.date LIKE %s ORDER BY c.date ASC, c.id ASC", (f"{month_filter}%",))
        else:
            cursor.execute(query + " ORDER BY c.date ASC, c.id ASC")
        return jsonify(cursor.fetchall())

@shifts_bp.route('/api/time_corrections/<int:req_id>', methods=['PUT'])
@requires_role(['admin', 'manager'])
def update_time_correction(req_id):
    status = (request.json or {}).get('status')
    if status not in ('approved', 'rejected'): return jsonify({'success': False, 'error': 'סטטוס לא תקין'}), 400
    with db_cursor(dict_cursor=True) as (conn, cursor):
        cursor.execute("SELECT * FROM time_corrections WHERE id = %s", (req_id,))
        req = cursor.fetchone()
        if not req: return jsonify({'success': False, 'error': 'בקשה לא נמצאה'}), 404
        
        if status == 'approved':
            # תיקון "אישור עיוור": מוודא שאין משמרת חופפת קיימת לפני שמאשרים
            cursor.execute("SELECT entry_time, exit_time FROM shift_segments WHERE employee_id = %s AND date = %s AND exit_time IS NOT NULL", (req['employee_id'], req['date']))
            existing_shifts = cursor.fetchall()
            s1 = t_to_float(req['entry_time'])
            e1 = t_to_float(req['exit_time'])
            if s1 is not None and e1 is not None:
                if e1 < s1: e1 += 24
                for ex in existing_shifts:
                    s2 = t_to_float(ex['entry_time'])
                    e2 = t_to_float(ex['exit_time'])
                    if s2 is not None and e2 is not None:
                        if e2 < s2: e2 += 24
                        if s1 < e2 and s2 < e1:
                            return jsonify({'success': False, 'error': 'אי אפשר לאשר - כבר קיימת למערכת משמרת חופפת עבור העובד בשעות אלו באותו היום!'}), 400

            total = calc_hours(req['entry_time'], req['exit_time'])
            cursor.execute("""INSERT INTO shift_segments (employee_id, date, domain_id, entry_time, exit_time, total_hours, notes, source)
                              VALUES (%s, %s, %s, %s, %s, %s, %s, 'correction')""",
                           (req['employee_id'], req['date'], req['domain_id'], req['entry_time'], req['exit_time'], round(total, 2), f"אישור תיקון: {req['reason']}" if req['reason'] else "אישור מנהל"))
        
        cursor.execute("UPDATE time_corrections SET status = %s WHERE id = %s", (status, req_id))
        conn.commit()
    return jsonify({'success': True})
