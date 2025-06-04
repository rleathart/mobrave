cmake_minimum_required(VERSION 3.21)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

project(executor LANGUAGES C CXX)

include(FetchContent)
FetchContent_Declare(crave
  GIT_REPOSITORY https://github.com/lucaayscough/crave
  GIT_TAG 580c9b3
)
FetchContent_MakeAvailable(crave)

add_compile_options(
  "-pthread"
  "-mbulk-memory"
  "-matomics"
  $<$<CONFIG:Debug>:-g>
)

# NOTE(robin): just so clangd knows where emscripten stuff is
set(EMSCRIPTEN_FLAGS
  "-DEMSCRIPTEN"
  "-target" "wasm32-unknown-emscripten"
  "--sysroot=$ENV{EMSDK}/upstream/emscripten/cache/sysroot"
  "-Werror=implicit-function-declaration"
  "-Xclang"
  "-iwithsysroot/include/fakesdl"
  "-Xclang"
  "-iwithsysroot/include/compat"
)

add_executable(executor src/executor.cpp)
target_compile_options(executor PRIVATE ${EMSCRIPTEN_FLAGS})
set_target_properties(executor PROPERTIES CXX_STANDARD 20)

target_link_libraries(executor crave)

target_link_options(executor PRIVATE
  "-sMODULARIZE=1"
  "-sAUDIO_WORKLET=1"
  "-sWASM_WORKERS=1"
  "-sINITIAL_MEMORY=512MB"
  "-sEXPORT_NAME=MOBRave"
  "-sEXPORTED_RUNTIME_METHODS=emscriptenRegisterAudioObject,emscriptenGetAudioObject"
  "-pthread"
  "-sPTHREAD_POOL_SIZE=1"
  "--bind"
)
