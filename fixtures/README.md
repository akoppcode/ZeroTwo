# fixtures

Committed test fixtures for Zero Two.

- `sample.pbip/` — a minimal **PBIR (enhanced) format** PBIP: 2 pages
  (Overview visible, Details hidden), 6 visuals (cards, a column chart, a
  slicer, a table), and a small TMDL semantic model (Sales + Date, one
  measure). Drives the ProjectService inspection tests (page/visual inventory,
  PBIR detection).
- `legacy-sample.pbip/` — a **PBIR-legacy** PBIP (monolithic `report.json`, no
  `definition/` folder). Drives the attach-rejection test.
- `mock-bin/` — env-driven fake CLIs (see its README).

> NOTE: `sample.pbip` and `legacy-sample.pbip` are hand-authored to the PBIR
> schema shape. Per spec §14 they should be **regenerated from a real Power BI
> Desktop** ("Save as .pbip" of a blank + a small report) before relying on the
> `powerbi-report-author validate` acceptance — that check is a Windows manual-
> verification item until the real fixtures land. Inspection/inventory logic is
> fully unit-tested against these committed shapes.
