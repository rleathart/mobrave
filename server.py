#!/usr/bin/env python3

import ssl;
import argparse
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

def should_send_cors_headers(req_headers):
    if args.debug:
        return req_headers['Sec-Fetch-Mode'] != 'no-cors';

    return True

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory='./website', **kwargs)

class CORSServer(Handler):
    def end_headers(self):
        self.send_header("Accept-Ranges", "bytes")

        if 'executor' in self.path:
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")

        if should_send_cors_headers(self.headers):
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
            self.send_header("Cross-Origin-Resource-Policy", "same-origin")

        super().end_headers()

if __name__ == "__main__":

    parser = argparse.ArgumentParser();
    parser.add_argument('--debug', action='store_true')
    args = parser.parse_args();

    port = 8080
    server_address = ("", port)  # Serve on all available interfaces
    httpd = ThreadingHTTPServer(server_address, CORSServer)

    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certfile="certs/server.crt", keyfile="certs/server.key")
    httpd.socket = context.wrap_socket(httpd.socket, server_side=True)

    print(f"Serving on port {port}...")
    httpd.serve_forever()
