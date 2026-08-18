from flask import Blueprint, jsonify
from database import db_cursor
from routes.auth import requires_role

latest_bp = Blueprint('latest', __name__)

@latest_bp.route('/api/shifts/<int:emp_id>/latest', methods=['GET'])
@requires_role(['admin', 'manager'])
def latest_employee_shifts(emp_id):
    """Return the employee's most recently reported month in one DB round-trip."""
    with db_cursor(dict_cursor=True) as (conn, cursor):
        cursor.execute("""
            SELECT MAX(date) AS latest_date
            FROM shift_segments
            WHERE employee_id = %s
        """, (emp_id,))
        latest = cursor.fetchone()
        latest_date = latest['latest_date'] if latest else None
        if not latest_date:
            return jsonify({'month': None, 'latest_date': None, 'shifts': []})

        month = str(latest_date)[:7]
        cursor.execute("""
            SELECT s.*, d.name AS domain_name, d.color AS domain_color
            FROM shift_segments s
            LEFT JOIN domains d ON d.id = s.domain_id
            WHERE s.employee_id = %s AND s.date LIKE %s
            ORDER BY s.date DESC, s.id DESC
        """, (emp_id, f'{month}%'))
        rows = cursor.fetchall()

    return jsonify({
        'month': month,
        'latest_date': latest_date,
        'shifts': rows
    })
