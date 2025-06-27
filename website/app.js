// NOTE(robin): Just a handy little object to store all of our various pieces of global state
let app = {
  audioContext: null,

  // C++
  mobrave: null,
  mobravePromise: null, // NOTE(robin): used to `await` mobrave being ready
  weightsUrl: '/v1_test_weights.bin',
  weightsData: null,
  weightsBuffer: null,

  currentLatents: [], // NOTE(robin): used to communicate the current RNBO latents to C++

  // RNBO
  patcherUrl: '/patch.export.json',
  patcherData: null,
  patcherJson: null,
  device: null,

  isSensorSetupComplete: false,

  lastAccel: { x: 0.0, y: 0.0, z: 0.0 }, // NOTE(robin): used when computing the step count

  // NOTE(robin): Stores the latest sensor data
  sensors: {
    accel: {x: undefined, y: undefined, z: undefined},
    rotation: {x: undefined, y: undefined, z: undefined},
    heading: undefined,
    stepCount: 0,
  },

  // NOTE(robin): Stores the optional RNBO parameter objects
  params: {
    accel: {x: null, y: null, z: null},
    rotation: {x: null, y: null, z: null},
    heading: null,
    stepCount: null,
  },
};

// NOTE(robin): The initialisation process for the web page is actually a bit of a ball ache so I'll
// do my best to explain it here.
//
// We have a couple of things that need to be initialised:
//   1) The actual MOBRave WASM module instance
//   2) The mobrave C++ backed AudioWorketNode
//   3) The RNBO device
//
// Usually for 1) we would just do something like `await MOBRave()` when the page loads. The trouble
// is that there are other parts of the code that depend on 1) being loaded so instead we create a
// promise that gives us a mechanism to wait for the WASM module to actually be finished loading.
// For example, when we're setting up the RNBO device (3) we need to connect the RNBO latents to the
// mobrave C++ latents. Of course, in order to do this we need to be sure that the mobrave instance
// is valid when we try to connect the two together. This is where the mobrave promise comes in, we
// just await the promise after setting up the RNBO device and then that will make sure we execute
// the code for connecting the latents once the WASM instance has been loaded.
//
// Ok, now onto the wonkier stuff.
//
// The main problem we have is that both 2) and 3) require an existing audio context in order to be
// initialised. The C++ code needs an audio context to pass to `createWasmAudioThread` and RNBO
// needs an audio context to pass to `RNBO.createDevice`. Now, this wouldn't be a big deal except
// that audio contexts can **only be created in response to user gestures**. This in itself wouldn't
// be a problem but what's a real kick in the teeth is that Safari will silently give you a broken
// audio context if you don't return from the user gesture initiated code quickly enough! This means
// we can't actually `await` anything during the user gesture that sets up the audio context.
//
// What we end up having to do because of this is performing only the most minimal setup of the
// audio context and 2) during the actual user gesture and then we defer the creation of the RNBO
// device to a later time using setTimeout.

async function main() {
  setupConsole();

  app.mobravePromise = loadWasmModuleAsync(MOBRave).then(mobrave => {
    console.log(`Finished loading MOBRave WASM instance: ${mobrave}`);
    app.mobrave = mobrave;
  });

  setupPlayButton('playButton', toggleAudio);
  setupMetrics();

  console.log('Fetching RNBO patch data...');
  // app.patcherData = await fetch(app.patcherUrl);
  // app.patcherJson = await app.patcherData.json();
  app.patcherJson = track(fetch(app.patcherUrl).then(response => response.json()));
  console.log('Fetching RNBO patch data... Done');

  console.log('Fetching Model weights...');
  app.weightsData = await fetch(app.weightsUrl);
  app.weightsBuffer = await app.weightsData.arrayBuffer();
  console.log('Fetching Model weights... Done');

  await app.mobravePromise;
  console.log('Loading Model Weights...');
  app.mobrave.setCurrentModel(app.weightsBuffer);
  console.log('Loading Model Weights... Done');
}

// ================================================================================

function loadWasmModuleAsync(module) {
  console.log(`Loading WASM module...`);
  let instance = module();
  return instance;
}

function setupPlayButton(id, toggleAudio) {
  let button = document.getElementById(id)
  if (button) {
    button.addEventListener('click', () => toggleAudio(button));
  } else {
    console.error(`Couldn't find play button element with id: ${id}`);
  }
}

async function setupRNBODevice() {
  let patcherJson = await app.patcherJson;

  app.device = await RNBO.createDevice({context: app.audioContext, patcher: patcherJson});
  makeSliders(app.device);

  await app.mobravePromise;
  setupLatentCommunication(app.mobrave, app.device);

  let device = app.device;

  app.params.accel.x = device.parametersById.get('param.accel.x');
  app.params.accel.y = device.parametersById.get('param.accel.y');
  app.params.accel.z = device.parametersById.get('param.accel.z');

  app.params.rotation.x = device.parametersById.get('param.rotation.x');
  app.params.rotation.y = device.parametersById.get('param.rotation.y');
  app.params.rotation.z = device.parametersById.get('param.rotation.z');

  app.params.stepCount = device.parametersById.get('param.stepCount');
  app.params.heading = device.parametersById.get('param.heading');
}

function setupLatentCommunication(mobrave, device) {
  device.messageEvent.subscribe((ev) => {
    if (ev.tag === "latents_out") {
      app.currentLatents = ev.payload;
    }
  });

  let updateLatents = function(data, count) {
    let f32data = new Float32Array(mobrave.HEAPF32.buffer, data, count);

    // NOTE(robin): send latents to RNBO
    let latents = Array.from(f32data);
    if (device) {
      let e = new RNBO.MessageEvent(RNBO.TimeNow, "latents_in", latents);
      device.scheduleEvent(e);
    }

    // NOTE(robin): update the latents with the most recent values we got from RNBO
    for (let i = 0; i < app.currentLatents.length; i++) {
      if (i < count)
        f32data[i] = app.currentLatents[i];
    }
  };

  mobrave.setLatentsCallback(updateLatents);
}

// ================================================================================

// IMPORTANT(robin): Safari may revoke its gesture context and cause the audio
// context to be in a broken state if we don't return quickly from this
// function. You should do only the very bare minimum of work in this function and use
// something like setTimeout to defer more expensive operations to a later date.
function onAudioContextCreated(audioContext) {
  let cppContext = app.mobrave.emscriptenRegisterAudioObject(audioContext);
  app.mobrave.createWasmAudioThread(cppContext);

  setTimeout(setupRNBODevice, 0);
}

// NOTE(robin): Called from C++ land just after the wasm audio worklet node is created.
function onProcessorCreated() {
  console.log(`onProcessorCreated: audioContext.state: ${app.audioContext.state}`);
  console.log(`mobraveWorklet: ${app.audioContext.mobraveWorklet}`);

  app.audioContext.mobraveWorklet.connect(app.device.node);
  app.device.node.connect(app.audioContext.destination);
}

function createAudioContext() {
  let context = new (window.AudioContext || window.webkitAudioContext)();
  return context;
}

async function toggleAudio(playButton) {

  // IMPORTANT(robin): Safari is very picky about the initialisation of audio contexts:
  //   1. The audio context MUST be created in response to a user gesture.
  //   2. You must not take too long to create the audio context after the user
  //   gesture. This means no `await`-ing before the context has been created.
  //   3. You must return quickly from the user gesture callback. This typically means no
  //   `await`-ing after the audio context creation either!

  if (!app.audioContext) {
    app.audioContext = createAudioContext();

    if (!app.audioContext) {
      let message = `Critical error: Couldn't initialise an AudioContext instance. Perhaps there is an issue with your audio device?`;
      console.error(message);
      alert(message);
    }

    app.audioContext.suspend().catch(console.error);

    onAudioContextCreated(app.audioContext);
  }

  if (!app.isSensorSetupComplete) {
    setupSensors();
    app.isSensorSetupComplete = true;
  }

  if (app.audioContext.state === "suspended") {
    app.audioContext.resume()
      .then(() => playButton.innerHTML = 'Pause')
      .catch(console.error);
  } else {
    app.audioContext.suspend()
      .then(() => playButton.innerHTML = 'Play')
      .catch(console.error);
  }
}

// ================================================================================

function updateDeviceParameter(param, value) {
  if (param) {
    param.value = value;
  }
}

function processStepCounter(accelerationIncludingGravity) {
  let acceleration = accelerationIncludingGravity;
  let delta = Math.abs(acceleration.x - app.lastAccel.x) + Math.abs(acceleration.y - app.lastAccel.y) + Math.abs(acceleration.z - app.lastAccel.z);
  let threshold = 12.0;

  if (delta > threshold) {
    app.sensors.stepCount += 1;
    updateDeviceParameter(app.params.stepCount, app.sensors.stepCount);
  }

  app.lastAccel = { x: acceleration.x, y: acceleration.y, z: acceleration.z};
}

function processAcceleration(acceleration) {
  updateDeviceParameter(app.params.accel.x, acceleration.x);
  updateDeviceParameter(app.params.accel.y, acceleration.y);
  updateDeviceParameter(app.params.accel.z, acceleration.z);

  app.sensors.accel.x = acceleration.x;
  app.sensors.accel.y = acceleration.y;
  app.sensors.accel.z = acceleration.z;
}

function handleDeviceMotion(event) {
  let accel = event.acceleration || event.accelerationIncludingGravity;
  if (accel) {
    processAcceleration(accel)
  }

  let aig = event.accelerationIncludingGravity;
  if (aig) {
    processStepCounter(aig);
  }
}

function handleDeviceOrientation(event) {

  // NOTE(robin): Euler angles to axis:
  // x: beta [-180.0, 180.0]
  // y: gamma [-90.0, 90.0]
  // z: alpha [0.0, 360.0]

  updateDeviceParameter(app.params.rotation.x, event.beta);
  updateDeviceParameter(app.params.rotation.y, event.gamma);
  updateDeviceParameter(app.params.rotation.z, event.alpha);

  app.sensors.rotation.x = event.beta;
  app.sensors.rotation.y = event.gamma;
  app.sensors.rotation.z = event.alpha;
}

function handleGeolocationPosition(position) {
  const coords = position.coords;
  const heading = coords.heading; // In degrees, or null if not available

  app.sensors.heading = heading || undefined;
  updateDeviceParameter(app.params.heading, heading);
}

async function setupSensors() {
  function maybeRequestPermissionFor(event) {
    if (event === undefined)
      return Promise.resolve('denied');

    if (typeof event.requestPermission === 'function') {
      return event.requestPermission();
    }

    return Promise.resolve('granted');
  };

  maybeRequestPermissionFor(window.DeviceMotionEvent).then(access => {
    if (access === 'granted') {
      window.addEventListener('devicemotion', handleDeviceMotion);
    } else {
      console.error('Could not access DeviceMotionEvent');
    }
  });

  maybeRequestPermissionFor(window.DeviceOrientationEvent).then(access => {
    if (access === 'granted') {
      window.addEventListener('deviceorientation', handleDeviceOrientation);
    } else {
      console.error('Could not access DeviceOrientationEvent');
    }
  });

  if ("geolocation" in navigator) {

    let settings = {
      enableHighAccuracy: true,
      maximumAge: 1000,
      timeout: 5000
    };

    navigator.geolocation.watchPosition(handleGeolocationPosition, console.error, settings);

  } else {
    console.error("Geolocation is not supported by this browser.");
  }
}

// ================================================================================

function makeSliders(device) {
  let pdiv = document.getElementById("rnbo-parameter-sliders");
  let noParamLabel = document.getElementById("no-param-label");
  if (noParamLabel && device.numParameters > 0) pdiv.removeChild(noParamLabel);

  // This will allow us to ignore parameter update events while dragging the slider.
  let isDraggingSlider = false;
  let uiElements = {};

  device.parameters.forEach(param => {
    // Subpatchers also have params. If we want to expose top-level
    // params only, the best way to determine if a parameter is top level
    // or not is to exclude parameters with a '/' in them.
    // You can uncomment the following line if you don't want to include subpatcher params

    //if (param.id.includes("/")) return;

    // Create a label, an input slider and a value display
    let label = document.createElement("label");
    let slider = document.createElement("input");
    let text = document.createElement("input");
    let sliderContainer = document.createElement("div");
    sliderContainer.appendChild(label);
    sliderContainer.appendChild(slider);
    sliderContainer.appendChild(text);

    // Add a name for the label
    label.setAttribute("name", param.name);
    label.setAttribute("for", param.name);
    label.setAttribute("class", "param-label");
    label.textContent = `${param.name}: `;

    // Make each slider reflect its parameter
    slider.setAttribute("type", "range");
    slider.setAttribute("class", "param-slider");
    slider.setAttribute("id", param.id);
    slider.setAttribute("name", param.name);
    slider.setAttribute("min", param.min);
    slider.setAttribute("max", param.max);
    if (param.steps > 1) {
      slider.setAttribute("step", (param.max - param.min) / (param.steps - 1));
    } else {
      slider.setAttribute("step", (param.max - param.min) / 1000.0);
    }
    slider.setAttribute("value", param.value);

    // Make a settable text input display for the value
    text.setAttribute("value", param.value.toFixed(1));
    text.setAttribute("type", "text");

    // Make each slider control its parameter
    slider.addEventListener("pointerdown", () => {
      isDraggingSlider = true;
    });
    slider.addEventListener("pointerup", () => {
      isDraggingSlider = false;
      slider.value = param.value;
      text.value = param.value.toFixed(1);
    });
    slider.addEventListener("input", () => {
      let value = Number.parseFloat(slider.value);
      param.value = value;
      console.log(`Parameter ${param.name} changed to ${value}`);
    });

    // Make the text box input control the parameter value as well
    text.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        let newValue = Number.parseFloat(text.value);
        if (isNaN(newValue)) {
          text.value = param.value;
        } else {
          newValue = Math.min(newValue, param.max);
          newValue = Math.max(newValue, param.min);
          text.value = newValue;
          param.value = newValue;

        }
      }
    });

    // Store the slider and text by name so we can access them later
    uiElements[param.id] = { slider, text };

    // Add the slider element
    pdiv.appendChild(sliderContainer);
  });

  // Listen to parameter changes from the device
  device.parameterChangeEvent.subscribe(param => {
      if (!isDraggingSlider)
          uiElements[param.id].slider.value = param.value;
      uiElements[param.id].text.value = param.value.toFixed(1);
  });
}

function setupConsole() {
  let consoleOutput = document.getElementById('console.output');

  let [log, error] = [console.log, console.error];

  function logger(stream, ...args) {
    if (consoleOutput) {
      let maxConsoleLen = 64 * 1024; // 64 KiB limit
      let message = args[0];

      if (consoleOutput.innerHTML.length > maxConsoleLen)
        consoleOutput.innerHTML = "";

      consoleOutput.innerHTML += message + '<br>';
      consoleOutput.scrollTop = consoleOutput.scrollHeight;
    }

    stream.apply(console, args)
  }

  console.log = (...args) => {
    logger(log, ...args)
  };

  console.error = (...args) => {
    logger(error, ...args)
  };
}

function setupMetrics() {
  let metricsTableBody = document.getElementById('metrics.table.tbody');
  let sensorsTableBody = document.getElementById('sensors.table.tbody');

  function createRow(label, value) {
    const tr = document.createElement('tr');

    const tdLabel = document.createElement('td');
    tdLabel.style.textAlign = 'right';
    tdLabel.textContent = label;

    const tdValue = document.createElement('td');
    tdValue.textContent = value;

    tr.appendChild(tdLabel);
    tr.appendChild(tdValue);

    return tr;
  }

  function updateMetrics() {
    metricsTableBody.textContent = '';
    sensorsTableBody.textContent = '';

    const metrics = app.mobrave ? app.mobrave.getMetrics() : {};

    metricsTableBody.appendChild(
      createRow('audioContext.state', app.audioContext?.state ?? 'unknown')
    );

    // metrics
    for (const field in metrics) {
      const value = Number(metrics[field]).toFixed(2);
      metricsTableBody.appendChild(createRow(field, value));
    }

    // sensor values
    for (const field in app.sensors) {
      const sensor = app.sensors[field];

      if (typeof sensor === 'object') {
        // NOTE(robin): a bit fucked but whatever
        for (const subfield in sensor) {
          const value = Number(sensor[subfield]).toFixed(2);
          sensorsTableBody.appendChild(
            createRow(`${field}.${subfield}`, value)
          );
        }
      } else {
        const value =
          sensor !== undefined ? Number(sensor).toFixed(2) : 'null';
        sensorsTableBody.appendChild(createRow(field, value));
      }
    }
  }

  let metricUpdateIntervalMs = 33;
  setInterval(updateMetrics, metricUpdateIntervalMs);
}

class TrackedPromise {
    constructor() {
        this.state = "pending";
        this.result = undefined;
        this.error = undefined;

        this.promise = new Promise((res, rej) => {
            this._resolve = (value) => {
                this.state = "resolved";
                this.result = value;
                res(value);
            };
            this._reject = (err) => {
                this.state = "rejected";
                this.error = err;
                rej(err);
            };
        });
    }

    resolve(value) {
        this._resolve(value);
    }

    reject(error) {
        this._reject(error);
    }

    then(onFulfilled, onRejected) {
        return this.promise.then(onFulfilled, onRejected);
    }

    catch(onRejected) {
        return this.promise.catch(onRejected);
    }

    finally(onFinally) {
        return this.promise.finally(onFinally);
    }
};

function track(nativePromise) {
  const tracked = new TrackedPromise();

  nativePromise
    .then(value => {
      tracked.resolve(value);
      return value;
    })
    .catch(err => {
      tracked.reject(err);
      throw err;
    });

  return tracked;
}

main();
