import base64
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

    def request(self, method, path, data=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        request_headers = {'Content-Type': 'application/json'} if data is not None else {}
        request_headers.update(headers or {})
        connection.request(method, path, body=json.dumps(data).encode() if data is not None else None, headers=request_headers)
        response = connection.getresponse()
        status, body = response.status, response.read()
        connection.close()
        return status, json.loads(body) if body and response.getheader('Content-Type', '').startswith('application/json') else body

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

    def test_optional_auth(self):
        server.USERNAME, server.PASSWORD = 'test', 'secret'
        try:
            self.assertEqual(self.request('GET', '/api/coffees')[0], 401)
            self.assertEqual(self.request('POST', '/api/coffees', {'name':'x'})[0], 401)
            self.assertEqual(self.request('GET', '/')[0], 401)
            self.assertEqual(self.request('GET', '/health')[0], 200)
            credentials = base64.b64encode(b'test:secret').decode()
            self.assertEqual(self.request('GET', '/api/coffees', headers={'Authorization':f'Basic {credentials}'})[0], 200)
        finally:
            server.USERNAME = server.PASSWORD = ''

    def test_all_pwa_assets_are_available(self):
        for path in ['/', '/app.js', '/style.css', '/sw.js', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png']:
            with self.subTest(path=path):
                self.assertEqual(self.request('GET', path)[0], 200)

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
