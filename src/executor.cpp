#include "spsc_queue.hpp"

#define CRV_IMPLEMENTATION
#define CRV_IM2COL
#include <model.h>

#include <stdio.h>

#include <array>
#include <string>
#include <chrono>

#include <emscripten.h>
#include <emscripten/webaudio.h>
#include <emscripten/bind.h>
#include <emscripten/threading.h>

#include "threadsafe.hpp"

constexpr size_t operator""_KiB(unsigned long long int x) {
  return 1024ull * x;
}

constexpr size_t operator""_MiB(unsigned long long int x) {
  return 1024_KiB * x;
}

static float randf() {
  auto x = std::rand();
  auto f = x / float(RAND_MAX);
  return f;
}

struct Timer
{
  using clock = std::chrono::high_resolution_clock;

  void start()
  {
    startTime = clock::now();
  }

  auto stop()
  {
    using namespace std::chrono_literals;

    auto end = clock::now();
    auto duration = (end - startTime) / 1.0ms;
    return (double)duration;
  }

  std::chrono::time_point<clock> startTime;
};

struct Model
{
  Model(const std::string& buffer)
  {
    memory.reserve(100_MiB);

    auto it = memory.data();
    auto result = model_load(&it, const_cast<char*>(buffer.data()), &model);
    blockSize = model.header.block_size;
    numLatents = model.header.num_latents;
  }

  void decode(tensor_t* z)
  {
    assert(z->count == numLatents);
    model_decode(z, &model);
    assert(z->count == blockSize);
  }

  std::vector<char> memory;

  model_t model;

  int blockSize;
  int numLatents;
};

enum
{
  maxBlockSize = 8192,
  maxLatents = 256,
};

struct Metrics
{
  Timer timer;

  float updateLatentsTime;
  float decodeTime;

  int inputOverflows;
  int outputUnderflows;

  int samplesAvailable;
} metrics;

#define metrics_time(field, code) \
  do { \
    metrics.timer.start(); \
    code; \
    metrics.field = metrics.timer.stop(); \
  } while (0)

struct policy : spsc_queue_policy
{
  enum {allow_partial_rw = false};
};

float modelInputBuffer[maxBlockSize * 8];
float modelOutputBuffer[maxBlockSize * 8];
auto modelInputQueue = spsc_queue_adapter<float, policy> {modelInputBuffer};
auto modelOutputQueue = spsc_queue_adapter<float, policy> {modelOutputBuffer};

Threadsafe<std::unique_ptr<Model>> modelHolder;

void setCurrentModel(const std::string& buffer)
{
  if (auto access = modelHolder.getWriteAccess()) {
    auto& model = *access;
    model = std::make_unique<Model>(buffer);
  }
}

static emscripten::val latentsCallback;
void updateLatents(float* data, int count)
{
  auto updateInternal = [] (float* data, int count) {
    if (latentsCallback.as<bool>())
      latentsCallback((intptr_t)data, count);
  };

  // NOTE(robin): only the main thread is allowed to run javascript so we have
  // to proxy the call here.
  emscripten_sync_run_in_main_runtime_thread(
    EM_FUNC_SIG_VII, (void*)+updateInternal, data, count);
}

std::atomic<int> samplesAvailable;

static pthread_t modelThreadId;
void* modelThread(void* userData)
{
  Timer timer;

  printf("modelThread started\n");

  size_t z_cap = 32 * maxBlockSize;
  auto z_buffer = std::vector<char>(z_cap);
  auto it = z_buffer.data();
  tensor_t* z = crv_tensor_create(&it, CRV_TPL(1, 4, 1), z_cap, CRV_SWAP);

  for (;;)
  {
    if (auto available = samplesAvailable.load(); available <= 0)
      emscripten_futex_wait(&samplesAvailable, available, 5000.0);

    auto available = samplesAvailable.load();
    metrics.samplesAvailable = available;

    if (available <= 0)
      continue;

    float buffer[maxBlockSize];
    for (;;)
    {
      if (auto access = modelHolder.tryReadAccess()) {
        auto& model = *access;

        if (model.get())
        {
          assert(model->blockSize <= maxBlockSize);

          auto popped = modelInputQueue.pop(buffer, model->blockSize);
          if (popped != model->blockSize)
            break;

          samplesAvailable.fetch_sub(model->blockSize);

          crv_tensor_init(z, CRV_TPL(1, 4, 1));

          z->data[0] = 10.0f * buffer[0];
          z->data[1] = 10.0f * buffer[1];
          z->data[2] = 10.0f * buffer[2];
          z->data[3] = 10.0f * buffer[3];

          metrics_time(updateLatentsTime, {
            updateLatents(z->data, z->count);
          });

          metrics_time(decodeTime, {
            model->decode(z);
          });

          assert(z->count == model->blockSize);
          memcpy(buffer, z->data, model->blockSize * sizeof(float));

          auto pushed = modelOutputQueue.push(buffer, model->blockSize);
        }
      }
    }
  }

  return nullptr;
}

char audioStack alignas(16) [1_MiB];
EM_BOOL audioCallback(int inputCount, const AudioSampleFrame* inputs,
                     int outputCount, AudioSampleFrame* outputs,
                     int paramCount, const AudioParamFrame* params,
                     void* userData)
{
  float gain = 1.0f;

  for (int i = 0; i < paramCount; i++) {
    auto param = params[i];
    if (param.length > 0) {
      if (i == 0) {
        gain = param.data[0];
      }
    }
  }

  if (inputCount > 0) {
    auto input = inputs[0];
    auto frameCount = input.samplesPerChannel;
    auto gain = 1.0f / input.numberOfChannels;

    float buffer alignas(16) [maxBlockSize] = {};

    for (int i = 0; i < frameCount; i++) {
      float sample = 0.0f;
      for (int c = 0; c < input.numberOfChannels; c++)
        sample += gain * input.data[frameCount * c + i];

      buffer[i] = sample;
    }

    auto pushed = modelInputQueue.push(buffer, frameCount);
    assert(pushed <= frameCount);
    assert(frameCount <= maxBlockSize);
    if (pushed != frameCount) {
      metrics.inputOverflows += 1;
    }

    samplesAvailable.fetch_add(pushed);
    emscripten_futex_wake(&samplesAvailable, 1);
  }

  for (int o = 0; o < outputCount; o++)
  {
    auto output = outputs[o];
    auto frameCount = output.samplesPerChannel;

    if (o == 0) {
      float buffer alignas(16) [maxBlockSize] = {};
      auto popped = modelOutputQueue.pop(buffer, frameCount);
      assert(popped <= frameCount);
      assert(frameCount <= maxBlockSize);
      if (popped != frameCount) {
        metrics.outputUnderflows += 1;
      }

      for (int i = 0; i < frameCount; i++) {
        for (int c = 0; c < output.numberOfChannels; c++) {
          output.data[frameCount * c + i] = buffer[i];
        }
      }
    }

  }

  return EM_TRUE;
}

void createWasmAudioThread(EMSCRIPTEN_WEBAUDIO_T context)
{
  auto onAudioThreadInitialised = [] (EMSCRIPTEN_WEBAUDIO_T context, EM_BOOL success, void* userData) {
    if (!success) {
      printf("Failed to initialise wasm audio thread. context: %d\n", context);
      return;
    }

    WebAudioParamDescriptor parameters[] = {
      // default, min, max, rate
      {1.0f, 0.0f, 1.0f, WEBAUDIO_PARAM_A_RATE}, // gain
    };

    static auto processorName = "mobrave-wasm-processor";

    WebAudioWorkletProcessorCreateOptions options = {};
    options.name = processorName;
    options.numAudioParams = 1;
    options.audioParamDescriptors = parameters;

    auto onProcessorCreated = [] (EMSCRIPTEN_WEBAUDIO_T context, EM_BOOL success, void* userData) {
      if (!success) {
        printf("Failed to create processor: %s\n", processorName);
        return;
      }

      int outputChannelCounts[] = {2};
      EmscriptenAudioWorkletNodeCreateOptions options = {};
      options.numberOfInputs = 1;
      options.numberOfOutputs = 1;
      options.outputChannelCounts = outputChannelCounts;

      auto worklet = emscripten_create_wasm_audio_worklet_node(context, processorName, &options, audioCallback, nullptr);

      EM_ASM({onAudioWorkletCreated(emscriptenGetAudioObject($0))}, worklet);
    };

    emscripten_create_wasm_audio_worklet_processor_async(context, &options, onProcessorCreated, nullptr);
  };

  emscripten_start_wasm_audio_worklet_thread_async(context,
                                                   audioStack, sizeof(audioStack),
                                                   onAudioThreadInitialised, nullptr);
}

void setLatentsCallback(emscripten::val func)
{
  latentsCallback = func;
}

auto getMetrics() -> Metrics
{
  return metrics;
}

int main(int argc, const char** argv) {
  int result = 0;
  pthread_attr_t attrs = {};
  result = pthread_attr_init(&attrs);
  printf("pthread_attr_init: %d\n", result);
  result = pthread_create(&modelThreadId, &attrs, modelThread, nullptr);
  printf("pthread_create: %d\n", result);
  result = pthread_attr_destroy(&attrs);
  printf("pthread_attr_destroy: %d\n", result);

  return 0;
}

EMSCRIPTEN_BINDINGS(MOBRave) {
  emscripten::function("createWasmAudioThread", &createWasmAudioThread);
  emscripten::function("setCurrentModel", &setCurrentModel);
  emscripten::function("setLatentsCallback", &setLatentsCallback);
  emscripten::function("getMetrics", &getMetrics);
  emscripten::value_object<Metrics>("Metrics")
    .field("decodeTime", &Metrics::decodeTime)
    .field("updateLatentsTime", &Metrics::updateLatentsTime)
    .field("inputOverflows", &Metrics::inputOverflows)
    .field("outputUnderflows", &Metrics::outputUnderflows)
    .field("samplesAvailable", &Metrics::samplesAvailable)
    ;
}
