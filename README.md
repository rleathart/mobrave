# MOBRave

## Quick Start

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
cd certs && ./create_certs.sh`
```

Start the webserver
```
python3 server.py
```
