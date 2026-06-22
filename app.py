import os
import psycopg2
from psycopg2.extras import RealDictCursor
from flask import Flask, render_template, request, jsonify, session, Response
import json
import csv
from io import StringIO
from datetime import datetime

app = Flask(__name__)
app.secret_key = 'admin_secret_key_123'

# קבלת קישור ההתחברות מתוך משתני הסביבה של Render
DATABASE_URL = os.environ.get('DATABASE_URL')

def get_db():
    return psycopg2.connect(DATABASE_URL)

def init_db():
    if not DATABASE_URL:
        return
    conn = get_db()
    cursor = conn.cursor()
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
    cursor.execute('''CREATE TABLE IF NOT EXISTS schedule
                  (id SERIAL PRIMARY KEY,
                   matrix_json TEXT)''')
    conn.commit()
    cursor.close()
    conn.close()

if DATABASE_URL:
    init_db()

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
    conn = get_db()
    cursor = conn.cursor(cursor_factory=RealDictCursor)
    cursor.execute("SELECT * FROM employees ORDER BY first_name")
    emps = cursor.fetchall()
    cursor.close()
    conn.close()
    return jsonify([{'id': e['id'], 'name': f"{e['first_name']} {e['last_name']}", 'phone': e['phone'], 'department': e['department'], 'role': e['role'], 'pin_code': e['pin_code']} for e in emps])

@app.route('/api/employees', methods=['POST'])
def add_employee():
    if not session.get('logged_in'): return jsonify({'error': 'Unauthorized'}), 401
    data = request.json
    pin = data['phone'][-4:] if data['phone'] and len(data['phone']) >= 4 else '0000'
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("INSERT INTO employees (first_name, last_name, phone, pin_code, department, role) VALUES (%s, %s, %s, %s, %s, %s)",
               (data['first_name'], data['last_name'], data['phone'], pin, data['department'], data['role']))
    conn.commit()
    cursor.close()
    conn.close()
    return jsonify({'success': True, 'pin': pin})

@app.route('/api/employees/<int:emp_id>', methods=['DELETE'])
def delete_employee(emp_id):
    if not session.get('logged_in'): return jsonify({'error': 'Unauthorized'}), 401
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM employees WHERE id = %s", (emp_id,))
    cursor.execute("DELETE FROM shifts WHERE employee_id = %s", (emp_id,))
    conn.commit()
    cursor.close()
    conn.close()
    return jsonify({'success': True})

@app.route('/api/shifts/<int:emp_id>', methods=['GET'])
def get_shifts(emp_id):
    conn = get_db()
    cursor = conn.cursor(cursor_factory=RealDictCursor)
    cursor.execute("SELECT * FROM shifts WHERE employee_id = %s ORDER BY date ASC", (emp_id,))
    shifts = cursor.fetchall()
    cursor.close()
    conn.close()
    
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
    data = request.json
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO shifts (employee_id, date, entry1, exit1, entry2, exit2, total_hours, notes) 
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT(employee_id, date) DO UPDATE SET 
        entry1=EXCLUDED.entry1, exit1=EXCLUDED.exit1, entry2=EXCLUDED.entry2, 
        exit2=EXCLUDED.exit2, total_hours=EXCLUDED.total_hours, notes=EXCLUDED.notes
    """, (data['employee_id'], data['date'], data['entry1'], data['exit1'], data['entry2'], data['exit2'], data['total_hours'], data.get('notes', '-')))
    conn.commit()
    cursor.close()
    conn.close()
    return jsonify({'success': True})

@app.route('/api/kiosk/punch', methods=['POST'])
def kiosk_punch():
    data = request.json
    pin, action_type = data.get('pin'), data.get('action_type')
    conn = get_db()
    cursor = conn.cursor(cursor_factory=RealDictCursor)
    
    cursor.execute("SELECT * FROM employees WHERE pin_code = %s", (pin,))
    emp = cursor.fetchone()
    
    if not emp: 
        cursor.close()
        conn.close()
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
                cursor.close(); conn.close()
                return jsonify({'success': False, 'message': 'אתה כבר נמצא במשמרת פעילה. עליך להחתים יציאה קודם.'})
            else:
                cursor.close(); conn.close()
                return jsonify({'success': False, 'message': 'השלמת את מכסת הכניסות שלך להיום.'})
                
    elif action_type == 'exit':
        cursor.execute("SELECT * FROM shifts WHERE employee_id = %s AND (exit1 = '-' OR exit2 = '-') ORDER BY date DESC LIMIT 1", (emp['id'],))
        shift = cursor.fetchone()
        
        if not shift:
            cursor.execute("SELECT * FROM shifts WHERE employee_id = %s AND date = %s", (emp['id'], today))
            shift = cursor.fetchone()
            
        if not shift: 
            cursor.close(); conn.close()
            return jsonify({'success': False, 'message': 'לא נמצאה כניסה שלך למשמרת.'})
        else:
            new_exit1, new_exit2, target_id = shift['exit1'], shift['exit2'], shift['id']
            if shift['entry1'] != '-' and shift['exit1'] == '-': new_exit1, action_name = time_now, "יציאה 1"
            elif shift['entry2'] != '-' and shift['exit2'] == '-': new_exit2, action_name = time_now, "יציאה 2"
            else: 
                cursor.close(); conn.close()
                return jsonify({'success': False, 'message': 'אין לך משמרת פתוחה לצאת ממנה.'})
            
            total = calc_hours(shift['entry1'], new_exit1) + calc_hours(shift['entry2'], new_exit2)
            cursor.execute("UPDATE shifts SET exit1 = %s, exit2 = %s, total_hours = %s WHERE id = %s", (new_exit1, new_exit2, round(total, 2), target_id))
    
    conn.commit()
    cursor.close()
    conn.close()
    return jsonify({'success': True, 'name': f"{emp['first_name']} {emp['last_name']}", 'action': action_name, 'time': time_now})

@app.route('/api/dashboard', methods=['GET'])
def dashboard_stats():
    if not session.get('logged_in'): return jsonify({'error': 'Unauthorized'}), 401
    current_month, today_str = datetime.now().strftime('%Y-%m'), datetime.now().strftime('%Y-%m-%d')
    
    conn = get_db()
    cursor = conn.cursor(cursor_factory=RealDictCursor)
    cursor.execute("SELECT id, department, first_name, last_name FROM employees")
    emps = cursor.fetchall()
    
    cursor.execute("SELECT * FROM shifts WHERE date LIKE %s", (f"{current_month}%",))
    shifts = cursor.fetchall()
    cursor.close()
    conn.close()
    
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
    conn = get_db()
    cursor = conn.cursor(cursor_factory=RealDictCursor)
    if request.method == 'POST':
        if not session.get('logged_in'): return jsonify({'error': 'Unauthorized'}), 401
        cursor.execute("DELETE FROM schedule")
        cursor.execute("INSERT INTO schedule (matrix_json) VALUES (%s)", (json.dumps(request.json.get('matrix')),))
        conn.commit()
        cursor.close(); conn.close()
        return jsonify({'success': True})
    else:
        cursor.execute("SELECT matrix_json FROM schedule ORDER BY id DESC LIMIT 1")
        row = cursor.fetchone()
        cursor.close(); conn.close()
        if row: return jsonify({'matrix': json.loads(row['matrix_json'])})
        return jsonify({'matrix': [["תפקיד", "ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"], ["אחראי משמרת", "", "", "", "", "", "", ""]]})

@app.route('/api/exports/all_employees', methods=['GET'])
def export_all_employees():
    if not session.get('logged_in'): return jsonify({'error': 'Unauthorized'}), 401
    month_filter = request.args.get('month')
    if not month_filter: return jsonify({'error': 'Month parameter is required'}), 400
        
    conn = get_db()
    cursor = conn.cursor(cursor_factory=RealDictCursor)
    cursor.execute("SELECT id, first_name, last_name, department, role FROM employees")
    employees = cursor.fetchall()
    
    si = StringIO()
    si.write('\uFEFF')
    cw = csv.writer(si)
    cw.writerow(['תעודת זהות/מזהה', 'שם עובד', 'מחלקה', 'תפקיד', 'תאריך', 'כניסה 1', 'יציאה 1', 'כניסה 2', 'יציאה 2', 'סה"כ שעות', 'הערות'])
    dept_translations = {'waiters': 'מלצרות', 'maintenance': 'אחזקה'}
    
    for emp in employees:
        emp_full_name = f"{emp['first_name']} {emp['last_name']}"
        translated_dept = dept_translations.get(emp['department'], emp['department'])
        cursor.execute("SELECT date, entry1, exit1, entry2, exit2, total_hours, notes FROM shifts WHERE employee_id = %s AND date LIKE %s ORDER BY date ASC", (emp['id'], f"{month_filter}%"))
        shifts = cursor.fetchall()
        for s in shifts:
            cw.writerow([emp['id'], emp_full_name, translated_dept, emp['role'] or '-', s['date'], s['entry1'] if s['entry1'] != '-' else '', s['exit1'] if s['exit1'] != '-' else '', s['entry2'] if s['entry2'] != '-' else '', s['exit2'] if s['exit2'] != '-' else '', s['total_hours'], s['notes'] if s['notes'] != '-' else ''])
            
    cursor.close()
    conn.close()
    response = Response(si.getvalue(), mimetype='text/csv')
    response.headers["Content-Disposition"] = f"attachment; filename=all_employees_report_{month_filter}.csv"
    return response

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
