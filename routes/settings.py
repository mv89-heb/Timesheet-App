from flask import Blueprint, request, jsonify, session
from psycopg2 import errors as pg_errors
from calendar import monthrange
from database import db_cursor, SETTINGS_SCHEMA, hebrew_calendar_day, HEBREW_CALENDAR_AVAILABLE
from routes.auth import requires_role

settings_bp = Blueprint('settings', __name__)

@settings_bp.route('/api/domains', methods=['GET'])
@requires_role(['admin', 'manager'])
def get_domains():
    with db_cursor(dict_cursor=True) as (conn, cursor):
        cursor.execute("SELECT * FROM domains ORDER BY sort_order ASC, id ASC")
        return jsonify([{'id': r['id'], 'name': r['name'], 'color': r['color'], 'active': r['active'], 'sort_order': r['sort_order']} for r in cursor.fetchall()])

@settings_bp.route('/api/domains', methods=['POST'])
@requires_role(['admin', 'manager'])
def add_domain():
    name = (request.json.get('name') or '').strip()
    if not name: return jsonify({'success': False, 'error': 'יש להזין שם תחום'}), 400
    color = request.json.get('color') or '#6366f1'
    with db_cursor(dict_cursor=True) as (conn, cursor):
        cursor.execute("SELECT COALESCE(MAX(sort_order), -1) AS m FROM domains")
        try:
            cursor.execute("INSERT INTO domains (name, color, active, sort_order) VALUES (%s, %s, TRUE, %s) RETURNING id", (name, color, cursor.fetchone()['m'] + 1))
            new_id = cursor.fetchone()['id']; conn.commit()
            return jsonify({'success': True, 'id': new_id})
        except pg_errors.UniqueViolation:
            conn.rollback(); return jsonify({'success': False, 'error': 'תחום בשם הזה כבר קיים'}), 400

@settings_bp.route('/api/domains/<int:domain_id>', methods=['PUT'])
@requires_role(['admin', 'manager'])
def update_domain(domain_id):
    data = request.json or {}; fields, params = [], []
    if 'name' in data: fields.append("name = %s"); params.append((data['name'] or '').strip())
    if 'color' in data: fields.append("color = %s"); params.append(data['color'])
    if 'active' in data: fields.append("active = %s"); params.append(bool(data['active']))
    if not fields: return jsonify({'success': False, 'error': 'אין נתונים לעדכון'}), 400
    params.append(domain_id)
    with db_cursor() as (conn, cursor):
        try: 
            cursor.execute(f"UPDATE domains SET {', '.join(fields)} WHERE id = %s", params); conn.commit()
            return jsonify({'success': True})
        except pg_errors.UniqueViolation: 
            conn.rollback(); return jsonify({'success': False, 'error': 'תחום בשם הזה כבר קיים'}), 400

@settings_bp.route('/api/domains/<int:domain_id>', methods=['DELETE'])
@requires_role(['admin', 'manager'])
def delete_domain(domain_id):
    with db_cursor() as (conn, cursor): 
        cursor.execute("UPDATE domains SET active = FALSE WHERE id = %s", (domain_id,)); conn.commit()
    return jsonify({'success': True})

@settings_bp.route('/api/kiosk/domains', methods=['GET'])
def kiosk_domains():
    with db_cursor(dict_cursor=True) as (conn, cursor):
        cursor.execute("SELECT id, name, color FROM domains WHERE active = TRUE ORDER BY sort_order ASC, id ASC")
        return jsonify([{'id': r['id'], 'name': r['name'], 'color': r['color']} for r in cursor.fetchall()])

@settings_bp.route('/api/settings', methods=['GET'])
@requires_role(['admin', 'manager'])
def get_settings_route():
    with db_cursor(dict_cursor=True) as (conn, cursor):
        cursor.execute("SELECT key, value FROM settings")
        stored = {r['key']: r['value'] for r in cursor.fetchall()}
    return jsonify({key: stored.get(key, meta['default']) for key, meta in SETTINGS_SCHEMA.items()})

@settings_bp.route('/api/settings', methods=['PUT'])
@requires_role(['admin', 'manager'])
def update_settings_route():
    data = request.json or {}
    with db_cursor() as (conn, cursor):
        for key in SETTINGS_SCHEMA:
            if key in data: 
                cursor.execute("""INSERT INTO settings (key, value) VALUES (%s, %s) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value""", (key, str(data[key])))
        conn.commit()
    return jsonify({'success': True})

@settings_bp.route('/api/hebrew_calendar', methods=['GET'])
def hebrew_calendar():
    month = request.args.get('month')
    if not month: return jsonify({'error': 'Month is required'}), 400
    try: y, m = (int(p) for p in month.split('-'))
    except: return jsonify({'error': 'Invalid month'}), 400
    days_in_month = monthrange(y, m)[1]
    days = {}
    for d in range(1, days_in_month + 1):
        info = hebrew_calendar_day(y, m, d)
        if info: days[str(d)] = info
    return jsonify({'available': HEBREW_CALENDAR_AVAILABLE, 'days': days})