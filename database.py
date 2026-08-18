import os
import psycopg2
from psycopg2 import errors as pg_errors
from psycopg2.extras import RealDictCursor
from contextlib import contextmanager
from datetime import datetime
from zoneinfo import ZoneInfo

DATABASE_URL = os.environ.get('DATABASE_URL')
ISRAEL_TZ = ZoneInfo('Asia/Jerusalem')

# ==========================================
# חיבור למסד הנתונים
# ==========================================
def get_db():
    return psycopg2.connect(DATABASE_URL, connect_timeout=10, application_name='timesheet-app')

@contextmanager
def db_cursor(dict_cursor=False):
    conn = get_db()
    cursor = conn.cursor(cursor_factory=RealDictCursor) if dict_cursor else conn.cursor()
    try:
        yield conn, cursor
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        cursor.close()
        conn.close()

DEFAULT_DOMAINS = ['מלצרות', 'אחזקה', 'ניקיון', 'מטבח']

def now_israel():
    return datetime.now(ISRAEL_TZ).replace(tzinfo=None)

def init_db():
    if not DATABASE_URL:
        return
    with db_cursor() as (conn, cursor):
        cursor.execute('''CREATE TABLE IF NOT EXISTS employees (id SERIAL PRIMARY KEY, first_name TEXT, last_name TEXT, phone TEXT, pin_code TEXT, department TEXT, role TEXT)''')
        cursor.execute('''ALTER TABLE employees ADD COLUMN IF NOT EXISTS permission_level TEXT DEFAULT 'worker' ''')
        cursor.execute('''ALTER TABLE employees ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE ''')
        cursor.execute('''CREATE TABLE IF NOT EXISTS domains (id SERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL, color TEXT DEFAULT '#6366f1', active BOOLEAN DEFAULT TRUE, sort_order INTEGER DEFAULT 0)''')
        cursor.execute('''CREATE TABLE IF NOT EXISTS shifts (id SERIAL PRIMARY KEY, employee_id INTEGER, date TEXT, entry1 TEXT, exit1 TEXT, entry2 TEXT, exit2 TEXT, total_hours REAL, notes TEXT, UNIQUE(employee_id, date))''')
        cursor.execute('''CREATE TABLE IF NOT EXISTS shift_segments (id SERIAL PRIMARY KEY, employee_id INTEGER REFERENCES employees(id) ON DELETE CASCADE, date TEXT NOT NULL, domain_id INTEGER REFERENCES domains(id), entry_time TEXT, exit_time TEXT, total_hours REAL DEFAULT 0, notes TEXT, source TEXT DEFAULT 'manual', created_at TIMESTAMP DEFAULT NOW())''')
        cursor.execute('''ALTER TABLE shift_segments ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual' ''')
        cursor.execute('''CREATE INDEX IF NOT EXISTS idx_shift_segments_emp_date ON shift_segments (employee_id, date)''')
        cursor.execute('''CREATE INDEX IF NOT EXISTS idx_shift_segments_emp_date_prefix ON shift_segments (employee_id, date text_pattern_ops)''')
        cursor.execute('''CREATE INDEX IF NOT EXISTS idx_shift_segments_date_prefix ON shift_segments (date text_pattern_ops)''')
        cursor.execute('''CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)''')
        cursor.execute('''CREATE TABLE IF NOT EXISTS monthly_schedule (id SERIAL PRIMARY KEY, month TEXT UNIQUE, matrix_json TEXT)''')
        cursor.execute('''CREATE TABLE IF NOT EXISTS shift_requests (id SERIAL PRIMARY KEY, employee_id INTEGER, date TEXT, meal TEXT, request_type TEXT, note TEXT, status TEXT DEFAULT 'pending', created_at TIMESTAMP DEFAULT NOW())''')
        cursor.execute('''CREATE TABLE IF NOT EXISTS time_corrections (
                          id SERIAL PRIMARY KEY,
                          employee_id INTEGER REFERENCES employees(id) ON DELETE CASCADE,
                          date TEXT NOT NULL,
                          domain_id INTEGER REFERENCES domains(id),
                          entry_time TEXT,
                          exit_time TEXT,
                          reason TEXT,
                          status TEXT DEFAULT 'pending',
                          created_at TIMESTAMP DEFAULT NOW())''')
        conn.commit()
        cursor.execute("SELECT COUNT(*) AS c FROM domains")
        if cursor.fetchone()[0] == 0:
            for i, name in enumerate(DEFAULT_DOMAINS):
                cursor.execute("INSERT INTO domains (name, active, sort_order) VALUES (%s, TRUE, %s)", (name, i))
            conn.commit()

SETTINGS_SCHEMA = {'shift_gap_alert_hours': {'default': '8', 'label': 'סף התראה על פער שעות בין משמרות באותו יום'}}

def get_setting(key, default=None):
    with db_cursor(dict_cursor=True) as (conn, cursor):
        cursor.execute("SELECT value FROM settings WHERE key = %s", (key,))
        row = cursor.fetchone()
    return row['value'] if row else default

def set_setting(key, value):
    with db_cursor() as (conn, cursor):
        cursor.execute("""INSERT INTO settings (key, value) VALUES (%s, %s) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value""", (key, value))
        conn.commit()

def calc_hours(start_str, end_str):
    if not start_str or not end_str or start_str == '-' or end_str == '-':
        return 0
    fmt = '%H:%M'
    try:
        t1 = datetime.strptime(start_str, fmt)
        t2 = datetime.strptime(end_str, fmt)
        diff = (t2 - t1).total_seconds()
        if diff < 0:
            diff += 86400
        return diff / 3600
    except Exception:
        return 0

# ======== הפונקציה המקורית לשחזור נתונים ========
def migrate_legacy_shifts():
    if not DATABASE_URL:
        return
    with db_cursor(dict_cursor=True) as (conn, cursor):
        try:
            cursor.execute("SELECT COUNT(*) AS c FROM shifts")
            if cursor.fetchone()['c'] == 0:
                return
            cursor.execute("SELECT id, name FROM domains")
            domains_by_name = {d['name']: d['id'] for d in cursor.fetchall()}
            default_domain_id = domains_by_name.get('מלצרות') or (next(iter(domains_by_name.values())) if domains_by_name else None)
            legacy_dept_map = {'waiters': domains_by_name.get('מלצרות'), 'maintenance': domains_by_name.get('אחזקה')}
            cursor.execute("SELECT id, department FROM employees")
            emp_domain = {e['id']: (legacy_dept_map.get(e['department']) or default_domain_id) for e in cursor.fetchall()}
            cursor.execute("SELECT * FROM shifts ORDER BY date ASC, id ASC")
            legacy_rows = cursor.fetchall()
            cursor.execute("SELECT DISTINCT employee_id, date FROM shift_segments")
            already_migrated = {(row['employee_id'], row['date']) for row in cursor.fetchall()}
            migrated = 0
            for s in legacy_rows:
                if (s['employee_id'], s['date']) in already_migrated:
                    continue
                domain_id = emp_domain.get(s['employee_id'], default_domain_id)
                notes = s['notes'] if s['notes'] and s['notes'] != '-' else None
                first_segment = True
                for entry, exit_ in ((s['entry1'], s['exit1']), (s['entry2'], s['exit2'])):
                    if not entry or entry == '-':
                        continue
                    exit_val = exit_ if exit_ and exit_ != '-' else None
                    hours = calc_hours(entry, exit_val) if exit_val else 0
                    cursor.execute("""INSERT INTO shift_segments
                            (employee_id, date, domain_id, entry_time, exit_time, total_hours, notes, source)
                            VALUES (%s, %s, %s, %s, %s, %s, %s, 'legacy')""",
                            (s['employee_id'], s['date'], domain_id, entry, exit_val, round(hours, 2), notes if first_segment else None))
                    first_segment = False
                    migrated += 1
            conn.commit()
            if migrated > 0:
                print(f"[migration] הועברו {migrated} מקטעי משמרת מהטבלה הישנה 'shifts' לטבלה 'shift_segments'")
        except Exception as e:
            conn.rollback()
            print(f"Migration error: {e}")

try:
    from pyluach import dates as pyluach_dates
    HEBREW_CALENDAR_AVAILABLE = True
except ImportError:
    HEBREW_CALENDAR_AVAILABLE = False

EREV_CHAG_MAP = {
    (6, 29): 'ערב ראש השנה', (7, 9): 'ערב יום כיפור', (7, 14): 'ערב סוכות',
    (1, 14): 'ערב פסח', (3, 5): 'ערב שבועות',
}
CHAG_DAYS = {(7, 1), (7, 2), (7, 10), (7, 15), (7, 22), (1, 15), (1, 21), (3, 6)}

def hebrew_calendar_day(year, month, day):
    if not HEBREW_CALENDAR_AVAILABLE:
        return None
    try:
        gd = pyluach_dates.GregorianDate(year, month, day)
    except Exception:
        return None
    heb = gd.to_heb()
    key = (heb.month, heb.day)
    holiday_name = gd.holiday(israel=True, hebrew=True, prefix_day=True)
    is_fast = gd.fast_day() is not None
    category = 'fast' if is_fast else 'chag' if holiday_name and key in CHAG_DAYS else 'chol_hamoed' if holiday_name and ((heb.month == 7 and 16 <= heb.day <= 21) or (heb.month == 1 and 16 <= heb.day <= 20)) else 'chag' if holiday_name else 'erev_chag' if key in EREV_CHAG_MAP else None
    return {'hebrew_date': heb.hebrew_date_string(), 'holiday': EREV_CHAG_MAP.get(key, holiday_name), 'category': category}
