import { maybeRequestPermissionFor } from './permission.js'

export class StepCounter {
  constructor() {
    this.count = 0;
    this.threshold = 12.0;
    this.listeners = new Map();
    this._lastAccel = {x: 0, y: 0, z: 0};
  }

  addListener(id, callback) {
    this.listeners.set(id, callback);
  }

  removeListener(id) {
    this.listeners.delete(id);
  }

  notifyListeners(count) {
    for (const [id, callback] of this.listeners) {
      callback(count);
    }
  }

  setThreshold(thresh) {
    this.threshold = thresh;
  }

  reset() {
    this.count = 0;
  }

  update(acceleration) {
    const lastAccel = this._lastAccel;
    const delta = Math.abs(acceleration.x - lastAccel.x)
                + Math.abs(acceleration.y - lastAccel.y)
                + Math.abs(acceleration.z - lastAccel.z);

    if (delta >= this.threshold) {
      this.count += 1;
      this.notifyListeners(this.count);
    }

    this._lastAccel = acceleration;
  }

  async setup() {
    const access = await maybeRequestPermissionFor(window.DeviceMotionEvent);
    const success = access === 'granted';

    function internalUpdate(instance, event) {
      const accel = event.accelerationIncludingGravity || event.acceleration;
      instance.update(accel);
    }

    if (success)
      window.addEventListener('devicemotion', event => internalUpdate(this, event));

    let error = success ? undefined : 'Could not access window.DeviceMotionEvent';
    return error;
  }
};
