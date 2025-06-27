/**
 * @brief Allows the creation of a promise style object that doesn't require an initial callable and
 * who's state can be queried.
 *
 * You can use this to represent a resource that you know will be made available by some part of the
 * codebase at some point but that you can't immediately request.
 *
 * @example Say you have some code that depends on an initialised AudioContext. Since AudioContexts
 * must be created in response to a user gesture, you cannot initialise one when the page loads. So,
 * instead what you can do is use this class to declare some variable that will eventually store
 * your AudioContext and await on it being created in your startup code like this:
 *
 * @code
 *
 * let audioContextPromise = new TrackedPromise();
 *
 * async function main() {
 *   let audioContext = await audioContextPromise;
 *   doSomethingWith(audioContext);
 * }
 *
 * // let's say this runs when your page is loaded
 * main();
 *
 * function onButtonClicked() {
 *   let audioContext = new AudioContext();
 *
 *   // this will now unblock main()
 *   audioContextPromise.resolve(audioContext);
 * }
 * @endcode
 */
export class TrackedPromise {
  constructor() {
    this.state = "pending";
    this.result = undefined;
    this.error = undefined;

    this.promise = new Promise((res, rej) => {
      this._resolve = (value) => {
        this.state = "resolved";
        this.result = value;
        res(value);
      };
      this._reject = (err) => {
        this.state = "rejected";
        this.error = err;
        rej(err);
      };
    });
  }

  resolved() {
    return this.state === "resolved";
  }

  resolve(value) {
    this._resolve(value);
  }

  reject(error) {
    this._reject(error);
  }

  then(onFulfilled, onRejected) {
    return this.promise.then(onFulfilled, onRejected);
  }

  catch(onRejected) {
    return this.promise.catch(onRejected);
  }

  finally(onFinally) {
    return this.promise.finally(onFinally);
  }
};

/// @brief creates a TrackedPromise from a native Promise object
export function track(nativePromise) {
  const tracked = new TrackedPromise();

  nativePromise
    .then(value => {
      tracked.resolve(value);
      return value;
    })
    .catch(err => {
      tracked.reject(err);
      throw err;
    });

  return tracked;
}
