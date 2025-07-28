let progress = 0;
let alphaParamVal = 0.4;   // expected: 0–1 (normalized angle)
let betaParamVal = 0.4;    // expected: -1 to 1 (up/down)
let gammaParamVal = -0.3;   // expected: -1 to 1 (left/right)
let progressSpeed = 0.001;

let playButton, resetButton;
let isPlaying = false;
let isMidiEnabled = false;
let isCraveEnabled = false;
let isGranulatorEnabled = false;

const ui = {
  weightsDownloadProgress: null,

  settingsButton: null,
  onSettingsClicked: () => {},
};

function setup() {
  const canvas = createCanvas(windowWidth, windowHeight);
  canvas.parent('p5-container');
  angleMode(DEGREES);
  noStroke();

  playButton = createButton("▶"); // initial label
  styleButton(playButton); // replace with playButton.addClass('Button').
  playButton.style('font-size', '48px')
  playButton.style('display', 'none');
  playButton.mousePressed(togglePlay);

  resetButton = createButton("↻");
  styleButton(resetButton);
  resetButton.style('font-size', '58px')
  resetButton.style('display', 'none');
  resetButton.mousePressed(onResetClicked); //replace to actual resets.

  ui.settingsButton = createButton("⚙");
  styleButton(ui.settingsButton);
  ui.settingsButton.style('font-size', '58px')
}


function draw() {
  background(140);

  const barY = height - 100;
  const barMargin = 50;
  const cx = width / 2;
  const cy = height / 2 - 100;
  const radius = 120;

  // --- Labels ---
  textSize(40);
  text("MOBRAVE", width /2, 100)

  ui.settingsButton.position(width - 100, 30);
  ui.settingsButton.mousePressed(ui.onSettingsClicked);

  // --- Loading bar ---

  const dlprogress = ui.weightsDownloadProgress;
  const loadingPercent = dlprogress ? ceil(100 * dlprogress.received / dlprogress.total) : 0;

  if (!dlprogress?.done)
  {
    fill(0, 0, 0);
    textAlign(CENTER);
    text(`LOADING... ${loadingPercent}%`, cx, 180);
  }
  else
  {
    playButton.style('display', 'initial');
    resetButton.style('display', 'initial');

    // --- Progress Bar ---
    stroke(0);
    strokeWeight(1);
    line(barMargin, barY, width - barMargin, barY);

    const progressX = map(progress % 1, 0, 1, barMargin, width - barMargin);
    strokeWeight(2);
    line(progressX, barY - 20, progressX, barY + 20);

    // textSize(20);
    // text("V1", (width /2)+115, 107)

    noStroke();
    textSize(width / 30);


    isMidiEnabled ? fill(0, 255, 0) : fill(255, 0, 0);
    textAlign(LEFT);
    text("MIDI", width / 10, barY + 80);

    isCraveEnabled ? fill(0, 255, 0) : fill(255, 0, 0);
    textAlign(CENTER);
    text("CRAVE", width / 2, barY + 80);

    isGranulatorEnabled ? fill(0, 255, 0) : fill(255, 0, 0);
    textAlign(RIGHT);
    text("GRAN", width - width / 10, barY + 80);

    // --- Buttons ---

    playButton.position(cx - 100, barY - 160);
    resetButton.position(cx + 20, barY - 170);

    // --- Orientation Lines ---
    stroke(0);
    strokeWeight(1);

    // Gamma (horizontal) line
    line(cx - radius, cy, cx + radius, cy);

    // Gamma indicator (mapped -1 to 1 across width)
    const gammaX = map(gammaParamVal, -1, 1, cx - radius, cx + radius);
    noStroke();
    fill(0);
    circle(gammaX, cy, 12);

    // Beta (vertical) line
    stroke(0);
    line(cx, cy - radius, cx, cy + radius);

    // Beta indicator (mapped -1 to 1 vertically)
    const betaY = map(betaParamVal, -1, 1, cy + radius, cy - radius); // invert for screen
    noStroke();
    fill(0);
    circle(cx, betaY, 12);

    // Alpha circle
    noFill();
    stroke(0);
    strokeWeight(2);
    circle(cx, cy, radius * 2);

    // Rotating alpha indicator
    const angle = alphaParamVal * 360; // assume alphaParamVal in range 0–1
    const ix = cx + cos(angle) * radius;
    const iy = cy + sin(angle) * radius;

    noStroke();
    fill(0, 255, 255);
    circle(ix, iy, 12);

    // Display alpha angle
    fill(0);
    textSize(16);
    textAlign(CENTER, CENTER);
    text(`${floor(angle % 360)}°`, cx, cy + radius + 20);

    // Optional: increment progress if desired
    // progress += progressSpeed;
    //
  }
}

function togglePlay() {
  isPlaying = !isPlaying;
  playButton.html(isPlaying ? "❚❚" : "▶");

  enableSensors();
  toggleAudio();
}

function resetProgress() {
  progress = 0;
}

function onResetClicked() {
  resetProgress();
  resetParameters();
}

// Add this bit to css.
function styleButton(btn) {
  btn.style('background-color', '#8C8C8C');         // match canvas background
  btn.style('color', '#000000');                    // white icon
  btn.style('box-shadow', 'none'); 
  btn.style('border', '2px solid #8C8C8C');  
  btn.style('padding', '10px 20px');             // spacing
  btn.style('cursor', 'pointer');
  btn.style('outline', 'none');
}


function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}
