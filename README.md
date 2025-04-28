# MOBRave

## Quick Start

Install the Emscripten SDK from
[emscripten-core/emsdk](https://github.com/emscripten-core/emsdk). We're using
4.0.7 but other versions may work as well.

Fetch the version of the RNBO runtime you want to serve (we have to host the
file locally because of CORS).
```
curl https://js.cdn.cycling74.com/rnbo/1.3.3/rnbo.min.js -o website/rnbo.min.js
```

Place your exported RNBO patch in the website directory
```
cp /path/to/export/patch.export.json website/patch.export.json
```

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
