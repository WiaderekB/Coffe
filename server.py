"""Small, dependency-free coffee recipe server."""
import base64
from contextlib import contextmanager
import hmac
import hashlib
import json
import os
from pathlib import Path
import sqlite3
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

ROOT = Path(__file__).parent
DB_PATH = Path(os.environ.get('DB_PATH', ROOT / 'data' / 'coffee.sqlite3'))
USERNAME = os.environ.get('APP_USERNAME', '')
PASSWORD = os.environ.get('APP_PASSWORD', '')

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
        ''')
        if not db.execute("SELECT 1 FROM migrations WHERE name='seed'").fetchone():
            coffee_id = db.execute('INSERT INTO coffees(name, description) VALUES (?, ?)',
                                   ('Parallel 12', 'Słodki, aromatyczny napar. Przepisy dopracowane do konkretnej porcji.')).lastrowid
            db.execute('INSERT INTO recipes(coffee_id, data) VALUES (?, ?)', (coffee_id, json.dumps(SEED, ensure_ascii=False)))
            db.execute("INSERT INTO migrations VALUES ('seed')")


def get_coffees(db):
    coffees = [dict(row) | {'recipes': []} for row in db.execute('SELECT * FROM coffees ORDER BY name COLLATE NOCASE')]
    by_id = {c['id']: c for c in coffees}
    for row in db.execute('SELECT * FROM recipes'):
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


def snapshot(db):
    coffees = get_coffees(db)
    canonical = sorted((c | {'recipes': sorted(c['recipes'], key=lambda r: r['id'])} for c in coffees), key=lambda c: c['id'])
    revision = hashlib.sha256(json.dumps(canonical, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    return {'coffees': coffees, 'revision': revision}


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
        item = {'id': identifier(coffee.get('id'), coffee_ids),
                'name': string(coffee.get('name'), 'nazwa kawy', True, 120),
                'description': string(coffee.get('description', ''), 'opis', limit=1000), 'recipes': []}
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
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def authorized(self):
        if not PASSWORD:
            return True
        expected = 'Basic ' + base64.b64encode(f'{USERNAME}:{PASSWORD}'.encode()).decode()
        if hmac.compare_digest(self.headers.get('Authorization', ''), expected):
            return True
        self.send_response(401)
        self.send_header('WWW-Authenticate', 'Basic realm="Moja kawa", charset="UTF-8"')
        self.end_headers()
        return False

    def respond(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/health':
            try:
                with connect() as db:
                    db.execute('SELECT 1 FROM coffees LIMIT 1')
                return self.respond(200, {'ok': True})
            except sqlite3.Error:
                return self.respond(503, {'ok': False})
        if not self.authorized():
            return
        if path == '/api/state':
            with connect() as db:
                return self.respond(200, snapshot(db))
        if path == '/api/coffees':
            with connect() as db:
                return self.respond(200, get_coffees(db))
        if path.startswith('/api/'):
            return self.respond(404, {'error': 'Nie znaleziono.'})
        if path == '/':
            self.path = '/index.html'
        super().do_GET()

    def do_HEAD(self):
        if self.authorized():
            super().do_HEAD()

    def do_POST(self):
        self.mutate('POST')

    def do_PUT(self):
        self.mutate('PUT')

    def do_DELETE(self):
        self.mutate('DELETE')

    def mutate(self, method):
        if not self.authorized():
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
            parts = urlparse(self.path).path.strip('/').split('/')
            with connect() as db:
                if parts == ['api', 'sync'] and method == 'POST':
                    collection = validate_snapshot(data.get('coffees'))
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
                        db.execute('INSERT INTO coffees(id, name, description) VALUES (?, ?, ?)',
                                   (coffee['id'], coffee['name'], coffee['description']))
                        for recipe in coffee['recipes']:
                            db.execute('INSERT INTO recipes(id, coffee_id, data) VALUES (?, ?, ?)',
                                       (recipe['id'], coffee['id'], json.dumps({k: v for k, v in recipe.items() if k != 'id'}, ensure_ascii=False)))
                    result = snapshot(db)
                elif parts == ['api', 'coffees'] and method == 'POST':
                    name = string(data.get('name'), 'nazwa kawy', True, 120)
                    description = string(data.get('description', ''), 'opis', limit=1000)
                    db.execute('INSERT INTO coffees(name, description) VALUES (?, ?)', (name, description))
                elif len(parts) == 3 and parts[:2] == ['api', 'coffees'] and parts[2].isdigit() and method in ('PUT', 'DELETE'):
                    coffee_id = int(parts[2])
                    if not db.execute('SELECT 1 FROM coffees WHERE id=?', (coffee_id,)).fetchone():
                        return self.respond(404, {'error': 'Nie znaleziono kawy.'})
                    if method == 'DELETE':
                        db.execute('DELETE FROM coffees WHERE id=?', (coffee_id,))
                    else:
                        db.execute('UPDATE coffees SET name=?, description=? WHERE id=?',
                                   (string(data.get('name'), 'nazwa kawy', True, 120), string(data.get('description', ''), 'opis', limit=1000), coffee_id))
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
