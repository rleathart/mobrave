import './JZZ.js'
import './JZZ.midi.SMF.js'

export class MIDIPlayer {
  constructor(portName) {
    this.portName = portName;
    this.onMessage = msg => {};
    this.onPlayingChanged = playing => {};
    this.playing = false;
  }

  setupVirtualNode() {
    this.node = JZZ.Widget();
    this.node._receive = msg => this.onMessage(msg);

    JZZ.addMidiOut(this.portName, this.node);
    this.port = JZZ().openMidiOut(this.portName);
  }

  loadMidiFile(buffer) {
    this.smf = new JZZ.MIDI.SMF(buffer);
    this.player = this.smf.player();
    this.player.connect(this.port);
  }

  play() {
    this.player?.resume();
    this.playing = true;
    this.onPlayingChanged(this.playing);
  }

  pause() {
    this.player?.pause();
    this.player?.sndOff();

    // NOTE(robin): emit note offs for every note on every channel
    for (let c = 0; c < 16; c++) {
      for (let note = 0; note < 128; note++) {
        const velocity = 0;
        this.player?._emit(JZZ.MIDI.noteOff(c, note, velocity));
      }
    }

    this.playing = false;
    this.onPlayingChanged(this.playing);
  }

  stop() {
    this.player?.stop();
    this.playing = false;
    this.onPlayingChanged(this.playing);
  }
}
