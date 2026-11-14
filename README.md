# Best in Town — Web-App (PWA)

Statische Auslieferung der Web-App. Diese Dateien werden aus dem Hauptprojekt
(`best-in-town`) erzeugt und hier veröffentlicht, damit die App im Browser und
als Homescreen-App auf iPhone und Android läuft.

- `index.html` — die App
- `manifest.webmanifest` — Name, Farben, Icons, Standalone-Modus
- `icon-*.png` — Icons für Homescreen und Installationsdialog

Daten und Anmeldung liegen in Supabase; hier steht nur der öffentliche Schlüssel,
der in jedem Browser ohnehin sichtbar ist.
