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
from unittest.mock import patch
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

    def test_agent_token_is_independent_of_pwa_login(self):
        with patch.object(server, 'API_TOKEN', ''), patch.object(server, 'PASSWORD', ''):
            self.assertEqual(self.request('GET', '/api/v1/coffees')[0], 503)
            self.assertEqual(self.request('POST', '/api/v1/coffees', {'name':'Disabled'})[0], 503)
        with patch.object(server, 'API_TOKEN', 'test-agent-token-' * 3), patch.object(server, 'PASSWORD', 'locked'):
            for auth in [{}, {'Authorization':'Bearer wrong'}, {'Cookie':'coffee_session=fake'}]:
                self.assertEqual(self.request('GET', '/api/v1/state', headers=auth)[0], 401)
                self.assertEqual(self.request('POST', '/api/v1/coffees', {'name':'Unauthorized'}, auth)[0], 401)
            auth = {'Authorization':'Bearer ' + server.API_TOKEN}
            self.assertEqual(self.request('GET', '/api/v1/coffees', headers=auth)[0], 200)
            self.assertEqual(self.request('GET', '/api/state', headers=auth)[0], 401)
            self.assertEqual(self.request('POST', '/api/v1/sync', {}, auth)[0], 404)
            self.assertEqual(self.request('POST', '/api/v1/login', {}, auth)[0], 404)
            with patch.object(server, 'API_TOKEN', 'rotated-token-' * 4):
                self.assertEqual(self.request('GET', '/api/v1/coffees', headers=auth)[0], 401)
        with patch.object(server, 'API_TOKEN', 'test-agent-token-' * 3), patch.object(server, 'PASSWORD', ''):
            self.assertEqual(self.request('GET', '/api/v1/coffees')[0], 401)
            self.assertEqual(self.request('GET', '/api/coffees')[0], 200)

    def test_agent_api_lifecycle_revisions_history_and_pwa_conflict(self):
        with patch.object(server, 'API_TOKEN', 'test-agent-token-' * 3):
            auth = {'Authorization':'Bearer ' + server.API_TOKEN}
            before = self.request('GET', '/api/state')[1]
            code, created, headers = self.request('POST', '/api/v1/coffees',
                {'name':'Agent lifecycle','accent':'sky','country':'Etiopia'}, auth, True)
            self.assertEqual(code, 201)
            coffee_id = created['data']['id']
            path = f'/api/v1/coffees/{coffee_id}'
            self.assertEqual(headers['Location'], path)
            self.assertEqual(headers['ETag'], '"' + created['revision'] + '"')
            self.assertEqual(self.request('GET', path, headers=auth)[1]['country'], 'Etiopia')
            self.assertEqual(self.request('GET', path+'/recipes', headers=auth)[1], [])
            self.assertEqual(self.request('POST', '/api/v1/coffees', {'name':'  AGENT   lifecycle  '}, auth)[0], 409)
            code, added = self.request('POST', path+'/recipes', server.SEED, auth)
            self.assertEqual(code, 201)
            recipe_id = added['data']['id']
            recipe_path = f'/api/v1/recipes/{recipe_id}'
            self.assertEqual(added['data']['coffee_id'], coffee_id)
            code, duplicate = self.request('POST', path+'/recipes', server.SEED, auth)
            self.assertEqual((code, duplicate['id']), (409, recipe_id))
            code, recipe, headers = self.request('GET', recipe_path, headers=auth, include_headers=True)
            self.assertEqual(recipe['grind'], server.SEED['grind'])
            self.assertEqual(self.request('PATCH', recipe_path, {'notes':'Agent updated'},
                auth | {'If-Match':headers['ETag']})[0], 200)
            self.assertEqual(self.request('PATCH', recipe_path, {'notes':'Stale'},
                auth | {'If-Match':headers['ETag']})[0], 412)
            self.assertEqual(self.request('DELETE', path, headers=auth | {'If-Match':headers['ETag']})[0], 412)
            current = self.request('GET', recipe_path, headers=auth)[1]
            self.assertEqual(current['notes'], 'Agent updated')
            self.assertEqual(current['grind'], server.SEED['grind'])
            self.assertEqual(self.request('PATCH', path, {'roaster':'Test roaster'}, auth)[0], 200)
            self.assertEqual(self.request('GET', path, headers=auth)[1]['accent'], 'sky')
            history = self.request('GET', '/api/v1/history', headers=auth)[1]
            self.assertTrue(history[0]['label'].startswith('API agenta: PATCH'))
            detail = self.request('GET', f"/api/v1/history/{history[0]['id']}", headers=auth)[1]
            self.assertIn(coffee_id, [c['id'] for c in detail['coffees']])
            # An offline PWA cannot overwrite the agent's newer state.
            self.assertEqual(self.request('POST', '/api/sync', before | {'coffees':before['coffees'] + [
                {'id':7000001,'name':'Unsynced PWA','recipes':[]} ]})[0], 409)
            self.assertEqual(self.request('DELETE', recipe_path, headers=auth)[0], 200)
            self.assertEqual(self.request('GET', recipe_path, headers=auth)[0], 404)
            self.assertEqual(self.request('POST', path+'/recipes', server.SEED, auth)[0], 201)
            self.assertEqual(self.request('DELETE', path, headers=auth)[0], 200)
            self.assertEqual(self.request('GET', path, headers=auth)[0], 404)
            self.assertEqual(self.request('GET', recipe_path, headers=auth)[0], 404)
            with server.connect() as db:
                self.assertEqual(db.execute('SELECT count(*) FROM recipes WHERE coffee_id=?', (coffee_id,)).fetchone()[0], 0)

    def test_agent_api_validation_and_public_spec(self):
        with patch.object(server, 'API_TOKEN', 'test-agent-token-' * 3), patch.object(server, 'PASSWORD', 'locked'):
            auth = {'Authorization':'Bearer ' + server.API_TOKEN}
            code, spec = self.request('GET', '/api/openapi.json')
            self.assertEqual(code, 200)
            self.assertEqual(spec['openapi'], '3.0.3')
            self.assertIn('/recipes/{recipe_id}', spec['paths'])
            self.assertNotIn(server.API_TOKEN, json.dumps(spec))
            self.assertEqual(self.request('GET', '/agent-api.md')[0], 200)
            self.assertEqual(self.request('POST', '/api/v1/coffees', {'name':'Bad','recipes':[]}, auth)[0], 400)
            self.assertEqual(self.request('POST', '/api/v1/coffees', {'name':'Bad','accent':'orange'}, auth)[0], 400)
            coffee = self.request('GET', '/api/v1/coffees', headers=auth)[1][0]
            path = f"/api/v1/coffees/{coffee['id']}/recipes"
            for bad in [{'temperature':None}, {'volume':float('nan')}, {'pours':[None]}, {'dose':False}, {'water':500}]:
                self.assertEqual(self.request('POST', path, server.SEED | bad, auth)[0], 400)
            self.assertEqual(self.request('POST', path, server.SEED, auth | {'Sec-Fetch-Site':'cross-site'})[0], 403)
            self.assertEqual(self.request('POST', path, server.SEED, auth | {'Content-Type':'text/plain'})[0], 415)
            self.assertEqual(self.request('PATCH', '/api/v1/recipes/999999999999999999999999', {}, auth)[0], 404)
            self.assertEqual(self.request('GET', '/api/v1/recipes/99999999', headers=auth)[0], 404)
            self.assertEqual(self.request('GET', '/api/v1/history/'+'9'*100, headers=auth)[0], 404)

    def test_agent_concurrent_create_and_stale_update(self):
        with patch.object(server, 'API_TOKEN', 'test-agent-token-' * 3):
            auth = {'Authorization':'Bearer ' + server.API_TOKEN}
            def create(_):
                return self.request('POST', '/api/v1/coffees', {'name':'Parallel agent writes'}, auth)
            with ThreadPoolExecutor(max_workers=2) as executor:
                results = list(executor.map(create, range(2)))
            self.assertEqual(sorted(code for code, _ in results), [201, 409])
            coffee = next(body['data'] for code, body in results if code == 201)
            path = f"/api/v1/coffees/{coffee['id']}"
            _, _, headers = self.request('GET', path, headers=auth, include_headers=True)
            def update(index):
                return self.request('PATCH', path, {'description':f'Edit {index}'}, auth | {'If-Match':headers['ETag']})[0]
            with ThreadPoolExecutor(max_workers=2) as executor:
                results = list(executor.map(update, range(2)))
            self.assertEqual(sorted(results), [200, 412])
            self.assertEqual(self.request('DELETE', path, headers=auth)[0], 200)

    def test_agent_recipe_replace_and_oversized_collection_rollback(self):
        with patch.object(server, 'API_TOKEN', 'test-agent-token-' * 3):
            auth = {'Authorization':'Bearer ' + server.API_TOKEN}
            coffee_id = self.request('POST', '/api/v1/coffees', {'name':'Agent rollback'}, auth)[1]['data']['id']
            path = f'/api/v1/coffees/{coffee_id}/recipes'
            recipe_id = self.request('POST', path, server.SEED, auth)[1]['data']['id']
            recipe_path = f'/api/v1/recipes/{recipe_id}'
            self.assertEqual(self.request('PUT', recipe_path, {'volume':250,'dose':15,'temperature':90}, auth)[0], 200)
            recipe = self.request('GET', recipe_path, headers=auth)[1]
            self.assertEqual((recipe['notes'],recipe['pours'],recipe['steps']), ('',[],[]))
            history_id = self.request('GET', '/api/v1/history', headers=auth)[1][0]['id']
            self.assertEqual(self.request('PATCH', recipe_path, {}, auth)[0], 200)
            self.assertEqual(self.request('GET', '/api/v1/history', headers=auth)[1][0]['id'], history_id)
            before = self.request('GET', '/api/v1/state', headers=auth)[1]
            oversized = {'steps':['x'*3000]*100, 'notes':'x'*10000}
            # Exercise the 1.8 MB limit without building a huge HTTP request.
            original = server.get_coffees
            def huge_collection(db):
                return original(db) + [{'padding':'x'*1800000}]
            with patch.object(server, 'get_coffees', huge_collection):
                self.assertEqual(self.request('PATCH', recipe_path, oversized, auth)[0], 400)
            self.assertEqual(self.request('GET', '/api/v1/state', headers=auth)[1], before)
            self.assertEqual(self.request('DELETE', f'/api/v1/coffees/{coffee_id}', headers=auth)[0], 200)

    def test_grinder_memory_persistence_conflicts_and_independent_recipes(self):
        with server.connect() as db:
            db.execute('DELETE FROM grinder_memory')
        before = self.request('GET', '/api/state')[1]
        self.assertEqual(self.request('GET', '/api/grinders')[1]['grinders'], [])
        item = {'name':'Timemore C3S','setting':'17 klików od zera'}
        # First use can be saved offline before the empty server memory was read.
        status, saved = self.request('POST', '/api/grinders', {'grinders':[item], 'revision':None})
        self.assertEqual(status, 200)
        server.init_db()
        self.assertEqual(self.request('GET', '/api/grinders')[1], saved)
        # Duplicate retry is safe after a lost response.
        self.assertEqual(self.request('POST', '/api/grinders', {'grinders':[item], 'revision':None})[0], 200)
        def update(setting):
            return self.request('POST', '/api/grinders', {'grinders':[item | {'setting':setting}], 'revision':saved['revision']})[0]
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(update, ['18 klików od zera','19 klików od zera']))
        self.assertEqual(sorted(results), [200,409])
        code, conflict = self.request('POST', '/api/grinders', {'grinders':[item], 'revision':saved['revision']})
        self.assertEqual(code, 409)
        self.assertNotEqual(conflict['grinders'][0]['setting'], item['setting'])
        self.assertEqual(self.request('GET', '/api/state')[1], before)
        # Old/full recipe clients cannot reset the operational memory.
        self.assertEqual(self.request('POST', '/api/sync', before)[0], 200)
        self.assertEqual(self.request('GET', '/api/grinders')[1]['revision'], conflict['revision'])
        self.assertEqual(self.request('POST', '/api/grinders', {'grinders':[item], 'revision':conflict['revision']})[0], 200)
        with server.connect() as db:
            db.execute('DELETE FROM grinder_memory')

    def test_grinder_memory_validation_auth_and_agent_access(self):
        before = self.request('GET', '/api/grinders')[1]
        for items in [None, {}, [{'name':'','setting':'17'}], [{'name':'C3S','setting':''}],
                      [{'name':'C3S','setting':'x'*181}], [{'name':'C3S','setting':'17'}, {'name':' c3s ','setting':'18'}],
                      [{'name':str(i),'setting':'17'} for i in range(21)]]:
            self.assertEqual(self.request('POST', '/api/grinders', {'grinders':items,'revision':before['revision']})[0], 400)
            self.assertEqual(self.request('GET', '/api/grinders')[1], before)
        with patch.object(server, 'PASSWORD', 'locked'), patch.object(server, 'API_TOKEN', 'memory-agent-'*4):
            self.assertEqual(self.request('GET', '/api/grinders')[0], 401)
            self.assertEqual(self.request('POST', '/api/grinders', {'grinders':[]})[0], 401)
            auth = {'Authorization':'Bearer '+server.API_TOKEN}
            self.assertEqual(self.request('GET', '/api/v1/grinders', headers=auth)[0], 200)
            data = {'grinders':[{'name':'Test grinder','setting':'12 clicks from zero'}],'revision':before['revision']}
            self.assertEqual(self.request('POST', '/api/v1/grinders', data, auth | {'If-Match':'"stale"'})[0], 412)
            self.assertEqual(self.request('POST', '/api/v1/grinders', data, auth)[0], 200)
            self.assertEqual(self.request('POST', '/api/v1/grinders', {'grinders':[], 'revision':self.request('GET', '/api/v1/grinders', headers=auth)[1]['revision']}, auth)[0],200)

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
            self.assertEqual(self.request('GET', '/api/history')[0],401)
            self.assertEqual(self.request('GET', '/api/history/1')[0],401)
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
            db.execute('INSERT INTO recipes VALUES (10, 999, ?)', (json.dumps(server.SEED),))
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
            with server.connect() as db:
                self.assertEqual(db.execute('SELECT count(*) FROM recipes WHERE coffee_id=999').fetchone()[0],0)
            self.assertEqual(self.request('DELETE', '/api/coffees/17', {})[0],200)
            with server.connect() as db:
                self.assertEqual(db.execute('SELECT count(*) FROM recipes').fetchone()[0],0)
            self.assertEqual(self.request('GET', '/api/coffees')[1],[])
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

    def test_history_preserves_deleted_versions_and_restores_as_new_save(self):
        original = self.request('GET', '/api/state')[1]
        added = {'id': 300000000001, 'name': 'History QA', 'description': '',
                 'recipes': [server.SEED | {'id': 300000000002}]}
        status, created = self.request('POST', '/api/sync', {'revision':original['revision'], 'coffees':original['coffees']+[added], 'label':'Dodano kawę QA'})
        self.assertEqual(status,200)
        history = self.request('GET', '/api/history')[1]
        saved_id = history[0]['id']
        self.assertEqual(history[0]['label'],'Dodano kawę QA')
        # Retrying a save does not create another version.
        self.assertEqual(self.request('POST', '/api/sync', {'revision':original['revision'], 'coffees':original['coffees']+[added]})[0],200)
        self.assertEqual(self.request('GET', '/api/history')[1][0]['id'],saved_id)
        status, deleted = self.request('POST', '/api/sync', {'revision':created['revision'], 'coffees':original['coffees'], 'label':'Usunięto kawę QA'})
        self.assertEqual(status,200)
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM recipes WHERE coffee_id=?',(added['id'],)).fetchone()[0],0)
        previous = self.request('GET', f'/api/history/{saved_id}')[1]
        self.assertTrue(any(c['id']==added['id'] for c in previous['coffees']))
        status, restored = self.request('POST', '/api/sync', {'revision':deleted['revision'], 'coffees':previous['coffees'], 'label':f'Przywrócono wersję #{saved_id}'})
        self.assertEqual(status,200)
        latest = self.request('GET', '/api/history')[1][0]
        self.assertGreater(latest['id'],saved_id)
        self.assertEqual(latest['label'],f'Przywrócono wersję #{saved_id}')
        self.assertEqual(self.request('POST', '/api/sync', {'revision':restored['revision'], 'coffees':original['coffees']})[0],200)
        self.assertEqual(self.request('GET', '/api/history/999999999')[0],404)

    def test_history_retains_only_last_twenty_versions(self):
        old_path = server.DB_PATH
        try:
            server.DB_PATH = Path(self.temp.name) / 'history-limit.sqlite3'
            server.init_db()
            for i in range(25):
                with server.connect() as db:
                    db.execute('UPDATE coffees SET description=?',(str(i),))
                    server.record_version(db,f'Edycja {i}')
            versions = self.request('GET', '/api/history')[1]
            self.assertEqual(len(versions),20)
            self.assertEqual(versions[0]['label'],'Edycja 24')
            self.assertEqual(versions[-1]['label'],'Edycja 5')
        finally:
            server.DB_PATH = old_path

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
