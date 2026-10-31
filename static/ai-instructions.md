Przygotuj dane do importu do aplikacji „Moja kawa”. Zwróć wyłącznie JSON lub Markdown zgodny z poniższym formatem, bez dodatkowego komentarza.

Zasady:
- Kawa jest głównym obiektem. Każda kawa ma tablicę niezależnych przepisów dla różnych objętości lub metod. Dla tej samej kawy używaj jednej nazwy i jednego obiektu; różne porcje oraz metody umieszczaj jako warianty w recipes.
- Przy kawie zapisz podstawowe informacje jako teksty: roaster (palarnia), country (kraj pochodzenia), region, variety (odmiana), process (obróbka), roast (stopień palenia), tasting_notes (nuty smakowe, np. oddzielone przecinkami). Każde pole ma maks. 300 znaków. Jeśli informacji nie podano, użyj "". Nie zgaduj po nazwie kawy ani nie przypisuj jej palarni lub pochodzenia bez danych.
- accent to stały kolor kawy wybrany z listy: rose (różowy), lime (pistacjowy), sky (błękitny), honey (miodowy), lavender (lawendowy). Użyj koloru wskazanego przez użytkownika, a jeśli nie wskazał — rose. Nie podawaj kodu HEX. Kolor nie zależy od kolejności kaw.
- Nie wymyślaj informacji i nie przeliczaj automatycznie przepisu na inne objętości. Dodawaj tylko podane warianty. Gdy brakuje ilości wody, dawki kawy lub temperatury, zapytaj przed przygotowaniem importu.
- Pola volume (woda w g, przybliżenie ml), dose (kawa w g), temperature (°C) są obowiązkowymi liczbami bez jednostek. Zakresy: volume 1–10000, dose 0.1–1000, temperature 1–100.
- grind zawiera pełną nazwę młynka i ustawienie, np. „Timemore C3S · 17 klików od zera”. Zachowaj podaną skalę i punkt odniesienia. Nie zastępuj tego ogólnym „średnio”. Jeśli nie podano ustawienia, użyj pustego tekstu.
- Pozostałe pola tekstowe: method (metoda), dripper, duration (docelowy czas), yield (ilość gotowego naparu), notes (uwagi). Nieznane wartości: "". Nie wyliczaj ilości naparu z wody.
- pours to tablica obiektów {"time":"0:00–0:15","amount":75}. amount oznacza dolewaną wodę, nie sumę. Suma amount musi być równa volume. Końca parzenia nie dodawaj jako zalania; umieść go w duration lub steps. Jeśli brak harmonogramu, pours: [].
- steps to tablica pojedynczych kroków (teksty). Jeśli brak: []. Zachowaj wskazówki istotne dla smaku, pomiń zbędne wstępy.
- name jest wymagane (maks. 120 znaków), description ma maks. 1000 znaków. Parametry tekstowe maks. 300 znaków, notes maks. 10000. Maks. 100 kroków (każdy do 3000 znaków), 50 zalań i 100 przepisów na kawę.
- Nie dodawaj identyfikatorów id, coffee_id, sum zalań ani proporcji: aplikacja oblicza je sama.
- Import dodaje dane. Istniejące kawy łączy po nazwie bez rozróżniania wielkości liter. Uzupełnia brakujący opis i puste informacje o kawie. Istniejących wartości i wybranego koloru nie nadpisuje, a identyczne przepisy pomija. Zmianę już zapisanego koloru lub informacji wykonuje się w edycji kawy. Zachowuj więc dokładną nazwę kawy.

Zalecany JSON:
{
  "version": 2,
  "coffees": [
    {
      "name": "Nazwa kawy",
      "description": "Krótki opis",
      "accent": "rose",
      "roaster": "",
      "country": "",
      "region": "",
      "variety": "",
      "process": "",
      "roast": "",
      "tasting_notes": "",
      "recipes": [
        {
          "volume": 500,
          "dose": 30,
          "temperature": 91,
          "grind": "Timemore C3S · 17 klików od zera",
          "dripper": "Hario V60 02",
          "method": "4:6",
          "duration": "4:00–4:40",
          "yield": "440–450 ml",
          "pours": [
            {"time": "0:00–0:15", "amount": 75},
            {"time": "0:50–1:07", "amount": 125},
            {"time": "1:40–1:55", "amount": 100},
            {"time": "2:30–2:45", "amount": 100},
            {"time": "3:20–3:35", "amount": 100}
          ],
          "steps": ["Przepłucz filtr i rozgrzej dripper.", "Zaparz zgodnie z harmonogramem."],
          "notes": "Uwagi o smaku i technice."
        }
      ]
    }
  ]
}

Gdy użytkownik importuje do już otwartej kawy, dopuszczalne jest {"recipes": [...]} bez name. Aby dodać kawę bez przepisu, użyj recipes: []. Możesz też zwrócić jeden obiekt kawy z name, description i recipes zamiast obiektu coffees.

Alternatywny Markdown (zachowaj dokładnie nazwy pól i poziomy nagłówków; używaj zwykłego tekstu bez pogrubień):

# Kawa: Nazwa kawy
Opis: Krótki opis
Kolor: rose
Palarnia:
Kraj:
Region:
Odmiana:
Obróbka:
Palenie:
Nuty smakowe:

## Przepis: 500 ml
Kawa: 30 g
Temperatura: 91 °C
Mielenie: Timemore C3S · 17 klików od zera
Dripper: Hario V60 02
Metoda: 4:6
Czas: 4:00–4:40
Napar: 440–450 ml

### Zalania
| Czas | Dolej (g) |
| --- | --- |
| 0:00–0:15 | 75 |
| 0:50–1:07 | 125 |
| 1:40–1:55 | 100 |
| 2:30–2:45 | 100 |
| 3:20–3:35 | 100 |

### Przygotowanie
1. Przepłucz filtr i rozgrzej dripper.
2. Zaparz zgodnie z harmonogramem.

### Uwagi
Uwagi o smaku i technice.

Kolejne warianty rozpoczynaj od „## Przepis: N ml”, a kolejne kawy od „# Kawa: Nazwa”. Jeżeli brakuje harmonogramu, pomiń sekcję Zalania. Opis, kolor i informacje o kawie umieszczaj przed pierwszym przepisem. Wartości tych pól zapisz w tej samej linii po dwukropku. Pola z pustą wartością są dozwolone. Bez nagłówka kawy można importować warianty wyłącznie do aktualnie otwartej kawy. Objętości mogą się powtarzać przy różnych metodach.
