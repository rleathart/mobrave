#!/bin/sh

BUILD_TYPE=${1:-Debug}

ln -sf ../build/$BUILD_TYPE/executor.js ./website
ln -sf ../build/$BUILD_TYPE/executor.aw.js ./website
ln -sf ../build/$BUILD_TYPE/executor.ww.js ./website
ln -sf ../build/$BUILD_TYPE/executor.wasm ./website
