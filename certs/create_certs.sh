#!/bin/sh -e

openssl req -x509 -newkey rsa:2048 -nodes -keyout server.key -out server.crt -days 365
