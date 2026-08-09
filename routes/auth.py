from flask import Blueprint, request, jsonify, session
from functools import wraps
from database import db_cursor

auth_bp = Blueprint('auth', __name__)

def requires_role(allowed_roles):
    """Decorator להגבלת גישה לפי הרשאת משתמש"""
    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            if not session.get('logged_in'):
                return jsonify({'error': 'Unauthorized'}), 401

            # session.get בלי ברירת מחדל: מבדילים בין "לא הוגדרה הרשאה בכלל"
            # (session ישנה מלפני שנוסף מנגנון ההרשאות - session.py לא היה
            # שם permission_level, לכן היא "תקועה" ותציג 403 על הכול לנצח)
            # לבין "worker" אמיתי שנקבע במפורש. במקרה הראשון ה-session פגומה -
            # מנקים אותה ומחזירים 401, כדי שהלקוח יידע לחזור למסך ההתחברות
            # במקום להיתקע במסך ריק עם 403 על כל בקשה.
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

@auth_bp.route('/api/check_auth', methods=['GET'])
def check_auth():
    return jsonify({'logged_in': session.get('logged_in', False)})

@auth_bp.route('/api/login', methods=['POST'])
def login():
    data = request.json or {}
    password = data.get('password')
    
    # תאימות לאחור (כניסת מאסטר)
    if password == 'admin':
        session['logged_in'] = True
        session['permission_level'] = 'super_admin'
        return jsonify({'success': True})
        
    phone = data.get('phone')
    pin = data.get('pin')
    if phone and pin:
        with db_cursor(dict_cursor=True) as (conn, cursor):
            cursor.execute("SELECT id, permission_level FROM employees WHERE phone = %s AND pin_code = %s AND is_active = TRUE", (phone, pin))
            emp = cursor.fetchone()
            if emp and emp['permission_level'] in ['admin', 'manager']:
                session['logged_in'] = True
                session['emp_id'] = emp['id']
                session['permission_level'] = emp['permission_level']
                return jsonify({'success': True})
                
    return jsonify({'success': False}), 401

@auth_bp.route('/api/logout', methods=['POST'])
def logout():
    session.pop('logged_in', None)
    session.pop('emp_id', None)
    session.pop('permission_level', None)
    return jsonify({'success': True})# Blueprint: ניהול התחברות, התנתקות ובדיקת הרשאות
