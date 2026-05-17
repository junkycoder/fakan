---
name: fok
description: Rychlý záznam časového údaje („už budu", „jsem tam", apod.) do souboru FOK.md. Použij, když uživatel napíše /fok <zpráva> nebo zprávu ve stylu „fok už budu".
---

# /fok

Spec je v [FOK.md](../../../FOK.md). Cíl: rychlý časový záznam ve formátu

```
2026
05
16:20 už budu
```

…tj. rok, měsíc, čas + krátký vzkaz na nový řádek.

## Postup (TODO doimplementovat)

1. Z `date` vezmi aktuální rok, měsíc, čas (HH:MM v lokální TZ).
2. Pokud aktuální `FOK.md` ještě obsahuje původní instrukční text, **přepiš ho** podle pokynu v souboru („nauč se skill a pak tento soubor přepiš na uvedené výše").
3. Append nový záznam tak, aby:
   - rok se opakoval jen když se změnil
   - měsíc se opakoval jen když se změnil
   - jinak jen `HH:MM zpráva`
4. Žádné commit / push, jen úprava souboru.

## TODO

- [ ] Vyřešit grupování po rocích / měsících (algoritmus pro append)
- [ ] Default zpráva, když uživatel napíše jen `/fok` bez textu
- [ ] Volitelně: zpětný `--list` / `--last`
