import os
import psycopg2
from psycopg2 import pool as pg_pool
from psycopg2.extras import RealDictCursor
from flask import Flask, render_template, request, jsonify, session, Response
from contextlib import contextmanager
import json
import csv
from io import StringIO
from datetime import datetime

app = Flask(__name__)
app.secret_key = 'admin_secret_key_123'

DATABASE_URL = os.environ.get('DATABASE_URL')

# ==========================================
# מאגר חיבורים (connection pool) לבסיס הנתונים
# ==========================================
# במקום לפתוח חיבור TCP/SSL חדש לבסיס הנתונים בכל בקשה (איטי, ובבסיסי נתונים
# מנוהלים כמו Neon/Render עלול להיתקל ב"התעוררות" איטית של השרת אחרי חוסר פעילות),
# מחזיקים כמה חיבורים פתוחים מראש וממחזרים אותם. זה גם קובע תקרה ברורה למספר
# החיבורים הנפתחים, כך שבמקום "להיתקע" בהמתנה לחיבור פנוי, בקשה שלא מקבלת
# חיבור בזמן סביר תיכשל במהירות עם שגיאה ברורה במקום להיתלות ללא הגבלת זמן.
db_pool = None

def init_pool():
    global db_pool
    if DATABASE_URL and db_pool is None:
        db_pool = pg_pool.ThreadedConnectionPool(1, 15, DATABASE_URL)

if DATABASE_URL:
    init_pool()

def get_db():
    return psycopg2.connect(DATABASE_URL)

# ==========================================
# ניהול חיבורי DB בטוח: מבטיח שהחיבור תמיד יוחזר למאגר
# (גם אם מתרחשת שגיאה באמצע הבקשה), כדי למנוע מצב שבו חיבורים
# "נעלמים" בהדרגה ומרוקנים את המאגר, וגורמים לכל פעולה עתידית
# "להיתקע" בהמתנה לחיבור פנוי. אם החיבור נתקל בשגיאה (למשל חיבור
# שנסגר בצד השרת אחרי חוסר פעילות ארוך), הוא מוחזר עם close=True
# כדי שלא יחזור לשימוש במצב שבור, ובקשה חדשה תיפתח חיבור טרי במקומו.
# ==========================================
@contextmanager
def db_cursor(dict_cursor=False):
    if db_pool is None:
        # נפילה חזרה לחיבור ישיר (למשל בסביבת פיתוח מקומית ללא מאגר)
        conn = get_db()
        cursor = conn.cursor(cursor_factory=RealDictCursor) if dict_cursor else conn.cursor()
        try:
            yield conn, cursor
        except Exception:
            conn.rollback()
            raise
        finally:
            cursor.close()
            conn.close()
        return

    conn = db_pool.getconn()
    had_error = False
    cursor = conn.cursor(cursor_factory=RealDictCursor) if dict_cursor else conn.cursor()
    try:
        yield conn, cursor
    except Exception:
        had_error = True
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        cursor.close()
        db_pool.putconn(conn, close=had_error)

def init_db():
    if not DATABASE_URL:
        return
    with db_cursor() as (conn, cursor):
        cursor.execute('''CREATE TABLE IF NOT EXISTS employees
                      (id SERIAL PRIMARY KEY, 
                       first_name TEXT, 
                       last_name TEXT, 
                       phone TEXT, 
                       pin_code TEXT,
                       department TEXT,
                       role TEXT)''')
        cursor.execute('''CREATE TABLE IF NOT EXISTS shifts
                      (id SERIAL PRIMARY KEY,
                       employee_id INTEGER,
                       date TEXT,
                       entry1 TEXT,
                       exit1 TEXT,
                       entry2 TEXT,
                       exit2 TEXT,
                       total_hours REAL,
                       notes TEXT,
                       UNIQUE(employee_id, date))''')
        cursor.execute('''CREATE TABLE IF NOT EXISTS monthly_schedule
                      (id SERIAL PRIMARY KEY,
                       month TEXT UNIQUE,
                       matrix_json TEXT)''')
        cursor.execute('''CREATE TABLE IF NOT EXISTS shift_requests
                      (id SERIAL PRIMARY KEY,
                       employee_id INTEGER,
                       date TEXT,
                       meal TEXT,
                       request_type TEXT,
                       note TEXT,
                       status TEXT DEFAULT 'pending',
                       created_at TIMESTAMP DEFAULT NOW())''')
        conn.commit()

if DATABASE_URL:
    init_db()

# ==========================================
# שכבת הגנה: ביטול שמירה בזיכרון (Cache)
# ==========================================
@app.after_request
def add_header(response):
    response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '0'
    return response

def calc_hours(start_str, end_str):
    if start_str == '-' or end_str == '-': return 0
    fmt = '%H:%M'
    try:
        t1 = datetime.strptime(start_str, fmt)
        t2 = datetime.strptime(end_str, fmt)
        diff = (t2 - t1).total_seconds()
        if diff < 0: diff += 86400  
        return diff / 3600
    except:
        return 0

@app.route('/')
def admin_panel(): return render_template('index.html')

@app.route('/kiosk')
def kiosk_mode(): return render_template('kiosk.html')

@app.route('/api/check_auth', methods=['GET'])
def check_auth(): return jsonify({'logged_in': session.get('logged_in', False)})

@app.route('/api/login', methods=['POST'])
def login():
    if request.json.get('password') == 'admin':
        session['logged_in'] = True
        return jsonify({'success': True})
    return jsonify({'success': False}), 401

@app.route('/api/logout', methods=['POST'])
def logout():
    session.pop('logged_in', None)
    return jsonify({'success': True})

@app.route('/api/employees', methods=['GET'])
def get_employees():
    if not session.get('logged_in'): return jsonify({'error': 'Unauthorized'}), 401
    with db_cursor(dict_cursor=True) as (conn, cursor):
        cursor.execute("SELECT * FROM employees ORDER BY first_name")
        emps = cursor.fetchall()
    return jsonify([{'id': e['id'], 'name': f"{e['first_name']} {e['last_name']}", 'phone': e['phone'], 'department': e['department'], 'role': e['role'], 'pin_code': e['pin_code']} for e in emps])

@app.route('/api/employees', methods=['POST'])
def add_employee():
    if not session.get('logged_in'): return jsonify({'error': 'Unauthorized'}), 401
    data = request.json or {}
    if not data.get('first_name') or not data.get('last_name') or not data.get('phone') or not data.get('department'):
        return jsonify({'success': False, 'error': 'יש למלא את כל שדות החובה'}), 400
    pin = data['phone'][-4:] if data['phone'] and len(data['phone']) >= 4 else '0000'
    with db_cursor() as (conn, cursor):
        cursor.execute("INSERT INTO employees (first_name, last_name, phone, pin_code, department, role) VALUES (%s, %s, %s, %s, %s, %s)",
                   (data['first_name'], data['last_name'], data['phone'], pin, data['department'], data.get('role', '')))
        conn.commit()
    return jsonify({'success': True, 'pin': pin})

@app.route('/api/employees/<int:emp_id>', methods=['PUT'])
def update_employee(emp_id):
    if not session.get('logged_in'): return jsonify({'success': False, 'error': 'Unauthorized'}), 401
    data = request.json or {}
    if not data.get('first_name') or not data.get('last_name') or not data.get('phone') or not data.get('department'):
        return jsonify({'success': False, 'error': 'יש למלא את כל שדות החובה'}), 400

    pin = data['phone'][-4:] if data['phone'] and len(data['phone']) >= 4 else '0000'

    with db_cursor() as (conn, cursor):
        cursor.execute("SELECT id FROM employees WHERE id = %s", (emp_id,))
        if not cursor.fetchone():
            return jsonify({'success': False, 'error': 'עובד לא נמצא'}), 404

        cursor.execute("""
            UPDATE employees
            SET first_name = %s, last_name = %s, phone = %s, pin_code = %s, department = %s, role = %s
            WHERE id = %s
        """, (data['first_name'], data['last_name'], data['phone'], pin, data['department'], data.get('role', ''), emp_id))
        conn.commit()
    return jsonify({'success': True, 'pin': pin})

@app.route('/api/employees/<int:emp_id>', methods=['DELETE'])
def delete_employee(emp_id):
    if not session.get('logged_in'): return jsonify({'error': 'Unauthorized'}), 401
    with db_cursor() as (conn, cursor):
        cursor.execute("DELETE FROM employees WHERE id = %s", (emp_id,))
        cursor.execute("DELETE FROM shifts WHERE employee_id = %s", (emp_id,))
        conn.commit()
    return jsonify({'success': True})

@app.route('/api/shifts/<int:emp_id>', methods=['GET'])
def get_shifts(emp_id):
    if not session.get('logged_in'): return jsonify({'error': 'Unauthorized'}), 401
    with db_cursor(dict_cursor=True) as (conn, cursor):
        cursor.execute("SELECT * FROM shifts WHERE employee_id = %s ORDER BY date ASC", (emp_id,))
        shifts = cursor.fetchall()

    result = []
    today_str = datetime.now().strftime('%Y-%m-%d')
    
    def t_to_float(t_str):
        if not t_str or t_str == '-': return None
        try:
            h, m = map(int, t_str.split(':'))
            return h + m/60.0
        except: return None

    for s in shifts:
        warnings = []
        if s['date'] < today_str:
            if s['entry1'] != '-' and s['exit1'] == '-': warnings.append("משמרת 1 נותרה פתוחה (חסר clock_out)")
            if s['entry2'] != '-' and s['exit2'] == '-': warnings.append("משמרת 2 נותרה פתוחה (חסר clock_out)")
            
        e1, x1 = t_to_float(s['entry1']), t_to_float(s['exit1'])
        e2, x2 = t_to_float(s['entry2']), t_to_float(s['exit2'])
        
        if e1 is not None and x1 is not None and e2 is not None:
            if e1 <= x1: 
                if e1 < e2 < x1: warnings.append("חפיפת זמנים: כניסה 2 נרשמה בתוך שעות משמרת 1")
                    
        if x1 is not None and e2 is not None:
            if e1 <= x1 and e2 <= x2:
                if (e2 - x1) > 8: warnings.append("פער חריג של מעל 8 שעות בין המשמרות באותו יום")
                    
        if s['total_hours'] and float(s['total_hours']) > 16:
            warnings.append(f"אורך משמרת חריג ({s['total_hours']} שעות) - ייתכן והוזנו זמנים הפוכים")
            
        result.append({
            'date': s['date'], 'entry1': s['entry1'], 'exit1': s['exit1'], 
            'entry2': s['entry2'], 'exit2': s['exit2'], 'total_hours': s['total_hours'], 
            'notes': s['notes'], 'warnings': warnings, 'is_anomaly': len(warnings) > 0
        })
    return jsonify(result)

@app.route('/api/shifts/upsert', methods=['POST'])
def upsert_shift():
    if not session.get('logged_in'): return jsonify({'success': False, 'error': 'Unauthorized'}), 401
    data = request.json or {}
    required = ['employee_id', 'date', 'entry1', 'exit1', 'entry2', 'exit2', 'total_hours']
    if any(k not in data for k in required):
        return jsonify({'success': False, 'error': 'חסרים שדות חובה'}), 400
    with db_cursor() as (conn, cursor):
        cursor.execute("""
            INSERT INTO shifts (employee_id, date, entry1, exit1, entry2, exit2, total_hours, notes) 
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT(employee_id, date) DO UPDATE SET 
            entry1=EXCLUDED.entry1, exit1=EXCLUDED.exit1, entry2=EXCLUDED.entry2, 
            exit2=EXCLUDED.exit2, total_hours=EXCLUDED.total_hours, notes=EXCLUDED.notes
        """, (data['employee_id'], data['date'], data['entry1'], data['exit1'], data['entry2'], data['exit2'], data['total_hours'], data.get('notes', '-')))
        conn.commit()
    return jsonify({'success': True})

@app.route('/api/kiosk/punch', methods=['POST'])
def kiosk_punch():
    data = request.json or {}
    pin, action_type = data.get('pin'), data.get('action_type')

    with db_cursor(dict_cursor=True) as (conn, cursor):
        cursor.execute("SELECT * FROM employees WHERE pin_code = %s", (pin,))
        emp = cursor.fetchone()

        if not emp:
            return jsonify({'success': False, 'message': 'קוד PIN שגוי. אנא נסה שוב.'})

        today, time_now = datetime.now().strftime('%Y-%m-%d'), datetime.now().strftime('%H:%M')
        action_name = ""

        if action_type == 'entry':
            cursor.execute("SELECT * FROM shifts WHERE employee_id = %s AND date = %s", (emp['id'], today))
            shift = cursor.fetchone()

            if not shift:
                cursor.execute("INSERT INTO shifts (employee_id, date, entry1, exit1, entry2, exit2, total_hours, notes) VALUES (%s, %s, %s, '-', '-', '-', 0, '-')", (emp['id'], today, time_now))
                action_name = "כניסה 1"
            else:
                if shift['entry1'] == '-':
                    cursor.execute("UPDATE shifts SET entry1 = %s WHERE id = %s", (time_now, shift['id']))
                    action_name = "כניסה 1"
                elif shift['entry1'] != '-' and shift['exit1'] != '-' and shift['entry2'] == '-':
                    cursor.execute("UPDATE shifts SET entry2 = %s WHERE id = %s", (time_now, shift['id']))
                    action_name = "כניסה 2"
                elif shift['entry1'] != '-' and shift['exit1'] == '-':
                    return jsonify({'success': False, 'message': 'אתה כבר נמצא במשמרת פעילה. עליך להחתים יציאה קודם.'})
                else:
                    return jsonify({'success': False, 'message': 'השלמת את מכסת הכניסות שלך להיום.'})

        elif action_type == 'exit':
            cursor.execute("SELECT * FROM shifts WHERE employee_id = %s AND (exit1 = '-' OR exit2 = '-') ORDER BY date DESC LIMIT 1", (emp['id'],))
            shift = cursor.fetchone()

            if not shift:
                cursor.execute("SELECT * FROM shifts WHERE employee_id = %s AND date = %s", (emp['id'], today))
                shift = cursor.fetchone()

            if not shift:
                return jsonify({'success': False, 'message': 'לא נמצאה כניסה שלך למשמרת.'})
            else:
                new_exit1, new_exit2, target_id = shift['exit1'], shift['exit2'], shift['id']
                if shift['entry1'] != '-' and shift['exit1'] == '-': new_exit1, action_name = time_now, "יציאה 1"
                elif shift['entry2'] != '-' and shift['exit2'] == '-': new_exit2, action_name = time_now, "יציאה 2"
                else:
                    return jsonify({'success': False, 'message': 'אין לך משמרת פתוחה לצאת ממנה.'})

                total = calc_hours(shift['entry1'], new_exit1) + calc_hours(shift['entry2'], new_exit2)
                cursor.execute("UPDATE shifts SET exit1 = %s, exit2 = %s, total_hours = %s WHERE id = %s", (new_exit1, new_exit2, round(total, 2), target_id))
        else:
            return jsonify({'success': False, 'message': 'סוג פעולה לא תקין.'})

        conn.commit()
        return jsonify({'success': True, 'name': f"{emp['first_name']} {emp['last_name']}", 'action': action_name, 'time': time_now})

@app.route('/api/dashboard', methods=['GET'])
def dashboard_stats():
    if not session.get('logged_in'): return jsonify({'error': 'Unauthorized'}), 401
    current_month, today_str = datetime.now().strftime('%Y-%m'), datetime.now().strftime('%Y-%m-%d')

    with db_cursor(dict_cursor=True) as (conn, cursor):
        cursor.execute("SELECT id, department, first_name, last_name FROM employees")
        emps = cursor.fetchall()

        cursor.execute("SELECT * FROM shifts WHERE date LIKE %s", (f"{current_month}%",))
        shifts = cursor.fetchall()

    w_count, m_count, w_hours, m_hours, anomalies_count = 0, 0, 0.0, 0.0, 0
    emp_hours_map = {e['id']: {'name': f"{e['first_name']} {e['last_name']}", 'hours': 0.0, 'dept': e['department']} for e in emps}
    
    for e in emps:
        if e['department'] == 'waiters': w_count += 1
        else: m_count += 1
            
    for s in shifts:
        if s['date'] < today_str:
            if (s['entry1'] != '-' and s['exit1'] == '-') or (s['entry2'] != '-' and s['exit2'] == '-'):
                anomalies_count += 1
            
        if s['employee_id'] in emp_hours_map:
            emp_hours_map[s['employee_id']]['hours'] += float(s['total_hours'] or 0)
            if emp_hours_map[s['employee_id']]['dept'] == 'waiters': w_hours += float(s['total_hours'] or 0)
            else: m_hours += float(s['total_hours'] or 0)
                
    chart_data = [{'name': v['name'], 'hours': round(v['hours'], 2), 'dept': v['dept']} for v in emp_hours_map.values() if v['hours'] > 0]
    return jsonify({'waiters_count': w_count, 'maint_count': m_count, 'waiters_hours': round(w_hours, 2), 'maint_hours': round(m_hours, 2), 'anomalies_count': anomalies_count, 'chart_data': chart_data})

@app.route('/api/schedule', methods=['GET', 'POST'])
def handle_schedule():
    if request.method == 'POST':
        if not session.get('logged_in'): return jsonify({'error': 'Unauthorized'}), 401
        month = request.json.get('month') if request.json else None
        if not month:
            return jsonify({'error': 'Month is required'}), 400
        # שומרים אובייקט אחד שמכיל גם את מטריצת השיבוץ וגם שעות מותאמות אישית לכל יום/ארוחה
        payload = {
            'matrix': request.json.get('matrix') or [],
            'mealTimes': request.json.get('mealTimes') or {}
        }
        matrix = json.dumps(payload)

        with db_cursor() as (conn, cursor):
            cursor.execute("""
                INSERT INTO monthly_schedule (month, matrix_json) VALUES (%s, %s)
                ON CONFLICT(month) DO UPDATE SET matrix_json=EXCLUDED.matrix_json
            """, (month, matrix))
            conn.commit()
        return jsonify({'success': True})
    else:
        month = request.args.get('month', datetime.now().strftime('%Y-%m'))
        with db_cursor(dict_cursor=True) as (conn, cursor):
            cursor.execute("SELECT matrix_json FROM monthly_schedule WHERE month = %s", (month,))
            row = cursor.fetchone()

        if row:
            data = json.loads(row['matrix_json'])
            # תאימות לאחור: שיבוצים ישנים שנשמרו כמערך בלבד (ללא שעות מותאמות)
            if isinstance(data, list):
                return jsonify({'matrix': data, 'mealTimes': {}})
            return jsonify({'matrix': data.get('matrix', []), 'mealTimes': data.get('mealTimes', {})})
        return jsonify({'matrix': [], 'mealTimes': {}})

MEAL_LABELS = {'breakfast': 'בוקר', 'lunch': 'צהריים', 'dinner': 'ערב', 'all': 'כל היום'}
REQUEST_TYPE_LABELS = {'available': 'זמין לעבודה', 'unavailable': 'לא זמין'}

MEALS_ORDER = ['breakfast', 'lunch', 'dinner']
ROWS_PER_MEAL = 6
EXTRA_ROLE_MEAL_PREFIX = '§meal:'  # תואם בדיוק לתגית שנוצרת בצד הלקוח (templates/index.html)

def _decode_extra_role(raw):
    """מפרק שדה תפקיד של שורת 'מלצר נוסף' שתויגה לארוחה ספציפית בטבלת השיבוץ.
    מחזיר (meal_key, role_text); meal_key הוא None אם השורה לא תויגה (שורה כללית/ישנה)."""
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
    payload = json.dumps({'matrix': matrix, 'mealTimes': meal_times})
    cursor.execute("""
        INSERT INTO monthly_schedule (month, matrix_json) VALUES (%s, %s)
        ON CONFLICT(month) DO UPDATE SET matrix_json=EXCLUDED.matrix_json
    """, (month, payload))
    conn.commit()

def _try_assign_employee(matrix, meal_key, day_num, emp_name):
    """מנסה לשבץ עובד שאושר כ'זמין' לתא ריק בטבלת השיבוץ, בארוחה/יום המבוקשים.
    מחזיר 'assigned' אם שובץ עכשיו, 'already' אם כבר היה משובץ שם, או 'full' אם אין תא פנוי (התנגשות)."""
    if meal_key not in MEALS_ORDER:
        return 'full'

    def cell_of(row):
        return (row[day_num] if day_num < len(row) else '') or ''

    meal_idx = MEALS_ORDER.index(meal_key)
    fixed_start = meal_idx * ROWS_PER_MEAL
    fixed_end = fixed_start + ROWS_PER_MEAL

    # שורות התפקיד הקבועות של הארוחה הזו
    empty_fixed_idx = None
    for i in range(fixed_start, min(fixed_end, len(matrix))):
        cell = cell_of(matrix[i]).strip()
        if cell == emp_name.strip():
            return 'already'
        if empty_fixed_idx is None and not cell:
            empty_fixed_idx = i

    # שורות "מלצר נוסף" ששייכות לארוחה הזו
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
        while len(row) <= day_num:
            row.append('')
        row[day_num] = emp_name
        return 'assigned'

    for i in extra_indices:
        row = matrix[i]
        if not cell_of(row).strip():
            while len(row) <= day_num:
                row.append('')
            row[day_num] = emp_name
            return 'assigned'

    return 'full'

@app.route('/api/kiosk/validate_pin', methods=['POST'])
def kiosk_validate_pin():
    data = request.json or {}
    pin = data.get('pin')
    with db_cursor(dict_cursor=True) as (conn, cursor):
        cursor.execute("SELECT * FROM employees WHERE pin_code = %s", (pin,))
        emp = cursor.fetchone()
    if not emp:
        return jsonify({'success': False, 'message': 'קוד PIN שגוי. אנא נסה שוב.'})
    return jsonify({'success': True, 'employee_id': emp['id'], 'name': f"{emp['first_name']} {emp['last_name']}"})

@app.route('/api/kiosk/shift_request', methods=['POST'])
def kiosk_create_shift_request():
    data = request.json or {}
    pin = data.get('pin')
    date = data.get('date')
    meal = data.get('meal', 'all')
    request_type = data.get('request_type')
    note = data.get('note', '')

    with db_cursor(dict_cursor=True) as (conn, cursor):
        cursor.execute("SELECT * FROM employees WHERE pin_code = %s", (pin,))
        emp = cursor.fetchone()
        if not emp:
            return jsonify({'success': False, 'message': 'קוד PIN שגוי.'})

        if not date or request_type not in ('available', 'unavailable'):
            return jsonify({'success': False, 'message': 'נא למלא תאריך וסוג בקשה.'})

        cursor.execute("""INSERT INTO shift_requests (employee_id, date, meal, request_type, note, status)
                           VALUES (%s, %s, %s, %s, %s, 'pending')""",
                        (emp['id'], date, meal, request_type, note))
        conn.commit()
        return jsonify({'success': True, 'name': f"{emp['first_name']} {emp['last_name']}"})

@app.route('/api/shift_requests', methods=['GET'])
def get_shift_requests():
    if not session.get('logged_in'): return jsonify({'error': 'Unauthorized'}), 401
    month_filter = request.args.get('month')

    with db_cursor(dict_cursor=True) as (conn, cursor):
        cursor.execute("SELECT id, first_name, last_name FROM employees")
        emps = {e['id']: f"{e['first_name']} {e['last_name']}" for e in cursor.fetchall()}

        if month_filter:
            cursor.execute("SELECT * FROM shift_requests WHERE date LIKE %s ORDER BY date ASC, id ASC", (f"{month_filter}%",))
        else:
            cursor.execute("SELECT * FROM shift_requests ORDER BY date ASC, id ASC")
        reqs = cursor.fetchall()

        # שולפים את מטריצות השיבוץ החודשיות הרלוונטיות כדי לבדוק התנגשויות
        months_needed = sorted(set((r['date'] or '')[:7] for r in reqs if r['date']))
        schedules = {}
        for m in months_needed:
            if not m: continue
            cursor.execute("SELECT matrix_json FROM monthly_schedule WHERE month = %s", (m,))
            row = cursor.fetchone()
            if row:
                try:
                    payload = json.loads(row['matrix_json'])
                    matrix = payload.get('matrix', []) if isinstance(payload, dict) else payload
                except Exception:
                    matrix = []
                schedules[m] = matrix
            else:
                schedules[m] = []

    meals_order = ['breakfast', 'lunch', 'dinner']
    rows_per_meal = 6

    def is_assigned(emp_name, date_str, meal):
        m = date_str[:7]
        matrix = schedules.get(m, [])
        try:
            day_num = int(date_str[8:10])
        except (ValueError, TypeError):
            return False
        meal_indices = range(len(meals_order)) if meal == 'all' else [meals_order.index(meal)] if meal in meals_order else []
        target_meals = {meals_order[mi] for mi in meal_indices}
        for mi in meal_indices:
            for row in matrix[mi * rows_per_meal:(mi + 1) * rows_per_meal]:
                cell = (row[day_num] if day_num < len(row) else '') or ''
                if emp_name.strip() and emp_name.strip() in cell.strip():
                    return True
        for row in matrix[len(meals_order) * rows_per_meal:]:
            role_field = row[0] if row else ''
            row_meal, _role = _decode_extra_role(role_field)
            if row_meal in target_meals:
                cell = (row[day_num] if day_num < len(row) else '') or ''
                if emp_name.strip() and emp_name.strip() in cell.strip():
                    return True
        return False

    result = []
    by_employee_slot = {}
    for r in reqs:
        key = (r['employee_id'], r['date'], r['meal'])
        by_employee_slot.setdefault(key, []).append(r['request_type'])

    for r in reqs:
        emp_name = emps.get(r['employee_id'], 'עובד לא ידוע')
        conflicts = []
        assigned = is_assigned(emp_name, r['date'] or '', r['meal'])
        if r['request_type'] == 'unavailable' and assigned:
            conflicts.append('העובד מתוזמן בשיבוץ למרות בקשת אי-זמינות')
        types_here = set(by_employee_slot.get((r['employee_id'], r['date'], r['meal']), []))
        if len(types_here) > 1:
            conflicts.append('קיימות בקשות סותרות של אותו עובד לאותו מועד')

        result.append({
            'id': r['id'],
            'employee_id': r['employee_id'],
            'employee_name': emp_name,
            'date': r['date'],
            'meal': r['meal'],
            'meal_label': MEAL_LABELS.get(r['meal'], r['meal']),
            'request_type': r['request_type'],
            'request_type_label': REQUEST_TYPE_LABELS.get(r['request_type'], r['request_type']),
            'note': r['note'],
            'status': r['status'],
            'is_assigned': assigned,
            'has_conflict': len(conflicts) > 0,
            'conflict_reasons': conflicts,
            'created_at': r['created_at'].isoformat() if r['created_at'] else None
        })

    return jsonify(result)

@app.route('/api/shift_requests/<int:req_id>', methods=['PUT'])
def update_shift_request(req_id):
    if not session.get('logged_in'): return jsonify({'success': False, 'error': 'Unauthorized'}), 401
    data = request.json or {}
    status = data.get('status')
    if status not in ('pending', 'approved', 'rejected'):
        return jsonify({'success': False, 'error': 'סטטוס לא תקין'}), 400

    with db_cursor(dict_cursor=True) as (conn, cursor):
        cursor.execute("SELECT * FROM shift_requests WHERE id = %s", (req_id,))
        req = cursor.fetchone()
        if not req:
            return jsonify({'success': False, 'error': 'הבקשה לא נמצאה'}), 404

        if status != 'approved':
            cursor.execute("UPDATE shift_requests SET status = %s WHERE id = %s", (status, req_id))
            conn.commit()
            return jsonify({'success': True})

        # אישור בקשה: מנסים לשבץ אוטומטית עובד שביקש "זמין לעבודה" לתא פנוי בטבלת השיבוץ.
        # בקשות "לא זמין" (או בקשות עם נתונים חסרים) רק מתעדכנות לסטטוס "אושר", ללא שינוי בשיבוץ.
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
            cursor.execute("UPDATE shift_requests SET status = %s WHERE id = %s", (status, req_id))
            conn.commit()
            return jsonify({'success': True, 'assigned': False})

        # בקשות סותרות של אותו עובד לאותו יום/ארוחה (גם "זמין" וגם "לא זמין") - לא משבצים אוטומטית
        cursor.execute("""SELECT DISTINCT request_type FROM shift_requests
                           WHERE employee_id = %s AND date = %s AND meal = %s""",
                        (req['employee_id'], req['date'], req['meal']))
        types_here = {r['request_type'] for r in cursor.fetchall()}
        if len(types_here) > 1:
            return jsonify({
                'success': False,
                'conflict': True,
                'message': f'יש בקשות סותרות של {emp_name} לאותו מועד (גם זמין וגם לא זמין) - יש לפתור לפני האישור.'
            })

        meal_keys = MEALS_ORDER if req['meal'] == 'all' else ([req['meal']] if req['meal'] in MEALS_ORDER else [])
        if not meal_keys:
            cursor.execute("UPDATE shift_requests SET status = %s WHERE id = %s", (status, req_id))
            conn.commit()
            return jsonify({'success': True, 'assigned': False})

        sched = _load_month_schedule(cursor, month)
        matrix = sched['matrix']

        results = {mk: _try_assign_employee(matrix, mk, day_num, emp_name) for mk in meal_keys}
        full_meals = [MEAL_LABELS.get(mk, mk) for mk, r in results.items() if r == 'full']

        if full_meals:
            # אין תא פנוי - לא שומרים כלום ולא מסמנים כאושר, כדי שהבקשה תישאר ניתנת לטיפול
            meals_txt = ', '.join(full_meals)
            return jsonify({
                'success': False,
                'conflict': True,
                'message': f'אין תא פנוי ל{emp_name} ב{"ארוחות" if len(full_meals) > 1 else "ארוחת"} {meals_txt} ביום {day_num}. אפשר להוסיף שורת "מלצר נוסף" לארוחה בטבלת השיבוץ ואז לאשר שוב.'
            })

        _save_month_schedule(cursor, conn, month, matrix, sched['mealTimes'])
        cursor.execute("UPDATE shift_requests SET status = %s WHERE id = %s", (status, req_id))
        conn.commit()

        newly_assigned = any(r == 'assigned' for r in results.values())
        return jsonify({
            'success': True,
            'assigned': newly_assigned,
            'message': (f'{emp_name} שובץ אוטומטית בטבלת השיבוץ.' if newly_assigned
                        else f'{emp_name} כבר היה משובץ במועד הזה - הבקשה אושרה.')
        })

@app.route('/api/shift_requests/<int:req_id>', methods=['DELETE'])
def delete_shift_request(req_id):
    if not session.get('logged_in'): return jsonify({'success': False, 'error': 'Unauthorized'}), 401
    with db_cursor() as (conn, cursor):
        cursor.execute("DELETE FROM shift_requests WHERE id = %s", (req_id,))
        conn.commit()
    return jsonify({'success': True})

@app.route('/api/exports/all_employees', methods=['GET'])
def export_all_employees():
    if not session.get('logged_in'): return jsonify({'error': 'Unauthorized'}), 401
    month_filter = request.args.get('month')
    if not month_filter: return jsonify({'error': 'Month parameter is required'}), 400

    si = StringIO()
    si.write('\uFEFF')
    cw = csv.writer(si)
    cw.writerow(['תעודת זהות/מזהה', 'שם עובד', 'מחלקה', 'תפקיד', 'תאריך', 'כניסה 1', 'יציאה 1', 'כניסה 2', 'יציאה 2', 'סה"כ שעות', 'הערות'])
    dept_translations = {'waiters': 'מלצרות', 'maintenance': 'אחזקה'}

    with db_cursor(dict_cursor=True) as (conn, cursor):
        cursor.execute("SELECT id, first_name, last_name, department, role FROM employees")
        employees = cursor.fetchall()

        for emp in employees:
            emp_full_name = f"{emp['first_name']} {emp['last_name']}"
            translated_dept = dept_translations.get(emp['department'], emp['department'])
            cursor.execute("SELECT date, entry1, exit1, entry2, exit2, total_hours, notes FROM shifts WHERE employee_id = %s AND date LIKE %s ORDER BY date ASC", (emp['id'], f"{month_filter}%"))
            shifts = cursor.fetchall()
            for s in shifts:
                cw.writerow([emp['id'], emp_full_name, translated_dept, emp['role'] or '-', s['date'], s['entry1'] if s['entry1'] != '-' else '', s['exit1'] if s['exit1'] != '-' else '', s['entry2'] if s['entry2'] != '-' else '', s['exit2'] if s['exit2'] != '-' else '', s['total_hours'], s['notes'] if s['notes'] != '-' else ''])

    response = Response(si.getvalue(), mimetype='text/csv')
    response.headers["Content-Disposition"] = f"attachment; filename=all_employees_report_{month_filter}.csv"
    return response

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
