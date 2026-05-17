---
title: Záruka
slug: zaruka
---

# Záruka

Než si u nás cokoli pronajmete, vědět tohle:

## Co je vaše

- **Doména** zůstává vaše. Pokud si ji u nás koupíte, máte DNS přístup. Když odejdete nebo my zanikneme, převedeme vám ji bez podmínek.
- **Obsah** zůstává váš. Vždy jsou to `.md` soubory ve vašem repu nebo vaší složce. My v databázi neukládáme nic, co byste si nemohli stáhnout.
- **E-mail** je váš. Forwarding na Cloudflare Email Routing — můžete si ho nastavit i sami, bez nás.

## Co děláme my

- Hostujeme „přehrávač" — kód, který kreslí mindmapu, routuje subdomény, řeší TLS.
- Backupy obsahu jednou denně do našeho úložiště (Cloudflare R2). Pro Hosted plán a GitHub / upload zdroje. Lokální složku v prohlížeči zálohovat neumíme — to byste museli sami.
- Provoz, monitoring, podporu na e-mailu.

## Co když fakan zanikne

- Ohlásíme to **90 dní předem**.
- Worker kód je [open source pod AGPL-3.0](https://github.com/junkycoder/fakan). Dohostíte si ho sami, nebo si vezmete náš template a přejdete jinam.
- Doménu vám převedeme. Obsah už máte ve svém gitu nebo složce.
- Backupy z R2 si stáhnete jako `.tar.gz` na jedno kliknutí.

## Žádný vendor lock-in

Vaše data nikdy nejsou v naší proprietární databázi. Jsou ve vaší složce, ve vašem gitu. My jen servírujeme HTML.

Pokud tohle zní rozumně, klikněte v rohu na **Chci tohle taky**.
