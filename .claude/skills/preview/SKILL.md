---
name: preview
description: Spustit / reloadnout / screenshotovat lokální preview fakan.cz na portu 5173. Použij, když uživatel řekne /preview, chce vidět aktuální stav webu, nebo když po editaci souborů potřebuješ ověřit změnu v prohlížeči.
---

# /preview

Preview server je definovaný v [.claude/launch.json](../../launch.json) — `python3 -m http.server 5173`.

## Postup

1. Pokud Claude Preview MCP ještě neběží, spusť `preview_start name="fakan"`.
2. Po editaci HTML/CSS/JS vyvolej reload: `preview_eval expression="location.reload()"`.
3. Pro vizuální ověření použij `preview_screenshot`. Pro přesné hodnoty (barvy, rozměry, fonty) preferuj `preview_inspect` se seznamem CSS properties — screenshoty jsou JPEG s kompresí, lžou na hairlinech a barvách.

## TODO

- [ ] Doplnit konkrétní příkazy pro běžné situace (např. „ověř, že chrome je na úvodu schované")
- [ ] Připojit `preview_console_logs` + `preview_network` checklist pro debugging
