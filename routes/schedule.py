import json
from datetime import datetime
from flask import Blueprint, request, jsonify, session
from database import db_cursor
from routes.auth import requires_role

schedule_bp = Blueprint('schedule', __name__)

MEAL_LABELS = {'breakfast': 'בוקר', 'lunch': 'צהריים', 'dinner': 'ערב', 'all': 'כל היום'}
REQUEST_TYPE_LABELS = {'available': 'זמין לעבודה', 'unavailable': 'לא זמין'}

MEALS_ORDER = ['breakfast', 'lunch', 'dinner']
ROWS_PER_MEAL = 6
EXTRA_ROLE_MEAL_PREFIX = '§meal:'

def _decode_extra_role(raw):
    if isinstance(raw, str) and raw.startswith(EXTRA_ROLE_MEAL_PREFIX):
        rest = raw[len(EXTRA_ROLE_MEAL_PREFIX):]
        if '§' in rest:
            meal, role = rest.split('§', 1)
            return meal, role
    return None, (raw or '')

def _load_month_schedule(cursor, month):
    cursor.execute("SELECT matrix_json FROM monthly_schedule WHERE month = %s", (month,))
    row = cursor.fetchone()
    if not row:
        return {'matrix': [], 'mealTimes': {}}
    try:
        payload = json.loads(row['matrix_json'])
    except Exception:
        return {'matrix': [], 'mealTimes': {}}
    if isinstance(payload, list):
        return {'matrix': payload, 'mealTimes': {}}
    return {'matrix': payload.get('matrix', []) or [], 'mealTimes': payload.get('mealTimes', {}) or {}}

def _save_month_schedule(cursor, conn, month, matrix, meal_times):
    new_modified = datetime.now().timestamp()
    payload = json.dumps({'matrix': matrix, 'mealTimes': meal_times, 'last_modified': new_modified})
    cursor.execute("""INSERT INTO monthly_schedule (month, matrix_json) VALUES (%s, %s)
                       ON CONFLICT(month) DO UPDATE SET matrix_json=EXCLUDED.matrix_json""", (month, payload))
    conn.commit()

def _try_assign_employee(matrix, meal_key, day_num, emp_name):
    if meal_key not in MEALS_ORDER:
        return 'full'

    def cell_of(row):
        return (row[day_num] if day_num < len(row) else '') or ''

    meal_idx = MEALS_ORDER.index(meal_key)
    fixed_start = meal_idx * ROWS_PER_MEAL
    fixed_end = fixed_start + ROWS_PER_MEAL

    empty_fixed_idx = None
    for i in range(fixed_start, min(fixed_end, len(matrix))):
        cell = cell_of(matrix[i]).strip()
        if cell == emp_name.strip():
            return 'already'
        if empty_fixed_idx is None and not cell:
            empty_fixed_idx = i

    extra_indices = []
    for i in range(len(MEALS_ORDER) * ROWS_PER_MEAL, len(matrix)):
        role_field = matrix[i][0] if matrix[i] else ''
        m_key, _role = _decode_extra_role(role_field)
        if m_key == meal_key:
            cell = cell_of(matrix[i]).strip()
            if cell == emp_name.strip():
                return 'already'
            extra_indices.append(i)

    if empty_fixed_idx is not None:
        row = matrix[empty_fixed_idx]
        while len(row) <= day_num: row.append('')
        row[day_num] = emp_name
        return 'assigned'

    for i in extra_indices:
        row = matrix[i]
        if not cell_of(row).strip():
            while len(row) <= day_num: row.append('')
            row[day_num] = emp_name
            return 'assigned'

    return 'full'

@schedule_bp.route('/api/schedule', methods=['GET', 'POST'])
@requires_role(['admin', 'manager'])
def handle_schedule():
    if request.method == 'POST':
        month = request.json.get('month')
        if not month: return jsonify({'error': 'Month is required'}), 400
        incoming_modified = request.json.get('last_modified', 0)
        
        with db_cursor(dict_cursor=True) as (conn, cursor):
            # הגנה מפני דריסת נתונים (Race Condition) ע"י מנהל אחר
            cursor.execute("SELECT matrix_json FROM monthly_schedule WHERE month = %s", (month,))
            row = cursor.fetchone()
            if row and row['matrix_json']:
                curr_data = json.loads(row['matrix_json'])
                curr_modified = curr_data.get('last_modified', 0)
                if curr_modified > incoming_modified:
                    return jsonify({'error': 'השיבוץ שונה על ידי מנהל אחר או פעולה אוטומטית בזמן שהמסך היה פתוח. רענן את העמוד כדי לראות את הנתונים החדשים ולא לדרוס אותם.'}), 409

            new_modified = datetime.now().timestamp()
            matrix_payload = json.dumps({'matrix': request.json.get('matrix') or [], 'mealTimes': request.json.get('mealTimes') or {}, 'last_modified': new_modified})
            cursor.execute("""INSERT INTO monthly_schedule (month, matrix_json) VALUES (%s, %s) 
                              ON CONFLICT(month) DO UPDATE SET matrix_json=EXCLUDED.matrix_json""", (month, matrix_payload))
            conn.commit()
        return jsonify({'success': True, 'last_modified': new_modified})
    else:
        month = request.args.get('month') or datetime.now().strftime('%Y-%m')
        with db_cursor(dict_cursor=True) as (conn, cursor):
            cursor.execute("SELECT matrix_json FROM monthly_schedule WHERE month = %s", (month,))
            row = cursor.fetchone()
        if row and row['matrix_json']:
            data = json.loads(row['matrix_json'])
            if isinstance(data, list): return jsonify({'matrix': data, 'mealTimes': {}, 'last_modified': 0})
            return jsonify({'matrix': data.get('matrix', []), 'mealTimes': data.get('mealTimes', {}), 'last_modified': data.get('last_modified', 0)})
        return jsonify({'matrix': [], 'mealTimes': {}, 'last_modified': 0})

@schedule_bp.route('/api/schedule/copy', methods=['POST'])
@requires_role(['admin', 'manager'])
def copy_schedule():
    target_month = request.json.get('target_month')
    if not target_month: return jsonify({'error': 'Target month is required'}), 400
    
    y, m = map(int, target_month.split('-'))
    if m == 1:
        prev_m = f"{y-1}-12"
    else:
        prev_m = f"{y}-{str(m-1).zfill(2)}"
        
    with db_cursor(dict_cursor=True) as (conn, cursor):
        cursor.execute("SELECT matrix_json FROM monthly_schedule WHERE month = %s", (prev_m,))
        row = cursor.fetchone()
        
        if not row or not row['matrix_json']:
            return jsonify({'success': False, 'error': f'לא נמצאו נתוני שיבוץ בחודש הקודם ({prev_m}) לשכפול.'})
            
        cursor.execute("""
            INSERT INTO monthly_schedule (month, matrix_json) VALUES (%s, %s) 
            ON CONFLICT(month) DO UPDATE SET matrix_json=EXCLUDED.matrix_json
        """, (target_month, row['matrix_json']))
        conn.commit()
        
    return jsonify({'success': True, 'message': 'השיבוץ שוכפל בהצלחה מהחודש הקודם!'})

@schedule_bp.route('/api/shift_requests', methods=['GET'])
@requires_role(['admin', 'manager'])
def get_shift_requests():
    month_filter = request.args.get('month')
    with db_cursor(dict_cursor=True) as (conn, cursor):
        cursor.execute("SELECT id, first_name, last_name FROM employees")
        emps = {e['id']: f"{e['first_name']} {e['last_name']}" for e in cursor.fetchall()}
        query = "SELECT * FROM shift_requests" + (" WHERE date LIKE %s ORDER BY date ASC, id ASC" if month_filter else " ORDER BY date ASC, id ASC")
        cursor.execute(query, (f"{month_filter}%",) if month_filter else ())
        reqs = cursor.fetchall()
        
        schedules = {}
        for m in set((r['date'] or '')[:7] for r in reqs if r['date']):
            cursor.execute("SELECT matrix_json FROM monthly_schedule WHERE month = %s", (m,))
            row = cursor.fetchone()
            schedules[m] = json.loads(row['matrix_json']).get('matrix', []) if row and not isinstance(json.loads(row['matrix_json']), list) else (json.loads(row['matrix_json']) if row else [])

    def is_assigned(emp_name, date_str, meal):
        m = date_str[:7]
        matrix = schedules.get(m, [])
        try:
            day_num = int(date_str[8:10])
        except (ValueError, TypeError):
            return False
        meal_indices = range(len(MEALS_ORDER)) if meal == 'all' else ([MEALS_ORDER.index(meal)] if meal in MEALS_ORDER else [])
        target_meals = {MEALS_ORDER[mi] for mi in meal_indices}
        for mi in meal_indices:
            for row in matrix[mi * ROWS_PER_MEAL:(mi + 1) * ROWS_PER_MEAL]:
                cell = (row[day_num] if day_num < len(row) else '') or ''
                if emp_name.strip() and emp_name.strip() in cell.strip():
                    return True
        for row in matrix[len(MEALS_ORDER) * ROWS_PER_MEAL:]:
            role_field = row[0] if row else ''
            row_meal, _role = _decode_extra_role(role_field)
            if row_meal in target_meals:
                cell = (row[day_num] if day_num < len(row) else '') or ''
                if emp_name.strip() and emp_name.strip() in cell.strip():
                    return True
        return False

    result = []
    for r in reqs:
        emp_name = emps.get(r['employee_id'], 'עובד לא ידוע')
        assigned = is_assigned(emp_name, r['date'] or '', r['meal'])
        conflicts = ['העובד מתוזמן בשיבוץ למרות בקשת אי-זמינות'] if r['request_type'] == 'unavailable' and assigned else []
        result.append({'id': r['id'], 'employee_id': r['employee_id'], 'employee_name': emp_name, 'date': r['date'], 'meal': r['meal'], 'meal_label': MEAL_LABELS.get(r['meal'], r['meal']), 'request_type': r['request_type'], 'request_type_label': REQUEST_TYPE_LABELS.get(r['request_type'], r['request_type']), 'note': r['note'], 'status': r['status'], 'is_assigned': assigned, 'has_conflict': len(conflicts) > 0, 'conflict_reasons': conflicts})
    return jsonify(result)

def _audit_log(action, req_id, **fields):
    reviewer = f"emp_id:{session.get('emp_id')}" if session.get('emp_id') else 'super_admin'
    ts = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    parts = ' '.join(f"{k}={v}" for k, v in fields.items())
    print(f"[AUDIT] shift_request id={req_id} action={action} by={reviewer} at={ts} {parts}".strip())

@schedule_bp.route('/api/shift_requests/<int:req_id>', methods=['PUT', 'DELETE'])
@requires_role(['admin', 'manager'])
def manage_shift_request(req_id):
    with db_cursor(dict_cursor=True) as (conn, cursor):
        if request.method == 'DELETE':
            cursor.execute("DELETE FROM shift_requests WHERE id = %s", (req_id,)); conn.commit()
            _audit_log('deleted', req_id)
            return jsonify({'success': True})

        cursor.execute("SELECT * FROM shift_requests WHERE id = %s", (req_id,))
        req = cursor.fetchone()
        if not req:
            return jsonify({'success': False, 'error': 'הבקשה לא נמצאה'}), 404

        status = (request.json or {}).get('status')
        if status not in ('pending', 'approved', 'rejected'):
            return jsonify({'success': False, 'error': 'סטטוס לא תקין'}), 400

        if status != 'approved':
            cursor.execute("UPDATE shift_requests SET status = %s WHERE id = %s", (status, req_id)); conn.commit()
            _audit_log(status, req_id, auto_assigned=False, conflict=False)
            return jsonify({'success': True})

        cursor.execute("SELECT first_name, last_name FROM employees WHERE id = %s", (req['employee_id'],))
        emp = cursor.fetchone()
        emp_name = f"{emp['first_name']} {emp['last_name']}".strip() if emp else None

        date_str = req['date'] or ''
        month = date_str[:7] if len(date_str) >= 7 else ''
        try:
            day_num = int(date_str[8:10])
        except (ValueError, TypeError):
            day_num = None

        if req['request_type'] != 'available' or not emp_name or not month or day_num is None:
            cursor.execute("UPDATE shift_requests SET status = %s WHERE id = %s", (status, req_id)); conn.commit()
            _audit_log('approved', req_id, auto_assigned=False, conflict=False, note='not_applicable')
            return jsonify({'success': True, 'assigned': False})

        cursor.execute("""SELECT DISTINCT request_type FROM shift_requests WHERE employee_id = %s AND date = %s AND meal = %s""", (req['employee_id'], req['date'], req['meal']))
        types_here = {r['request_type'] for r in cursor.fetchall()}
        if len(types_here) > 1:
            _audit_log('approve_blocked', req_id, reason='conflicting_requests')
            return jsonify({'success': False, 'conflict': True, 'message': f'יש בקשות סותרות של {emp_name} לאותו מועד (גם זמין וגם לא זמין) - יש לפתור לפני האישור.'})

        meal_keys = MEALS_ORDER if req['meal'] == 'all' else ([req['meal']] if req['meal'] in MEALS_ORDER else [])
        if not meal_keys:
            cursor.execute("UPDATE shift_requests SET status = %s WHERE id = %s", (status, req_id)); conn.commit()
            _audit_log('approved', req_id, auto_assigned=False, conflict=False, note='invalid_meal')
            return jsonify({'success': True, 'assigned': False})

        sched = _load_month_schedule(cursor, month)
        matrix = sched['matrix']
        results = {mk: _try_assign_employee(matrix, mk, day_num, emp_name) for mk in meal_keys}
        full_meals = [MEAL_LABELS.get(mk, mk) for mk, r in results.items() if r == 'full']

        if full_meals:
            _audit_log('approve_blocked', req_id, reason='no_available_slot', meals=','.join(full_meals))
            meals_txt = ', '.join(full_meals)
            return jsonify({'success': False, 'conflict': True, 'message': f'אין תא פנוי ל{emp_name} ב{"ארוחות" if len(full_meals) > 1 else "ארוחת"} {meals_txt} ביום {day_num}. אפשר להוסיף שורת "מלצר נוסף" לארוחה בטבלת השיבוץ ואז לאשר שוב.'})

        _save_month_schedule(cursor, conn, month, matrix, sched['mealTimes'])
        cursor.execute("UPDATE shift_requests SET status = %s WHERE id = %s", (status, req_id)); conn.commit()

        newly_assigned = any(r == 'assigned' for r in results.values())
        _audit_log('approved', req_id, auto_assigned=newly_assigned, conflict=False)
        return jsonify({'success': True, 'assigned': newly_assigned, 'message': (f'{emp_name} שובץ אוטומטית בטבלת השיבוץ.' if newly_assigned else f'{emp_name} כבר היה משובץ במועד הזה - הבקשה אושרה.')})

@schedule_bp.route('/api/kiosk/shift_request', methods=['POST'])
def kiosk_create_shift_request():
    data = request.json or {}
    pin, date, meal, request_type, note = data.get('pin'), data.get('date'), data.get('meal', 'all'), data.get('request_type'), data.get('note', '')
    with db_cursor(dict_cursor=True) as (conn, cursor):
        cursor.execute("SELECT * FROM employees WHERE pin_code = %s", (pin,))
        emp = cursor.fetchone()
        if not emp: return jsonify({'success': False, 'message': 'קוד PIN שגוי.'})
        if not date or request_type not in ('available', 'unavailable'): return jsonify({'success': False, 'message': 'נא למלא תאריך וסוג בקשה.'})
        cursor.execute("""INSERT INTO shift_requests (employee_id, date, meal, request_type, note, status) 
                          VALUES (%s, %s, %s, %s, %s, 'pending')""", (emp['id'], date, meal, request_type, note))
        conn.commit()
        return jsonify({'success': True, 'name': f"{emp['first_name']} {emp['last_name']}"})
