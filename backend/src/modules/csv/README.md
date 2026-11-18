# csv

Pure functions that turn a source record into a CSV line using a customer's spec. No database, no files.

- `headerLine(spec)` – column headers (custom names or field names).
- `recordLine(record, spec)` – one row: value maps applied, dates formatted in the config timezone.
- `escapeCsvValue(value)` – RFC 4180 quoting, plus **formula-injection protection**: values that start with
  `=`, `+`, `-`, `@`, tab or carriage return get a leading `'` so Excel / Sheets show them as text.
  Plain negative numbers such as `-12.5` and a lone `-` are not escaped.

Date formats: `ISO_UTC` (default), `ISO_LOCAL`, `yyyy-MM-dd HH:mm:ss`, `dd-MM-yyyy HH:mm:ss`, `dd-MM-yyyy`.

To add a new output format (for example JSON Lines), add a sibling module with the same two functions
(`header`, `line`) and let the worker pick it from `spec.format`.
