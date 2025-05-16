#include <type_traits>
#include <mutex>
#include <shared_mutex>

template <typename T, typename Mutex, typename Lock>
class Access
{
public:
  template <typename ... LockArgs>
  Access(T& obj_, Mutex& m, LockArgs&& ... args) :
    lock(Lock {m, std::forward<LockArgs>(args)...}),
    obj(obj_)
  {
  }

  T* operator -> () const {
    return &obj;
  }

  T& operator * () const {
    return obj;
  }

  explicit operator bool () const {
    return static_cast<bool>(lock);
  }

  Lock lock;

private:
  T& obj;
};

struct DummyMutex
{
  void lock() {
  }

  void unlock() {
  }

  bool try_lock() {
    return true;
  }
};

struct ThreadsafeDummy
{
  using Mutex = DummyMutex;
  using ReadLock = std::unique_lock<Mutex>;
  using WriteLock = std::unique_lock<Mutex>;
};

struct ThreadsafeDefaults
{
  using Mutex = std::shared_timed_mutex;
  using ReadLock = std::shared_lock<Mutex>;
  using WriteLock = std::unique_lock<Mutex>;
};

template <typename T, typename Traits = ThreadsafeDefaults>
class Threadsafe
{
  using Mutex     = typename Traits::Mutex;
  using ReadLock  = typename Traits::ReadLock;
  using WriteLock = typename Traits::WriteLock;

  static constexpr bool mutexSupportsTryLock = requires (Mutex m) {
    m.try_lock();
  };
  static constexpr bool mutexSupportsWaiting = requires (Mutex m) {
    m.try_lock_for(std::chrono::duration<float>(0.0f));
  };

  static constexpr bool mutexSupportsSharedLock = requires (Mutex m) {
    m.lock_shared();
  };

  static_assert(!std::is_same_v<WriteLock, std::lock_guard<Mutex>>
             && !std::is_same_v<ReadLock,  std::lock_guard<Mutex>>,
             "Use std::unique_lock instead of std::lock_guard.");

  static_assert(!std::is_same_v<WriteLock, std::shared_lock<Mutex>>);
  static_assert(!std::is_same_v<ReadLock, std::shared_lock<Mutex>> || mutexSupportsSharedLock,
                "Incompatible lock and mutex types.");

public:
  template <typename ... CtorArgs>
  Threadsafe(CtorArgs&& ... args) : object(std::forward<CtorArgs>(args)...) {
  }

  // NOTE(robin): required because the template constructor is greedy and is selected instead
  // of the const copy constructor when the copied object is not declared const.
  Threadsafe(Threadsafe& other_) : Threadsafe(static_cast<const Threadsafe&>(other_)) {
  }

  Threadsafe(const Threadsafe& other_) : object(*other_.getReadAccess()) {
  }

  Threadsafe& operator = (const Threadsafe& other_) {
    if (this != &other_) {
      auto readAccess = other_.getReadAccessDeferred();
      auto writeAccess = this->getWriteAccessDeferred();
      auto lock = std::scoped_lock {readAccess.lock, writeAccess.lock};
      *writeAccess = *readAccess;
    }
    return *this;
  }

  Threadsafe(Threadsafe&& other_) = delete; // A Threadsafe object is not moveable. What would threads blocking for read access do when the underlying object is moved out from under them?
  Threadsafe& operator = (Threadsafe&& other_) = delete; // A Threadsafe object is not moveable. What would threads blocking for read access do when the underlying object is moved out from under them?

  const auto getReadAccess() const {
    return ReadAccess {object, mutex};
  }

  const auto getReadAccessDeferred() const {
    return ReadAccess {object, mutex, std::defer_lock};
  }

  const auto tryReadAccess() const requires mutexSupportsTryLock {
    return ReadAccess {object, mutex, std::try_to_lock};
  }

  const auto tryReadAccessFor(double seconds) const requires mutexSupportsWaiting {
    auto access = ReadAccess {object, mutex, std::defer_lock};
    access.lock.try_lock_for(std::chrono::duration<double>(seconds));
    return access;
  }

  auto getWriteAccess() {
    return WriteAccess {object, mutex};
  }

  auto getWriteAccessDeferred() {
    return WriteAccess {object, mutex, std::defer_lock};
  }

  auto tryWriteAccess() requires mutexSupportsTryLock {
    return WriteAccess {object, mutex, std::try_to_lock};
  }

  auto tryWriteAccessFor(double seconds) requires mutexSupportsWaiting {
    auto access = WriteAccess {object, mutex, std::defer_lock};
    access.lock.try_lock_for(std::chrono::duration<double>(seconds));
    return access;
  }

  using ReadAccess = Access<const T, Mutex, ReadLock>;
  using WriteAccess = Access<T, Mutex, WriteLock>;

private:
  T object;
  mutable Mutex mutex;
};
