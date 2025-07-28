import {TrackedPromise, track} from './TrackedPromise.js'
import {MIDIPlayer} from './midi.js'
import * as sensors from './sensors/index.js'
import * as wakelock from './wakelock.js'

// NOTE(robin): Just a handy little object to store all of our various pieces of global state
let app = {
  audioContext: null,
  audioWorklet: null,

  midiPlayer: null,

  // C++
  mobrave: null,
  weightsUrl: '/models/cello-v2-var1_e9d35023c2_streaming.bin',
  weightsBuffer: null,

  currentLatents: [], // NOTE(robin): used to communicate the current RNBO latents to C++

  // RNBO
  patcherUrl: '/export/patch.export.json',
  patcherJson: null,
  dependenciesUrl: '/export/dependencies.json',
  dependencies: null,
  midiManifestUrl: '/export/midiManifest.json',
  midiManifest: null,
  device: null,

  // NOTE(robin): enable or disable certain sensors or other features here
  features: {
    stepCounter: true,
    accelerometer: true,
    orientation: true,
    geolocation: true,
  },

  stepCounter: null,

  isSensorSetupComplete: false,

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
    cRaveEnable: null,
  },
};

async function main() {

  app.audioContext = new TrackedPromise();
  app.audioWorklet = new TrackedPromise();
  app.device = new TrackedPromise();
  app.midiPlayer = new TrackedPromise();

  setupConsole();
  setupMetrics();

  setupButtonClickHandler('playButton', toggleAudio);
  setupButtonClickHandler('enableSensorsButton', enableSensors);
  setupButtonClickHandler('enableWakeLockButton', enableWakeLock);

  // NOTE(robin): Hide the MIDI section until setup is complete
  document.getElementById('midiSection').style.display = 'none';

  setupEventHandler('midiPlayButton', 'click', toggleMidi);
  setupEventHandler('midiForm', 'submit', onMidiFormSubmitted);

  // NOTE(robin): hide the debug UI by default
  document.getElementById('debug-view').style.display = 'none';
  ui.onSettingsClicked = () => {
    const debugView = document.getElementById('debug-view');
    if (debugView) {
      if (debugView.style.display === 'none') {
        debugView.style.display = 'initial';
      } else {
        debugView.style.display = 'none';
      }
    }
  };

  // NOTE(robin): kick off some of the async initialisation/fetching

  app.mobrave = track(loadWasmModuleAsync(MOBRave));
  app.patcherJson = track(fetch(app.patcherUrl).then(response => response.json()));
  app.weightsBuffer = track(trackedFetch(onWeightsProgress, app.weightsUrl).then(response => response.arrayBuffer()));
  app.dependencies = track(fetch(app.dependenciesUrl).then(response => response.json()));
  app.midiManifest = track(fetch(app.midiManifestUrl).then(response => response.json()).then(fixupMidiManifest));

  // ================================================================================
  // NOTE(robin): now wait until everything we need is initialised and then setup all the
  // RNBO/MOBRave stuff.

  let [audioContext, audioWorklet, mobrave, patcherJson, dependencies, weightsBuffer] = await Promise.all([
    app.audioContext, app.audioWorklet, app.mobrave, app.patcherJson, app.dependencies, app.weightsBuffer
  ]);

  mobrave.setCurrentModel(weightsBuffer);

  let device = await RNBO.createDevice({context: audioContext, patcher: patcherJson});
  app.device.resolve(device);

  // NOTE(robin): Do any event handler setup immediately here before awaiting
  // anything else. This is because if we give something else an opportunity to
  // run before our event handlers are registered, it could result in RNBO
  // loadbangs firing before we've actually conected our handlers.

  try {
    const midiPlayer = setupMidiPlayer(device);
    midiPlayer.onPlayingChanged = updateMidiPlayButtonState;
    app.midiPlayer.resolve(midiPlayer);
    isMidiEnabled = true;
  } catch (e) {
  }

  setupLatentCommunication(mobrave, device);
  setupDeviceParameters(device);
  setupDeviceListeners(device);

  await loadDependencies(device, dependencies).catch(e => {
    console.error(`Error loading RNBO dependencies: ${e.name}: ${e.message}`);
  });

  makeSliders(device);
  makePresetSelector(device, patcherJson);

  audioWorklet.connect(device.node);
  device.node.connect(audioContext.destination);

  document.getElementById('midiSection').style.display = 'initial';

  updateCraveStatus();
}

// ================================================================================

function onWeightsProgress(progress) {
  if (ui !== undefined)
    ui.weightsDownloadProgress = progress;
}

function loadWasmModuleAsync(module) {
  console.log(`Loading WASM module...`);
  let instance = module().catch(e => {
    console.log(`Error loading WASM module: ${e.name}: ${e.message}`);
    throw e;
  });
  return instance;
}

function setupEventHandler(id, event, handler) {
  const element = document.getElementById(id);
  if (element) {
    element.addEventListener(event, (...args) => handler(element, ...args));
  } else {
    console.error(`Couldn't find element with id: ${id}`);
  }
}

function setupButtonClickHandler(id, handler) {
  let button = document.getElementById(id)
  if (button) {
    button.addEventListener('click', () => handler(button));
  } else {
    console.error(`Couldn't find element with id: ${id}`);
  }
}

function loadDependencies(device, dependencies) {
  // Prepend "export" to any file dependencies
  const exports = dependencies.map(d => d.file ? {...d, file: `export/${d.file}`} : d);
  return device.loadDataBufferDependencies(exports);
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

function resetParameters() {

  if (app.stepCounter) {
    app.stepCounter.reset();
  }

  if (app.device.resolved()) {
    const device = app.device.result;
    device.parameters.forEach((param, index) => {
      param.value = param.initialValue;
    });
  }
}

function setupDeviceParameters(device) {
  app.params.accel.x = device.parametersById.get('param.accel.x');
  app.params.accel.y = device.parametersById.get('param.accel.y');
  app.params.accel.z = device.parametersById.get('param.accel.z');

  app.params.rotation.x = device.parametersById.get('param.rotation.x');
  app.params.rotation.y = device.parametersById.get('param.rotation.y');
  app.params.rotation.z = device.parametersById.get('param.rotation.z');

  app.params.stepCount = device.parametersById.get('param.stepCount');
  app.params.heading = device.parametersById.get('param.heading');

  app.params.cRaveEnable = device.parametersById.get('param.cRaveEnable');
}

async function setRaveProcessingEnabled(enabled) {
  const mobrave = await app.mobrave;
  mobrave.setBypassed(!enabled);
  updateCraveStatus();
}

async function loadPresetByIndex(device, index) {
  assert(app.patcherJson.resolved(), `Cannot load preset ${index} because the patcher JSON data is not available`);
  const presets = app.patcherJson.result.presets || [];
  const preset = presets[index];
  console.log(`Loading preset: ${preset.name}`);
  device.setPreset(preset.preset);
}

function updateCraveStatus()
{
  isCraveEnabled = false;

  if (app.mobrave.resolved() && app.mobrave.result) {
    const mobrave = app.mobrave.result;
    isCraveEnabled = mobrave.getBypassed() === false;
  }
}

function setupDeviceListeners(device) {
  device.parameterChangeEvent.subscribe(param => {

    switch (param.id) {
      case "param.stepCount": {
        if (progress !== undefined) {
          const stepCount = param.value;
          const maxStepCount = 10000 + 1;
          progress = stepCount / maxStepCount;
        }
      } break;

      case "param.rotation.x": {
        if (betaParamVal !== undefined) {
          betaParamVal = param.value / 180.0;
        }
      } break;

      case "param.rotation.y": {
        if (gammaParamVal !== undefined) {
          gammaParamVal = param.value / 90.0;
        }
      } break;

      case "param.rotation.z": {
        if (alphaParamVal !== undefined) {
          alphaParamVal = param.value / 360.0;
        }
      } break;
    }
  });

  device.messageEvent.subscribe(async (ev) => {
    switch (ev.tag) {
      case "crave_enable": {
        assert(typeof ev.payload === "number", `Message passed to RNBO outport ${ev.tag} should be of type "number" but got "${typeof ev.payload}" instead.`)
        setRaveProcessingEnabled(!!ev.payload);
      } break;

      case "midi.play": {
        assert(typeof ev.payload === "number", `Message passed to RNBO outport ${ev.tag} should be of type "number" but got "${typeof ev.payload}" instead.`)
        const command = { type: MidiCommand.Play, id: ev.payload };
        processMidiCommand(command).catch(console.error);
      } break;

      case "midi.pause": {
        assert(typeof ev.payload === "number", `Message passed to RNBO outport ${ev.tag} should be of type "number" but got "${typeof ev.payload}" instead.`)
        const command = { type: MidiCommand.Pause, id: ev.payload };
        processMidiCommand(command).catch(console.error);
      } break;

      case "midi.stop": {
        assert(typeof ev.payload === "number", `Message passed to RNBO outport ${ev.tag} should be of type "number" but got "${typeof ev.payload}" instead.`)
        const command = { type: MidiCommand.Stop, id: ev.payload };
        processMidiCommand(command).catch(console.error);
      } break;

      case "preset.recall": {
        assert(typeof ev.payload === "number", `Message passed to RNBO outport ${ev.tag} should be of type "number" but got "${typeof ev.payload}" instead.`)
        const index = ev.payload;
        loadPresetByIndex(device, index).catch(console.error);
      } break;
    }
  });
}

// ================================================================================

function fixupMidiManifest(json) {
  const manifest = structuredClone(json);
  for (const field in manifest) {
    const entry = manifest[field];
    if (entry.url?.startsWith('./')) {
      entry.url = entry.url.replace('./', '/export/');
    }
  }
  return manifest;
}

function setupMidiPlayer(device) {
  const midiPlayer = new MIDIPlayer('RNBO');

  midiPlayer.onMessage = msg => {
    const message = [...msg];
    if (message.length > 0) {
      const midiPort = 0;
      const event = new RNBO.MIDIEvent(RNBO.TimeNow, midiPort, message);
      device.scheduleEvent(event);
    }
  };

  midiPlayer.setupVirtualNode();

  return midiPlayer;
}

function updateMidiPlayButtonState(playing) {
  const button = document.getElementById('midiPlayButton');
  if (button) {
    button.innerHTML = playing ? 'Pause' : 'Play';
  }
}

function toggleMidi(button) {
  if (!app.midiPlayer.resolved()) {
    console.log('Midi player is not ready yet.');
    return;
  }

  const midiPlayer = app.midiPlayer.result;
  if (midiPlayer.playing) {
    midiPlayer.pause();
  } else {
    midiPlayer.play();
  }
}

async function onMidiFormSubmitted(form, event) {
  event.preventDefault();

  const url = form.midiFile?.value;
  const midiFile = await fetch(url).then(r => r.arrayBuffer()).catch(e => {
    console.error(`Failed to fetch MIDI File: ${e.name}: ${e.message}`)
  });

  if (app.midiPlayer.resolved()) {
    const midiPlayer = app.midiPlayer.result;
    midiPlayer.loadMidiFile(midiFile);
  }
}

function makeEnum(values) {
  const obj = Object.create(null);
  for (const val of values) {
    obj[val] = Symbol(val);
  }
  return Object.freeze(obj);
}

const MidiCommand = makeEnum([
  'Play',
  'Pause',
  'Stop',
]);

async function processMidiCommand(command) {
  const midiPlayer = app.midiPlayer.result;
  const manifest = app.midiManifest.result;

  switch (command.type) {
    case MidiCommand.Play: {
      if (midiPlayer.currentFileId !== command.id) {
        const entry = manifest[command.id];
        const data = await fetch(entry.url).then(r => r.arrayBuffer());
        midiPlayer.loadMidiFile(data);
        midiPlayer.currentFileId = command.id;
      }

      midiPlayer.play();
    } break;

    case MidiCommand.Pause: {
      if (midiPlayer.currentFileId === command.id)
        midiPlayer.pause();
    } break;

    case MidiCommand.Stop: {
      if (midiPlayer.currentFileId === command.id)
        midiPlayer.stop();
    } break;
  }
}

// ================================================================================

// IMPORTANT(robin): Safari may revoke its gesture context and cause the audio
// context to be in a broken state if we don't return quickly from this
// function. You should do only the very bare minimum of work in this function and use
// something like setTimeout to defer more expensive operations to a later date.
function onAudioContextCreated(audioContext) {
  console.log(`onAudioContextCreated: ${audioContext}`);

  assert(app.mobrave.resolved(), 'app.mobrave resource should be resolved prior to creating the audio context');
  let mobrave = app.mobrave.result;

  let cppContext = mobrave.emscriptenRegisterAudioObject(audioContext);
  mobrave.createWasmAudioThread(cppContext);

  app.audioContext.resolve(audioContext);
}

// NOTE(robin): Called from C++ land when the wasm audio worklet node is created.
// IMPORTANT(robin): This must return quickly because it's run in the user gesture path for creating
// the audio context
function onAudioWorkletCreated(audioWorklet) {
  console.log(`onAudioWorkletCreated: ${audioWorklet}`);
  app.audioWorklet.resolve(audioWorklet);
}

function createAudioContext() {
  let context = new (window.AudioContext || window.webkitAudioContext)();
  return context;
}

async function toggleAudio(playButton) {

  if (!app.mobrave.resolved()) {
    console.log('Cannot start the audio context because the WASM module is not ready yet');
    return;
  }

  // IMPORTANT(robin): Safari is very picky about the initialisation of audio contexts:
  //   1. The audio context MUST be created in response to a user gesture.
  //   2. You must not take too long to create the audio context after the user
  //   gesture. This means no `await`-ing before the context has been created.
  //   3. You must return quickly from the user gesture callback. This typically means no
  //   `await`-ing after the audio context creation either!

  if (!app.audioContext.resolved()) {
    let audioContext = createAudioContext();
    assert(audioContext, `Couldn't initialise an AudioContext instance. Perhaps there is an issue with your audio device?`);

    audioContext.suspend().catch(console.error);
    onAudioContextCreated(audioContext);
  }

  // NOTE(robin): we know this should have been resolved by the time we get to this point. If it
  // hasn't then there was some problem creating the audio context.
  let audioContext = app.audioContext.result;

  if (audioContext.state === "suspended") {
    audioContext.resume()
      .then(() => playButton.innerHTML = 'Pause')
      .catch(console.error);
  } else {
    audioContext.suspend()
      .then(() => playButton.innerHTML = 'Play')
      .catch(console.error);
  }
}

// ================================================================================

async function enableWakeLock(button) {
  if (!app.isWakeLockSetupComplete) {
    app.isWakeLockSetupComplete = true;

    let error = await wakelock.requestWakeLock();
    if (error) {
      console.error(`Failed to enable WakeLock: ${error}`);
    }

    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'visible') {
        wakelock.requestWakeLock();
      }
    });
  }
}

// ================================================================================

function enableSensors(button) {
  if (!app.isSensorSetupComplete) {
    app.isSensorSetupComplete = true;
    setupSensors();
  }
}

function updateDeviceParameter(param, value) {
  if (param) {
    param.value = value;
  }
}

function updateStepCount(count) {
  app.sensors.stepCount = count;
  updateDeviceParameter(app.params.stepCount, count);
}

function updateAccelerometer(accel) {
  app.sensors.accel = accel;
  updateDeviceParameter(app.params.accel.x, accel.x);
  updateDeviceParameter(app.params.accel.y, accel.y);
  updateDeviceParameter(app.params.accel.z, accel.z);
}

function updateOrientation(orientation) {
  app.sensors.rotation = orientation;
  updateDeviceParameter(app.params.rotation.x, orientation.x);
  updateDeviceParameter(app.params.rotation.y, orientation.y);
  updateDeviceParameter(app.params.rotation.z, orientation.z);
}

function updateGeolocation(position) {
  const coords = position.coords;
  const heading = coords.heading; // In degrees, or null if not available

  app.sensors.heading = heading || undefined;
  updateDeviceParameter(app.params.heading, heading);
}

async function setupSensors() {
  const id = 'app'; // NOTE(robin): listener id
  const features = app.features;

  if (features.stepCounter) {
    console.log('Setting up StepCounter...');
    let stepCounter = new sensors.StepCounter();
    let error = await stepCounter.setup();

    if (error) {
      console.error(`Failed to setup StepCounter: ${error}`);
    }

    stepCounter.addListener(id, updateStepCount);
    console.log('Setting up StepCounter... Done');

    app.stepCounter = stepCounter;
  }

  if (features.accelerometer) {
    console.log('Setting up Accelerometer...');
    let accelerometer = new sensors.Accelerometer();
    let error = await accelerometer.setup();

    if (error) {
      console.error(`Failed to setup Accelerometer: ${error}`);
    }

    accelerometer.addListener(id, updateAccelerometer);
    console.log('Setting up Accelerometer... Done');
  }

  if (features.orientation) {
    console.log('Setting up Orientation...');
    let orientation = new sensors.Orientation();
    let error = await orientation.setup();

    if (error) {
      console.error(`Failed to setup Orientation: ${error}`);
    }

    orientation.addListener(id, updateOrientation);
    console.log('Setting up Orientation... Done');
  }

  if (features.geolocation) {
    console.log('Setting up Geolocation...');

    let settings = {
      enableHighAccuracy: true,
      maximumAge: 1000,
      timeout: 5000
    };

    let geolocation = new sensors.Geolocation();
    let error = geolocation.setup(settings);

    if (error) {
      console.error(`Failed to setup Geolocation: ${error}`);
    }

    geolocation.addListener(id, updateGeolocation);
    console.log('Setting up Geolocation... Done');
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
    try {
      if (!isDraggingSlider)
          uiElements[param.id].slider.value = param.value;
      uiElements[param.id].text.value = param.value.toFixed(1);
    } catch (e) {
    }
  });
}

function makePresetSelector(device, patcher) {
  let presets = patcher.presets || [];
  if (presets.length < 1) {
    document.getElementById("rnbo-presets").removeChild(document.getElementById("preset-select"));
    return;
  }

  document.getElementById("rnbo-presets").removeChild(document.getElementById("no-presets-label"));
  let presetSelect = document.getElementById("preset-select");
  presets.forEach((preset, index) => {
    const option = document.createElement("option");
    option.innerText = preset.name;
    option.value = index;
    presetSelect.appendChild(option);
  });

  presetSelect.onchange = () => loadPresetByIndex(device, presetSelect.value);
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

    let mobrave = app.mobrave.resolved() ? app.mobrave.result : undefined;
    let audioContext = app.audioContext.resolved() ? app.audioContext.result : undefined;
    let metrics = mobrave ? mobrave.getMetrics() : {};

    metricsTableBody.appendChild(
      createRow('audioContext.state', audioContext?.state ?? 'unknown')
    );

    for (const field in app) {
      if (app[field] instanceof TrackedPromise) {
        metricsTableBody.appendChild(
          createRow(`app.${field}`, app[field].state)
        );
      }
    }

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

async function trackedFetch(onProgress, url, ...args) {
 const response = await fetch(url, ...args);

  if (!response.ok || !response.body) {
    throw new Error(`Fetch failed with status ${response.status}`);
  }

  const contentLength = response.headers.get('Content-Length');
  const total = contentLength ? parseInt(contentLength, 10) : undefined;

  const reader = response.body.getReader();
  let received = 0;

  const stream = new ReadableStream({
    start(controller) {
      function push() {
        reader.read().then(({ done, value }) => {
          const progress = {
            done: done,
            total: total,
            received: received,
          };

          if (done) {
            onProgress(progress);
            controller.close();
            return;
          }

          received += value.length;
          onProgress(progress);

          controller.enqueue(value);
          push();
        }).catch(error => {
          controller.error(error);
        });
      }

      push();
    }
  });

  // Create a new Response that behaves just like a normal fetch response
  const newResponse = new Response(stream, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });

  return newResponse;
}

// ================================================================================

function assert(condition, message) {
  if (!condition) {
    let formattedMessage = `Assertion failed: ${message}`;
    console.error(formattedMessage);
    alert(`Critical error: ${message}`);
    throw new Error(formattedMessage);
  }
}

// ================================================================================
// NOTE(robin): Global scope exports

window.app = app;
window.onAudioWorkletCreated = onAudioWorkletCreated;
window.toggleAudio = toggleAudio;
window.resetParameters = resetParameters;
window.enableSensors = enableSensors;

// ================================================================================

main();
