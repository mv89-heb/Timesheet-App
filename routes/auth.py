from flask import Blueprint, request, jsonify, session
from functools import wraps
from database import db_cursor


auth_bp = Blueprint('auth', __name__)


def requires_role(allowed_roles):
    """Decorator להגבלת גישה לפי הרשאת משתמש."""
    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            if not session.get('logged_in'):
                return jsonify({'error': 'Unauthorized'}), 401

            user_role = session.get('permission_level')
            if user_role is None:
                session.clear()
                return jsonify({'error': 'Session expired, please log in again'}), 401

            if user_role == 'super_admin':
                return f(*args, **kwargs)

            if user_role not in allowed_roles:
                return jsonify({'error': 'Forbidden - Insufficient permissions'}), 403
            return f(*args, **kwargs)
        return decorated_function
    return decorator


@auth_bp.route('/api/health', methods=['GET'])
def health():
    """Endpoint ציבורי קטן לבדיקת זמינות האפליקציה וה-DB."""
    try:
        with db_cursor(dict_cursor=True) as (conn, cursor):
            cursor.execute('SELECT 1 AS ok')
            row = cursor.fetchone()
        return jsonify({'ok': True, 'database': bool(row and row.get('ok') == 1)})
    except Exception as exc:
        print(f'[health] database check failed: {exc}')
        return jsonify({'ok': False, 'database': False, 'error': 'Database unavailable'}), 503


@auth_bp.route('/api/check_auth', methods=['GET'])
def check_auth():
    return jsonify({'logged_in': bool(session.get('logged_in', False))})


@auth_bp.route('/api/login', methods=['POST'])
def login():
    try:
        data = request.get_json(silent=True) or {}
        password = str(data.get('password') or '').strip()

        # כניסת מנהל ראשית אינה תלויה במסד הנתונים.
        if password == 'admin':
            session.clear()
            session['logged_in'] = True
            session['permission_level'] = 'super_admin'
            session.permanent = True
            return jsonify({'success': True})

        phone = str(data.get('phone') or '').strip()
        pin = str(data.get('pin') or '').strip()
        if not phone or not pin:
            return jsonify({'success': False, 'error': 'חסרים פרטי התחברות'}), 400

        with db_cursor(dict_cursor=True) as (conn, cursor):
            cursor.execute(
                "SELECT id, permission_level FROM employees "
                "WHERE phone = %s AND pin_code = %s AND is_active = TRUE",
                (phone, pin)
            )
            emp = cursor.fetchone()

        if emp and emp['permission_level'] in ['admin', 'manager']:
            session.clear()
            session['logged_in'] = True
            session['emp_id'] = emp['id']
            session['permission_level'] = emp['permission_level']
            session.permanent = True
            return jsonify({'success': True})

        return jsonify({'success': False, 'error': 'פרטי התחברות שגויים'}), 401

    except Exception as exc:
        print(f'[login] unexpected error: {exc}')
        return jsonify({
            'success': False,
            'error': 'שגיאת שרת בזמן ההתחברות. בדוק את לוגי Render.'
        }), 500


@auth_bp.route('/api/logout', methods=['POST'])
def logout():
    session.clear()
    return jsonify({'success': True})
