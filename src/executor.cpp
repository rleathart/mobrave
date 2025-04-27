#include "spsc_queue.hpp"
#include <crave.h>
#include <models/v1.h>

#include <stdio.h>

#include <array>
#include <string>
#include <chrono>

#include <emscripten.h>
#include <emscripten/webaudio.h>
#include <emscripten/bind.h>
#include <emscripten/threading.h>

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

volatile uint32_t numAvailableBlocks = 0;

struct policy : spsc_queue_policy
{
  enum {allow_partial_rw = false};
};

float modelInputBuffer[2048 * 32];
float modelOutputBuffer[2048 * 32];
auto modelInputQueue = spsc_queue_adapter<float, policy> {modelInputBuffer};
auto modelOutputQueue = spsc_queue_adapter<float, policy> {modelOutputBuffer};

arena_t arena = {};
v1_model_weights_t weights;

static bool isModelLoaded;

void setCurrentModel(const std::string& buffer)
{
  tensor_list_t* list = tensor_load_from_memory(&arena, (void*)buffer.data(), buffer.size());
  for (uint32_t i = 0; i < list->count; i++) {
    printf("got tensor: %s\n", list->tensors[i]->name);
  }
  load_weights(&arena, &weights, list);

  isModelLoaded = true;
}

static pthread_t modelThreadId;
void* modelThread(void* userData)
{
  printf("modelThread started\n");
  tensor_t* z = tensor_create(&arena, U32_TPL(1, 4, 1), 4096);

  for (;;)
  {
    emscripten_futex_wait(&numAvailableBlocks, 0, 1000.0);
    if (numAvailableBlocks == 0)
      continue;

    float buffer[2048];
    size_t popped = 0; do {
      popped = modelInputQueue.pop(buffer, 2048);

      // process buffer in some way
      if (isModelLoaded) {
        tensor_init(z, U32_TPL(1, 4, 1));

        z->data[0] = 10.0f * buffer[0];
        z->data[1] = 10.0f * buffer[1];
        z->data[2] = 10.0f * buffer[2];
        z->data[3] = 10.0f * buffer[3];

        using namespace std::chrono_literals;
        auto start = std::chrono::high_resolution_clock::now();

        decode(z, &weights);

        auto end = std::chrono::high_resolution_clock::now();
        auto elapsed = end - start;
        printf("Runtime: %.2f ms\n", float(elapsed / 1.0ms));

        assert(z->count == std::size(buffer));
        memcpy(buffer, z->data, sizeof(buffer));
      }

      if (numAvailableBlocks > 0)
        numAvailableBlocks -= 1;

      auto pushed = modelOutputQueue.push(buffer, 2048);
    } while (popped == 2048);
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

    float buffer alignas(16) [2048] = {};

    for (int i = 0; i < frameCount; i++) {
      float sample = 0.0f;
      for (int c = 0; c < input.numberOfChannels; c++)
        sample += gain * input.data[frameCount * c + i];

      buffer[i] = sample;
    }

    auto pushed = modelInputQueue.push(buffer, frameCount);
    assert(pushed <= frameCount);
    assert(frameCount <= 2048);
    if (pushed != frameCount) {
      // ET_LOG(Error, "modelInputQueue is full! Only had space for %zu samples.", pushed);
    }

    static uint32_t samplesProcessed = 0;
    samplesProcessed += pushed;
    if (samplesProcessed >= 2048) {
      numAvailableBlocks += 1;
      samplesProcessed -= 2048;
      emscripten_futex_wake(&numAvailableBlocks, 1);
    }
  }

  for (int o = 0; o < outputCount; o++)
  {
    auto output = outputs[o];
    auto frameCount = output.samplesPerChannel;

    if (o == 0) {
      float buffer alignas(16) [2048] = {};
      auto popped = modelOutputQueue.pop(buffer, frameCount);
      assert(popped <= frameCount);
      assert(frameCount <= 2048);
      if (popped != frameCount) {
        // ET_LOG(Error, "modelOutputQueue is empty! Only contained %zu samples.", popped);
      }

      for (int i = 0; i < frameCount; i++) {
        for (int c = 0; c < output.numberOfChannels; c++) {
          // output.data[frameCount * c + i] = 0.1f * gain * (2.0f * randf() - 1.0f);
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

      int outputChannelCounts[] = {1};
      EmscriptenAudioWorkletNodeCreateOptions options = {};
      options.numberOfInputs = 1;
      options.numberOfOutputs = 1;
      options.outputChannelCounts = outputChannelCounts;

      auto worklet = emscripten_create_wasm_audio_worklet_node(context, processorName, &options, audioCallback, nullptr);

      EM_ASM({emscriptenGetAudioObject($0).mobraveWorklet = emscriptenGetAudioObject($1)}, context, worklet);
      EM_ASM({emscriptenGetAudioObject($0).connect(emscriptenGetAudioObject($1).destination)}, worklet, context);
      EM_ASM({onProcessorCreated()});
    };

    emscripten_create_wasm_audio_worklet_processor_async(context, &options, onProcessorCreated, nullptr);
  };

  emscripten_start_wasm_audio_worklet_thread_async(context,
                                                   audioStack, sizeof(audioStack),
                                                   onAudioThreadInitialised, nullptr);

  auto state = emscripten_audio_context_state(context);
  printf("AudioContext state: %d\n", state);
  if (state != AUDIO_CONTEXT_STATE_RUNNING) {
    emscripten_resume_audio_context_sync(context);
  }
}

int main(int argc, const char** argv) {
  arena_init(&arena, 5 * MB);

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
}
