#!/usr/bin/env python3
"""Zostaví index.html (samostatná appka Brain) zo zdrojového HTML Claude artefaktu.

Použitie:  python3 tools/build.py src/brain-artifact.html index.html

Úpravy oproti artefaktu:
- plná HTML hlavička (PWA manifest, ikony, iOS meta, bezpečné okraje),
- načíta config.js, vendor/supabase.js a shim.js (náhrada window.claude),
- fotky cez relatívnu cestu _blob/<id> (obsluhuje sw.js),
- nová sekcia Účet (prihlásenie, synchronizácia, záloha),
- texty, ktoré odkazovali na otvorenie v Claude.
"""
import re, sys, pathlib

src = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
out = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else "index.html")

# Hlavička artefaktu (ak bol stiahnutý zo servera aj s obalom) preč
if src.lstrip().lower().startswith("<!doctype"):
    src = src[src.index("<body>") + len("<body>"):]
    src = src[: src.rindex("</body>")]
src = re.sub(r"<title>.*?</title>\s*", "", src, count=1, flags=re.S)
src = re.sub(r'<meta name="claude:[^"]*"[^>]*>\s*', "", src)

def rep(old, new, count=1, required=True):
    global src
    n = src.count(old)
    if required and n < 1:
        sys.exit(f"Chýba úsek na úpravu: {old[:70]!r}")
    src = src.replace(old, new) if count == 0 else src.replace(old, new, count)

# Fotky
rep("/_blob/", "_blob/", count=0)

# Sekcia Účet
rep('["mapa","Mapa"]];', '["mapa","Mapa"],["ucet","Účet"]];')
rep("const ICONS = {", "const ICONS = {\n  ucet:'<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\"><circle cx=\"12\" cy=\"8\" r=\"4\"/><path d=\"M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6\"/></svg>',")
rep('  else if(S.view==="mapa") { stopGraph();',
    '  else if(S.view==="ucet") { m.innerHTML=window.brainAccount?brainAccount.html():""; if(window.brainAccount) brainAccount.bind(m); }\n  else if(S.view==="mapa") { stopGraph();')

# Texty
TXT = [
    ("Úložisko nie je v tomto zobrazení dostupné. Otvor stránku v Claude prihlásený ako jej vlastník.",
     "Úložisko nie je dostupné. Skontroluj pripojenie alebo sa prihlás (sekcia Účet)."),
    ("Prílohy sa dajú ukladať len vlastníkovi stránky v Claude.", "Prílohy sa nedajú uložiť – nie si prihlásený."),
    ("AI triedenie je dostupné po otvorení stránky v Claude. Ukladať môžeš aj bez neho.",
     "AI triedenie je zatiaľ v Claude (napíš „Brain: …“). Tu sa zápis uloží priamo."),
    ("Čítanie bločkov cez AI funguje po otvorení stránky v Claude. Vyplň údaje ručne.",
     "Čítanie bločkov cez AI je zatiaľ v Claude. Vyplň údaje ručne."),
    ("Otázky sú dostupné po otvorení stránky v Claude.",
     "Otázky nad záznamami zatiaľ kladieš v Claude (projekt SECOND BRAIN)."),
    ("Čítanie diára cez AI funguje po otvorení stránky v Claude.", "Čítanie diára cez AI je zatiaľ v Claude."),
    ('{app:"druhy-mozog",', '{app:"brain",'),
    ("druhy-mozog-zaloha-", "brain-zaznamy-"),
    ("Súbor nie je platná záloha Druhého mozgu (JSON).", "Súbor nie je platná záloha Brain (JSON)."),
]
for a, b in TXT:
    rep(a, b, count=0, required=False)
# zvyšné zmienky
rep("funguje po otvorení stránky v Claude", "funguje zatiaľ len v Claude verzii", count=0, required=False)
rep("sú dostupné po otvorení stránky v Claude", "sú zatiaľ dostupné len v Claude verzii", count=0, required=False)
rep("je dostupné po otvorení stránky v Claude", "je zatiaľ dostupné len v Claude verzii", count=0, required=False)
rep("po otvorení stránky v Claude", "v Claude verzii", count=0, required=False)

HEAD = """<!doctype html>
<html lang="sk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Brain</title>
<meta name="description" content="Marekov osobný Brain">
<meta name="theme-color" content="#04070c">
<meta name="color-scheme" content="dark">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Brain">
<meta name="robots" content="noindex,nofollow">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" type="image/png" href="icons/icon-192.png">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<style>:root{box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);background:#04070c}html{scroll-padding-top:env(safe-area-inset-top,0px)}body{margin:0;padding:0}img{max-width:100%}[hidden]:not([hidden=until-found i]){display:none!important}</style>
<script src="config.js"></script>
<script src="vendor/supabase.js"></script>
<script src="shim.js"></script>
</head>
<body>
"""
out.write_text(HEAD + src.strip() + "\n</body>\n</html>\n", encoding="utf-8")
print(f"OK → {out} ({out.stat().st_size // 1024} kB)")
