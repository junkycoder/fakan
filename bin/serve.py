#!/usr/bin/env python3
# Lokální dev server — http.server + SPA fallback.
#
# Pro browser navigaci (Accept: text/html) na neexistující path nebo na soubor
# který není .html ve stromě (např. /about/zaruka.md, /projects/foo) servíruje
# index.html, takže SPA loader chytí pathname a otevře odpovídající panel.
# Pro fetch z aplikace (Accept: */*) servíruje normálně (tree.json, *.js, .md
# raw atd.) — stejná logika jako functions/_middleware.js v produkci.
#
# Spuštění: python3 bin/serve.py [PORT]  (default 5173, env PORT prioritně)

import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class SpaHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        accept = self.headers.get('Accept', '') or ''
        is_html_nav = 'text/html' in accept

        if is_html_nav and self.path not in ('/', '/index.html'):
            # SPA fallback — frontend si z location.pathname vytáhne stav
            self.path = '/index.html'
        return super().do_GET()

    def log_message(self, fmt, *args):  # noqa: A003
        # tišší log: jen status code + path, bez stack timestampu
        sys.stderr.write(f"{self.command} {self.path} {args[1] if len(args) > 1 else ''}\n")


def main():
    port_env = os.environ.get('PORT')
    port = int(port_env) if port_env else int(sys.argv[1]) if len(sys.argv) > 1 else 5173
    server = ThreadingHTTPServer(('0.0.0.0', port), SpaHandler)
    print(f'fakan dev server → http://localhost:{port}')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()


if __name__ == '__main__':
    main()
