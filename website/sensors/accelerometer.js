import { maybeRequestPermissionFor } from './permission.js'

export class Accelerometer {
  constructor() {
    this.listeners = new Map();
  }

  addListener(id, callback) {
    this.listeners.set(id, callback);
  }

  removeListener(id) {
    this.listeners.delete(id);
  }

  notifyListeners(arg) {
    for (const [id, callback] of this.listeners) {
      callback(arg);
    }
  }

  update(acceleration) {
    this.notifyListeners(acceleration);
  }

  async setup() {
    const access = await maybeRequestPermissionFor(window.DeviceMotionEvent);
    const success = access === 'granted';

    function internalUpdate(instance, event) {
      const accel = event.acceleration || event.accelerationIncludingGravity;
      instance.update(accel);
    }

    if (success)
      window.addEventListener('devicemotion', event => internalUpdate(this, event));

    let error = success ? undefined : 'Could not access window.DeviceMotionEvent';
    return error;
  }
}
