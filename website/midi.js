import './JZZ.js'
import './JZZ.midi.SMF.js'

export class MIDIPlayer {
  constructor(portName) {
    this.portName = portName;
    this.onMessage = msg => {};
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
    this.player?.play();
    this.playing = true;
  }

  pause() {
    this.player?.pause();
    this.playing = false;
  }
}
