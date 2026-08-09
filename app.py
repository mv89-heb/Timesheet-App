import os
from flask import Flask, render_template

# ייבוא הפונקציות ממסד הנתונים
from database import init_db, migrate_legacy_shifts

from routes.auth import auth_bp
from routes.employees import employees_bp
from routes.shifts import shifts_bp
from routes.schedule import schedule_bp
from routes.settings import settings_bp

app = Flask(__name__)
app.secret_key = 'admin_secret_key_123'

@app.after_request
def add_header(response):
    response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '0'
    return response

app.register_blueprint(auth_bp)
app.register_blueprint(employees_bp)
app.register_blueprint(shifts_bp)
app.register_blueprint(schedule_bp)
app.register_blueprint(settings_bp)

@app.route('/')
def admin_panel(): 
    return render_template('index.html')

@app.route('/kiosk')
def kiosk_mode(): 
    return render_template('kiosk.html')

# הפעלה אוטומטית של שחזור הנתונים בעליית השרת.
# עוטפים ב-try/except כדי שתקלת חיבור זמנית ל-DB (למשל בזמן "התעוררות" של
# Neon, או סיסמה שהוחלפה ועדיין לא עודכנה במשתני הסביבה) לא תפיל את כל
# השרת - היא רק תימנע מהאתחול האוטומטי לרוץ, אבל האתר עצמו ימשיך לעלות
# ולהציג את מסך ההתחברות; קריאות ה-API יחזירו שגיאה ברורה בקונסול/ברשת
# במקום שהשרת כולו יקרוס וכל הדף ייראה ריק.
if os.environ.get('DATABASE_URL'):
    try:
        init_db()
        migrate_legacy_shifts()
    except Exception as e:
        print(f"[startup] אתחול מסד הנתונים נכשל: {e}")

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
