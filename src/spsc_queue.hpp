#pragma once

// .hpp ===========================================================================

#include <algorithm>
#include <atomic>
#include <span>

struct spsc_queue_policy
{
  enum { cache_line_size = 64, };
  enum { allow_partial_rw = true, };
};

template <typename T, typename policy = spsc_queue_policy>
struct spsc_queue_adapter
{
  spsc_queue_adapter(std::span<T>);
  size_t push(const T* data, size_t count);
  size_t pop(T* data, size_t count);

  alignas(policy::cache_line_size) std::atomic<size_t> head {0};
  alignas(policy::cache_line_size) std::atomic<size_t> tail {0};
  std::span<T> buffer;
};

// .cpp ===========================================================================

namespace spsc_queue_detail {

static size_t fastModulo(size_t x, size_t max)
{
  while (x >= max)
    x -= max;
  return x;
}

static size_t getUsed(size_t writeIndex, size_t readIndex, size_t size)
{
  auto used = writeIndex >= readIndex
    ? writeIndex - readIndex
    : 2 * size + writeIndex - readIndex;
  return used;
}

}

template <typename T, typename policy>
spsc_queue_adapter<T, policy>::spsc_queue_adapter(std::span<T> buffer_) :
  buffer(buffer_)
{
}

template <typename T, typename policy>
size_t spsc_queue_adapter<T, policy>::push(const T* input, size_t count)
{
  using namespace spsc_queue_detail;

  auto data = buffer.data();
  auto size = buffer.size();

  auto tail_ = tail.load(std::memory_order_relaxed);
  auto head_ = head.load(std::memory_order_acquire);
  auto used = getUsed(tail_, head_, size);
  auto avail = size - used;

  auto writes = std::min(avail, count);

  if (policy::allow_partial_rw || writes == count)
  {
    auto writeIndex = fastModulo(tail_, size);

    auto copy1Size = writeIndex + writes > size ? size - writeIndex : writes;
    auto copy2Size = writes - copy1Size;

    std::copy(input, input + copy1Size, data + writeIndex);
    std::copy(input + copy1Size, input + copy1Size + copy2Size, data);

    auto newWriteIndex = fastModulo(tail_ + writes, 2 * size);
    tail.store(newWriteIndex, std::memory_order_release);
  }

  return writes;
}

template <typename T, typename policy>
size_t spsc_queue_adapter<T, policy>::pop(T* output, size_t count)
{
  using namespace spsc_queue_detail;

  auto data = buffer.data();
  auto size = buffer.size();

  auto tail_ = tail.load(std::memory_order_acquire);
  auto head_ = head.load(std::memory_order_relaxed);
  auto used = getUsed(tail_, head_, size);
  auto avail = used;

  auto reads = std::min(avail, count);

  if (policy::allow_partial_rw || reads == count)
  {
    auto readIndex = fastModulo(head_, size);

    auto copy1Size = readIndex + reads > size ? size - readIndex : reads;
    auto copy2Size = reads - copy1Size;

    std::copy(data + readIndex, data + readIndex + copy1Size, output);
    std::copy(data, data + copy2Size, output + copy1Size);

    auto newReadIndex = fastModulo(head_ + reads, size * 2);
    head.store(newReadIndex, std::memory_order_release);
  }

  return reads;
}
