# MOBRave

## Quick Start

Install the Emscripten SDK from
[emscripten-core/emsdk](https://github.com/emscripten-core/emsdk). We're using
4.0.7 but other versions may work as well.

Build the wasm module
```
./build.sh
```

Install the version you want
```
./install.sh [Debug|Release]
```

Create the SSL cert so you can serve over HTTPS
```
cd certs && ./create_certs.sh
```

Start the webserver
```
python3 server.py
```
