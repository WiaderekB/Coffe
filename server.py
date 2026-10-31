"""Small, dependency-free coffee recipe server."""
from contextlib import contextmanager
import hmac
import hashlib
import json
import os
import secrets
import time
from http.cookies import SimpleCookie, CookieError
from pathlib import Path
import sqlite3
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

ROOT = Path(__file__).parent
DB_PATH = Path(os.environ.get('DB_PATH', ROOT / 'data' / 'coffee.sqlite3'))
USERNAME = os.environ.get('APP_USERNAME', '')
PASSWORD = os.environ.get('APP_PASSWORD', '')
ACCENTS = ('rose', 'lime', 'sky', 'honey', 'lavender')
COFFEE_FIELDS = ('roaster', 'country', 'region', 'variety', 'process', 'roast', 'tasting_notes')
SESSION_SECONDS = 30 * 24 * 60 * 60
COOKIE_NAME = 'coffee_session'


def credential_fingerprint():
    return hashlib.sha256(json.dumps([USERNAME, PASSWORD], ensure_ascii=False).encode()).hexdigest()


def default_accent(coffee_id):
    return ACCENTS[(coffee_id - 1) % len(ACCENTS)]


SEED = {
    'volume': 500, 'dose': 30, 'temperature': 91,
    'grind': 'Timemore C3S · 17 klików od zera',
    'dripper': 'Hario V60 02 lub 03', 'method': '4:6',
    'duration': '4:00–4:40', 'yield': '440–450 ml',
    'pours': [
        {'time': '0:00–0:15', 'amount': 75},
        {'time': '0:50–1:07', 'amount': 125},
        {'time': '1:40–1:55', 'amount': 100},
        {'time': '2:30–2:45', 'amount': 100},
        {'time': '3:20–3:35', 'amount': 100},
    ],
    'steps': [
        'Dokładnie przepłucz filtr i rozgrzej V60 oraz serwer.',
        'Wsyp 30 g kawy zmielonej na 17 klikach i wyrównaj złoże.',
        'Pierwsze 75 g nalej spokojną spiralą. Wykonaj jeden bardzo delikatny obrót dripperem, aby równomiernie zwilżyć kawę.',
        'Następne zalania wykonuj cienkim strumieniem, głównie w środkowych ⅔ złoża. Nie polewaj papieru.',
        'Przed kolejnym zalaniem pozwól, aby poziom wody wyraźnie opadł. Nie musisz czekać na całkowite osuszenie złoża.',
        'Po ostatnim zalaniu nie mieszaj. Zdejmij V60 w czasie 4:00–4:40, gdy strumień przejdzie w wolne kapanie.',
        'Zamieszaj napar w serwerze i zaczekaj 4–5 minut przed piciem.',
    ],
    'notes': 'Podział 75 + 125 g kieruje smak w stronę słodyczy, a trzy końcowe zalania po 100 g zwiększają aromat i intensywność. Większa porcja ma zachować słodycz i uniknąć kwaśnego, zbyt słabego naparu z pierwszej próby. Część wody zostaje w kawie.',
}


@contextmanager
def connect():
    db = sqlite3.connect(DB_PATH, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys = ON')
    try:
        with db:
            yield db
    finally:
        db.close()


def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with connect() as db:
        db.executescript('''
            CREATE TABLE IF NOT EXISTS coffees (
                id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS recipes (
                id INTEGER PRIMARY KEY, coffee_id INTEGER NOT NULL REFERENCES coffees(id) ON DELETE CASCADE,
                data TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS coffee_versions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                label TEXT NOT NULL, revision TEXT NOT NULL, data TEXT NOT NULL,
                coffee_count INTEGER NOT NULL, recipe_count INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY, expires REAL NOT NULL, fingerprint TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS login_attempts (
                address TEXT PRIMARY KEY, count INTEGER NOT NULL, started REAL NOT NULL
            );
        ''')
        if not db.execute("SELECT 1 FROM migrations WHERE name='seed'").fetchone():
            coffee_id = db.execute('INSERT INTO coffees(name, description) VALUES (?, ?)',
                                   ('Parallel 12', 'Słodki, aromatyczny napar. Przepisy dopracowane do konkretnej porcji.')).lastrowid
            db.execute('INSERT INTO recipes(coffee_id, data) VALUES (?, ?)', (coffee_id, json.dumps(SEED, ensure_ascii=False)))
            db.execute("INSERT INTO migrations VALUES ('seed')")
        columns = {row['name'] for row in db.execute('PRAGMA table_info(coffees)')}
        if 'accent' not in columns:
            db.execute("ALTER TABLE coffees ADD COLUMN accent TEXT NOT NULL DEFAULT 'rose'")
            for row in db.execute('SELECT id FROM coffees').fetchall():
                db.execute('UPDATE coffees SET accent=? WHERE id=?', (default_accent(row['id']), row['id']))
        if 'info' not in columns:
            db.execute("ALTER TABLE coffees ADD COLUMN info TEXT NOT NULL DEFAULT '{}'")
        # Older/imported SQLite schemas may not have the cascade constraint.
        db.execute('DELETE FROM recipes WHERE NOT EXISTS (SELECT 1 FROM coffees WHERE coffees.id=recipes.coffee_id)')
        record_version(db, 'Stan początkowy')



def get_coffees(db):
    coffees = []
    for row in db.execute('SELECT * FROM coffees ORDER BY name COLLATE NOCASE'):
        coffee = dict(row)
        info = json.loads(coffee.pop('info'))
        coffee.update({key: info.get(key, '') for key in COFFEE_FIELDS})
        coffee['recipes'] = []
        coffees.append(coffee)
    by_id = {c['id']: c for c in coffees}
    for row in db.execute('SELECT * FROM recipes'):
        if row['coffee_id'] in by_id:
            by_id[row['coffee_id']]['recipes'].append(json.loads(row['data']) | {'id': row['id']})
    for coffee in coffees:
        coffee['recipes'].sort(key=lambda r: (r['volume'], r['id']))
    return coffees


def string(value, name, required=False, limit=10000):
    if not isinstance(value, str) or len(value) > limit or (required and not value.strip()):
        raise ValueError(f'Nieprawidłowe pole: {name}.')
    return value.strip()


def number(value, name, minimum, maximum):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not minimum <= value <= maximum:
        raise ValueError(f'Pole {name}: wpisz liczbę od {minimum} do {maximum}.')
    return value


def validate_recipe(data):
    result = {key: number(data.get(key), label, low, high) for key, label, low, high in [
        ('volume', 'woda', 1, 10000), ('dose', 'kawa', 0.1, 1000), ('temperature', 'temperatura', 1, 100)]}
    for key in ['grind', 'dripper', 'method', 'duration', 'yield', 'notes']:
        result[key] = string(data.get(key, ''), key, limit=10000 if key == 'notes' else 300)
    pours = data.get('pours', [])
    steps = data.get('steps', [])
    if not isinstance(pours, list) or len(pours) > 50 or not isinstance(steps, list) or len(steps) > 100:
        raise ValueError('Zbyt wiele zalań lub kroków.')
    result['pours'] = []
    for pour in pours:
        if not isinstance(pour, dict):
            raise ValueError('Nieprawidłowe zalanie.')
        result['pours'].append({'time': string(pour.get('time'), 'czas zalania', True, 100),
                                'amount': number(pour.get('amount'), 'ilość zalania', 0.1, 10000)})
    if pours and abs(sum(p['amount'] for p in result['pours']) - result['volume']) > 0.01:
        raise ValueError('Suma zalań musi być równa ilości wody.')
    result['steps'] = [string(step, 'krok przygotowania', True, 3000) for step in steps]
    return result


def validate_coffee(data):
    accent = data.get('accent', 'rose')
    if accent not in ACCENTS:
        raise ValueError('Wybierz kolor z dostępnej palety.')
    return {'name': string(data.get('name'), 'nazwa kawy', True, 120),
            'description': string(data.get('description', ''), 'opis', limit=1000),
            'accent': accent,
            **{key: string(data.get(key, ''), key, limit=300) for key in COFFEE_FIELDS}}


def coffee_values(coffee):
    return (coffee['name'], coffee['description'], coffee['accent'],
            json.dumps({key: coffee[key] for key in COFFEE_FIELDS}, ensure_ascii=False))


def snapshot(db):
    # Coffee rows and their recipes must come from the same database snapshot.
    if not db.in_transaction:
        db.execute('BEGIN')
    coffees = get_coffees(db)
    def digest(collection):
        canonical = sorted((c | {'recipes': sorted(c['recipes'], key=lambda r: r['id'])} for c in collection), key=lambda c: c['id'])
        return hashlib.sha256(json.dumps(canonical, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    # Allows an older offline client to migrate pending changes without losing them.
    legacy = [{key: c[key] for key in ('id', 'name', 'description', 'recipes')} for c in coffees]
    return {'coffees': coffees, 'revision': digest(coffees), 'legacyRevision': digest(legacy)}


def record_version(db, label):
    current = snapshot(db)
    last = db.execute('SELECT revision FROM coffee_versions ORDER BY id DESC LIMIT 1').fetchone()
    if last and last['revision'] == current['revision']:
        return
    db.execute('INSERT INTO coffee_versions(label, revision, data, coffee_count, recipe_count) VALUES (?, ?, ?, ?, ?)',
               (label, current['revision'], json.dumps(current['coffees'], ensure_ascii=False), len(current['coffees']),
                sum(len(c['recipes']) for c in current['coffees'])))
    db.execute('DELETE FROM coffee_versions WHERE id NOT IN (SELECT id FROM coffee_versions ORDER BY id DESC LIMIT 20)')


def validate_snapshot(coffees):
    if not isinstance(coffees, list) or len(coffees) > 1000:
        raise ValueError('Nieprawidłowa kolekcja kaw (maksymalnie 1000).')
    result, coffee_ids, recipe_ids = [], set(), set()
    def identifier(value, used):
        if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value < 2**53 or value in used:
            raise ValueError('Nieprawidłowy lub powtórzony identyfikator.')
        used.add(value)
        return value
    for coffee in coffees:
        if not isinstance(coffee, dict):
            raise ValueError('Nieprawidłowa kawa.')
        item = validate_coffee(coffee) | {'id': identifier(coffee.get('id'), coffee_ids), 'recipes': []}
        recipes = coffee.get('recipes', [])
        if not isinstance(recipes, list) or len(recipes) > 100:
            raise ValueError('Maksymalnie 100 przepisów na kawę.')
        for recipe in recipes:
            if not isinstance(recipe, dict):
                raise ValueError('Nieprawidłowy przepis.')
            item['recipes'].append(validate_recipe(recipe) | {'id': identifier(recipe.get('id'), recipe_ids)})
        result.append(item)
    return result


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / 'static'), **kwargs)

    def end_headers(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Referrer-Policy', 'same-origin')
        self.send_header('Content-Security-Policy', "default-src 'self'; style-src 'self'; font-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
        self.send_header('Cache-Control', 'no-store' if self.path.startswith('/api/') else 'no-cache')
        super().end_headers()

    def session_token(self):
        try:
            cookie = SimpleCookie()
            cookie.load(self.headers.get('Cookie', ''))
            value = cookie.get(COOKIE_NAME)
            return value.value if value else ''
        except CookieError:
            return ''

    def authenticated(self):
        if not PASSWORD:
            return True
        token = self.session_token()
        if not token or len(token) > 100:
            return False
        with connect() as db:
            row = db.execute('SELECT expires, fingerprint FROM sessions WHERE token_hash=?',
                             (hashlib.sha256(token.encode()).hexdigest(),)).fetchone()
        return bool(row and row['expires'] > time.time() and hmac.compare_digest(row['fingerprint'], credential_fingerprint()))

    def authorized(self):
        if self.authenticated():
            return True
        self.respond(401, {'error': 'Zaloguj się w aplikacji, aby uzyskać dostęp do przepisów.'})
        return False

    def cookie_header(self, token='', clear=False):
        secure = self.headers.get('X-Forwarded-Proto', '').split(',')[0].strip() == 'https'
        return f'{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={0 if clear else SESSION_SECONDS}' + ('; Secure' if secure else '')

    def respond(self, status, data, headers=None):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def login(self, data):
        if not PASSWORD:
            return self.respond(200, {'authenticated': True, 'required': False, 'username': ''})
        address, now = self.client_address[0], time.time()
        # Serialize attempts so parallel requests cannot bypass the short login limit.
        with connect() as db:
            db.execute('BEGIN IMMEDIATE')
            db.execute('DELETE FROM login_attempts WHERE started < ?', (now - 300,))
            row = db.execute('SELECT count FROM login_attempts WHERE address=?', (address,)).fetchone()
            if row and row['count'] >= 10:
                return self.respond(429, {'error': 'Za dużo prób. Spróbuj ponownie za 5 minut.'}, {'Retry-After': '300'})
            username, password = data.get('username'), data.get('password')
            valid = isinstance(username, str) and isinstance(password, str)
            valid = valid and len(username) <= 300 and len(password) <= 1000
            valid = valid and hmac.compare_digest(username.encode(), USERNAME.encode()) and hmac.compare_digest(password.encode(), PASSWORD.encode())
            if not valid:
                db.execute('INSERT INTO login_attempts(address, count, started) VALUES (?, 1, ?) ON CONFLICT(address) DO UPDATE SET count=count+1', (address, now))
                result = (401, {'error': 'Nieprawidłowy login lub hasło.'}, {})
            else:
                token = secrets.token_urlsafe(32)
                db.execute('DELETE FROM login_attempts WHERE address=?', (address,))
                db.execute('DELETE FROM sessions WHERE expires <= ? OR fingerprint != ?', (now, credential_fingerprint()))
                db.execute('INSERT INTO sessions VALUES (?, ?, ?)', (hashlib.sha256(token.encode()).hexdigest(), now + SESSION_SECONDS, credential_fingerprint()))
                result = (200, {'authenticated': True, 'required': True, 'username': USERNAME}, {'Set-Cookie': self.cookie_header(token)})
        self.respond(*result)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/health':
            try:
                with connect() as db:
                    db.execute('SELECT 1 FROM coffees LIMIT 1')
                return self.respond(200, {'ok': True})
            except sqlite3.Error:
                return self.respond(503, {'ok': False})
        if path == '/api/auth':
            authenticated = self.authenticated()
            return self.respond(200, {'required': bool(PASSWORD), 'authenticated': authenticated,
                                      'username': USERNAME if authenticated and PASSWORD else ''})
        if path.startswith('/api/') and not self.authorized():
            return
        if path == '/api/state':
            with connect() as db:
                return self.respond(200, snapshot(db))
        if path == '/api/history':
            with connect() as db:
                versions = [dict(row) for row in db.execute('SELECT id, created_at, label, revision, coffee_count, recipe_count FROM coffee_versions ORDER BY id DESC')]
                return self.respond(200, versions)
        parts = path.strip('/').split('/')
        if len(parts) == 3 and parts[:2] == ['api', 'history'] and parts[2].isdigit():
            with connect() as db:
                version = db.execute('SELECT * FROM coffee_versions WHERE id=?', (int(parts[2]),)).fetchone()
                if not version:
                    return self.respond(404, {'error': 'Ta wersja nie jest już dostępna.'})
                result = dict(version)
                result['coffees'] = json.loads(result.pop('data'))
                return self.respond(200, result)
        if path == '/api/coffees':
            with connect() as db:
                return self.respond(200, get_coffees(db))
        if path.startswith('/api/'):
            return self.respond(404, {'error': 'Nie znaleziono.'})
        if path == '/':
            self.path = '/index.html'
        super().do_GET()

    def do_HEAD(self):
        if not urlparse(self.path).path.startswith('/api/') or self.authorized():
            super().do_HEAD()

    def do_POST(self):
        self.mutate('POST')

    def do_PUT(self):
        self.mutate('PUT')

    def do_DELETE(self):
        self.mutate('DELETE')

    def mutate(self, method):
        path = urlparse(self.path).path
        if path not in ('/api/login', '/api/logout') and not self.authorized():
            return
        # JSON-only writes plus rejection of cross-site requests prevent form-based CSRF.
        if self.headers.get('Sec-Fetch-Site') == 'cross-site':
            return self.respond(403, {'error': 'Niedozwolone źródło żądania.'})
        if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            return self.respond(415, {'error': 'Wymagany format JSON.'})
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 2000000:
                return self.respond(413, {'error': 'Nieprawidłowy rozmiar danych.'})
            data = json.loads(self.rfile.read(size))
            if not isinstance(data, dict):
                raise ValueError('Nieprawidłowe dane.')
            parts = path.strip('/').split('/')
            if path == '/api/login' and method == 'POST':
                return self.login(data)
            if path == '/api/logout' and method == 'POST':
                with connect() as db:
                    token_hash = hashlib.sha256(self.session_token().encode()).hexdigest()
                    db.execute('DELETE FROM sessions WHERE token_hash=?', (token_hash,))
                return self.respond(200, {'ok': True}, {'Set-Cookie': self.cookie_header(clear=True)})
            with connect() as db:
                if parts == ['api', 'sync'] and method == 'POST':
                    collection = validate_snapshot(data.get('coffees'))
                    label = string(data.get('label', 'Zmieniono przepisy'), 'opis wersji', limit=120) or 'Zmieniono przepisy'
                    # Lock before checking the revision: concurrent devices cannot overwrite each other.
                    db.execute('BEGIN IMMEDIATE')
                    current = snapshot(db)
                    if data.get('revision') != current['revision']:
                        # An interrupted response can be retried without creating duplicates.
                        canonical = lambda cs: sorted((c | {'recipes': sorted(c['recipes'], key=lambda r: r['id'])} for c in cs), key=lambda c: c['id'])
                        if canonical(collection) == canonical(current['coffees']):
                            return self.respond(200, current)
                        return self.respond(409, {'error': 'Przepisy zmieniły się na innym urządzeniu. Twoje zmiany są bezpieczne na tym urządzeniu.'})
                    db.execute('DELETE FROM recipes')
                    db.execute('DELETE FROM coffees')
                    for coffee in collection:
                        db.execute('INSERT INTO coffees(id, name, description, accent, info) VALUES (?, ?, ?, ?, ?)',
                                   (coffee['id'], *coffee_values(coffee)))
                        for recipe in coffee['recipes']:
                            db.execute('INSERT INTO recipes(id, coffee_id, data) VALUES (?, ?, ?)',
                                       (recipe['id'], coffee['id'], json.dumps({k: v for k, v in recipe.items() if k != 'id'}, ensure_ascii=False)))
                    result = snapshot(db)
                elif parts == ['api', 'coffees'] and method == 'POST':
                    coffee = validate_coffee(data)
                    db.execute('INSERT INTO coffees(name, description, accent, info) VALUES (?, ?, ?, ?)', coffee_values(coffee))
                elif len(parts) == 3 and parts[:2] == ['api', 'coffees'] and parts[2].isdigit() and method in ('PUT', 'DELETE'):
                    coffee_id = int(parts[2])
                    if not db.execute('SELECT 1 FROM coffees WHERE id=?', (coffee_id,)).fetchone():
                        return self.respond(404, {'error': 'Nie znaleziono kawy.'})
                    if method == 'DELETE':
                        db.execute('DELETE FROM recipes WHERE coffee_id=?', (coffee_id,))
                        db.execute('DELETE FROM coffees WHERE id=?', (coffee_id,))
                    else:
                        existing = next(c for c in get_coffees(db) if c['id'] == coffee_id)
                        coffee = validate_coffee(existing | data)
                        db.execute('UPDATE coffees SET name=?, description=?, accent=?, info=? WHERE id=?',
                                   (*coffee_values(coffee), coffee_id))
                elif len(parts) == 4 and parts[:2] == ['api', 'coffees'] and parts[2].isdigit() and parts[3] == 'recipes' and method == 'POST':
                    coffee_id = int(parts[2])
                    if not db.execute('SELECT 1 FROM coffees WHERE id=?', (coffee_id,)).fetchone():
                        return self.respond(404, {'error': 'Nie znaleziono kawy.'})
                    recipe = validate_recipe(data)
                    db.execute('INSERT INTO recipes(coffee_id, data) VALUES (?, ?)', (coffee_id, json.dumps(recipe, ensure_ascii=False)))
                elif len(parts) == 3 and parts[:2] == ['api', 'recipes'] and parts[2].isdigit() and method in ('PUT', 'DELETE'):
                    recipe_id = int(parts[2])
                    if not db.execute('SELECT 1 FROM recipes WHERE id=?', (recipe_id,)).fetchone():
                        return self.respond(404, {'error': 'Nie znaleziono przepisu.'})
                    if method == 'DELETE':
                        db.execute('DELETE FROM recipes WHERE id=?', (recipe_id,))
                    else:
                        db.execute('UPDATE recipes SET data=? WHERE id=?', (json.dumps(validate_recipe(data), ensure_ascii=False), recipe_id))
                else:
                    return self.respond(404, {'error': 'Nie znaleziono.'})
                record_version(db, label if parts == ['api', 'sync'] else ('Usunięto kawę i jej przepisy' if method == 'DELETE' and parts[:2] == ['api', 'coffees'] else 'Zmieniono przepisy'))
            self.respond(200, result if parts == ['api', 'sync'] else {'ok': True})
        except (ValueError, TypeError, UnicodeDecodeError) as error:
            self.respond(400, {'error': str(error) or 'Nieprawidłowe dane.'})
        except sqlite3.Error:
            self.respond(500, {'error': 'Nie udało się zapisać danych. Spróbuj ponownie.'})


if __name__ == '__main__':
    if bool(USERNAME) != bool(PASSWORD):
        raise SystemExit('Ustaw jednocześnie APP_USERNAME i APP_PASSWORD albo pozostaw oba puste.')
    init_db()
    port = int(os.environ.get('PORT', '8080'))
    print(f'Moja kawa: http://localhost:{port}', flush=True)
    ThreadingHTTPServer(('0.0.0.0', port), Handler).serve_forever()
