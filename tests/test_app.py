import hashlib
import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer

import server


class AppTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        server.DB_PATH = Path(cls.temp.name) / 'test.sqlite3'
        server.init_db()
        class QuietHandler(server.Handler):
            def log_message(self, *args):
                pass
        cls.http = ThreadingHTTPServer(('127.0.0.1', 0), QuietHandler)
        cls.port = cls.http.server_port
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.thread.join()
        cls.temp.cleanup()

    def request(self, method, path, data=None, headers=None, include_headers=False):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        request_headers = {'Content-Type': 'application/json'} if data is not None else {}
        request_headers.update(headers or {})
        connection.request(method, path, body=json.dumps(data).encode() if data is not None else None, headers=request_headers)
        response = connection.getresponse()
        status, body = response.status, response.read()
        connection.close()
        result = (status, json.loads(body) if body and response.getheader('Content-Type', '').startswith('application/json') else body)
        return (*result, dict(response.getheaders())) if include_headers else result

    def test_seed_and_idempotent_initialization(self):
        server.init_db()
        status, coffees = self.request('GET', '/api/coffees')
        self.assertEqual(status, 200)
        seeds = [coffee for coffee in coffees if coffee['name'] == 'Parallel 12']
        self.assertEqual(len(seeds), 1)
        recipe = seeds[0]['recipes'][0]
        self.assertEqual(sum(p['amount'] for p in recipe['pours']), 500)
        self.assertEqual(recipe['dose'], 30)
        self.assertEqual(len(recipe['steps']), 7)

    def test_coffee_recipe_lifecycle_and_cascade(self):
        self.assertEqual(self.request('POST', '/api/coffees', {'name':'Testowa kawa','description':'Opis'})[0], 200)
        coffee = next(c for c in self.request('GET', '/api/coffees')[1] if c['name'] == 'Testowa kawa')
        recipe = server.SEED | {'volume':250,'dose':15,'pours':[{'time':'0:00','amount':250}]}
        self.assertEqual(self.request('POST', f"/api/coffees/{coffee['id']}/recipes", recipe)[0], 200)
        coffee = next(c for c in self.request('GET', '/api/coffees')[1] if c['id'] == coffee['id'])
        recipe_id = coffee['recipes'][0]['id']
        self.assertEqual(self.request('PUT', f'/api/recipes/{recipe_id}', recipe | {'notes':'Zmienione'})[0], 200)
        self.assertEqual(self.request('PUT', f"/api/coffees/{coffee['id']}", {'name':'Inna nazwa','description':''})[0], 200)
        self.assertEqual(self.request('DELETE', f"/api/coffees/{coffee['id']}", {})[0], 200)
        self.assertEqual(self.request('PUT', f'/api/recipes/{recipe_id}', recipe)[0], 404)
        with server.connect() as db:
            self.assertIsNone(db.execute('SELECT * FROM recipes WHERE id=?', (recipe_id,)).fetchone())

    def test_recipe_deletion(self):
        coffee_id = self.request('GET', '/api/coffees')[1][0]['id']
        self.assertEqual(self.request('POST', f'/api/coffees/{coffee_id}/recipes', server.SEED)[0], 200)
        recipes = next(c for c in self.request('GET', '/api/coffees')[1] if c['id'] == coffee_id)['recipes']
        recipe_id = max(r['id'] for r in recipes)
        self.assertEqual(self.request('DELETE', f'/api/recipes/{recipe_id}', {})[0], 200)
        self.assertEqual(self.request('DELETE', f'/api/recipes/{recipe_id}', {})[0], 404)

    def test_validation_and_write_protection(self):
        self.assertEqual(self.request('POST', '/api/coffees', {'name':' '})[0], 400)
        self.assertEqual(self.request('POST', '/api/coffees', {'name':42})[0], 400)
        self.assertEqual(self.request('POST', '/api/coffees', {'name':'x'}, {'Sec-Fetch-Site':'cross-site'})[0], 403)
        self.assertEqual(self.request('POST', '/api/coffees', {'name':'x'}, {'Content-Type':'text/plain'})[0], 415)
        coffee_id = self.request('GET', '/api/coffees')[1][0]['id']
        for bad in [{'dose':0}, {'temperature':101}, {'volume':True}, {'pours':[{'time':'0:00','amount':10}]}, {'steps':'text'}, {'pours':[None]}]:
            with self.subTest(bad=bad):
                self.assertEqual(self.request('POST', f'/api/coffees/{coffee_id}/recipes', server.SEED | bad)[0], 400)

    def test_in_app_auth_session_and_logout(self):
        server.USERNAME, server.PASSWORD = 'test', 'secret'
        try:
            with server.connect() as db:
                db.execute('DELETE FROM login_attempts')
            self.assertEqual(self.request('GET', '/')[0], 200)
            for path in ['/sw.js', '/app.js', '/logo.svg', '/manifest.webmanifest', '/icon-192.png']:
                self.assertEqual(self.request('GET', path)[0], 200)
            code, body, headers = self.request('GET', '/api/coffees', include_headers=True)
            self.assertEqual(code, 401)
            self.assertNotIn('WWW-Authenticate', headers)
            self.assertEqual(self.request('POST', '/api/coffees', {'name':'x'})[0], 401)
            self.assertEqual(self.request('GET', '/health')[0], 200)
            self.assertEqual(self.request('GET', '/api/auth')[1], {'required':True,'authenticated':False,'username':''})
            self.assertEqual(self.request('POST', '/api/login', {'username':'test','password':'wrong'})[0], 401)
            self.assertEqual(self.request('POST', '/api/login', {'username':'test','password':'secret'}, {'Sec-Fetch-Site':'cross-site'})[0], 403)
            code, body, headers = self.request('POST', '/api/login', {'username':'test','password':'secret'}, {'X-Forwarded-Proto':'https'}, include_headers=True)
            self.assertEqual(code, 200)
            cookie = headers['Set-Cookie']
            for part in ['HttpOnly', 'SameSite=Lax', 'Secure', 'Max-Age=2592000']:
                self.assertIn(part, cookie)
            auth = {'Cookie':cookie.split(';')[0]}
            self.assertEqual(self.request('GET', '/api/state', headers=auth)[0], 200)
            self.assertEqual(self.request('GET', '/api/auth', headers=auth)[1]['username'], 'test')
            server.init_db()
            self.assertEqual(self.request('GET', '/api/state', headers=auth)[0], 200)
            self.assertEqual(self.request('POST', '/api/logout', {}, auth)[0], 200)
            self.assertEqual(self.request('GET', '/api/state', headers=auth)[0], 401)
        finally:
            server.USERNAME = server.PASSWORD = ''

    def test_expired_session_and_password_change_revoke_access(self):
        server.USERNAME, server.PASSWORD = 'test', 'secret'
        try:
            code, _, headers = self.request('POST', '/api/login', {'username':'test','password':'secret'}, include_headers=True)
            self.assertEqual(code, 200)
            auth = {'Cookie':headers['Set-Cookie'].split(';')[0]}
            server.PASSWORD = 'changed'
            self.assertEqual(self.request('GET', '/api/state', headers=auth)[0], 401)
            server.PASSWORD = 'secret'
            with server.connect() as db:
                db.execute('UPDATE sessions SET expires=0')
            self.assertEqual(self.request('GET', '/api/state', headers=auth)[0], 401)
        finally:
            server.USERNAME = server.PASSWORD = ''

    def test_login_rate_limit(self):
        server.USERNAME, server.PASSWORD = 'test', 'secret'
        try:
            with server.connect() as db:
                db.execute('DELETE FROM login_attempts')
            for _ in range(10):
                self.assertEqual(self.request('POST', '/api/login', {'username':'test','password':'bad'})[0], 401)
            self.assertEqual(self.request('POST', '/api/login', {'username':'test','password':'secret'})[0], 429)
            with server.connect() as db:
                db.execute('UPDATE login_attempts SET started=?', (time.time()-301,))
            self.assertEqual(self.request('POST', '/api/login', {'username':'test','password':'secret'})[0], 200)
        finally:
            server.USERNAME = server.PASSWORD = ''

    def test_coffee_metadata_and_accent_survive_rename_and_sync(self):
        details = {'name':'Metadata test','description':'','accent':'lavender','roaster':'Palarnia QA','country':'Etiopia',
                   'region':'Sidama','variety':'Heirloom','process':'Natural','roast':'Jasne','tasting_notes':'Jaśmin, brzoskwinia'}
        self.assertEqual(self.request('POST', '/api/coffees', details)[0], 200)
        state = self.request('GET', '/api/state')[1]
        coffee = next(c for c in state['coffees'] if c['name'] == details['name'])
        for key, value in details.items():
            self.assertEqual(coffee[key], value)
        self.assertEqual(self.request('PUT', f"/api/coffees/{coffee['id']}", {'name':'AAA renamed'})[0], 200)
        state = self.request('GET', '/api/state')[1]
        current = next(c for c in state['coffees'] if c['id'] == coffee['id'])
        self.assertEqual(current['accent'], 'lavender')
        self.assertEqual(current['country'], 'Etiopia')
        self.assertEqual(self.request('POST', '/api/sync', {'coffees':state['coffees'],'revision':state['revision']})[0], 200)
        for bad in [{'accent':'red'}, {'country':42}, {'roaster':'x'*301}]:
            self.assertEqual(self.request('PUT', f"/api/coffees/{coffee['id']}", bad)[0], 400)
        self.assertEqual(self.request('DELETE', f"/api/coffees/{coffee['id']}", {})[0], 200)

    def test_legacy_database_migration_preserves_recipes(self):
        old_path = server.DB_PATH
        try:
            server.DB_PATH = Path(self.temp.name) / 'legacy.sqlite3'
            db = sqlite3.connect(server.DB_PATH)
            db.executescript("""
                CREATE TABLE coffees (id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '');
                CREATE TABLE recipes (id INTEGER PRIMARY KEY, coffee_id INTEGER NOT NULL, data TEXT NOT NULL);
                CREATE TABLE migrations (name TEXT PRIMARY KEY);
                INSERT INTO migrations VALUES ('seed');
                INSERT INTO coffees VALUES (17, 'Stara kawa', 'Zachowaj mnie');
            """)
            db.execute('INSERT INTO recipes VALUES (9, 17, ?)', (json.dumps(server.SEED),))
            db.commit()
            db.close()
            legacy = [{'id':17,'name':'Stara kawa','description':'Zachowaj mnie','recipes':[server.SEED | {'id':9}]}]
            expected_revision = hashlib.sha256(json.dumps(legacy, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
            server.init_db()
            server.init_db()
            with server.connect() as db:
                state = server.snapshot(db)
            self.assertEqual(state['legacyRevision'], expected_revision)
            self.assertEqual(state['coffees'][0]['accent'], server.default_accent(17))
            self.assertEqual(state['coffees'][0]['recipes'][0]['pours'], server.SEED['pours'])
            self.assertEqual(len(state['coffees']), 1)
        finally:
            server.DB_PATH = old_path

    def test_all_pwa_assets_are_available(self):
        for path in ['/', '/app.js', '/style.css', '/sw.js', '/manifest.webmanifest', '/icon.svg', '/icon-180.png', '/icon-192.png', '/icon-512.png', '/logo.svg', '/core.js', '/store.js', '/cup.svg', '/ai-instructions.md', '/fonts/BarlowCondensed-ExtraBold.ttf']:
            with self.subTest(path=path):
                self.assertEqual(self.request('GET', path)[0], 200)

    def test_sync_is_atomic_and_survives_retry(self):
        status, initial = self.request('GET', '/api/state')
        self.assertEqual(status, 200)
        added = {'id': 100000000001, 'name': 'Offline test', 'description': '',
                 'recipes': [server.SEED | {'id': 100000000002}]}
        data = {'revision': initial['revision'], 'coffees': initial['coffees'] + [added]}
        status, saved = self.request('POST', '/api/sync', data)
        self.assertEqual(status, 200)
        self.assertNotEqual(saved['revision'], initial['revision'])
        self.assertEqual(self.request('POST', '/api/sync', data)[0], 200)
        with server.connect() as db:
            self.assertEqual(len([c for c in server.get_coffees(db) if c['id'] == added['id']]), 1)
        # A stale device must not overwrite the snapshot.
        stale = {'revision': initial['revision'], 'coffees': initial['coffees']}
        self.assertEqual(self.request('POST', '/api/sync', stale)[0], 409)
        self.assertEqual(self.request('GET', '/api/state')[1]['revision'], saved['revision'])
        self.assertEqual(self.request('POST', '/api/sync', {'revision': saved['revision'], 'coffees': initial['coffees']})[0], 200)

    def test_invalid_sync_leaves_database_unchanged(self):
        initial = self.request('GET', '/api/state')[1]
        for bad in [[{'id': 0, 'name': 'No'}], initial['coffees'] * 2, [{'id': 42, 'name': 'Bad', 'recipes': [{'volume': 500}]}]]:
            with self.subTest(bad=bad):
                self.assertEqual(self.request('POST', '/api/sync', {'revision':initial['revision'],'coffees':bad})[0], 400)
                self.assertEqual(self.request('GET', '/api/state')[1], initial)

    def test_concurrent_devices_cannot_overwrite_each_other(self):
        initial = self.request('GET', '/api/state')[1]
        def write(n):
            return self.request('POST', '/api/sync', {'revision':initial['revision'], 'coffees':initial['coffees'] + [
                {'id':200000000000+n,'name':f'Device {n}','description':'','recipes':[]}]})[0]
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(write, [1, 2]))
        self.assertEqual(sorted(results), [200, 409])
        current = self.request('GET', '/api/state')[1]
        self.assertEqual(self.request('POST', '/api/sync', {'revision':current['revision'],'coffees':initial['coffees']})[0], 200)

    def test_parallel_reads(self):
        with ThreadPoolExecutor(max_workers=5) as executor:
            results = list(executor.map(lambda _: self.request('GET', '/api/coffees')[0], range(10)))
        self.assertEqual(results, [200] * 10)

    def test_seed_does_not_return_after_deletion(self):
        old_path = server.DB_PATH
        try:
            server.DB_PATH = Path(self.temp.name) / 'separate.sqlite3'
            server.init_db()
            with server.connect() as db:
                db.execute('DELETE FROM coffees')
            server.init_db()
            with server.connect() as db:
                self.assertEqual(server.get_coffees(db), [])
        finally:
            server.DB_PATH = old_path


if __name__ == '__main__':
    unittest.main()
