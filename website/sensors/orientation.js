import { maybeRequestPermissionFor } from './permission.js'

export class Orientation {
  constructor() {
    this.listeners = new Map();
  }

  addListener(id, callback) {
    this.listeners.set(id, callback);
  }

  removeListener(id) {
    this.listeners.delete(id);
  }

  notifyListeners(orientation) {
    for (const [id, callback] of this.listeners) {
      callback(orientation);
    }
  }

  update(event) {
    let orientation = {x: 0.0, y: 0.0, z: 0.0};

    // NOTE(robin): Euler angles to axis:
    // x: beta [-180.0, 180.0]
    // y: gamma [-90.0, 90.0]
    // z: alpha [0.0, 360.0]

    orientation.x = event.beta;
    orientation.y = event.gamma;
    orientation.z = event.alpha;

    this.notifyListeners(orientation);
  }

  async setup() {
    const access = await maybeRequestPermissionFor(window.DeviceOrientationEvent);
    const success = access === 'granted';

    function internalUpdate(instance, event) {
      instance.update(event);
    }

    if (success)
      window.addEventListener('deviceorientation', event => internalUpdate(this, event));

    let error = success ? undefined : 'Could not access window.DeviceOrientationEvent';
    return error;
  }

}
