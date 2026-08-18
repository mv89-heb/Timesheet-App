import os
from flask import Flask, render_template

from database import init_db, migrate_legacy_shifts
from routes.auth import auth_bp
from routes.employees import employees_bp
from routes.shifts import shifts_bp
from routes.schedule import schedule_bp
from routes.settings import settings_bp
from routes.latest import latest_bp

app = Flask(__name__)
app.secret_key = os.environ.get('SECRET_KEY', os.urandom(24))

@app.after_request
def add_header(response):
    response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '0'

    if response.content_type and response.content_type.startswith('text/html'):
        try:
            html = response.get_data(as_text=True)
            markers = (
                '<script src="/static/js/admin-fixes.js"></script>\n'
                '<script src="/static/js/admin-latest.js"></script>'
            )
            if 'admin-fixes.js' not in html and '</body>' in html:
                html = html.replace('</body>', f'{markers}\n</body>')
            elif 'admin-fixes.js' in html and 'admin-latest.js' not in html and '</body>' in html:
                html = html.replace('</body>', '<script src="/static/js/admin-latest.js"></script>\n</body>')
            response.set_data(html)
        except Exception as e:
            print(f'[after_request] admin fixes injection failed: {e}')
    return response

app.register_blueprint(auth_bp)
app.register_blueprint(employees_bp)
app.register_blueprint(shifts_bp)
app.register_blueprint(schedule_bp)
app.register_blueprint(settings_bp)
app.register_blueprint(latest_bp)

@app.route('/')
def admin_panel():
    return render_template('index.html')

@app.route('/kiosk')
def kiosk_mode():
    return render_template('kiosk.html')

if os.environ.get('DATABASE_URL'):
    try:
        init_db()
        migrate_legacy_shifts()
    except Exception as e:
        print(f'[startup] אתחול מסד הנתונים נכשל: {e}')

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
