# MOBRave

## Quick Start

Install the Emscripten SDK from
[emscripten-core/emsdk](https://github.com/emscripten-core/emsdk). We're using
4.0.7 but other versions may work as well. Once that's done don't forget to
```
/path/to/emsdk/emsdk activate latest
source /path/to/emsdk/emsdk_env.sh
```

Fetch the version of the RNBO runtime you want to serve (we have to host the
file locally because of CORS).
```
curl https://js.cdn.cycling74.com/rnbo/1.3.3/rnbo.min.js -o website/rnbo.min.js
```

Fetch dependencies:
```
curl https://raw.githubusercontent.com/jazz-soft/JZZ/refs/heads/master/javascript/JZZ.js -o website/JZZ.js
curl https://raw.githubusercontent.com/jazz-soft/JZZ-midi-SMF/refs/heads/master/javascript/JZZ.midi.SMF.js -o website/JZZ.midi.SMF.js
```

Fetch the `crave` weights files:
```
curl https://github.com/lucaayscough/crave/releases/download/weights/v1_test_weights.bin -o website/v1_test_weights.bin
curl https://github.com/lucaayscough/crave/releases/download/weights/v2_test_weights.bin -o website/v2_test_weights.bin
```

Place your exported RNBO patch in the website export directory
```
mkdir -p website/export
cp /path/to/export/patch.export.json website/export/patch.export.json
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
