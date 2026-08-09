import csv
from io import StringIO
from flask import Blueprint, request, jsonify, session, Response
from database import db_cursor
from routes.auth import requires_role

employees_bp = Blueprint('employees', __name__)

@employees_bp.route('/api/employees', methods=['GET'])
@requires_role(['admin', 'manager'])
def get_employees():
    with db_cursor(dict_cursor=True) as (conn, cursor):
        cursor.execute("SELECT * FROM employees ORDER BY is_active DESC, first_name")
        return jsonify([{
            'id': e['id'], 
            'name': f"{e['first_name']} {e['last_name']}", 
            'phone': e['phone'], 
            'department': e['department'], 
            'role': e['role'], 
            'pin_code': e['pin_code'],
            'permission_level': e.get('permission_level', 'worker'),
            'is_active': e.get('is_active', True)
        } for e in cursor.fetchall()])

@employees_bp.route('/api/employees', methods=['POST'])
@requires_role(['admin', 'manager'])
def add_employee():
    data = request.json or {}
    if not data.get('first_name') or not data.get('last_name') or not data.get('phone') or not data.get('department'):
        return jsonify({'success': False, 'error': 'יש למלא את כל שדות החובה'}), 400
    pin = data['phone'][-4:] if data['phone'] and len(data['phone']) >= 4 else '0000'
    
    with db_cursor() as (conn, cursor):
        cursor.execute("""
            INSERT INTO employees (first_name, last_name, phone, pin_code, department, role, permission_level, is_active) 
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        """, (data['first_name'], data['last_name'], data['phone'], pin, data['department'], data.get('role', ''), data.get('permission_level', 'worker'), data.get('is_active', True)))
        conn.commit()
    return jsonify({'success': True, 'pin': pin})

@employees_bp.route('/api/employees/<int:emp_id>', methods=['PUT'])
@requires_role(['admin', 'manager'])
def update_employee(emp_id):
    data = request.json or {}
    pin = data['phone'][-4:] if data['phone'] and len(data['phone']) >= 4 else '0000'
    
    with db_cursor() as (conn, cursor):
        cursor.execute("""
            UPDATE employees
            SET first_name = %s, last_name = %s, phone = %s, pin_code = %s, department = %s, role = %s, permission_level = %s, is_active = %s
            WHERE id = %s
        """, (data['first_name'], data['last_name'], data['phone'], pin, data['department'], data.get('role', ''), data.get('permission_level', 'worker'), data.get('is_active', True), emp_id))
        conn.commit()
    return jsonify({'success': True, 'pin': pin})

# רק מנהל מערכת (admin) רשאי למחוק לחלוטין (Hard Delete)
@employees_bp.route('/api/employees/<int:emp_id>', methods=['DELETE'])
@requires_role(['admin'])
def delete_employee(emp_id):
    with db_cursor() as (conn, cursor):
        cursor.execute("DELETE FROM employees WHERE id = %s", (emp_id,))
        cursor.execute("DELETE FROM shift_segments WHERE employee_id = %s", (emp_id,))
        cursor.execute("DELETE FROM shift_requests WHERE employee_id = %s", (emp_id,))
        cursor.execute("DELETE FROM time_corrections WHERE employee_id = %s", (emp_id,))
        conn.commit()
    return jsonify({'success': True})

@employees_bp.route('/api/exports/all_employees', methods=['GET'])
@requires_role(['admin', 'manager'])
def export_all_employees():
    month_filter = request.args.get('month')
    if not month_filter: return jsonify({'error': 'Month parameter is required'}), 400

    si = StringIO()
    si.write('\uFEFF')
    cw = csv.writer(si)
    cw.writerow(['תעודת זהות/מזהה', 'שם עובד', 'מחלקה', 'תפקיד', 'תאריך', 'תחום המשמרת', 'כניסה', 'יציאה', 'שעות', 'מקור דיווח'])

    SOURCE_LABELS = {'kiosk': 'קיוסק', 'manual': 'הזנה ידנית', 'legacy': 'היסטורי (מיגרציה)', 'correction': 'תיקון עובד'}

    with db_cursor(dict_cursor=True) as (conn, cursor):
        cursor.execute("SELECT id, first_name, last_name, department, role FROM employees")
        for emp in cursor.fetchall():
            cursor.execute("""SELECT s.date, s.entry_time, s.exit_time, s.total_hours, s.source, d.name AS domain_name
                               FROM shift_segments s LEFT JOIN domains d ON d.id = s.domain_id
                               WHERE s.employee_id = %s AND s.date LIKE %s
                               ORDER BY s.date ASC, s.id ASC""", (emp['id'], f"{month_filter}%"))
            for seg in cursor.fetchall():
                cw.writerow([emp['id'], f"{emp['first_name']} {emp['last_name']}", emp['department'] or '-', emp['role'] or '-', seg['date'],
                             seg['domain_name'] or '-', seg['entry_time'] or '', seg['exit_time'] or '', seg['total_hours'],
                             SOURCE_LABELS.get(seg['source'], seg['source'] or '-')])

    response = Response(si.getvalue(), mimetype='text/csv')
    response.headers["Content-Disposition"] = f"attachment; filename=all_employees_report_{month_filter}.csv"
    return response
