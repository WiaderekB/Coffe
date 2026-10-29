# Moja kawa

Prosty przepiśnik PWA: **kawa → objętość → przepis**. Polski interfejs, wygodny na telefonie i komputerze. Bez timera, kont użytkowników i zewnętrznych usług.

Kawy i przepisy można dodawać, edytować i usuwać w aplikacji. Każdy wariant ma własne proporcje, mielenie, temperaturę, plan zalewania, kroki oraz uwagi. Ilość wody i gotowego naparu są osobnymi polami. Można zapisać kilka metod dla tej samej objętości. Pierwsze uruchomienie dodaje Parallel 12 / 500 ml z dostarczonym przepisem 4:6; późniejsze uruchomienia nie przywracają usuniętych danych.

## Coolify

1. Wypchnij to repozytorium do swojego serwera Git.
2. W Coolify dodaj zasób z repozytorium i wybierz **Docker Compose** jako sposób budowania.
3. Wskaż plik `/compose.yaml` (gdy formularz oczekuje ścieżki względem repozytorium: `compose.yaml`).
4. Do usługi `coffee` przypisz swoją domenę z portem kontenera **8080**, np. `https://kawa.twojadomena.pl:8080`. Port 8080 jest portem wewnętrznym; Coolify wystawi stronę przez HTTPS.
5. Opcjonalnie ustaw w Coolify **APP_USERNAME** i **APP_PASSWORD**, aby chronić całą aplikację logowaniem. Ustaw oba pola naraz. Bez nich każdy, kto ma dostęp do adresu, może czytać i zmieniać przepisy.
6. Wdróż aplikację. Trwały wolumen `coffee-data` przechowuje bazę `/data/coffee.sqlite3` i zachowuje przepisy podczas aktualizacji kontenera.

Nie dodawaj `compose.local.yaml` do konfiguracji Coolify. Nie trzeba instalować zależności ani konfigurować osobnej bazy. Obraz działa jako zwykły użytkownik z systemem plików tylko do odczytu; zapisy trafiają na wolumen. `/health` jest publicznym punktem kontroli stanu i nie ujawnia przepisów.

## Lokalnie

Z Dockerem:

```sh
docker compose -f compose.yaml -f compose.local.yaml up --build -d
```

Otwórz http://localhost:8080. Opcjonalne zmienne możesz umieścić w `.env`, korzystając z `.env.example`.

Bez Dockera, z Pythonem 3.10 lub nowszym:

```sh
python3 server.py
```

Dane lokalne zapisują się w `data/coffee.sqlite3`. Można zmienić lokalizację przez `DB_PATH`, a port przez `PORT`.

## Instalacja PWA i tryb offline

Wymagane jest **HTTPS** (lokalnie działa też `localhost`). Android/Chrome: wybierz „Zainstaluj” w aplikacji, gdy przeglądarka udostępni instalację, lub użyj menu przeglądarki. iPhone/Safari: Udostępnij → Dodaj do ekranu początkowego.

Po pierwszym otwarciu aplikacja zachowuje interfejs i ostatnio odczytane przepisy na urządzeniu. Offline możesz je przeglądać; zapis i usuwanie wymagają połączenia. Formularz zachowuje wpisane dane przy błędzie zapisu, dopóki go nie zamkniesz lub nie odświeżysz strony. Dane offline są ostatnio odczytaną kopią, nie kopią zapasową serwera.

Opcjonalne logowanie używa HTTP Basic przez HTTPS. Przeglądarka zapamiętuje sesję, a przepisy offline pozostają w pamięci danego profilu przeglądarki. Na współdzielonym urządzeniu usuń dane witryny po użyciu. Aplikacja nie ma osobnych kont ani synchronizacji edycji offline.

## Kopie zapasowe

Włącz w Coolify kopię trwałego wolumenu. Przy ręcznym kopiowaniu pliku bazy zatrzymaj usługę na czas kopiowania albo użyj mechanizmu SQLite backup. Nie uruchamiaj `docker compose down -v`, jeśli chcesz zachować przepisy — opcja `-v` usuwa wolumen. Uruchamiaj jedną instancję usługi na jednym wolumenie.

## Sprawdzenie

```sh
python3 -m unittest discover -s tests -v
```

Backend korzysta wyłącznie z biblioteki standardowej Pythona, frontend z HTML, CSS i JavaScript, a trwałe dane z SQLite.
