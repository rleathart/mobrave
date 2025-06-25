let logFunction = console.log;
let errFunction = console.error;
let maxConsoleLen = 64 * 1024; // 64 KiB limit
let consoleOutput = document.getElementById('console.output');
let osc;
let audioSetupDone = false;
let device;
let audioContext;

console.log = function(message) {
  if (consoleOutput.innerHTML.length > maxConsoleLen)
    consoleOutput.innerHTML = "";

  consoleOutput.innerHTML += message + '<br>';
  consoleOutput.scrollTop = consoleOutput.scrollHeight;
  logFunction(message);
};

console.error = function(message) {
  if (consoleOutput.innerHTML.length > maxConsoleLen)
    consoleOutput.innerHTML = "";

  consoleOutput.innerHTML += message + '<br>';
  consoleOutput.scrollTop = consoleOutput.scrollHeight;
  errFunction(message);
};

console.log('Hello script!')

let mobrave;
let m = MOBRave;
let patcher;
let currentLatents = [];

(async () => {
  console.log('Fetching RNBO patch')
  let rawPatcher = await fetch('/patch.export.json') // Path to RNBO patch
  patcher = await rawPatcher.json();

  console.log('Loading wasm module');
  mobrave = await MOBRave();

  let res = await fetch('/weights.bin');
  let buffer = await res.arrayBuffer();

  let updateLatents = function(data, count) {
    let f32data = new Float32Array(mobrave.HEAPF32.buffer, data, count);

    // NOTE(robin): send latents to RNBO
    let latents = Array.from(f32data);
    if (device) {
      let e = new RNBO.MessageEvent(RNBO.TimeNow, "latents_in", latents);
      device.scheduleEvent(e);
    }

    // NOTE(robin): update the latents with the most recent values we got from RNBO
    for (let i = 0; i < currentLatents.length; i++) {
      if (i < count)
        f32data[i] = currentLatents[i];
    }
  };

  let blockSize = 2048;
  let numLatents = 4;
  mobrave.setLatentsCallback(updateLatents);
  mobrave.setCurrentModel(buffer, blockSize, numLatents);

  // create the device and sliders on page load
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  audioContext.suspend();

  device = await RNBO.createDevice({context: audioContext, patcher: patcher});
  makeSliders(device);

  globalScaleParam = device.parametersById.get('globalScale');
  globalOffssetParam = device.parametersById.get('globalOffset');
  latent1accYParam = device.parametersById.get('latent1accY');
  latent2accXParam = device.parametersById.get('latent2accX');
  latent3accZParam = device.parametersById.get('latent3accZ');
  latent4rvecXParam = device.parametersById.get('latent4rvecX');
  latent5rvecYParam = device.parametersById.get('latent5rvecY');
  latent6rvecZParam = device.parametersById.get('latent6rvecZ');
  latent7gyrXParam = device.parametersById.get('latent7gyrX');
  latent8gyrYParam = device.parametersById.get('latent8gyrY');

  function updateMetrics() {
    let decodeTime = document.getElementById('metrics.decodeTime');
    let updateLatentsTime = document.getElementById('metrics.updateLatentsTime');

    let metrics = mobrave.getMetrics();

    let tbody = "";
    for (field in metrics) {
      value = Number(metrics[field]).toFixed(2);
      tbody += `<tr><td style="text-align: right;">${field}</td><td>${value}</td></tr>\n`;
    }

    let e = document.getElementById('metrics.table.tbody');
    e.innerHTML = tbody;
  }

  let metricUpdateIntervalMs = 33;
  setInterval(updateMetrics, metricUpdateIntervalMs);
})()

let playButton = document.getElementById('playButton');

async function onProcessorCreated() {
  console.log('onProcessorCreated');

  if (!audioContext) {
    console.error('AudioContext is null!');
    return;
  }

  device.messageEvent.subscribe((ev) => {
    if (ev.tag === "latents_out") {
      currentLatents = ev.payload;
    }
  });

  console.log(`mobraveWorklet: ${audioContext.mobraveWorklet}`);

  audioContext.mobraveWorklet.connect(device.node);
  device.node.connect(audioContext.destination);
}

let threshold = 12;
let stepCount = 0;
let lastAccel = { x: 0, y: 0, z: 0 };

function processStepCounter(accelerationIncludingGravity) {
  let acceleration = accelerationIncludingGravity;
  let delta = Math.abs(acceleration.x - lastAccel.x) + Math.abs(acceleration.y - lastAccel.y) + Math.abs(acceleration.z - lastAccel.z);

  if (delta > threshold) {
    stepCount++;

    // console.log(`Step detected! Count: ${stepCount}`);
    // console.log(`Acceleration X: ${acceleration.x}, Y: ${acceleration.y}, Z: ${acceleration.z}`);

    if (latent7gyrXParam) {
      latent7gyrXParam.normalizedValue = stepCount;
    }
  }
  lastAccel = { x: acceleration.x, y: acceleration.y, z: acceleration.z};
}

function processAcceleration(acceleration) {
  let x = acceleration.x || 0;
  let y = acceleration.y || 0;
  let z = acceleration.z || 0;

  // console.log(`Acceleration X: ${x}, Y: ${y}, Z: ${z}`);

  if (latent1accYParam) {
    latent1accYParam.normalizedValue = x * 20;
  }
  if (latent2accXParam) {
    latent2accXParam.normalizedValue = y * 20;
  }
  if (latent3accZParam) {
    latent3accZParam.normalizedValue = z * 20;
  }
}

function handleDeviceMotion(event) {
  let accel = event.acceleration;
  if (accel) {
    processAcceleration(accel)
  }

  let aig = event.accelerationIncludingGravity;
  if (aig) {
    processStepCounter(aig);
  }
}

function handleDeviceOrientation(event) {

  const rotateDegrees = event.alpha; // alpha: rotation around z-axis
  const leftToRight = event.gamma; // gamma: left to right
  const frontToBack = event.beta; // beta: front back motion

  //console.log(`Orientation - Front to Back: ${frontToBack}, Left to Right: ${leftToRight}, Rotate Degrees: ${rotateDegrees}`);

  if (globalScaleParam) {
    globalScaleParam.normalizedValue = frontToBack;
  }

  if (globalOffssetParam) {
    globalOffssetParam.normalizedValue = leftToRight;
  }

}

function handleGeolocationPosition(position) {
  const coords = position.coords;
  const heading = coords.heading; // In degrees, or null if not available

  if (heading !== null) {
    console.log(`Heading: ${heading}°`);
    // Example: send heading to RNBO parameter if needed
    // if (device && device.parametersById.get("headingParam")) {
    //     let e = new RNBO.MessageEvent(RNBO.TimeNow, "headingParam", heading);
    //     device.scheduleEvent(e);
    // }
  } else {
    console.log("Heading not available.");
  }
}

async function setupSensors() {
  let maybeRequestPermissionFor = (event) => {
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

let isSetupComplete = false;
async function toggleAudio() {

  if (!isSetupComplete) {
    setupSensors();

    let cppContext = mobrave.emscriptenRegisterAudioObject(audioContext);
    mobrave.createWasmAudioThread(cppContext);

    isSetupComplete = true;
  }

  if (audioContext.state === "suspended") {
    audioContext.resume();

    playButton.innerHTML = 'Pause';
  } else {
    audioContext.suspend();

    playButton.innerHTML = 'Play';
  }
}

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

function resetStepCounter() {
  // Placeholder function to reset the step counter (if needed)
  stepCount = 0;
  console.log("Step counter reset");
}
