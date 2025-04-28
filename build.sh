#!/bin/sh -e

[ -d build ] || emcmake cmake -B build -G "Ninja Multi-Config"

cmake --build build
