export class Geolocation {
  constructor() {
    this.listeners = new Map();
    this.watchId = undefined;
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

  update(position) {
    this.notifyListeners(position);
  }

  setup(settings) {
    let error = undefined;

    if (!navigator.geolocation) {
      error = 'Geolocation is not supported by this browser';
      return error;
    }

    const defaults = {
      enableHighAccuracy: true,
      maximumAge: 1000,
      timeout: 5000
    };

    settings = settings || defaults;

    const onError = err => {
      console.error(`GeoLocation Error: ${err.code}: ${err.message}`);
    };

    this.watchId = navigator.geolocation.watchPosition(pos => this.update(pos), onError, settings);
    return error;
  }
}
