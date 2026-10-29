# Moja kawa

Prosty przepiśnik PWA: **kawa → objętość → przepis**. Polski interfejs, wygodny na telefonie i komputerze. Bez timera i zewnętrznych usług. Opcjonalny ekran logowania chroni wspólną kolekcję.

Kawy i przepisy można dodawać, edytować i usuwać w aplikacji. Każdy wariant ma własne proporcje, mielenie, temperaturę, plan zalewania, kroki oraz uwagi. Ilość wody i gotowego naparu są osobnymi polami. Można zapisać kilka metod dla tej samej objętości. Pierwsze uruchomienie dodaje Parallel 12 / 500 ml z dostarczonym przepisem 4:6; późniejsze uruchomienia nie przywracają usuniętych danych.

## Coolify

1. Wypchnij to repozytorium do swojego serwera Git.
2. W Coolify dodaj zasób z repozytorium i wybierz **Docker Compose** jako sposób budowania.
3. Wskaż plik `/compose.yaml` (gdy formularz oczekuje ścieżki względem repozytorium: `compose.yaml`).
4. Do usługi `coffee` przypisz swoją domenę z portem kontenera **8080**, np. `https://kawa.twojadomena.pl:8080`. Port 8080 jest portem wewnętrznym; Coolify wystawi stronę przez HTTPS.
5. Opcjonalnie ustaw w Coolify **APP_USERNAME** i **APP_PASSWORD**, aby włączyć ekran logowania w aplikacji (także w zainstalowanej PWA). Ustaw oba pola naraz. Bez nich każdy, kto ma dostęp do adresu, może czytać i zmieniać przepisy.
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

## Telefon, iPad i PWA

Interfejs jest projektowany najpierw na telefon: duże przyciski, dolna nawigacja, poziomy wybór porcji i widoczne ustawienie młynka. Na iPadzie harmonogram i przygotowanie tworzą dwie kolumny. Przygotowanie i uwagi rozwija się osobno. Czcionka i grafiki są lokalnymi zasobami, bez zewnętrznych żądań podczas używania.

Wymagane jest **HTTPS** (lokalnie działa też `localhost`). Na iPhonie i iPadzie w Safari: Udostępnij → Dodaj do ekranu początkowego. Android/Chrome: menu przeglądarki → Zainstaluj aplikację. Wskazówki znajdziesz też w Więcej → Zainstaluj aplikację.

Po pierwszym udanym połączeniu aplikacja zapisuje przepisy w **IndexedDB**, a service worker zachowuje cały interfejs, grafiki, czcionkę i instrukcję importu. Poczekaj na zakończenie pierwszego ładowania przed odłączeniem internetu. Offline działa przeglądanie, dodawanie, edycja, usuwanie, import i eksport. Zapis lokalny kończy się przed zamknięciem formularza. Niewysłane zmiany przetrwają odświeżenie i ponowne otwarcie strony.

Synchronizacja następuje po odzyskaniu połączenia, powrocie do aplikacji, co 30 sekund w aktywnej aplikacji i ręcznie przez Więcej → Synchronizuj teraz. Nie wymaga działającej aplikacji w tle; jeśli system ją zamknie, synchronizacja wznowi się po otwarciu. Wskaźnik na górze pokazuje, czy dane dotarły na serwer, czy czekają na urządzeniu.

**Równoczesne zmiany na kilku urządzeniach:** serwer sprawdza wersję kolekcji w transakcji SQLite. Przy konflikcie nie nadpisuje danych. Aplikacja pokazuje „Dwie wersje” i zachowuje lokalne zmiany. Pobierz ich kopię JSON, wczytaj wersję serwera i zaimportuj brakujące warianty z kopii. Import dodaje przepisy, więc zmodyfikowany wariant może zostać dodany jako drugi przepis tej samej objętości. Nie ma automatycznego rozstrzygania sprzecznych edycji.

Więcej → Zachowuj dane offline prosi przeglądarkę o trwałą pamięć. Decyzja należy do przeglądarki. Dane witryny mogą zostać usunięte przez użytkownika lub system; regularnie pobieraj kopię JSON, szczególnie przed czyszczeniem pamięci. Limit kolekcji: 1000 kaw, po 100 przepisów, do 1,8 MB danych JSON. Import pojedynczego pliku: do 1,5 MB.

Po aktualizacji aplikacji z wersji korzystającej z HTTP Basic wybierz Więcej → Aktualizuj aplikację, a następnie zaloguj się w nowym ekranie.

Aktualizacja interfejsu jest pobierana w tle; gotową wersję uruchomisz w Więcej → Aktualizuj aplikację. Zapisane przepisy i oczekujące zmiany pozostają w IndexedDB. Przy wdrażaniu zmian zasobów zwiększ nazwę `CACHE` w `static/sw.js`, aby stary i nowy interfejs miały osobne pamięci podręczne.

## Logowanie w aplikacji

Ustaw `APP_USERNAME` i `APP_PASSWORD` w Coolify tak jak wcześniej. Aplikacja pokazuje własny ekran logowania; nie używa okienka HTTP Basic ani nagłówka `WWW-Authenticate`. Publiczne są interfejs PWA, ikony i punkt kontroli stanu; dane oraz ich zapis wymagają sesji.

Sesja trwa 30 dni, jest przechowywana w ciasteczku **HttpOnly, SameSite=Lax** i zapamiętywana również po zamknięciu PWA. Za proxy Coolify ciasteczko otrzymuje **Secure**, gdy `X-Forwarded-Proto` wskazuje HTTPS. W produkcji używaj domeny HTTPS. Serwer zapisuje wyłącznie skrót losowego tokenu sesji w SQLite. Sesje przetrwają restart kontenera. Zmiana loginu lub hasła w zmiennych środowiskowych unieważnia wcześniejsze sesje. Po 10 błędnych próbach logowania z jednego adresu następuje przerwa do 5 minut; za wspólnym proxy limit może obejmować kilka urządzeń.

Po pierwszym zalogowaniu zapisane przepisy są dostępne offline na tym urządzeniu. To celowe zachowanie osobistego przepiśnika — lokalna kopia nie jest szyfrowana osobnym hasłem. Wygasła sesja nie usuwa niewysłanych zmian: ekran logowania umożliwia ponowne zalogowanie bez utraty danych. Hasło nie jest zapisywane w IndexedDB ani w pamięci podręcznej service workera.

Więcej → Wyloguj się unieważnia sesję i usuwa lokalną kopię przepisów, także z pozostałych otwartych kart tego samego profilu i adresu. Jeśli są niewysłane zmiany, aplikacja ostrzega i pozwala pobrać JSON przed potwierdzeniem. Wylogowanie wymaga połączenia z serwerem, aby zakończyć sesję; dane na serwerze pozostają. Na współdzielonym urządzeniu wyloguj się po użyciu.

Bez obu zmiennych aplikacja działa bez logowania. To jedna wspólna kolekcja, bez oddzielnych kont użytkowników.

## Informacje i kolor kawy

Każda kawa ma nazwę, opis, stały akcent z palety (`rose`, `lime`, `sky`, `honey`, `lavender`) oraz opcjonalne pola: palarnia (`roaster`), kraj (`country`), region (`region`), odmiana (`variety`), obróbka (`process`), stopień palenia (`roast`) i nuty smakowe (`tasting_notes`). Pola informacyjne są tekstami do 300 znaków. Nieznane wartości pozostają puste.

Kolor wybiera się podczas dodawania lub edycji kawy. Jest zapisywany przy kawie i synchronizowany między urządzeniami; sortowanie, filtrowanie oraz zmiana nazwy nie wpływają na niego. Istniejące kawy przy pierwszym uruchomieniu nowej wersji otrzymują stały kolor z migracji. Ich przepisy pozostają zachowane. Wcześniejsze lokalne zmiany są migrowane bez nadpisywania danych z drugiego urządzenia; ewentualny konflikt nadal wymaga porównania kopii.

Dane o kawie można rozwinąć pod jej nagłówkiem w sekcji „O kawie”. Palarnia i kraj pojawiają się też na karcie głównej, gdy są podane.

## Import JSON / Markdown i współpraca z AI

Na dole wybierz **Import**. Wklej tekst albo wybierz `.json` / `.md`. Sprawdź podgląd i zatwierdź dodanie. Otwierając import wewnątrz kawy, możesz użyć skróconego JSON `{"recipes": [...]}` lub Markdown zaczynającego się od `## Przepis: 500 ml`.

- Pełny przykład JSON: [examples/parallel-12.json](examples/parallel-12.json).
- Ten sam przepis jako zwykły Markdown: [examples/parallel-12.md](examples/parallel-12.md).
- Gotowy dopisek do wiadomości dla agenta AI: [static/ai-instructions.md](static/ai-instructions.md). Dostępny także w aplikacji pod przyciskiem „Instrukcja dla AI”, z kopiowaniem jednym kliknięciem.

Import dopasowuje kawy po nazwie bez rozróżniania wielkości liter. Dodaje nowe kawy i warianty, pomija identyczne przepisy i uzupełnia puste informacje oraz brakujący opis. Nie nadpisuje istniejących wartości ani wybranego koloru. Import obejmujący tylko informacje o kawie również ma podgląd i może być zatwierdzony. Starsze pliki bez nowych pól nadal są obsługiwane (domyślnie kolor `rose` i puste informacje). Suma zalań musi odpowiadać ilości wody, a parametry liczbowe są sprawdzane przed dodaniem. W Markdown przed pierwszym przepisem można podać `Kolor:`, `Palarnia:`, `Kraj:`, `Region:`, `Odmiana:`, `Obróbka:`, `Palenie:` i `Nuty smakowe:`. Surowy Markdown ma ustalony format opisany w instrukcji; obsługiwany jest też Markdown z blokiem `json`.

Więcej → Pobierz kopię JSON eksportuje bieżącą kolekcję, także ze zmianami niewysłanymi na serwer. Plik można później zaimportować do tej samej lub nowej instalacji.

## Kopie zapasowe

Włącz w Coolify kopię trwałego wolumenu. Przy ręcznym kopiowaniu pliku bazy zatrzymaj usługę na czas kopiowania albo użyj mechanizmu SQLite backup. Nie uruchamiaj `docker compose down -v`, jeśli chcesz zachować przepisy — opcja `-v` usuwa wolumen. Uruchamiaj jedną instancję usługi na jednym wolumenie.

## Sprawdzenie

```sh
python3 -m unittest discover -s tests -v
node --test tests/*.test.mjs
```

Node służy wyłącznie do testów importera; aplikacja i obraz Dockera go nie wymagają.

Backend korzysta wyłącznie z biblioteki standardowej Pythona, frontend z HTML, CSS i JavaScript, a trwałe dane z SQLite.

Czcionka [Barlow Condensed](https://github.com/google/fonts/tree/main/ofl/barlowcondensed) jest dołączona lokalnie na licencji SIL Open Font License; treść licencji: `static/fonts/OFL.txt`.
