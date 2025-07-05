export async function requestWakeLock() {
  let error = undefined;
  if (!navigator.wakeLock) {
    error = 'WakeLock is not supported by this browser';
    return error;
  }

  try {
    let wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      console.log('WakeLock was released');
    });
    console.log('WakeLock is active');
  } catch(e) {
    return e.message;
  }

  return error;
}
