/// @brief Handles possibly requesting permission for events like `DeviceMotionEvent` and
/// `DeviceOrientationEvent` on browsers where permission is required.
export function maybeRequestPermissionFor(event) {
  if (event === undefined)
    return Promise.resolve('denied');

  if (typeof event.requestPermission === 'function') {
    return event.requestPermission();
  }

  return Promise.resolve('granted');
};
