#!/bin/sh -e

[ -d build ] || emcmake cmake -B build

cmake --build build
