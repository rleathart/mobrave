#!/usr/bin/env python3

import ssl;
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory='./website', **kwargs)

class CORSServer(Handler):
    def end_headers(self):
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Access-Control-Allow-Origin", "*")
        if not self.headers['Sec-Fetch-Mode'] == 'no-cors':
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
            self.send_header("Cross-Origin-Resource-Policy", "same-origin")

        super().end_headers()

if __name__ == "__main__":
    port = 8080
    server_address = ("", port)  # Serve on all available interfaces
    httpd = ThreadingHTTPServer(server_address, CORSServer)

    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certfile="certs/server.crt", keyfile="certs/server.key")
    httpd.socket = context.wrap_socket(httpd.socket, server_side=True)

    print(f"Serving on port {port}...")
    httpd.serve_forever()
